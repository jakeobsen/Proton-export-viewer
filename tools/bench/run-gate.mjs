// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs a gate's measurements in the packaged test build, hidden, and writes a
// JSON and a markdown report.
//
//   node tools/bench/run-gate.mjs --gate index|cards --out <dir> --perf <folder> --scan-data <dir> [options]
//
//   --gate index|cards  which gate: indexing, or expanding cards
//   --out <dir>         a new folder for this run's files
//   --perf <folder>     the 20,000-message corpus, read in place and never written;
//                       its manifest is <folder>.manifest.json beside it
//   --stress <folder>   the 10,000-message stress corpus (index), likewise
//   --scan-data <dir>   a folder to search for generated test data (required, repeatable)
//   --runs <n>          launches per measurement (default 4)
//   --seed <n>          picks the expansions (cards; default 1)
//   --count <n>         expansions timed per launch (cards; default 1000)
//   --max-bytes <n>     largest message file expanded (cards; default 1048576)
//   --warmup <n>        untimed expansions first (cards; default 20)
//   --ci-log <file>     the local `npm run ci` log at the gate head (cards)
//   --linux-log <file>  the Linux `test` check's log at the gate head (cards)
//   --app <path>        the packaged test build (default: the one `npm run package:test` makes)
//   --dry               checks the inputs and prints the plan; launches nothing
//
// Every launch is the app's gate mode (--pev-gate) in a hidden window, one at
// a time. The first launch of each gate is the probe: frame delivery after DOM
// changes, and traced scrolls. When animation frames aren't prompt there, the
// first-rows and reopen times end at the DOM change instead, and the report
// marks them as a proxy that needs a decision: a proxy never passes a row.
//
// Before the run it refuses when the lid is closed, the checkout has changes,
// a corpus differs from its manifest, the out folder exists, less than 20 GiB
// is free, or generated test data plus a full index would reach 1 GB. Every
// corpus file is read once first (warm). After each launch the lid is checked
// again and the power log is searched for Sleep and DarkWake in the launch's
// time; either makes that launch invalid. The frontmost app is sampled once a
// second throughout; the app's memory (physical footprint, with RSS beside it)
// and the index folder's size once a second during each launch.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { cpus, homedir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { APP_ID, PRODUCT_NAME, appPath } from '../../scripts/package.mjs';
import { walk } from '../gen-export/tree.mjs';
import {
  budgetCheck,
  findTestData,
  footprintByPhase,
  footprintOf,
  freeSpace,
  frontmost,
  treeBytes,
} from './run-bench.mjs';
import { corpusState, median, percentile } from './run-open-bench.mjs';
import { checkNewFile, checkOutside, createWorkspace, removeInside } from './workspace.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The targets the gates check. */
export const TARGETS = {
  firstRowsMs: 3000,
  phase1At200kMs: 40_000,
  reopenMs: 2000,
  idleMiB: 500,
  peakMiB: 1536,
  openP95Ms: 150,
};
/** A frame within one 60 Hz frame of the DOM change counts as prompt (p95). */
export const PROMPT_FRAME_MS = 16.7;
/** Phase 1 at 20,000 messages, extrapolated linearly to 200,000. */
export const PHASE1_SCALE = 10;
/** The cap on the index's size on disk, with its WAL and shared memory. */
export const INDEX_CAP = 300 * 1000 * 1000;

const STEP_MS = 10 * 60_000;
const FRAME_MS = 250;
const RAF_PROBES = 50;
const SCROLL_STEPS = 240;
const SETTLE_MS = 5000;
const IDLE_MS = 10_000;
/** A launch that takes longer than this is stopped. */
const LAUNCH_TIMEOUT_MS = 60 * 60_000;

const round = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const mib = (bytes) => round(bytes / 2 ** 20);

/** Whether the lid is closed, from `ioreg -r -k AppleClamshellState`; null if it doesn't say. */
export function parseClamshell(text) {
  const m = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(text);
  return m ? m[1] === 'Yes' : null;
}

/** Sleep and DarkWake entries of `pmset -g log` between two epoch times, inclusive. */
export function sleepsBetween(text, fromMs, toMs) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) (Sleep|DarkWake)\s/.exec(line);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    if (at >= fromMs && at <= toMs) out.push({ at, kind: m[5] });
  }
  return out;
}

/** Whether frames came promptly after DOM changes: p95 within one 60 Hz frame and none missing. */
export function rafVerdict(probes) {
  const list = probes.filter(Boolean);
  const samples = list.flatMap((p) => p.samples);
  const timeouts = list.reduce((n, p) => n + p.timeouts, 0);
  const p95 = round(percentile(samples, 95));
  return {
    samples: samples.length,
    timeouts,
    p50: round(percentile(samples, 50)),
    p95,
    max: round(samples.length ? Math.max(...samples) : null),
    thresholdMs: PROMPT_FRAME_MS,
    prompt: samples.length > 0 && timeouts === 0 && p95 !== null && p95 <= PROMPT_FRAME_MS,
  };
}

