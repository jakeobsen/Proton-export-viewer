// SPDX-License-Identifier: AGPL-3.0-or-later
// Shell test hooks, reached by tests as window.__pevTest.

import { reportError } from '../renderer/errors';
import {
  cardLeads,
  cards,
  getMailboxState,
  list,
  listLeads,
  search,
} from '../renderer/mailbox-state';
import {
  chooseFolder,
  clearLink,
  forgetExport,
  getShellState,
  locateExport,
  openExport,
  refreshGeneration,
  refreshSources,
  switchRun,
} from '../renderer/shell';
import { closeReader, getReaderState, openInReader } from '../renderer/reader';
import type { OpenResult } from '../shared/api';
import { BODY_IFRAME_REFERRER, BODY_IFRAME_SANDBOX } from '../shared/constants';
import type { OpenMode } from '../shared/reader-protocol';
import { markLoaded } from './marker';
import type { TimedOpen } from './open-bench-types';

markLoaded();

/** The stub body's frame, outside the shell's own tree. */
function frame(): HTMLIFrameElement | null {
  return document.querySelector('iframe.body-frame');
}

/**
 * Opens a stub body in a frame of its own, with the attributes of the body
 * frame the shell ships. The old frame goes at once; main has revoked it.
 */
async function openStub(id: string): Promise<OpenResult> {
  frame()?.remove();
  clearLink();
  const generation = getShellState().generation ?? (await refreshGeneration());
  if (generation === null) return { ok: false, code: 'stale_generation' };
  const result = await window.pev.openStub(id, generation);
  if (result.ok) {
    const f = document.createElement('iframe');
    f.className = 'body-frame';
    f.title = 'Message body';
    f.setAttribute('sandbox', BODY_IFRAME_SANDBOX);
    f.referrerPolicy = BODY_IFRAME_REFERRER;
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:640px;height:480px;border:0';
    f.src = result.url;
    document.body.append(f);
  } else if (result.code === 'stale_generation') {
    await refreshGeneration();
  }
  return result;
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
    const opened = await openStub('sample');
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
    /** The search's state, with the shown rows as conversation IDs. */
    search: () => {
      const { rows, ...rest } = search.snapshot;
      return { ...rest, threadIds: rows.map((r) => r.threadId) };
    },
    /** The conversation's cards: which one is expanded, and what is held. */
    cards: () => cards.snapshot,
    /** Reads the cards again, as a scroll past the cards held does. */
    refreshCards: () => cards.refresh(),
    /** The lead lines held for the list's rows and for the cards, by message. */
    leads: (which: 'list' | 'cards') =>
      Object.fromEntries(which === 'list' ? listLeads.snapshot : cardLeads.snapshot),
    /** Body frames in the shell's own tree, with their URLs. */
    readerFrames: () =>
      [...document.querySelectorAll<HTMLIFrameElement>('iframe.rp-frame')].map((f) => f.src),
    refreshGeneration,
    open: (id: string) => openStub(id),
    /** Opens a message in the reader pane. */
    openInReader: (rowid: number, mode?: OpenMode) => openInReader(rowid, mode),
    closeReader,
    reader: () => getReaderState(),
    /** The export and generation the mail follows, `<sourceKey>:<generation>`; null with none. */
    mailboxKey: () => getMailboxState().key,
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
    /** Makes the shell throw on each render while on; the sources are read again to render. */
    renderFault: async (on: boolean) => {
      (window as unknown as { __pevTestRenderFault?: boolean }).__pevTestRenderFault = on;
      await refreshSources();
    },
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
