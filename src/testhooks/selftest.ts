// SPDX-License-Identifier: AGPL-3.0-or-later
// In-app self-test for the sandboxed build. It needs no debugging port: it runs
// its checks, writes the result into userData and quits.
//
// Arguments: --pev-selftest --pev-selftest-write=<file> --pev-selftest-port=<port>
//            --pev-selftest-nonce=<hex value echoed into the result>
//            --pev-selftest-smoke=<export folder inside the app's container>
//            --pev-selftest-save=<16 hex digits: the save check's folder mark>
//            --pev-selftest-timing=<export folder inside the app's container>
//            --pev-selftest-timing-ms=<how long the timing waits for phase 1>
//            --pev-selftest-timing-keep (the export stays known, for a reopen)
//            --pev-selftest-timing-reopen (times the reopen at launch; no pick)
//            --pev-selftest-timing-held=<rowid>,<rowid> (with -reopen: the scan is
//              held while the stored list and those messages are opened)
// The result goes to selftest-result-<nonce>.json, so concurrent runs that share
// a sandbox container never overwrite each other's result.
//
// With an export folder, the self-test also runs the smoke: it opens the
// export as a user would, through the shell and the production source, opens
// messages, switches to plain text, clicks a link, opens a message whose file
// is missing, and forgets the export again (smoke, in the result). With a
// timing folder, it opens that export and times what the shell shows, from
// the pick to the end of phase 1, then forgets it (timing, in the result).
//
// With a save nonce, the self-test also saves an attachment of a synthetic
// message into a folder of its own in the container, on both publish paths
// (save, in the result; see selftest-save).
//
// Besides the end state (shownWindows), the result carries the record of every
// show and focus event during the run (windowEvents, which must be empty), and
// a probe of the recorder on the self-test's own window (recorderProbe: one
// show and one focus for that window), which proves the record was connected.

import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserWindow, app, type WebContents } from 'electron';
import type { MessageOpenResult, SourceActionResult } from '../shared/api';
import type { EmlFile, IndexTotals, ListWindow } from '../shared/index-types';
import type { AppContext, AppWindow } from '../main/context';
import { bodyUrl } from '../main/views';
import { createAppWindow } from '../main/windows';
import { markLoaded } from './marker';
import { runSaveCheck, type SaveCheck } from './selftest-save';
import type { WindowEvent, WindowEventRecorder } from './window-events';

markLoaded();

type Outcome = { ok: boolean; code: string | null };

function argValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function tryWrite(target: string | undefined): Outcome {
  if (!target) return { ok: false, code: 'NO_TARGET' };
  try {
    writeFileSync(target, 'self-test\n');
    return { ok: true, code: null };
  } catch (err) {
    return { ok: false, code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
  }
}

function tryConnect(port: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, code: 'TIMEOUT' });
    }, 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve({ ok: true, code: null });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, code: err.code ?? 'UNKNOWN' });
    });
  });
}

/** What the smoke found, step by step; null where a step didn't get that far. */
export interface Smoke {
  chosen: string | null;
  totals: IndexTotals | null;
  newest: { rowid: number; format: string; body: number } | null;
  plain: { format: string; body: number; oldBody: number } | null;
  link: { dialogs: number } | null;
  missing: { code: string | null; text: string | null } | null;
  forgotten: string | null;
  error: string | null;
}

/** All Mail: every conversation of the export. */
const ALL_MAIL = '5';

/** An open's outcome, or the code it was refused with. */
const outcomeOf = (r: MessageOpenResult) => (r.ok ? r.outcome : r.code);

async function until<T>(
  get: () => Promise<T | null> | T | null,
  ms: number,
  what: string,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (value !== null) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await delay(50);
  }
}

interface FrameNode {
  frame: { id: string; url: string };
  childFrames?: FrameNode[];
}

/**
 * Clicks an element in the frame that shows `url`, with a user gesture. The
 * body frame runs no script of its own and has its own renderer process, so
 * the click goes through the window's DevTools protocol client (in process,
 * no port), attached to that frame's target, in an isolated world.
 */