/**
 * Frames in a trace (Chrome's JSON trace format): frames the display drew,
 * and the frame reporter's outcomes, among them the dropped frames.
 */
export function frameStats(trace) {
  const events = Array.isArray(trace) ? trace : (trace?.traceEvents ?? []);
  let drawn = 0;
  let reported = 0;
  let presented = 0;
  let dropped = 0;
  let noUpdate = 0;
  for (const e of events) {
    if (e.name === 'Display::DrawAndSwap' && (e.ph === 'X' || e.ph === 'B')) drawn += 1;
    if (e.name === 'PipelineReporter' && (e.ph === 'b' || e.ph === 'X')) {
      reported += 1;
      const state = e.args?.chrome_frame_reporter?.state ?? '';
      if (state === 'STATE_DROPPED') dropped += 1;
      else if (state === 'STATE_NO_UPDATE_DESIRED') noUpdate += 1;
      else if (String(state).startsWith('STATE_PRESENTED')) presented += 1;
    }
  }
  return {
    events: events.length,
    drawn,
    reported,
    presented,
    dropped,
    noUpdate,
    produced: drawn > 0 || presented > 0,
  };
}

/** One launch's validity: why it can't count, if anything. */
export function launchProblems(launch) {
  const problems = [];
  const r = launch.result;
  if (!r) problems.push('no result');
  else {
    if (r.nonce !== launch.nonce) problems.push('result of another launch');
    if (r.ok !== true) problems.push(`failed: ${r.error ?? 'unknown'}`);
    if (!Array.isArray(r.windowEvents) || r.windowEvents.length > 0)
      problems.push('a window was shown or focused');
    if (r.window && (r.window.visible || r.window.focused))
      problems.push('the window was visible or focused');
    if (r.idle && r.idle.indexingDuring > 0) problems.push('indexing during the idle window');
    if (typeof r.indexingDuringOpens === 'number' && r.indexingDuringOpens > 0)
      problems.push('indexing during the opens');
  }
  const exit = launch.exit;
  if (!exit || exit.code !== 0 || exit.signal !== null || exit.timedOut)
    problems.push('the app did not exit cleanly');
  if (launch.lidClosedAfter !== false)
    problems.push('the lid was closed after the launch, or its state is unknown');
  if ((launch.sleeps ?? []).length > 0)
    problems.push('the Mac slept or dark-woke during the launch');
  return problems;
}

/** Peak and idle memory of a launch from its samples and the gate's phase log. */
export function memoryOf(samples, phases, idleWindow) {
  const phaseLog = (phases ?? []).map((p) => ({ phase: p.phase, at: p.atEpoch }));
  const byPhase = footprintByPhase(samples, phaseLog);
  const inIdle = idleWindow
    ? samples.filter((s) => s.at >= idleWindow.fromEpoch && s.at <= idleWindow.toEpoch)
    : [];
  const peakSamples = samples.filter((s) => {
    const name = phaseLog.filter((p) => p.at <= s.at).pop()?.phase;
    return name === 'phase1' || name === 'scroll-after';
  });
  const max = (list, key) => (list.length ? Math.max(...list.map((s) => s[key] ?? 0)) : null);
  return {
    samples: samples.length,
    peakByPhase: byPhase.peakByPhase,
    idleMiB: inIdle.length ? round(median(inIdle.map((s) => s.totalBytes)) / 2 ** 20) : null,
    idleRssMiB: inIdle.length ? round(median(inIdle.map((s) => s.rssBytes ?? 0)) / 2 ** 20) : null,
    idleSamples: inIdle.length,
    peakMiB: peakSamples.length ? mib(max(peakSamples, 'totalBytes')) : null,
    peakRssMiB: peakSamples.length ? mib(max(peakSamples, 'rssBytes')) : null,
  };
}

/** A fresh launch's numbers, on main's clock. */
export function freshNumbers(r) {
  const rows = r.firstRows ?? {};
  const fromPick = (at) =>
    at === null || at === undefined || r.pickedAt == null ? null : round(at - r.pickedAt);
  return {
    firstRowsCommitMs: fromPick(rows.commitAt),
    firstRowsFrameMs: fromPick(rows.rafAt),
    phase1Ms: fromPick(r.phase1DoneAt),
    phase1Total: r.phase1Total ?? null,
    indexedMs: fromPick(r.indexedAt),
  };
}

/**
 * A reopen's numbers: from main's ready to the first list rows; then, after
 * index.opened, reconcile (until the index is at phase 'done' again; the
 * apply time too when it changed pairs) and verification (the check's time).
 */
