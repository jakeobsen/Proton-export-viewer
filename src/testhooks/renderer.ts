// SPDX-License-Identifier: AGPL-3.0-or-later
// Shell test hooks, reached by tests as window.__pevTest.

import { reportError } from '../renderer/errors';
import { getShellState, openMessage, refreshGeneration } from '../renderer/shell';
import { markLoaded } from './marker';

markLoaded();

function frame(): HTMLIFrameElement | null {
  return document.querySelector('iframe.body-frame');
}

export function install(): void {
  const api = {
    state: () => getShellState(),
    refreshGeneration,
    open: (id: string) => openMessage(id),
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
    log: (markers: string) =>
      window.pev.log('info', 'test.log', { subject: markers, path: markers, reason: markers }),
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