async function clickInFrame(contents: WebContents, url: string, selector: string): Promise<void> {
  const cdp = contents.debugger;
  const targets = new Map<string, string>();
  const onMessage = (_event: unknown, method: string, params: unknown) => {
    if (method !== 'Target.attachedToTarget') return;
    const attached = params as { sessionId: string; targetInfo: { url: string } };
    targets.set(attached.targetInfo.url, attached.sessionId);
  };
  cdp.on('message', onMessage);
  contents.debugger.attach('1.3');
  try {
    await cdp.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    const find = (node: FrameNode): string | null =>
      node.frame.url === url
        ? node.frame.id
        : ((node.childFrames ?? []).map(find).find((id) => id !== null) ?? null);
    // Only the body frame's own target is used, never the shell's.
    const sessionId = await until(() => targets.get(url) ?? null, 5000, 'body frame');
    const { frameTree } = (await cdp.sendCommand('Page.getFrameTree', {}, sessionId)) as {
      frameTree: FrameNode;
    };
    const frameId = find(frameTree);
    if (frameId === null) throw new Error('body frame not in its target');
    const { executionContextId } = (await cdp.sendCommand(
      'Page.createIsolatedWorld',
      { frameId, worldName: 'smoke' },
      sessionId,
    )) as { executionContextId: number };
    const evaluate = (expression: string, userGesture = false) =>
      cdp.sendCommand(
        'Runtime.evaluate',
        { expression, contextId: executionContextId, returnByValue: true, userGesture },
        sessionId,
      ) as Promise<{ result: { value?: unknown } }>;
    const sel = JSON.stringify(selector);
    await until(
      async () =>
        (await evaluate(`document.querySelector(${sel}) !== null`)).result.value === true
          ? true
          : null,
      5000,
      'link in the body',
    );
    await evaluate(`document.querySelector(${sel}).click()`, true);
  } finally {
    cdp.removeListener('message', onMessage);
    cdp.detach();
  }
}

/**
 * Opens the export at `root` as a user would: the folder pick (answered from
 * the test queue), phase 1 to its end, the newest message, plain text, a link
 * click, and a message whose file is missing. Then forgets the export, which
 * deletes its index.
 */
