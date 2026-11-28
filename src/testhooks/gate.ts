// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate mode of test builds. With --pev-gate=<config.json>, the app runs
// one launch of a gate measurement in its hidden shell window (see
// GateMode), writes one JSON result into the run's workspace and quits. The
// export is picked as a user picks it and read in place; nothing in it is
// written. Only the gate window runs without background throttling, which
// the result states, since a production window throttles when hidden.
//
// Times are main's performance.now() unless named otherwise; shell times are
// mapped onto it with both processes' timeOrigin. Epoch times (`*Epoch`)
// line up with what the runner samples from outside.

import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { app, screen } from 'electron';
import { Random } from '../../tools/gen-export/random.mjs';
import { checkNewFile } from '../../tools/bench/workspace.mjs';
import type { AppContext, AppWindow } from '../main/context';
import { createAppWindow } from '../main/windows';
import { IPC, type IndexUpdate, type SourceActionResult } from '../shared/api';
import type { CardsWindow, EmlFile, IndexTotals, ListPage } from '../shared/index-types';
import type { LogInput } from '../shared/log/schema';
import { readConfig, type GateConfig } from './gate-config';
import type {
  ExpansionItem,
  FirstRows,
  FrameRun,
  LogMark,
  ProgressMark,
  RafProbe,
  ScrollRun,
  TimedExpansion,
} from './gate-types';
import { markLoaded } from './marker';
import type { WindowEventRecorder } from './window-events';

markLoaded();

const FLAG = '--pev-gate=';
export const gateRequested = (argv: string[]): boolean => argv.some((a) => a.startsWith(FLAG));

/** All Mail: every conversation of the export. */
const ALL_MAIL = '5';
/** Main log codes the gate notes, with their time. */
const NOTED = /^(index|source|scan)\./;
const MAX_MARKS = 5000;

const epoch = (at: number) => performance.timeOrigin + at;

class Timeout extends Error {}

async function until<T>(
  get: () => T | null | Promise<T | null>,
  ms: number,
  what: string,
  every = 20,
): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const value = await get();
    if (value !== null) return value;
    if (performance.now() > end) throw new Timeout(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** Indexing has ended: phase 1 is done and phase 2 has finished, one way or the other. */
const indexingEnded = (m: ProgressMark | null) =>
  m !== null && m.phase === 'done' && (m.bodyPhase === 'done' || m.bodyPhase === 'failed');

/** What main noted about the open export while the gate ran. */
class Marks {
  readonly progress: ProgressMark[] = [];
  readonly log: LogMark[] = [];
  readonly phases: Array<{ phase: string; atEpoch: number }> = [];

  phase(name: string): void {
    this.phases.push({ phase: name, atEpoch: epoch(performance.now()) });
  }

  last(): ProgressMark | null {
    return this.progress[this.progress.length - 1] ?? null;
  }

  firstWhere(test: (m: ProgressMark) => boolean): ProgressMark | null {
    return this.progress.find(test) ?? null;
  }

  logAt(code: string): number | null {
    return this.log.find((m) => m.code === code)?.at ?? null;
  }

  /** Progress updates in [from, to] that show indexing under way. */
  indexingBetween(from: number, to: number): ProgressMark[] {
    return this.progress.filter((m) => m.at >= from && m.at <= to && !indexingEnded(m));
  }
}

/** Notes each index update main sends the gate window, and each noted main log event. */
function attach(ctx: AppContext, appWin: AppWindow, record: Marks): void {
  const contents = appWin.win.webContents;
  const send = contents.send.bind(contents);
  contents.send = (channel: string, ...args: unknown[]) => {
    if (channel === IPC.indexChanged && record.progress.length < MAX_MARKS) {
      const { progress: p } = args[0] as IndexUpdate;
      record.progress.push({
        at: performance.now(),
        phase: p.phase,
        bodyPhase: p.bodyPhase,
        loaded: p.loaded,
        total: p.total,
        bodiesDone: p.bodiesDone,
        bodiesTotal: p.bodiesTotal,
      });
    }
    send(channel, ...args);
  };
  const write = ctx.log.write.bind(ctx.log);
  ctx.log.write = (input: LogInput) => {
    if (NOTED.test(input.code) && record.log.length < MAX_MARKS) {
      record.log.push({ at: performance.now(), code: input.code });
    }
    write(input);
  };
}

/** Core's log events with these codes from `sinceEpoch` on: time (main's clock) and data. */
function coreEvents(
  codes: string[],
  sinceEpoch: number,
): Array<{ code: string; at: number; data: Record<string, unknown> }> {
  const file = join(app.getPath('userData'), 'logs', 'core.jsonl');
  if (!existsSync(file)) return [];
  const out: Array<{ code: string; at: number; data: Record<string, unknown> }> = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { code?: string; ts?: string; data?: Record<string, unknown> };
      if (!e.code || !codes.includes(e.code) || !e.ts) continue;
      const atEpoch = Date.parse(e.ts);
      if (atEpoch < sinceEpoch) continue;
      out.push({ code: e.code, at: atEpoch - performance.timeOrigin, data: e.data ?? {} });
    } catch {
      // A line cut by a rotation is skipped.
    }
  }
  return out;
}

