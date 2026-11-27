// SPDX-License-Identifier: AGPL-3.0-or-later
// Shell test hooks, reached by tests as window.__pevTest.

import { reportError } from '../renderer/errors';
import { list } from '../renderer/mailbox-state';
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

export function install(): void {
  const api = {
    state: () => getShellState(),
    listSelection: () => list.snapshot.selected,
    refreshGeneration,
    open: (id: string) => openStub(id),
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