async function runSmoke(
  ctx: AppContext,
  appWin: AppWindow,
  root: string,
  queuePick: (path: string, bookmark: string) => void,
): Promise<Smoke> {
  const smoke: Smoke = {
    chosen: null,
    totals: null,
    newest: null,
    plain: null,
    link: null,
    missing: null,
    forgotten: null,
    error: null,
  };
  const shell = <T>(code: string) => appWin.win.webContents.executeJavaScript(code) as Promise<T>;
  const open = (rowid: number, mode: string) =>
    shell<MessageOpenResult>(`window.__pevTest.openInReader(${rowid}, '${mode}')`);
  const status = async (url: string) => (await appWin.session.fetch(url)).status;
  try {
    queuePick(root, 'smoke');
    const chosen = await shell<SourceActionResult>('window.__pevTest.chooseFolder()');
    smoke.chosen = chosen.ok ? chosen.outcome : chosen.code;
    smoke.totals = await until(
      async () => {
        const r = await ctx.sources.queryIndex({ op: 'totals' });
        return r && r.progress.phase === 'done' ? (r.answer as IndexTotals) : null;
      },
      60_000,
      'phase 1',
    );
    const listed = await ctx.sources.queryIndex({
      op: 'window',
      labelId: ALL_MAIL,
      anchor: { index: 0 },
      before: 0,
      after: 20,
      selected: null,
    });
    const fileOf = async (rowid: number) =>
      (await ctx.sources.queryIndex({ op: 'eml', rowid }))?.answer as EmlFile | null;
    // The newest conversations whose newest message has its file; one export
    // message has none, for the missing-file step below.
    const rows: ListWindow['rows'] = [];
    for (const row of (listed?.answer as ListWindow | undefined)?.rows ?? []) {
      if ((await fileOf(row.anchorRowid))?.rel) rows.push(row);
    }
    const newest = rows[0];
    if (!newest) throw new Error('no rows');

    const html = await open(newest.anchorRowid, 'html');
    if (!html.ok || html.outcome !== 'view') throw new Error(`newest: ${outcomeOf(html)}`);
    smoke.newest = { rowid: newest.anchorRowid, format: html.format, body: await status(html.url) };
    const plain = await open(newest.anchorRowid, 'plain');
    if (!plain.ok || plain.outcome !== 'view') throw new Error(`plain: ${outcomeOf(plain)}`);
    smoke.plain = {
      format: plain.format,
      body: await status(plain.url),
      oldBody: await status(html.url),
    };

    // A message with a link: its link is clicked inside the body frame.
    for (const row of rows) {
      const view = await open(row.anchorRowid, 'html');
      if (!view.ok || view.outcome !== 'view') continue;
      const body = await (await appWin.session.fetch(view.url)).text();
      if (!body.includes('/l1"')) continue;
      const before = ctx.linkDialog.shown.length;
      await clickInFrame(appWin.win.webContents, view.url, 'a[href]');
      smoke.link = {
        dialogs: await until(
          () => {
            const n = ctx.linkDialog.shown.length - before;
            return n > 0 ? n : null;
          },
          5000,
          'link dialog',
        ),
      };
      break;
    }

    // The message whose file was missing at the scan.
    for (let rowid = 1; rowid <= smoke.totals.messages; rowid += 1) {
      const file = await fileOf(rowid);
      if (!file || file.rel !== null) continue;
      const result = await open(rowid, 'html');
      const text = await until(
        () => shell<string | null>("document.querySelector('.rp-state')?.textContent ?? null"),
        5000,
        'missing-file state',
      );
      smoke.missing = { code: result.ok ? null : result.code, text };
      break;
    }

    const key = ctx.sources.stamp()?.sourceKey;
    const forgotten = key
      ? await shell<SourceActionResult>(`window.__pevTest.forgetExport(${JSON.stringify(key)})`)
      : null;
    smoke.forgotten = forgotten ? (forgotten.ok ? forgotten.outcome : forgotten.code) : null;
  } catch (err) {
    smoke.error = err instanceof Error ? err.message : String(err);
  }
  return smoke;
}

/** Milliseconds from the pick to each step a user sees; null for a step not reached. */
export interface Timing {
  chosen: string | null;
  /** The export is open: the shell leaves the welcome screen. */
  opened: number | null;
  /** The sidebar's loading bar, with or without numbers. */
  firstBar: number | null;
  /** The first line with numbers: the files read, or the messages loaded. */
  firstCount: number | null;
  /** Main accepted the scan. */
  scanDone: number | null;
  /** The list shows its first conversation. */
  firstRows: number | null;
  phase1Done: number | null;
  pairs: number | null;
  /** The most memory core's processes held at a sample, in MB. */
  peakCoreMb: number;
  forgotten: string | null;
  /** With the scan held on a reopen: what showed and opened meanwhile. */
  held: HeldScan | null;
  error: string | null;
}

/** A reopen with its scan held: the stored list, and opens of stored messages. */
export interface HeldScan {
  /** List rows drawn while the scan was held. */
  listRows: number;
  /** Each message opened, and its outcome or the code it was refused with. */
  opens: Array<{ rowid: number; outcome: string }>;
  /** The scan was still held after the opens. */
  stillHeld: boolean;
}

/** How often the timing looks, in milliseconds. */
const TIMING_SAMPLE_MS = 100;

/**
 * Opens the export at `root` as a user would and times, from the pick, what
 * the shell shows, until phase 1 ends or `limitMs` passed. With `reopen`
 * there is no pick: it times the export the app reopened at launch, from
 * now. Then forgets the export, which deletes its index, unless `keep`.
 */