export function reopenNumbers(r) {
  const rows = r.firstRows ?? {};
  const fromReady = (at) =>
    at === null || at === undefined || r.readyAt == null ? null : round(at - r.readyAt);
  const verified = r.verified?.code === 'index.verified';
  return {
    rowsCommitMs: fromReady(rows.commitAt),
    rowsFrameMs: fromReady(rows.rafAt),
    rowsAfterOpened:
      rows.commitAt != null && r.openedAt != null ? rows.commitAt >= r.openedAt : null,
    openedMs: fromReady(r.openedAt),
    reconcileMs:
      r.reconcileDoneAt != null && r.openedAt != null
        ? round(r.reconcileDoneAt - r.openedAt)
        : null,
    reconcileApplyMs: r.reconciled?.data?.ms ?? null,
    verified,
    verifyMs: verified ? (r.verified?.data?.ms ?? null) : null,
  };
}

/** Phase 1's write transactions: p50, p95 and max time, and the rows regrouping re-pointed. */
export function batchNumbers(batches) {
  const list = Array.isArray(batches) ? batches : [];
  const ms = list.map((b) => b.ms);
  const sum = (k) => list.reduce((n, b) => n + (b[k] ?? 0), 0);
  return {
    batches: list.length,
    p50: round(percentile(ms, 50)),
    p95: round(percentile(ms, 95)),
    max: round(ms.length ? Math.max(...ms) : null),
    repointedMessages: sum('repointedMessages'),
    repointedKeys: sum('repointedKeys'),
    repointedLabelRows: sum('repointedLabelRows'),
    maxRepointed: list.reduce((n, b) => Math.max(n, b.maxRepointed ?? 0), 0),
    indexBytes: list.length ? list[list.length - 1].indexBytes : null,
  };
}

/** One opens launch: views, outcomes and percentiles of the timed expansions. */
export function opensNumbers(opens) {
  const list = Array.isArray(opens) ? opens : [];
  const ms = list.filter((o) => o.outcome === 'view' && typeof o.ms === 'number').map((o) => o.ms);
  return {
    opens: list.length,
    views: ms.length,
    timeouts: list.filter((o) => o.outcome === 'timeout').length,
    notHeld: list.filter((o) => o.outcome === 'not-held').length,
    notExpanded: list.filter((o) => o.outcome === 'not-expanded').length,
    p50: round(percentile(ms, 50)),
    p95: round(percentile(ms, 95)),
    max: round(ms.length ? Math.max(...ms) : null),
  };
}

/** The verdict of a row: within, MISS, or a proxy that needs a decision; null values make it INVALID. */
export function verdictOf(value, target, { proxy = false, valid = true } = {}) {
  if (!valid || value === null || value === undefined) return 'INVALID';
  if (proxy) return 'PROXY: needs a decision';
  return value <= target ? 'within' : 'MISS';
}

const medianOf = (values) => {
  const v = values.filter((x) => typeof x === 'number');
  return v.length === values.length && v.length > 0 ? round(median(v)) : null;
};

/** The scroll row: frames dropped in each traced scroll; not measurable when none were produced. */
export function scrollRow(name, scrolls) {
  const stats = scrolls.map((s) => s.frames ?? null);
  const all = stats.length > 0 && stats.every(Boolean);
  const produced = all && stats.every((s) => s.produced);
  const dropped = all ? stats.reduce((n, s) => n + s.dropped, 0) : null;
  return {
    row: 'Scroll',
    name,
    value: dropped,
    unit: 'dropped frames',
    target: 0,
    kind: 'measured',
    verdict: !all
      ? 'INVALID'
      : !produced
        ? 'not measurable hidden: needs a decision'
        : dropped === 0
          ? 'within'
          : 'MISS',
    scrolls: scrolls.map((s) => ({
      name: s.name,
      frames: s.frames,
      byFrame: s.run?.byFrame,
      byTimer: s.run?.byTimer,
    })),
  };
}

