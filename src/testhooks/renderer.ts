// SPDX-License-Identifier: AGPL-3.0-or-later
// Shell test hooks, reached by tests as window.__pevTest.

import { reportError } from '../renderer/errors';
import { list } from '../renderer/mailbox-state';
import {
  chooseFolder,
  forgetExport,
  getShellState,
  locateExport,
  openExport,
  openMessage,
  refreshGeneration,
  refreshSources,
  switchRun,
} from '../renderer/shell';
import { closeReader, getReaderState, openInReader } from '../renderer/reader';
import type { OpenMode } from '../shared/reader-protocol';
import { markLoaded } from './marker';
import type { TimedOpen } from './open-bench-types';

markLoaded();

function frame(): HTMLIFrameElement | null {
  return document.querySelector('iframe.body-frame');
}

/** How long the open bench waits for the body frame to load. */
const LOAD_TIMEOUT_MS = 5_000;

/** Resolves once the frame's next navigation has loaded. */
function nextLoad(f: HTMLIFrameElement): Promise<number> {
  return new Promise((resolve) => {
    f.addEventListener('load', () => resolve(performance.now()), { once: true });
  });
}

/**
 * Gives the shell a body frame that has finished loading: the sample open
 * makes one. Hidden windows get no animation frames, so this polls on a timer.
 */
async function readyFrame(): Promise<void> {
  if (!frame()) {
    const opened = await openMessage('sample');
    if (!opened.ok) throw new Error(`sample open refused: ${opened.code}`);
    for (let i = 0; i < 100 && !frame(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const f = frame();
  const src = f?.getAttribute('src');
  if (!f || !src) throw new Error('no body frame');
  // Loads it again, so its load is one this hook waited for.
  const loaded = nextLoad(f);
  f.src = src;
  await loaded;
}

/**
 * Opens each message as the reader does and shows it in the body frame. Each
 * one is timed from just before the open request to the frame's `load`.
 */
async function openTimes(rowids: number[]): Promise<TimedOpen[]> {
  const f = frame();
  if (!f) throw new Error('no body frame');
  const generation = getShellState().generation ?? (await refreshGeneration());
  if (generation === null) throw new Error('no generation');
  const out: TimedOpen[] = [];
  for (const rowid of rowids) {
    const start = performance.now();
    const opened = await window.pev.open(rowid, 'html', generation);
    if (!opened.ok) {
      out.push({ rowid, ms: null, outcome: 'rejected', code: opened.code });
      continue;
    }
    if (opened.outcome !== 'view') {
      out.push({ rowid, ms: null, outcome: 'fallback' });
      continue;
    }
    const loaded = nextLoad(f);
    f.src = opened.url;
    const end = await Promise.race([
      loaded,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOAD_TIMEOUT_MS)),
    ]);
    if (end === null) {
      out.push({ rowid, ms: null, outcome: 'timeout', format: opened.format });
      continue;
    }
    out.push({ rowid, ms: end - start, outcome: 'view', format: opened.format });
  }
  return out;
}

export function install(): void {
  const api = {
    state: () => getShellState(),
    listSelection: () => list.snapshot.selected,
    refreshGeneration,
    open: (id: string) => openMessage(id),
    /** Opens a message in the reader pane. */
    openInReader: (rowid: number, mode?: OpenMode) => openInReader(rowid, mode),
    closeReader,
    reader: () => getReaderState(),
    refreshSources,
    chooseFolder,
    openExport,
    switchRun,
    locateExport,
    forgetExport,
    frameSrc: () => frame()?.getAttribute('src') ?? null,
    frameSandbox: () => frame()?.getAttribute('sandbox') ?? null,
    setFrameSrc: (url: string) => {
      const f = frame();
      if (f) f.src = url;
    },
    readyFrame,
    openTimes,
    windowOpen: (url: string) => {
      window.open(url);
    },
    navigateMain: (url: string) => {
      window.location.href = url;
    },
    log: async (markers: string) => {
      const generation = getShellState().generation ?? (await refreshGeneration());
      if (generation === null) throw new Error('no generation');
      window.pev.log('info', 'test.log', generation, {
        subject: markers,
        path: markers,
        reason: markers,
      });
    },
    error: (markers: string) => reportError('error', new Error(markers)),
    throwUncaught: (markers: string) => {
      setTimeout(() => {
        throw new Error(markers);
      }, 0);
    },
    reject: (markers: string) => {
      void Promise.reject(new Error(markers));
    },
  };
  (window as unknown as { __pevTest: typeof api }).__pevTest = api;
}