async function runTiming(
  ctx: AppContext,
  appWin: AppWindow,
  root: string,
  queuePick: (path: string, bookmark: string) => void,
  limitMs: number,
  mode: { keep: boolean; reopen: boolean; held: number[] },
): Promise<Timing> {
  const timing: Timing = {
    chosen: null,
    opened: null,
    firstBar: null,
    firstCount: null,
    scanDone: null,
    firstRows: null,
    phase1Done: null,
    pairs: null,
    peakCoreMb: 0,
    forgotten: null,
    held: null,
    error: null,
  };
  const shell = <T>(code: string) => appWin.win.webContents.executeJavaScript(code) as Promise<T>;
  const start = performance.now();
  const since = () => Math.round(performance.now() - start);
  try {
    if (mode.reopen) {
      // The core the reopen starts holds its scan, when asked to.
      if (mode.held.length > 0) ctx.core.testInit = { holdScans: true };
      // The self-test skips the launch's own reopen, so it starts it here.
      void ctx.sources.restore();
      if (mode.held.length > 0) timing.held = await whileHeld(ctx, shell, mode.held, limitMs);
    } else {
      queuePick(root, 'timing');
      void shell<SourceActionResult>('window.__pevTest.chooseFolder()').then(
        (r) => {
          timing.chosen = r.ok ? r.outcome : r.code;
        },
        () => {
          timing.chosen = 'threw';
        },
      );
    }
    while (timing.phase1Done === null && performance.now() - start < limitMs) {
      const seen = await shell<{ bar: boolean; count: boolean; rows: number }>(
        `({ bar: !!document.querySelector('.side-foot .bar-track'),` +
          ` count: !!document.querySelector('.side-foot .loading-text'),` +
          ` rows: document.querySelectorAll('.list-scroll .conv:not(.placeholder)').length })`,
      );
      const at = since();
      if (timing.opened === null && ctx.sources.view().active) timing.opened = at;
      if (timing.firstBar === null && seen.bar) timing.firstBar = at;
      if (timing.firstCount === null && seen.count) timing.firstCount = at;
      if (timing.scanDone === null && ctx.sources.scanSummary()) timing.scanDone = at;
      if (timing.firstRows === null && seen.rows > 0) timing.firstRows = at;
      if (timing.scanDone !== null) {
        const totals = await ctx.sources.queryIndex({ op: 'totals' });
        if (totals?.progress.phase === 'done') {
          timing.phase1Done = since();
          timing.pairs = (totals.answer as IndexTotals).pairs;
        }
      }
      const coreKb = app
        .getAppMetrics()
        .filter((m) => m.type === 'Utility')
        .reduce((sum, m) => sum + m.memory.workingSetSize, 0);
      timing.peakCoreMb = Math.max(timing.peakCoreMb, Math.round(coreKb / 1024));
      await delay(TIMING_SAMPLE_MS);
    }
    const key = ctx.sources.stamp()?.sourceKey;
    const forgotten =
      key && !mode.keep
        ? await shell<SourceActionResult>(`window.__pevTest.forgetExport(${JSON.stringify(key)})`)
        : null;
    timing.forgotten = forgotten ? (forgotten.ok ? forgotten.outcome : forgotten.code) : null;
  } catch (err) {
    timing.error = err instanceof Error ? err.message : String(err);
  }
  return timing;
}

/**
 * With the reopen's scan held: waits for the stored list, opens each message
 * in the reader, notes whether the scan is still held, then lets it go.
 */
async function whileHeld(
  ctx: AppContext,
  shell: <T>(code: string) => Promise<T>,
  rowids: number[],
  limitMs: number,
): Promise<HeldScan> {
  const heldScans = async () => {
    const r = await ctx.core.request({ type: 'test', action: 'held-scans' }).catch(() => null);
    return r?.ok ? Number(r.value ?? 0) : 0;
  };
  const rows = () =>
    shell<number>(`document.querySelectorAll('.list-scroll .conv:not(.placeholder)').length`);
  await until(async () => ((await heldScans()) > 0 ? true : null), limitMs, 'held scan');
  const listRows = await until(
    async () => {
      const n = await rows();
      return n > 0 ? n : null;
    },
    limitMs,
    'stored list',
  );
  const opens: HeldScan['opens'] = [];
  for (const rowid of rowids) {
    const r = await shell<MessageOpenResult>(`window.__pevTest.openInReader(${rowid}, 'plain')`);
    opens.push({ rowid, outcome: outcomeOf(r) });
  }
  const stillHeld = (await heldScans()) > 0;
  await ctx.core.request({ type: 'test', action: 'release-scans', payload: { count: null } });
  return { listRows, opens, stillHeld };
}