/** The indexing gate's rows from the launches' numbers. */
export function indexRows(report) {
  const frames = report.probe?.raf ?? { prompt: false };
  const proxy = !frames.prompt;
  const fresh = report.fresh.filter((l) => l.valid);
  const freshOk = fresh.length === report.fresh.length && fresh.length > 0;
  const reopen = report.reopen.filter((l) => l.valid);
  const reopenOk = reopen.length === report.reopen.length && reopen.length > 0;
  const firstRows = medianOf(
    fresh.map((l) => (proxy ? l.numbers.firstRowsCommitMs : l.numbers.firstRowsFrameMs)),
  );
  const phase1 = medianOf(fresh.map((l) => l.numbers.phase1Ms));
  const reopenMs = medianOf(
    reopen.map((l) => (proxy ? l.numbers.rowsCommitMs : l.numbers.rowsFrameMs)),
  );
  const idle = medianOf(fresh.map((l) => l.memory.idleMiB));
  const peak = medianOf(fresh.map((l) => l.memory.peakMiB));
  const endFrame = proxy
    ? 'the DOM change that drew the first list row (MutationObserver): a proxy, frames were not prompt hidden'
    : 'the animation frame after the first list row was drawn';
  return [
    {
      row: 'Cold: first rows visible',
      value: firstRows,
      unit: 'ms',
      target: TARGETS.firstRowsMs,
      kind: 'measured (warm runs)',
      start: "main's performance.now() when the pick reached the source manager",
      end: endFrame,
      verdict: verdictOf(firstRows, TARGETS.firstRowsMs, { proxy, valid: freshOk }),
    },
    {
      row: 'Cold: phase 1 complete (conversation grouping included)',
      value: phase1 === null ? null : round(phase1 * PHASE1_SCALE),
      measured: phase1,
      unit: 'ms',
      target: TARGETS.phase1At200kMs,
      kind: `extrapolated ×${PHASE1_SCALE} (linear, 20k → 200k) from warm runs`,
      start: "main's performance.now() when the pick reached the source manager",
      end: "the first index update with phase 'done', as main sent it",
      verdict: verdictOf(phase1 === null ? null : phase1 * PHASE1_SCALE, TARGETS.phase1At200kMs, {
        valid: freshOk,
      }),
    },
    {
      row: 'Warm reopen to a usable list',
      value: reopenMs,
      unit: 'ms',
      target: TARGETS.reopenMs,
      kind: 'measured',
      start: "main's ready: the gate mode's start, right after the app's ready",
      end: `${endFrame}, after index.opened`,
      verdict: verdictOf(reopenMs, TARGETS.reopenMs, {
        proxy,
        valid: reopenOk && reopen.every((l) => l.numbers.rowsAfterOpened === true),
      }),
      after: {
        verifyMs: medianOf(reopen.map((l) => l.numbers.verifyMs)),
        reconcileMs: medianOf(reopen.map((l) => l.numbers.reconcileMs)),
      },
    },
    scrollRow('All Mail list, during and after phase 1', [
      ...(report.probe?.scrolls ?? []).filter((s) => s.name.startsWith('list-')),
      ...fresh.flatMap((l) => l.scrolls ?? []),
    ]),
    {
      row: 'Memory, idle after indexing (all processes)',
      value: idle,
      rss: medianOf(fresh.map((l) => l.memory.idleRssMiB)),
      unit: 'MiB (summed physical footprint; RSS beside it)',
      target: TARGETS.idleMiB,
      kind: 'measured',
      start: `${SETTLE_MS / 1000} s after phase 1, phase 2 and reconcile have all ended`,
      end: `the median over the next ${IDLE_MS / 1000} s`,
      verdict: verdictOf(idle, TARGETS.idleMiB, { valid: freshOk }),
    },
    {
      row: 'Peak memory, phase 1 and scrolling (all processes)',
      value: peak,
      rss: medianOf(fresh.map((l) => l.memory.peakRssMiB)),
      unit: 'MiB (summed physical footprint; RSS beside it)',
      target: TARGETS.peakMiB,
      kind: 'measured',
      start: 'the pick',
      end: 'the end of the scroll after phase 1',
      verdict: verdictOf(peak, TARGETS.peakMiB, { valid: freshOk }),
    },
  ];
}

/** The cards gate's rows from the launches' numbers. */
export function cardsRows(report) {
  const opens = report.opens.filter((l) => l.valid);
  const ok = opens.length === report.opens.length && opens.length > 0;
  const p95 = medianOf(opens.map((l) => l.numbers.p95));
  const complete = opens.every(
    (l) => l.numbers.views === l.numbers.opens && l.warmup?.views === l.warmup?.requested,
  );
  return [
    scrollRow('the largest perf1 conversation', [
      ...(report.probe?.scrolls ?? []).filter((s) => s.name === 'conversation'),
      ...opens.flatMap((l) => l.scrolls ?? []),
    ]),
    {
      row: 'Open message p95 (≤ 1 MB), idle: per expansion',
      value: p95,
      p95s: report.opens.map((l) => l.numbers?.p95 ?? null),
      unit: 'ms (median of the launches’ p95s)',
      target: TARGETS.openP95Ms,
      kind: 'measured',
      start: "the shell's performance.now() just before the cards model's expand",
      end: "the new body frame's load event for that view",
      verdict: verdictOf(p95, TARGETS.openP95Ms, { valid: ok && complete }),
      pacer:
        "Opens pass main's open pacer (at least 60 ms between a window's opens). With IPC jitter it can hold an open about 1 ms; that time counts, as it is the production path.",
    },
  ];
}

