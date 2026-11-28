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
// changes, the frame cadence, and scrolls. When animation frames aren't prompt
// there, the first-rows and reopen times end at the DOM change instead, and the
// report marks them as a proxy that needs a decision: a proxy never passes a row.
//
// Scrolls are measured by the cadence of the shell's animation frames, a proxy
// for dropped frames that sees only what the renderer itself missed. A launch
// that scrolls records the cadence with nothing else going on, before the pick
// (its frame interval F serves every scroll of the launch) and once indexing
// has ended (a check). A scroll row never passes on its own.
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
/**
 * A cadence counts as unthrottled when its median frame interval is at most
 * this (about 54 Hz), or within DISPLAY_SHARE of the display's own interval.
 */
export const MAX_FRAME_MS = 18.4;
export const DISPLAY_SHARE = 0.1;
/** An interval longer than this many frame intervals holds missed frames. */
export const LONG_INTERVAL = 1.5;
/** The check after indexing must differ from the baseline by less than this share. */
export const CHECK_SHARE = 0.1;
/**
 * Each timed expansion starts at least this long after the shown message's
 * body loaded: the gap main's open pacer keeps between a window's opens.
 */
export const OPEN_GAP_MS = 60;
/** Phase 1 at 20,000 messages, extrapolated linearly to 200,000. */
export const PHASE1_SCALE = 10;
/** The cap on the index's size on disk, with its WAL and shared memory. */
export const INDEX_CAP = 300 * 1000 * 1000;

const STEP_MS = 10 * 60_000;
const FRAME_MS = 250;
const RAF_PROBES = 50;
const CADENCE_FRAMES = 120;
const SCROLL_STEPS = 240;
const SCROLL_WAIT_MS = 2000;
const GRACE_MS = 100;
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

/**
 * Whether frames came promptly after DOM changes: p95 within LONG_INTERVAL
 * frame intervals of the launch's cadence (`frameMs`), and none missing.
 * Without a trusted cadence nothing is prompt.
 */
export function rafVerdict(probes, frameMs) {
  const list = probes.filter(Boolean);
  const samples = list.flatMap((p) => p.samples);
  const timeouts = list.reduce((n, p) => n + p.timeouts, 0);
  const p95 = percentile(samples, 95);
  const threshold = typeof frameMs === 'number' ? LONG_INTERVAL * frameMs : null;
  return {
    samples: samples.length,
    timeouts,
    p50: round(percentile(samples, 50)),
    p95: round(p95),
    max: round(samples.length ? Math.max(...samples) : null),
    thresholdMs: round(threshold),
    prompt:
      samples.length > 0 &&
      timeouts === 0 &&
      threshold !== null &&
      p95 !== null &&
      p95 <= threshold,
  };
}

/** The intervals between consecutive timestamps. */
export function intervalsOf(stamps) {
  const out = [];
  for (let i = 1; i < stamps.length; i += 1) out.push(stamps[i] - stamps[i - 1]);
  return out;
}

/**
 * One record of the frame cadence with nothing else going on: its median
 * frame interval F, and whether frames came unthrottled. They did if none
 * timed out, F is at most MAX_FRAME_MS or within DISPLAY_SHARE of the
 * display's own interval, and the p95 interval is at most LONG_INTERVAL × F.
 */
export function cadenceOf(run, displayHz) {
  const stamps = Array.isArray(run?.stamps) ? run.stamps : [];
  const intervals = intervalsOf(stamps);
  const frameMs = median(intervals);
  const p95 = percentile(intervals, 95);
  const displayMs = typeof displayHz === 'number' && displayHz > 0 ? 1000 / displayHz : null;
  const timeouts = run?.timeouts ?? 0;
  const reasons = [];
  if (!run) reasons.push('no record of the frame cadence');
  if (timeouts > 0) reasons.push(`no frame within ${run.timeoutMs} ms, ${timeouts} times`);
  if (frameMs === null) reasons.push('fewer than two frames');
  else {
    const rate =
      frameMs <= MAX_FRAME_MS ||
      (displayMs !== null && Math.abs(frameMs - displayMs) <= DISPLAY_SHARE * displayMs);
    if (!rate)
      reasons.push(
        `a frame every ${round(frameMs)} ms (${round(1000 / frameMs)} Hz), slower than ${MAX_FRAME_MS} ms` +
          (displayMs === null ? '' : ` and not the display's ${round(displayMs)} ms`),
      );
    if (p95 > LONG_INTERVAL * frameMs)
      reasons.push(`gaps: p95 ${round(p95)} ms is over ${LONG_INTERVAL} × ${round(frameMs)} ms`);
  }
  return {
    frames: stamps.length,
    timeouts,
    frameMs,
    hz: frameMs ? round(1000 / frameMs) : null,
    p95: round(p95),
    max: round(intervals.length ? Math.max(...intervals) : null),
    displayHz: typeof displayHz === 'number' ? displayHz : null,
    trusted: reasons.length === 0,
    reasons,
  };
}

