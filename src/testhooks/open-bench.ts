// SPDX-License-Identifier: AGPL-3.0-or-later
// The open bench of test builds. With --pev-open-bench=<config.json>, the app
// shows a list of messages from one folder in its hidden shell window, one
// after the other, timing each from the renderer's open request to the body
// frame's load. It writes one JSON result into the run's workspace and quits.
// The folder is only read: the reader's test source opens each file
// read-only, and only if it is a regular file inside that folder.

import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import type { AppContext } from '../main/context';
import { createAppWindow } from '../main/windows';
import { checkNewFile } from '../../tools/bench/workspace.mjs';
import { readConfig } from './open-bench-config';
import type { TimedOpen } from './open-bench-types';
import { READER_SOURCE_ACTION } from './reader-source';
import type { WindowEventRecorder } from './window-events';

const FLAG = '--pev-open-bench=';
/** How long the shell, the restore at launch and each step may take. */
const STEP_TIMEOUT_MS = 60_000;
/**
 * Opens start at least this far apart. Chromium drops a frame's navigations
 * past 200 in 10 s, so a faster loop would time navigations that never
 * happen. Main keeps the pace: a hidden window's timers are throttled.
 */
export const OPEN_PACE_MS = 60;

export const openBenchRequested = (argv: string[]): boolean => argv.some((a) => a.startsWith(FLAG));

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<number> {
  const start = performance.now();
  while (!(await check())) {
    if (performance.now() - start > STEP_TIMEOUT_MS) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return performance.now() - start;
}

/** Times each open in the shell, one at a time, starting them OPEN_PACE_MS apart. */
async function paced(js: <T>(code: string) => Promise<T>, rowids: number[]): Promise<TimedOpen[]> {
  const out: TimedOpen[] = [];
  let last = -Infinity;
  for (const rowid of rowids) {
    const wait = last + OPEN_PACE_MS - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = performance.now();
    out.push(...(await js<TimedOpen[]>(`window.__pevTest.openTimes([${rowid}])`)));
  }
  return out;
}

export async function runOpenBench(
  ctx: AppContext,
  argv: string[],
  windowEvents: WindowEventRecorder,
): Promise<void> {
  const result: Record<string, unknown> = { ok: false, startedAt: new Date().toISOString() };
  let out: { workspace: string; nonce: string; path: string } | null = null;
  try {
    const file = argv.find((a) => a.startsWith(FLAG))?.slice(FLAG.length) ?? '';
    // Refused unless the workspace is this run's and outside the message folder.
    const config = readConfig(file);
    out = {
      workspace: config.workspace,
      nonce: config.nonce,
      path: join(config.workspace, `open-result-${config.nonce}.json`),
    };
    result.nonce = config.nonce;
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

    const win = createAppWindow(ctx);
    const contents = win.win.webContents;
    if (contents.isLoading()) await once(contents, 'did-finish-load');
    const js = <T>(code: string) => contents.executeJavaScript(code) as Promise<T>;
    await until(
      () => js<boolean>('window.__pevTest?.state().generation != null'),
      'shell generation',
    );

    // Launch as the app does: reopen the export open at the last quit (with
    // a fresh profile there is none). Idle only: nothing is being restored
    // and no export is open, so no index work (phase 1, phase 2 or a
    // reconcile) can run during the opens.
    const restored = await ctx.sources.restore();
    const restoreWaitMs = await until(() => !ctx.sources.view().restoring, 'restore at launch');
    const exportOpen = ctx.sources.view().active !== null;
    result.idle = { restored, restoreWaitMs: Math.round(restoreWaitMs), exportOpen };
    if (exportOpen) throw new Error('an export is open: the open bench runs only with none');

    const source = await ctx.core.request({
      type: 'test',
      action: READER_SOURCE_ACTION,
      payload: { root: config.root, entries: config.files.map((f, i) => [i + 1, { file: f }]) },
    });
    if (!source.ok) throw new Error(`test source refused: ${source.code}`);
    await js('window.__pevTest.readyFrame()');

    const rowids = config.files.map((_, i) => i + 1);
    const warm = await paced(js, rowids.slice(0, config.warmup));
    const timedStart = performance.now();
    const opens = await paced(js, rowids);
    result.timedWallMs = Math.round(performance.now() - timedStart);
    result.warmup = { count: warm.length, views: warm.filter((o) => o.outcome === 'view').length };
    result.opens = opens;
    result.window = { visible: win.win.isVisible(), focused: win.win.isFocused() };
    result.paceMs = OPEN_PACE_MS;
    result.events = {
      start: 'shell renderer, performance.now() just before window.pev.open(rowid, "html")',
      end: "the body frame's load event, after its src is set to the view's URL",
    };
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    result.finishedAt = new Date().toISOString();
    // Every show and focus event of the run's windows; the runner fails a run with any.
    result.windowEvents = windowEvents.events();
    try {
      if (out) {
        checkNewFile(out.workspace, out.nonce, out.path);
        writeFileSync(out.path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      }
    } catch {
      // No place for the result: the runner reports the run as failed.
    }
    app.quit();
  }
}