/** Summary lines of a test log: test counts, and the conversation reader specs. */
export function testLogSummary(text) {
  const lines = text.split('\n');
  return {
    counts: lines
      .filter((l) => /\b(Tests|Test Files)\s+\d+|\d+ (passed|failed|flaky|skipped)\b/.test(l))
      .map((l) => l.trim())
      .slice(0, 20),
    conversation: lines
      .filter((l) => l.includes('conversation.spec.ts'))
      .map((l) => l.trim())
      .slice(0, 100),
  };
}

const cell = (v) => (v === null || v === undefined ? 'n/a' : String(v));

export function markdown(report) {
  const title = report.gate === 'index' ? 'Indexing gate' : 'Cards gate';
  const lines = [`# ${title}`, ''];
  const raf = report.probe?.raf;
  if (raf) {
    lines.push(
      `**Frames in the hidden window:** after a DOM change, the next animation frame came at p50 ${cell(raf.p50)} ms, p95 ${cell(raf.p95)} ms, max ${cell(raf.max)} ms (${raf.samples} changes, ${raf.timeouts} without a frame). ` +
        `Prompt means p95 ≤ ${raf.thresholdMs} ms (one 60 Hz frame) and none missing: **${raf.prompt ? 'prompt' : 'NOT prompt'}**.` +
        (raf.prompt
          ? ''
          : ' Rows that end on a frame end on the DOM change instead and are marked as a proxy that needs a decision.'),
      '',
    );
  }
  lines.push('| Row | Value | Target | Kind | Verdict |', '|---|---|---|---|---|');
  for (const r of report.rows) {
    lines.push(
      `| ${r.row}${r.name ? ` (${r.name})` : ''} | ${cell(r.value)} ${r.unit} | ${r.target} | ${r.kind} | ${r.verdict} |`,
    );
  }
  lines.push('', '## Start and end events', '');
  for (const r of report.rows)
    if (r.start) lines.push(`- **${r.row}:** from ${r.start}, to ${r.end}.`);
  for (const r of report.rows)
    if (r.after)
      lines.push(
        `- After the reopen, timed separately (medians): reconcile ${cell(r.after.reconcileMs)} ms, from index.opened to the index's next phase 'done'; verification ${cell(r.after.verifyMs)} ms, the quick check's own time (index.verified).`,
      );
  for (const r of report.rows) if (r.pacer) lines.push(`- ${r.pacer}`);
  if (report.stress) {
    const s = report.stress;
    lines.push(
      '',
      '## Stress corpus',
      '',
      `Phase 1 ${cell(s.phase1Ms)} ms (median); write batches p50 ${cell(s.batches.p50)} ms, p95 ${cell(s.batches.p95)} ms, max ${cell(s.batches.max)} ms; ` +
        `re-pointed: ${s.batches.repointedMessages} messages, ${s.batches.repointedKeys} keys, ${s.batches.repointedLabelRows} label rows (most in one merge ${s.batches.maxRepointed}).`,
    );
  }
  lines.push('', '## Inputs', '');
  const i = report.inputs;
  lines.push(
    `- Checkout: ${i.checkout.head} (${i.checkout.clean ? 'clean' : 'CHANGED'}).`,
    `- Build: ${i.build.app}; executable SHA-256 ${i.build.executableSha256}, app.asar SHA-256 ${i.build.asarSha256}.`,
    `- App: Electron ${cell(i.versions?.electron)}, Chrome ${cell(i.versions?.chrome)}, Node ${cell(i.versions?.node)}.`,
    `- Machine: ${i.machine.model}, ${i.machine.cpu}, ${i.machine.cores} cores, ${Math.round(i.machine.memoryBytes / 2 ** 30)} GiB, macOS ${i.machine.macos}.`,
    `- The gate window runs without background throttling; a production window throttles when hidden.`,
    `- Index cap ${INDEX_CAP} B; held: ${report.capHeld ? 'yes' : 'NO'}. Index folder peak ${cell(report.indexPeakMiB)} MiB.`,
    `- Runs: ${i.runs} per measurement, one launch at a time; seed ${i.seed}.`,
  );
  for (const c of i.corpora) {
    lines.push(
      `- Corpus ${c.name}: before ${c.before.matches ? 'matches' : 'DIFFERS FROM'} its manifest; after ${c.after?.matches ? 'matches' : 'DIFFERS FROM'} it (digest ${cell(c.after?.digest)}).`,
    );
  }
  lines.push(
    `- Frontmost app, sampled once a second: ${Object.entries(report.frontmost)
      .map(([n, k]) => `${n} ${k}`)
      .join(', ')}.`,
  );
  if (report.sampleListSha256)
    lines.push(`- Expansion sample list SHA-256 ${report.sampleListSha256}.`);
  lines.push('', '## Launches', '', '| Launch | Mode | Valid | Problems |', '|---|---|---|---|');
  for (const l of report.launches)
    lines.push(`| ${l.name} | ${l.mode} | ${l.valid} | ${l.problems.join('; ') || '-'} |`);
  return lines.join('\n') + '\n';
}