/** The result file for a run; a nonce that isn't plain hex is not used in the name. */
export function resultFileName(nonce: string | null): string {
  return nonce !== null && /^[0-9a-f]{8,64}$/.test(nonce)
    ? `selftest-result-${nonce}.json`
    : 'selftest-result.json';
}

export async function runSelfTest(
  ctx: AppContext,
  argv: string[],
  recorder: WindowEventRecorder,
  queuePick: (path: string, bookmark: string) => void,
): Promise<void> {
  const result = {
    nonce: argValue(argv, 'pev-selftest-nonce') ?? null,
    sandboxed: process.mas === true,
    core: false,
    worker: false,
    body: 0,
    asset: 0,
    write: { ok: false, code: 'NOT_RUN' } as Outcome,
    connect: { ok: false, code: 'NOT_RUN' } as Outcome,
    error: null as string | null,
    shownWindows: 0,
    windowEvents: [] as WindowEvent[],
    recorderProbe: [] as WindowEvent[],
    smoke: null as Smoke | null,
    save: null as SaveCheck | null,
    timing: null as Timing | null,
  };
  try {
    const appWin = createAppWindow(ctx, { show: false });
    result.recorderProbe = recorder.probe(appWin.win);
    if (appWin.win.webContents.isLoading()) await once(appWin.win.webContents, 'did-finish-load');

    const ping = await ctx.core.request({ type: 'ping' });
    result.core = ping.ok;
    const { openId, token } = appWin.views.accept();
    const opened = await ctx.core.request({
      type: 'open',
      openId,
      generation: ctx.generation,
      token,
      stubId: 'sample',
    });
    result.worker = opened.ok && !!opened.body;
    if (opened.ok && opened.body) {
      appWin.views.install(openId, token, ctx.generation, ctx.generation, opened.body);
      result.body = (await appWin.session.fetch(bodyUrl(token))).status;
      result.asset = (await appWin.session.fetch(`mail-asset://v/${token}/c1`)).status;
    }

    result.write = tryWrite(argValue(argv, 'pev-selftest-write'));
    const port = Number(argValue(argv, 'pev-selftest-port'));
    result.connect = Number.isInteger(port) && port > 0 ? await tryConnect(port) : result.connect;
    const smokeRoot = argValue(argv, 'pev-selftest-smoke');
    if (smokeRoot) result.smoke = await runSmoke(ctx, appWin, smokeRoot, queuePick);
    const saveNonce = argValue(argv, 'pev-selftest-save');
    if (saveNonce !== undefined && /^[0-9a-f]{16}$/.test(saveNonce)) {
      result.save = await runSaveCheck(ctx, appWin, saveNonce);
    }
    const timingRoot = argValue(argv, 'pev-selftest-timing');
    if (timingRoot) {
      const limit = Number(argValue(argv, 'pev-selftest-timing-ms') ?? '600000');
      const limitMs = Number.isSafeInteger(limit) && limit > 0 ? limit : 600_000;
      result.timing = await runTiming(ctx, appWin, timingRoot, queuePick, limitMs, {
        keep: argv.includes('--pev-selftest-timing-keep'),
        reopen: argv.includes('--pev-selftest-timing-reopen'),
        held: (argValue(argv, 'pev-selftest-timing-held') ?? '')
          .split(',')
          .map(Number)
          .filter((n) => Number.isSafeInteger(n) && n > 0),
      });
    }
  } catch (err) {
    result.error = err instanceof Error ? err.constructor.name : 'NonError';
  }
  result.shownWindows = BrowserWindow.getAllWindows().filter(
    (w) => w.isVisible() || w.isFocused(),
  ).length;
  result.windowEvents = recorder.events();
  writeFileSync(
    join(app.getPath('userData'), resultFileName(result.nonce)),
    JSON.stringify(result, null, 2),
  );
  ctx.log.info('test.selftest');
  app.exit(0);
}
