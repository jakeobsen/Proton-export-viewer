// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader state: the message in the reader pane and how it is shown. Every
// open, a switch between plain text and HTML included, is a new open in main
// with its own token. The old body frame goes as soon as an open starts.

import { useSyncExternalStore } from 'react';
import type { MessageOpenResult, RejectCode } from '../shared/api';
import type { OpenMode } from '../shared/reader-protocol';
import { clearLink, getShellState, refreshGeneration } from './shell';

export type ReaderView = Extract<MessageOpenResult, { outcome: 'view' }>;

export interface ReaderState {
  /** The message in the pane, or null when the pane is closed. */
  rowid: number | null;
  /** The mode of the latest open. */
  mode: OpenMode;
  /** An open is in flight; nothing is shown meanwhile. */
  pending: boolean;
  view: ReaderView | null;
  /** The reader couldn't render the message. */
  fallback: boolean;
  /** Main refused the open. */
  refused: RejectCode | null;
}

const CLOSED: ReaderState = {
  rowid: null,
  mode: 'html',
  pending: false,
  view: null,
  fallback: false,
  refused: null,
};

let state: ReaderState = CLOSED;
let latest = 0;
let openGeneration: number | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<ReaderState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getReaderState(): ReaderState {
  return state;
}

export function useReaderState(): ReaderState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Opens a message in the reader pane; HTML unless another mode is asked for. */
export async function openInReader(
  rowid: number,
  mode: OpenMode = 'html',
): Promise<MessageOpenResult> {
  latest += 1;
  const mine = latest;
  clearLink();
  update({ rowid, mode, pending: true, view: null, fallback: false, refused: null });
  const generation = getShellState().generation ?? (await refreshGeneration().catch(() => null));
  if (generation === null) {
    if (mine === latest) update({ pending: false, refused: 'stale_generation' });
    return { ok: false, code: 'stale_generation' };
  }
  openGeneration = generation;
  let result: MessageOpenResult;
  try {
    result = await window.pev.open(rowid, mode, generation);
  } catch {
    // The call itself failed: the pane ends refused, not pending.
    result = { ok: false, code: 'core_unavailable' };
  }
  // A newer open owns the pane now.
  if (mine !== latest) return result;
  if (!result.ok) {
    update({ pending: false, refused: result.code });
    if (result.code === 'stale_generation') await refreshGeneration();
  } else if (result.outcome === 'fallback') {
    update({ pending: false, fallback: true });
  } else {
    update({ pending: false, view: result });
  }
  return result;
}

/** Closes the pane and any link dialog that came from its body. */
export function closeReader(): void {
  latest += 1;
  openGeneration = null;
  clearLink();
  if (state !== CLOSED) {
    state = CLOSED;
    for (const listener of listeners) listener();
  }
}

/** Closes the pane when the generation moved on: main has revoked its view. */
export function generationChanged(generation: number | null): void {
  if (state.rowid !== null && openGeneration !== null && generation !== openGeneration) {
    closeReader();
  }
}