/** The launches a gate makes, in order. */
export function planOf(gate, runs) {
  const plan = [{ name: 'probe', mode: 'probe', corpus: 'perf', profile: 'probe' }];
  if (gate === 'index') {
    for (let i = 1; i <= runs; i++) {
      plan.push({ name: `fresh-${i}`, mode: 'fresh', corpus: 'perf', profile: `perf-${i}` });
      plan.push({ name: `reopen-${i}`, mode: 'reopen', corpus: 'perf', profile: `perf-${i}` });
    }
    for (let i = 1; i <= runs; i++)
      plan.push({ name: `stress-${i}`, mode: 'fresh', corpus: 'stress', profile: `stress-${i}` });
  } else {
    for (let i = 1; i <= runs; i++)
      plan.push({ name: `opens-${i}`, mode: 'opens', corpus: 'perf', profile: `opens-${i}` });
  }
  return plan;
}

function read(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 512 * 2 ** 20,
      ...options,
    }).trim();
  } catch {
    return null;
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function machine() {
  return {
    model: read('sysctl', ['-n', 'hw.model']),
    cpu: cpus()[0]?.model ?? null,
    cores: cpus().length,
    memoryBytes: totalmem(),
    macos: read('sw_vers', ['-productVersion']),
  };
}

const lidClosed = () =>
  parseClamshell(read('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4']) ?? '');

/** Resident sizes of these processes, summed, in bytes. */
function rssOf(pids) {
  const out = read('ps', ['-o', 'rss=', '-p', pids.join(',')]);
  return out ? out.split('\n').reduce((n, l) => n + (Number(l.trim()) || 0) * 1024, 0) : null;
}

function corpusOf(name, folder) {
  const root = realpathSync(resolve(folder));
  const manifestPath = `${root}.manifest.json`;
  if (!existsSync(manifestPath)) throw new Error(`no manifest beside ${root}`);
  return { name, root, manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) };
}

async function launch(step, ctx) {
  const nonce = randomBytes(8).toString('hex');
  const workspace = join(ctx.out, step.name);
  createWorkspace(workspace, nonce, []);
  const config = join(workspace, 'config.json');
  checkNewFile(workspace, nonce, config);
  const corpus = ctx.corpora[step.corpus];
  writeFileSync(
    config,
    JSON.stringify({
      nonce,
      workspace,
      mode: step.mode,
      root: corpus.root,
      capBytes: INDEX_CAP,
      stepMs: STEP_MS,
      frameMs: FRAME_MS,
      rafProbes: RAF_PROBES,
      scrollSteps: SCROLL_STEPS,
      settleMs: SETTLE_MS,
      idleMs: IDLE_MS,
      trace: step.mode !== 'reopen',
      sample:
        step.mode === 'opens'
          ? { seed: ctx.seed, count: ctx.count, maxBytes: ctx.maxBytes, warmup: ctx.warmup }
          : null,
    }) + '\n',
    { flag: 'wx' },
  );
  const userData = join(ctx.out, 'user-data', step.profile);
  const indexDir = join(userData, 'index');
  console.log(`gate: ${step.name}`);
  const started = Date.now();
  const samples = [];
  let indexPeak = 0;
  const exit = await new Promise((done) => {
    const child = spawn(ctx.executable, [`--pev-gate=${config}`, `--pev-user-data=${userData}`], {
      stdio: 'ignore',
    });
    let timedOut = false;
    const sampler = setInterval(() => {
      const s = footprintOf(child.pid);
      if (s) samples.push({ ...s, rssBytes: rssOf(s.procs.map((p) => p.pid)) });
      try {
        if (existsSync(indexDir)) indexPeak = Math.max(indexPeak, treeBytes(indexDir));
      } catch {
        // The index folder changes while it's counted; the next sample counts it again.
      }
    }, 1000);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, LAUNCH_TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearInterval(sampler);
      clearTimeout(timer);
      done({ code, signal, timedOut });
    });
  });
  const ended = Date.now();
  const lidClosedAfter = lidClosed();
  const sleeps = sleepsBetween(read('pmset', ['-g', 'log']) ?? '', started, ended);
  const resultFile = join(workspace, `gate-result-${nonce}.json`);
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
  const record = {
    ...step,
    nonce,
    started,
    ended,
    exit,
    lidClosedAfter,
    sleeps,
    result,
    indexPeakBytes: indexPeak,
  };
  record.problems = launchProblems(record);
  record.valid = record.problems.length === 0;
  record.memory = result ? memoryOf(samples, result.phases, result.idle) : null;
  record.scrolls = (result?.scrolls ?? []).map((s) => ({
    ...s,
    frames:
      s.trace && existsSync(s.trace) ? frameStats(JSON.parse(readFileSync(s.trace, 'utf8'))) : null,
  }));
  return record;
}

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      gate: { type: 'string' },
      out: { type: 'string' },
      perf: { type: 'string' },
      stress: { type: 'string' },
      'scan-data': { type: 'string', multiple: true },
      runs: { type: 'string', default: '4' },
      seed: { type: 'string', default: '1' },
      count: { type: 'string', default: '1000' },
      'max-bytes': { type: 'string', default: '1048576' },
      warmup: { type: 'string', default: '20' },
      'ci-log': { type: 'string' },
      'linux-log': { type: 'string' },
      app: { type: 'string' },
      dry: { type: 'boolean', default: false },
    },
  });
  if (values.gate !== 'index' && values.gate !== 'cards') throw new Error('--gate index|cards');
  if (!values.out || !values.perf) throw new Error('--out and --perf are required');
  if (values.gate === 'index' && !values.stress) throw new Error('--stress is required for index');
  if (!values['scan-data']?.length)
    throw new Error('--scan-data is required: the folders where generated test data lives');
  const int = (name, min) => {
    const n = Number(values[name]);
    if (!Number.isSafeInteger(n) || n < min)
      throw new Error(`--${name} must be a whole number of at least ${min}`);
    return n;
  };
  return {
    gate: values.gate,
    out: resolve(values.out),
    perf: values.perf,
    stress: values.stress ?? null,
    scanData: values['scan-data'],
    runs: int('runs', 1),
    seed: int('seed', 0),
    count: int('count', 1),
    maxBytes: int('max-bytes', 1),
    warmup: int('warmup', 0),
    ciLog: values['ci-log'] ?? null,
    linuxLog: values['linux-log'] ?? null,
    app: resolve(values.app ?? appPath('test')),
    dry: values.dry,
  };
}