/**
 * A launch's cadence: F comes from the baseline before the pick, always; the
 * check once indexing has ended must be trusted too and differ from the
 * baseline by less than CHECK_SHARE, or the launch's scrolls can't count.
 */
export function launchCadence(cadences, displayHz) {
  const list = Array.isArray(cadences) ? cadences : [];
  const baseline = cadenceOf(list.find((c) => c.name === 'baseline') ?? null, displayHz);
  const check = cadenceOf(list.find((c) => c.name === 'check') ?? null, displayHz);
  const reasons = [
    ...baseline.reasons.map((r) => `before the pick: ${r}`),
    ...check.reasons.map((r) => `after indexing: ${r}`),
  ];
  if (
    baseline.trusted &&
    check.trusted &&
    !(Math.abs(check.frameMs - baseline.frameMs) < CHECK_SHARE * baseline.frameMs)
  ) {
    reasons.push(
      `the frame rate changed during the launch: a frame every ${round(baseline.frameMs)} ms before the pick, ${round(check.frameMs)} ms after indexing`,
    );
  }
  return {
    frameMs: baseline.frameMs,
    hz: baseline.hz,
    displayHz: baseline.displayHz,
    baseline,
    check,
    trusted: reasons.length === 0,
    reasons,
  };
}

/** Missed frames in these intervals: each one over LONG_INTERVAL × F holds round(Δ / F) − 1, at least 1. */
export function missedIn(intervals, frameMs) {
  let long = 0;
  let missed = 0;
  for (const d of intervals) {
    if (d > LONG_INTERVAL * frameMs) {
      long += 1;
      missed += Math.max(1, Math.round(d / frameMs) - 1);
    }
  }
  return { intervals: intervals.length, long, missed };
}

/**
 * One scroll's frames against its launch's cadence. With `phase1DoneAt`
 * (main's clock), only intervals whose ending frame came before it count;
 * the rest are given beside them. With none before it, the measurement is
 * unavailable. A scroll that stopped, or a launch whose cadence isn't
 * trusted, gives no number.
 */