interface Shell {
  /** Runs code in the shell; it fails past `ms` (one step by default). */
  js: <T>(code: string, ms?: number) => Promise<T>;
  /** A shell time on main's clock. */
  toMain: (shellAt: number) => number;
}

async function openShell(
  ctx: AppContext,
  config: GateConfig,
): Promise<{ appWin: AppWindow; shell: Shell }> {
  // Hidden windows are throttled; the gate window alone is not, and draws
  // frames for the whole window while hidden.
  const appWin = createAppWindow(ctx, { framesWhileHidden: true });
  const contents = appWin.win.webContents;
  contents.setBackgroundThrottling(false);
  if (contents.isLoading()) await once(contents, 'did-finish-load');
  const js = <T>(code: string, ms = config.stepMs): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      contents.executeJavaScript(code) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout(`timed out: shell ${code.slice(0, 60)}`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  await until(
    () => js<boolean>('window.__pevTest?.state().generation != null').then((ok) => ok || null),
    config.stepMs,
    'shell generation',
    50,
  );
  const shellOrigin = await js<number>('window.__pevTest.gate.timeOrigin()');
  const offset = shellOrigin - performance.timeOrigin;
  return { appWin, shell: { js, toMain: (shellAt) => shellAt + offset } };
}

/** Picks the export as the user does: main's folder picker answers with it. Returns when the pick reached main. */
function pick(
  ctx: AppContext,
  shell: Shell,
  root: string,
): { pickedAt: () => number | null; chosen: Promise<string> } {
  let pickedAt: number | null = null;
  ctx.sources.setAccess({
    picker: () => {
      pickedAt ??= performance.now();
      return Promise.resolve({ path: root, bookmark: 'gate' });
    },
  });
  const chosen = shell
    .js<SourceActionResult>('window.__pevTest.chooseFolder()')
    .then((r) => (r.ok ? r.outcome : r.code))
    .catch(() => 'threw');
  return { pickedAt: () => pickedAt, chosen };
}

/**
 * A scroll of the list or the conversation. Its window and its steps' frame
 * timestamps are on main's clock.
 */
interface TimedScroll {
  name: string;
  startedAt: number;
  endedAt: number;
  steps: number;
  stamps: number[];
  stopped: boolean;
  waitMs: number;
  range: number;
}

async function scrollOnce(
  config: GateConfig,
  shell: Shell,
  name: string,
  selector: string,
): Promise<TimedScroll> {
  const startedAt = performance.now();
  const run = await shell.js<ScrollRun>(
    `window.__pevTest.gate.scroll(${JSON.stringify(selector)}, ${config.scrollSteps}, ${config.scrollWaitMs}, ${config.graceMs})`,
    config.scrollSteps * (config.scrollWaitMs + config.graceMs) + config.stepMs,
  );
  return {
    name,
    startedAt,
    endedAt: performance.now(),
    steps: run.steps,
    stamps: run.stamps.map(shell.toMain),
    stopped: run.stopped,
    waitMs: run.waitMs,
    range: run.range,
  };
}

/**
 * The frame cadence with nothing else going on: consecutive frames'
 * timestamps, on main's clock. `name` is 'baseline' (before the pick) or
 * 'check' (once indexing has ended).
 */
interface TimedCadence {
  name: string;
  startedAt: number;
  endedAt: number;
  stamps: number[];
  timeouts: number;
  timeoutMs: number;
}

async function cadence(
  config: GateConfig,
  shell: Shell,
  record: Marks,
  name: 'baseline' | 'check',
): Promise<TimedCadence> {
  record.phase(`cadence-${name}`);
  const startedAt = performance.now();
  const run = await shell.js<FrameRun>(
    `window.__pevTest.gate.frameRun(${config.cadenceFrames}, ${config.frameMs})`,
    config.cadenceFrames * config.frameMs + config.stepMs,
  );
  return {
    name,
    startedAt,
    endedAt: performance.now(),
    stamps: run.stamps.map(shell.toMain),
    timeouts: run.timeouts,
    timeoutMs: run.timeoutMs,
  };
}

/** The conversation with the most messages, from All Mail's pages. */
async function largestConversation(
  ctx: AppContext,
): Promise<{ threadId: number; newest: number; count: number } | null> {
  let best: { threadId: number; newest: number; count: number } | null = null;
  let after: ListPage['next'] = null;
  for (let i = 0; i < 10_000; i += 1) {
    const r = await ctx.sources.queryIndex({ op: 'page', labelId: ALL_MAIL, after, limit: 500 });
    const page = r?.answer as ListPage | undefined;
    if (!page) return best;
    for (const row of page.rows) {
      if (!best || row.count > best.count) {
        best = { threadId: row.threadId, newest: row.newestRowid, count: row.count };
      }
    }
    if (page.next === null) return best;
    after = page.next;
  }
  return best;
}

/**
 * The expansions to time: messages of at most `maxBytes` that aren't the
 * newest of a conversation of two or more, picked with the seed from all
 * such message files in name order, so the same index gives the same sample.
 */
async function pickExpansions(
  ctx: AppContext,
  messages: number,
  sample: NonNullable<GateConfig['sample']>,
): Promise<Array<ExpansionItem & { rel: string; size: number }>> {
  const pool: Array<{ rowid: number; rel: string; size: number }> = [];
  for (let rowid = 1; rowid <= messages; rowid += 1) {
    const r = await ctx.sources.queryIndex({ op: 'eml', rowid });
    const file = r?.answer as EmlFile | null | undefined;
    if (file?.rel && file.size <= sample.maxBytes)
      pool.push({ rowid, rel: file.rel, size: file.size });
  }
  pool.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const shuffled = new Random(`gate-expand-sample/${sample.seed}`).shuffle(pool);
  const picked: Array<ExpansionItem & { rel: string; size: number }> = [];
  for (const c of shuffled) {
    if (picked.length >= sample.count) break;
    // The card's place in its conversation; `after: 1` reads the card itself.
    const at = await ctx.sources.queryIndex({
      op: 'cards',
      follow: [c.rowid],
      threadId: null,
      anchor: { rowid: c.rowid, index: 0 },
      before: 0,
      after: 1,
    });
    const w = at?.answer as CardsWindow | undefined;
    if (!w || w.threadId === null || w.total < 2 || !w.anchorFound || w.anchor === null) continue;
    const index = w.anchor;
    if (index === w.total - 1) continue;
    const last = await ctx.sources.queryIndex({
      op: 'cards',
      follow: [c.rowid],
      threadId: w.threadId,
      anchor: { index: w.total - 1 },
      before: 0,
      after: 1,
    });
    const newest = (last?.answer as CardsWindow | undefined)?.cards[0]?.rowid;
    if (newest === undefined || newest === c.rowid) continue;
    picked.push({ rowid: c.rowid, threadId: w.threadId, newest, index, rel: c.rel, size: c.size });
  }
  if (picked.length < sample.count) {
    throw new Error(`only ${picked.length} messages fit the sample; ${sample.count} needed`);
  }
  return picked;
}

/** Waits until indexing has ended; returns when it did. */
function untilIndexed(record: Marks, config: GateConfig): Promise<number> {
  return until(
    () => {
      const last = record.last();
      return indexingEnded(last) ? (last as ProgressMark).at : null;
    },
    config.stepMs,
    'indexing to end',
  );
}

/**
 * Stays idle for the settle time and then the idle window, and checks that
 * nothing indexed meanwhile. The runner reads memory over the window.
 */
async function idle(record: Marks, config: GateConfig) {
  record.phase('settle');
  const settleAt = performance.now();
  await new Promise((resolve) => setTimeout(resolve, config.settleMs));
  record.phase('idle');
  const from = performance.now();
  await new Promise((resolve) => setTimeout(resolve, config.idleMs));
  const to = performance.now();
  record.phase('idle-end');
  return {
    settleAt,
    fromEpoch: epoch(from),
    toEpoch: epoch(to),
    indexingDuring: record.indexingBetween(settleAt, to).length,
  };
}

async function totalsOf(ctx: AppContext) {
  const r = await ctx.sources.queryIndex({ op: 'totals' });
  return r ? { totals: r.answer as IndexTotals, condition: r.progress.condition } : null;
}

type Result = { [key: string]: unknown };

async function runFresh(
  ctx: AppContext,
  config: GateConfig,
  shell: Shell,
  record: Marks,
  result: Result,
  probe: boolean,
): Promise<void> {
  const cadences: TimedCadence[] = [await cadence(config, shell, record, 'baseline')];
  result.cadences = cadences;
  if (probe) {
    record.phase('raf-before');
    result.rafBefore = await shell.js<RafProbe>(
      `window.__pevTest.gate.rafProbe(${config.rafProbes}, ${config.frameMs})`,
    );
  }
  const armed = await shell.js<boolean>(`window.__pevTest.gate.watchRows(${config.frameMs})`);
  if (!armed) throw new Error('list rows were drawn before the pick');
  record.phase('phase1');
  const picked = pick(ctx, shell, config.root);
  void picked.chosen.then((c) => {
    result.chosen = c;
  });
  const rows = await until(
    async () => {
      const r = await shell.js<FirstRows | null>('window.__pevTest.gate.firstRows()');
      return r && r.settled ? r : null;
    },
    config.stepMs,
    'first list rows',
  );
  const pickedAt = picked.pickedAt();
  if (pickedAt === null) throw new Error('the pick never reached main');
  // The list scrolled while phase 1 runs, and after it.
  const scrolls: TimedScroll[] = [];
  scrolls.push(await scrollOnce(config, shell, 'list-phase1', '.list-scroll'));
  const phase1 = await until(
    () => record.firstWhere((m) => m.phase === 'done'),
    config.stepMs,
    'phase 1 to end',
  );
  record.phase('scroll-after');
  scrolls.push(await scrollOnce(config, shell, 'list-after', '.list-scroll'));
  record.phase('phase2');
  if (probe) {
    record.phase('raf-after');
    result.rafAfter = await shell.js<RafProbe>(
      `window.__pevTest.gate.rafProbe(${config.rafProbes}, ${config.frameMs})`,
    );
  }
  const indexedAt = await untilIndexed(record, config);
  if (probe) {
    cadences.push(await cadence(config, shell, record, 'check'));
    const largest = await largestConversation(ctx);
    if (largest) {
      await shell.js(
        `window.__pevTest.gate.showConversation(${largest.newest}, ${largest.threadId})`,
      );
      await until(
        () =>
          shell
            .js<boolean>(`!!document.querySelector('.cv-scroll .cv-slot')`)
            .then((ok) => ok || null),
        config.stepMs,
        'conversation cards',
      );
      scrolls.push(await scrollOnce(config, shell, 'conversation', '.cv-scroll'));
      result.conversation = largest;
    }
  }
  result.firstRows = {
    ...rows,
    commitAt: rows.commitAt === null ? null : shell.toMain(rows.commitAt),
    rafAt: rows.rafAt === null ? null : shell.toMain(rows.rafAt),
  };
  result.pickedAt = pickedAt;
  result.phase1DoneAt = phase1.at;
  result.phase1Total = phase1.total;
  result.indexedAt = indexedAt;
  result.scrolls = scrolls;
  result.idle = probe ? null : await idle(record, config);
  if (!probe) cadences.push(await cadence(config, shell, record, 'check'));
}

async function runReopen(
  ctx: AppContext,
  config: GateConfig,
  shell: Shell,
  record: Marks,
  result: Result,
  readyAt: number,
): Promise<void> {
  const armed = await shell.js<boolean>(`window.__pevTest.gate.watchRows(${config.frameMs})`);
  if (!armed) throw new Error('list rows were drawn before the reopen');
  record.phase('reopen');
  const restoreAt = performance.now();
  const restored = await ctx.sources.restore();
  if (restored === null || !ctx.sources.view().active) throw new Error('nothing was reopened');
  const rows = await until(
    async () => {
      const r = await shell.js<FirstRows | null>('window.__pevTest.gate.firstRows()');
      return r && r.settled ? r : null;
    },
    config.stepMs,
    'first list rows',
  );
  const openedAt = await until(() => record.logAt('index.opened'), config.stepMs, 'index.opened');
  // Reconcile ends when the reopen's index reaches phase 'done' again; core
  // logs index.reconciled only when it changed pairs. Verification ends with
  // the check's outcome in core's log.
  const reconcileDone = await until(
    () => record.firstWhere((m) => m.at >= restoreAt && m.phase === 'done'),
    config.stepMs,
    'reconcile to end',
  );
  const since = epoch(restoreAt);
  const verified = await until(
    () =>
      coreEvents(['index.verified', 'index.unverified'], since).find(
        (e) => e.code === 'index.verified' || e.code === 'index.unverified',
      ) ?? null,
    config.stepMs,
    'verification',
    100,
  );
  result.readyAt = readyAt;
  result.restoreAt = restoreAt;
  result.openedAt = openedAt;
  result.firstRows = {
    ...rows,
    commitAt: rows.commitAt === null ? null : shell.toMain(rows.commitAt),
    rafAt: rows.rafAt === null ? null : shell.toMain(rows.rafAt),
  };
  result.reconcileDoneAt = reconcileDone.at;
  result.reconciled = coreEvents(['index.reconciled'], since)[0] ?? null;
  result.verified = verified;
  result.indexedAt = await untilIndexed(record, config).catch(() => null);
}

async function runOpens(
  ctx: AppContext,
  config: GateConfig,
  shell: Shell,
  record: Marks,
  result: Result,
): Promise<void> {
  const sample = config.sample;
  if (!sample) throw new Error('no sample');
  const cadences: TimedCadence[] = [await cadence(config, shell, record, 'baseline')];
  result.cadences = cadences;
  record.phase('phase1');
  const picked = pick(ctx, shell, config.root);
  void picked.chosen.then((c) => {
    result.chosen = c;
  });
  const indexedAt = await untilIndexed(record, config);
  result.pickedAt = picked.pickedAt();
  result.indexedAt = indexedAt;
  record.phase('sample');
  const totals = await totalsOf(ctx);
  if (!totals) throw new Error('no totals');
  const items = await pickExpansions(ctx, totals.totals.messages, sample);
  result.sample = items.map(({ rel, size, rowid }) => ({ rel, size, rowid }));
  cadences.push(await cadence(config, shell, record, 'check'));
  const largest = await largestConversation(ctx);
  if (largest) {
    await shell.js(
      `window.__pevTest.gate.showConversation(${largest.newest}, ${largest.threadId})`,
    );
    await until(
      () =>
        shell
          .js<boolean>(`!!document.querySelector('.cv-scroll .cv-slot')`)
          .then((ok) => ok || null),
      config.stepMs,
      'conversation cards',
    );
    result.conversation = largest;
    result.scrolls = [await scrollOnce(config, shell, 'conversation', '.cv-scroll')];
  }
  record.phase('opens');
  const opensFrom = performance.now();
  const plain = items.map(({ rowid, threadId, newest, index }) => ({
    rowid,
    threadId,
    newest,
    index,
  }));
  // Each expansion has three waits of at most a step (a show, a read and a
  // load), and the shell call gets time for all of them.
  const expansions = await shell.js<{ warm: TimedExpansion[]; timed: TimedExpansion[] }>(
    `window.__pevTest.gate.expandTimes(${JSON.stringify(plain)}, ${sample.warmup}, ${config.stepMs})`,
    config.stepMs * 3 * (items.length + sample.warmup) + config.stepMs,
  );
  const opensTo = performance.now();
  record.phase('opens-end');
  result.warmup = {
    requested: sample.warmup,
    count: expansions.warm.length,
    views: expansions.warm.filter((e) => e.outcome === 'view').length,
  };
  result.opens = expansions.timed;
  result.opensWindow = { from: opensFrom, to: opensTo };
  result.indexingDuringOpens = record.indexingBetween(opensFrom, opensTo).length;
}

export async function runGate(
  ctx: AppContext,
  argv: string[],
  windowEvents: WindowEventRecorder,
): Promise<void> {
  const readyAt = performance.now();
  const result: Result = { ok: false, startedAt: new Date().toISOString() };
  let out: { workspace: string; nonce: string; path: string } | null = null;
  const record = new Marks();
  try {
    const file = argv.find((a) => a.startsWith(FLAG))?.slice(FLAG.length) ?? '';
    // Refused unless the workspace is this run's and outside the export folder.
    const config = readConfig(file);
    out = {
      workspace: config.workspace,
      nonce: config.nonce,
      path: join(config.workspace, `gate-result-${config.nonce}.json`),
    };
    result.nonce = config.nonce;
    result.mode = config.mode;
    result.app = {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
    };
    result.machine = {
      cpu: cpus()[0]?.model ?? null,
      cores: cpus().length,
      memoryBytes: totalmem(),
      os: `${process.platform} ${release()}`,
      arch: process.arch,
    };
    result.inputs = {
      backgroundThrottling: false,
      capBytes: config.capBytes,
      framesWhileHidden: true,
      frameMs: config.frameMs,
      rafProbes: config.rafProbes,
      cadenceFrames: config.cadenceFrames,
      scrollSteps: config.scrollSteps,
      scrollWaitMs: config.scrollWaitMs,
      graceMs: config.graceMs,
      settleMs: config.settleMs,
      idleMs: config.idleMs,
    };
    result.processUptimeMs = Math.round(process.uptime() * 1000);
    result.timeOriginEpoch = performance.timeOrigin;
    // Core starts with the export: it gets the cap, and keeps each phase 1 batch's time.
    ctx.core.testInit = {
      ...(ctx.core.testInit ?? {}),
      capBytes: config.capBytes,
      recordBatches: true,
    };

    const { appWin, shell } = await openShell(ctx, config);
    // The display's nominal refresh rate, beside the cadence the window measures.
    result.display = {
      frequency: screen.getDisplayMatching(appWin.win.getBounds()).displayFrequency,
    };
    attach(ctx, appWin, record);
    record.phase('start');

    if (config.mode === 'reopen') {
      await runReopen(ctx, config, shell, record, result, readyAt);
    } else {
      // A launch that picks starts with nothing open, as on a fresh profile.
      const restored = await ctx.sources.restore();
      if (restored !== null || ctx.sources.view().active !== null) {
        throw new Error('an export is open: this launch runs only with none');
      }
      if (config.mode === 'opens') await runOpens(ctx, config, shell, record, result);
      else await runFresh(ctx, config, shell, record, result, config.mode === 'probe');
    }
    record.phase('end');
    const totals = await totalsOf(ctx);
    result.totals = totals?.totals ?? null;
    result.condition = totals?.condition ?? null;
    const batches = await ctx.core
      .request({ type: 'test', action: 'gate-batches' })
      .catch(() => null);
    result.batches = batches?.ok ? (batches.data ?? null) : null;
    result.window = { visible: appWin.win.isVisible(), focused: appWin.win.isFocused() };
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    result.finishedAt = new Date().toISOString();
    result.progress = record.progress;
    result.log = record.log;
    result.phases = record.phases;
    // Every show and focus event of the run's windows; the runner fails a run with any.
    result.windowEvents = windowEvents.events();
    try {
      if (out) {
        checkNewFile(out.workspace, out.nonce, out.path);
        writeFileSync(out.path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      }
    } catch {
      // No place for the result: the runner reports the launch as failed.
    }
    app.quit();
  }
}