async function main() {
  const args = parse(process.argv.slice(2));
  const corpora = { perf: corpusOf('perf', args.perf) };
  if (args.stress) corpora.stress = corpusOf('stress', args.stress);
  if (!isAbsolute(args.out) || existsSync(args.out))
    throw new Error(`${args.out} must be a new folder`);
  // The corpora are only read: an output folder in one is refused before anything is written.
  for (const c of Object.values(corpora)) checkOutside(c.root, args.out);
  const executable = join(args.app, 'Contents', 'MacOS', PRODUCT_NAME);
  const asar = join(args.app, 'Contents', 'Resources', 'app.asar');
  if (!existsSync(executable) || !existsSync(asar))
    throw new Error(`no packaged build at ${args.app}`);
  const closed = lidClosed();
  if (closed !== false)
    throw new Error(closed === null ? "can't read the lid's state" : 'the lid is closed');
  const status = read('git', ['-C', REPO_ROOT, 'status', '--porcelain']);
  if (status === null || status !== '')
    throw new Error('the checkout has changes (or git failed): commit or remove them first');
  const head = read('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']);
  const disk = freeSpace(dirname(args.out));
  const containersRoot = join(homedir(), 'Library', 'Containers');
  const containers = existsSync(containersRoot)
    ? readdirSync(containersRoot)
        .filter((name) => name === APP_ID || name.startsWith(`${APP_ID}.`))
        .map((name) =>
          join(containersRoot, name, 'Data', 'Library', 'Application Support', PRODUCT_NAME),
        )
    : [];
  const budget = budgetCheck(findTestData(args.scanData, { containers }), INDEX_CAP);
  const before = {};
  for (const [k, c] of Object.entries(corpora)) {
    before[k] = corpusState(c.root, c.manifest);
    if (!before[k].matches)
      throw new Error(`corpus ${k} differs from its manifest: ${before[k].differs}`);
  }
  const plan = planOf(args.gate, args.runs);
  if (args.dry) {
    console.log(
      JSON.stringify(
        { gate: args.gate, head, app: args.app, disk, budget: budget.withRun, plan },
        null,
        2,
      ),
    );
    return;
  }
  // Warm: every corpus file is read once, so the launches find them in the OS file cache.
  for (const c of Object.values(corpora)) {
    for (const e of walk(c.root)) if (e.type === 'file') readFileSync(e.full);
  }
  const nonce = randomBytes(8).toString('hex');
  createWorkspace(args.out, nonce, ['user-data']);
  const seen = new Map();
  const note = () => {
    const name = frontmost();
    seen.set(name, (seen.get(name) ?? 0) + 1);
  };
  note();
  const sampler = setInterval(note, 1000);
  const ctx = { ...args, corpora, executable };
  const launches = [];
  try {
    for (const step of plan) {
      launches.push(await launch(step, ctx));
      // A profile is kept only for the reopen that follows its fresh launch.
      const next = plan[plan.indexOf(step) + 1];
      if (!next || next.profile !== step.profile)
        removeInside(args.out, nonce, join(args.out, 'user-data', step.profile));
    }
  } finally {
    clearInterval(sampler);
    note();
  }
  const after = {};
  for (const [k, c] of Object.entries(corpora)) after[k] = corpusState(c.root, c.manifest);
  const first = launches.find((l) => l.result?.app)?.result;
  const probe = launches.find((l) => l.mode === 'probe');
  const byName = (prefix) =>
    launches
      .filter((l) => l.name.startsWith(prefix))
      .map((l) => ({
        name: l.name,
        valid: l.valid,
        problems: l.problems,
        memory: l.memory,
        scrolls: l.scrolls,
        warmup: l.result?.warmup ?? null,
        numbers:
          l.mode === 'reopen'
            ? reopenNumbers(l.result ?? {})
            : l.mode === 'opens'
              ? opensNumbers(l.result?.opens)
              : freshNumbers(l.result ?? {}),
        batches: l.mode === 'fresh' ? batchNumbers(l.result?.batches) : null,
      }));
  const report = {
    gate: args.gate,
    nonce,
    probe: probe
      ? {
          valid: probe.valid,
          problems: probe.problems,
          raf: rafVerdict([probe.result?.rafBefore, probe.result?.rafAfter]),
          scrolls: probe.scrolls,
          conversation: probe.result?.conversation ?? null,
        }
      : null,
    fresh: byName('fresh-'),
    reopen: byName('reopen-'),
    opens: byName('opens-'),
    stress: null,
    inputs: {
      checkout: { head, clean: true },
      build: { app: args.app, executableSha256: sha256(executable), asarSha256: sha256(asar) },
      versions: first?.app ?? null,
      machine: machine(),
      runs: args.runs,
      seed: args.seed,
      disk,
      budget,
      corpora: Object.entries(corpora).map(([k, c]) => ({
        name: k,
        root: c.root,
        manifest: c.manifestPath,
        before: before[k],
        after: after[k],
      })),
      gateWindow: { backgroundThrottling: false },
    },
    frontmost: Object.fromEntries(seen),
    indexPeakMiB: mib(Math.max(0, ...launches.map((l) => l.indexPeakBytes))),
    capHeld: launches.every((l) => l.indexPeakBytes <= INDEX_CAP),
    launches: launches.map((l) => ({
      name: l.name,
      mode: l.mode,
      valid: l.valid,
      problems: l.problems,
      started: l.started,
      ended: l.ended,
      exit: l.exit,
      sleeps: l.sleeps,
    })),
    rows: [],
  };
  const stress = byName('stress-');
  if (args.gate === 'index') {
    const valid = stress.filter((l) => l.valid);
    report.stress = {
      launches: stress.length,
      valid: valid.length,
      phase1Ms: medianOf(valid.map((l) => l.numbers.phase1Ms)),
      batches: valid[0]?.batches ?? batchNumbers([]),
      perLaunch: stress.map((l) => ({
        name: l.name,
        phase1Ms: l.numbers.phase1Ms,
        batches: l.batches,
      })),
    };
    report.rows = indexRows(report);
  } else {
    const samples = launches
      .filter((l) => l.mode === 'opens')
      .map((l) => (l.result?.sample ?? []).map((s) => s.rel).join('\n') + '\n');
    report.sampleListSha256 = samples.length
      ? createHash('sha256').update(samples[0]).digest('hex')
      : null;
    report.sampleSame = samples.every((s) => s === samples[0]);
    report.tests = {
      ci: args.ciLog
        ? {
            file: args.ciLog,
            sha256: sha256(args.ciLog),
            ...testLogSummary(readFileSync(args.ciLog, 'utf8')),
          }
        : null,
      linux: args.linuxLog
        ? {
            file: args.linuxLog,
            sha256: sha256(args.linuxLog),
            ...testLogSummary(readFileSync(args.linuxLog, 'utf8')),
          }
        : null,
    };
    report.rows = cardsRows(report);
  }
  const jsonPath = join(args.out, `${args.gate}-gate-${nonce}.json`);
  const mdPath = join(args.out, `${args.gate}-gate-${nonce}.md`);
  checkNewFile(args.out, nonce, jsonPath);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  checkNewFile(args.out, nonce, mdPath);
  writeFileSync(mdPath, markdown(report), { flag: 'wx' });
  console.log(`gate: wrote ${jsonPath} and ${mdPath}`);
  const corpusChanged = Object.values(after).some((a) => !a.matches);
  if (corpusChanged) {
    console.error('gate: a corpus changed during the run');
    process.exit(1);
  }
  if (launches.some((l) => !l.valid)) {
    console.error('gate: at least one launch is invalid; see the report');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`gate: ${err.message}`);
    process.exit(1);
  });
}