export function scrollFrames(scroll, cadence, phase1DoneAt = null) {
  const stamps = Array.isArray(scroll?.stamps) ? scroll.stamps : [];
  const pairs = intervalsOf(stamps).map((d, i) => ({ d, end: stamps[i + 1] }));
  const reasons = [];
  if (!scroll) reasons.push('no scroll');
  if (!cadence?.trusted) reasons.push(...(cadence?.reasons ?? ['no frame cadence']));
  if (scroll?.stopped) reasons.push(`no frame within ${round(scroll.waitMs / 1000)} s`);
  const trusted = reasons.length === 0;
  const phased = phase1DoneAt !== null;
  const counted = phased ? pairs.filter((p) => p.end < phase1DoneAt) : pairs;
  const past = phased ? pairs.filter((p) => p.end >= phase1DoneAt) : [];
  const available = counted.length > 0;
  const frameMs = cadence?.frameMs ?? null;
  const ds = counted.map((p) => p.d);
  return {
    name: scroll?.name ?? null,
    steps: scroll?.steps ?? null,
    made: stamps.length,
    frameMs: round(frameMs),
    hz: cadence?.hz ?? null,
    trusted,
    reasons,
    available,
    unavailable: available ? null : phased ? 'phase 1 ended before the scroll' : 'no intervals',
    ...(trusted && available
      ? missedIn(ds, frameMs)
      : { intervals: counted.length, long: null, missed: null }),
    p50: round(percentile(ds, 50)),
    p95: round(percentile(ds, 95)),
    max: round(ds.length ? Math.max(...ds) : null),
    pastPhase1: phased
      ? {
          intervals: past.length,
          missed:
            trusted && past.length
              ? missedIn(
                  past.map((p) => p.d),
                  frameMs,
                ).missed
              : null,
          ranPastMs: stamps.length
            ? round(Math.max(0, stamps[stamps.length - 1] - phase1DoneAt))
            : null,
        }
      : null,
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
    const early = (Array.isArray(r.opens) ? r.opens : []).filter(
      (o) => typeof o.gapMs === 'number' && o.gapMs < OPEN_GAP_MS,
    );
    if (early.length > 0)
      problems.push(
        `${early.length} expansions started less than ${OPEN_GAP_MS} ms after the shown body loaded (smallest ${round(Math.min(...early.map((o) => o.gapMs)))} ms), so main's open pacer may have held them`,
      );
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

/** The stress launches' write batches: the median over the launches of each number. */
export function stressBatches(launches) {
  const of = (k) => {
    const v = launches.map((l) => l.batches?.[k]);
    return v.length > 0 && v.every((x) => typeof x === 'number') ? round(median(v)) : null;
  };
  return {
    launches: launches.length,
    p50: of('p50'),
    p95: of('p95'),
    max: of('max'),
    repointedMessages: of('repointedMessages'),
    repointedKeys: of('repointedKeys'),
    repointedLabelRows: of('repointedLabelRows'),
    maxRepointed: of('maxRepointed'),
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

/**
 * A scroll row, from each launch's scroll frames (`scrollFrames`). Missed
 * frames in a trusted scroll make it a MISS; otherwise a scroll that can't be
 * trusted makes it not measurable, one without intervals unavailable, and
 * none missed is still not a pass: the proxy can't see compositor frames.
 */
export function scrollRow(name, frames) {
  const counted = frames.filter((f) => f.trusted && f.available);
  const missed = counted.reduce((n, f) => n + f.missed, 0);
  const verdict =
    frames.length === 0
      ? 'INVALID'
      : missed > 0
        ? 'MISS (proxy)'
        : frames.some((f) => !f.trusted)
          ? 'not measurable hidden'
          : frames.some((f) => !f.available)
            ? 'unavailable'
            : 'proxy: no missed frames seen, not a pass on its own';
  const reasons = [
    ...new Set(frames.flatMap((f) => [...f.reasons, ...(f.unavailable ? [f.unavailable] : [])])),
  ];
  return {
    row: 'Scroll (renderer rAF-interval proxy)',
    name,
    value: counted.length === frames.length && frames.length > 0 ? missed : null,
    unit: `missed frames (frame intervals over ${LONG_INTERVAL} × the launch's frame interval)`,
    target: 0,
    kind: "measured: the cadence of the shell's animation frames, not compositor frames",
    verdict,
    reasons,
    scrolls: frames,
  };
}

/** The probe's scrolls and these launches' scrolls with this name. */
const scrollsNamed = (report, launches, name) =>
  [...(report.probe?.scrolls ?? []), ...launches.flatMap((l) => l.scrolls ?? [])].filter(
    (s) => s.name === name,
  );

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
      start:
        "main's ready: the gate mode's start, right after the app's ready. An upper bound: the gate restores the export after the shell has loaded, while production restores it right after creating the window, alongside the load",
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
    scrollRow('All Mail list, during phase 1', scrollsNamed(report, fresh, 'list-phase1')),
    scrollRow('All Mail list, after phase 1', scrollsNamed(report, fresh, 'list-after')),
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

const cell = (v) => (v === null || v === undefined ? 'n/a' : String(v));

/** The smallest gap before a timed expansion, over these launches. */
function minGap(launches) {
  const gaps = launches.flatMap((l) => l.gaps ?? []);
  return gaps.length ? round(Math.min(...gaps)) : null;
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
    scrollRow('the largest perf1 conversation', scrollsNamed(report, opens, 'conversation')),
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
      pacer: `Each expansion started at least ${OPEN_GAP_MS} ms after the shown message's body loaded, so main's open pacer (at least ${OPEN_GAP_MS} ms between a window's opens) never held it; a shorter gap makes the launch invalid. Smallest gap: ${cell(minGap(report.opens))} ms.`,
      sample: `Messages of at most ${report.sampleRule?.maxBytes ?? 'n/a'} B in conversations of two or more, never a conversation's newest: it opens expanded with its conversation, so it has no expansion to time. Picked with seed ${report.sampleRule?.seed ?? 'n/a'} from all such message files in name order.`,
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

export function markdown(report) {
  const title = report.gate === 'index' ? 'Indexing gate' : 'Cards gate';
  const lines = [`# ${title}`, ''];
  const cadence = report.probe?.cadence;
  if (cadence) {
    const c = (x) =>
      `a frame every ${cell(round(x.frameMs))} ms (${cell(x.hz)} Hz), p95 ${cell(x.p95)} ms, ${x.timeouts} timeouts`;
    lines.push(
      `**Frame cadence in the hidden window (probe):** before the pick ${c(cadence.baseline)}; after indexing ${c(cadence.check)}. ` +
        `The display reports ${cell(cadence.displayHz)} Hz. ` +
        (cadence.trusted
          ? 'Trusted: frames came unthrottled.'
          : `**Not trusted:** ${cadence.reasons.join('; ')}.`),
      '',
    );
  }
  const raf = report.probe?.raf;
  if (raf) {
    lines.push(
      `**Frames in the hidden window:** after a DOM change, the next animation frame came at p50 ${cell(raf.p50)} ms, p95 ${cell(raf.p95)} ms, max ${cell(raf.max)} ms (${raf.samples} changes, ${raf.timeouts} without a frame). ` +
        `Prompt means p95 ≤ ${cell(raf.thresholdMs)} ms (${LONG_INTERVAL} frame intervals of the probe's cadence) and none missing: **${raf.prompt ? 'prompt' : 'NOT prompt'}**.` +
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
  for (const r of report.rows) if (r.sample) lines.push(`- Sample: ${r.sample}`);
  const scrollRows = report.rows.filter((r) => r.scrolls);
  if (scrollRows.length) {
    lines.push(
      '',
      '## Scrolls',
      '',
      "A proxy: the intervals between the shell's animation frames while it scrolls one step per frame, against the launch's frame interval F from its cadence before the pick. " +
        `An interval over ${LONG_INTERVAL} × F holds round(interval / F) − 1 missed frames. A frame the compositor or display drops after the renderer made it isn't seen, so no missed frames is not a pass on its own.`,
      '',
    );
    for (const r of scrollRows) {
      lines.push(
        `- **${r.name}:** ${r.verdict}.${r.reasons.length ? ` ${r.reasons.join('; ')}.` : ''}`,
      );
      for (const f of r.scrolls) {
        const past = f.pastPhase1
          ? `; after phase 1: ${f.pastPhase1.intervals} intervals, ${cell(f.pastPhase1.missed)} missed, ${cell(f.pastPhase1.ranPastMs)} ms past its end`
          : '';
        lines.push(
          `  - ${f.made} of ${cell(f.steps)} steps, F ${cell(f.frameMs)} ms (${cell(f.hz)} Hz): ${f.intervals} intervals, p50 ${cell(f.p50)} ms, p95 ${cell(f.p95)} ms, max ${cell(f.max)} ms, ${cell(f.long)} long, ${cell(f.missed)} missed${past}.`,
        );
      }
    }
  }
  if (report.stress) {
    const s = report.stress;
    lines.push(
      '',
      '## Stress corpus',
      '',
      `Phase 1 ${cell(s.phase1Ms)} ms (median); write batches, each the median over ${s.valid} valid launches of that launch's number: p50 ${cell(s.batches.p50)} ms, p95 ${cell(s.batches.p95)} ms, max ${cell(s.batches.max)} ms; ` +
        `re-pointed: ${cell(s.batches.repointedMessages)} messages, ${cell(s.batches.repointedKeys)} keys, ${cell(s.batches.repointedLabelRows)} label rows (most in one merge ${cell(s.batches.maxRepointed)}).`,
    );
  }
  lines.push('', '## Inputs', '');
  const i = report.inputs;
  lines.push(
    `- Checkout: ${i.checkout.head} (${i.checkout.clean ? 'clean' : 'CHANGED'}).`,
    `- Build: ${i.build.app}; executable SHA-256 ${i.build.executableSha256}, app.asar SHA-256 ${i.build.asarSha256}.`,
    `- App: Electron ${cell(i.versions?.electron)}, Chrome ${cell(i.versions?.chrome)}, Node ${cell(i.versions?.node)}.`,
    `- Machine: ${i.machine.model}, ${i.machine.cpu}, ${i.machine.cores} cores, ${Math.round(i.machine.memoryBytes / 2 ** 30)} GiB, macOS ${i.machine.macos}.`,
    `- The gate window runs without background throttling, set when it is created so it draws frames while hidden; a production window throttles when hidden.`,
    `- Display: ${cell(i.display?.frequency)} Hz reported.`,
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
      cadenceFrames: CADENCE_FRAMES,
      scrollSteps: SCROLL_STEPS,
      scrollWaitMs: SCROLL_WAIT_MS,
      graceMs: GRACE_MS,
      settleMs: SETTLE_MS,
      idleMs: IDLE_MS,
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
  record.cadence = result ? launchCadence(result.cadences, result.display?.frequency) : null;
  record.scrolls = (result?.scrolls ?? []).map((s) =>
    scrollFrames(
      s,
      record.cadence,
      // Without phase 1's end, nothing counts as during it.
      s.name === 'list-phase1' ? (result.phase1DoneAt ?? -Infinity) : null,
    ),
  );
  record.gaps = (result?.opens ?? []).map((o) => o.gapMs).filter((g) => typeof g === 'number');
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

/** The app's containers on this Mac, where a test build may have left data. */
function appContainers() {
  const containersRoot = join(homedir(), 'Library', 'Containers');
  return existsSync(containersRoot)
    ? readdirSync(containersRoot)
        .filter((name) => name === APP_ID || name.startsWith(`${APP_ID}.`))
        .map((name) =>
          join(containersRoot, name, 'Data', 'Library', 'Application Support', PRODUCT_NAME),
        )
    : [];
}

/** What the preflight reads from the system; tests pass their own. */
export const SYSTEM = {
  exists: existsSync,
  lidClosed,
  git: (args) => read('git', ['-C', REPO_ROOT, ...args]),
  freeSpace: (dir) => freeSpace(dir),
  containers: appContainers,
  testData: (scanData, containers) => findTestData(scanData, { containers }),
  budget: (folders) => budgetCheck(folders, INDEX_CAP),
  corpusOf,
  corpusState,
};

/**
 * Every refusal before a run writes anything: an out folder that exists or is
 * inside a corpus, no packaged build, the lid closed or unknown, a checkout
 * with changes, less than 20 GiB free, test data that would pass 1 GB with
 * this run, or a corpus that differs from its manifest.
 */
export function preflight(args, sys = SYSTEM) {
  const corpora = { perf: sys.corpusOf('perf', args.perf) };
  if (args.stress) corpora.stress = sys.corpusOf('stress', args.stress);
  if (!isAbsolute(args.out) || sys.exists(args.out))
    throw new Error(`${args.out} must be a new folder`);
  // The corpora are only read: an output folder in one is refused before anything is written.
  for (const c of Object.values(corpora)) checkOutside(c.root, args.out);
  const executable = join(args.app, 'Contents', 'MacOS', PRODUCT_NAME);
  const asar = join(args.app, 'Contents', 'Resources', 'app.asar');
  if (!sys.exists(executable) || !sys.exists(asar))
    throw new Error(`no packaged build at ${args.app}`);
  const closed = sys.lidClosed();
  if (closed !== false)
    throw new Error(closed === null ? "can't read the lid's state" : 'the lid is closed');
  const status = sys.git(['status', '--porcelain']);
  if (status === null || status !== '')
    throw new Error('the checkout has changes (or git failed): commit or remove them first');
  const head = sys.git(['rev-parse', 'HEAD']);
  const disk = sys.freeSpace(dirname(args.out));
  const budget = sys.budget(sys.testData(args.scanData, sys.containers()));
  const before = {};
  for (const [k, c] of Object.entries(corpora)) {
    before[k] = sys.corpusState(c.root, c.manifest);
    if (!before[k].matches)
      throw new Error(`corpus ${k} differs from its manifest: ${before[k].differs}`);
  }
  return { corpora, executable, asar, head, disk, budget, before };
}

async function main() {
  const args = parse(process.argv.slice(2));
  const { corpora, executable, asar, head, disk, budget, before } = preflight(args);
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
        cadence: l.cadence,
        scrolls: l.scrolls,
        gaps: l.gaps,
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
          cadence: probe.cadence,
          raf: rafVerdict(
            [probe.result?.rafBefore, probe.result?.rafAfter],
            probe.cadence?.baseline.trusted ? probe.cadence.frameMs : null,
          ),
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
      gateWindow: { backgroundThrottling: false, framesWhileHidden: true },
      display: { frequency: first?.display?.frequency ?? null },
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
      batches: stressBatches(valid),
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
    report.sampleRule = { seed: args.seed, maxBytes: args.maxBytes, count: args.count };
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
