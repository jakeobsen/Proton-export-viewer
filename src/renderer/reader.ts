// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader state: the message in the reader pane and how it is shown. Every
// open, a switch between plain text and HTML included, is a new open in main
// with its own token. The old body frame goes as soon as an open starts.
// While the conversation shown came from a search result, every open carries
// that search's ID, so main can say how the message matched it.

import { useSyncExternalStore } from 'react';
import type { MessageOpenResult, ReaderActionResult, RejectCode } from '../shared/api';
import type { OpenMode, ReaderMatch } from '../shared/reader-protocol';
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
  /** The search the latest open was made from; null outside search. */
  queryId: number | null;
  /** How the message matched that search: on a view, the fallback or a missing file. */
  match: ReaderMatch | null;
}

const CLOSED: ReaderState = {
  rowid: null,
  mode: 'html',
  pending: false,
  view: null,
  fallback: false,
  refused: null,
  queryId: null,
  match: null,
};

let state: ReaderState = CLOSED;
let latest = 0;
let openGeneration: number | null = null;
let searchQueryId: number | null = null;

/**
 * The search whose result showed the conversation in the reader, or null
 * once the reader no longer shows a result's conversation. Later opens carry it.
 */
export function setReaderSearch(queryId: number | null): void {
  searchQueryId = queryId;
}
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
  const queryId = searchQueryId;
  clearLink();
  update({
    rowid,
    mode,
    pending: true,
    view: null,
    fallback: false,
    refused: null,
    queryId,
    match: null,
  });
  const generation = getShellState().generation ?? (await refreshGeneration().catch(() => null));
  if (generation === null) {
    if (mine === latest) update({ pending: false, refused: 'stale_generation' });
    return { ok: false, code: 'stale_generation' };
  }
  openGeneration = generation;
  let result: MessageOpenResult;
  try {
    result = await (queryId === null
      ? window.pev.open(rowid, mode, generation)
      : window.pev.open(rowid, mode, generation, queryId));
  } catch {
    // The call itself failed: the pane ends refused, not pending.
    result = { ok: false, code: 'core_unavailable' };
  }
  // A newer open owns the pane now.
  if (mine !== latest) return result;
  if (!result.ok) {
    const match = 'match' in result ? result.match : null;
    update({ pending: false, refused: result.code, match });
    if (result.code === 'stale_generation') await refreshGeneration();
  } else if (result.outcome === 'fallback') {
    update({ pending: false, fallback: true, match: result.match });
  } else {
    update({ pending: false, view: result, match: result.match });
  }
  return result;
}

/** An action on the message the pane shows, such as Show in folder, by its view's open. */
async function viewAction(
  act: (openId: number, generation: number) => Promise<ReaderActionResult>,
): Promise<ReaderActionResult> {
  const view = state.view;
  if (!view || openGeneration === null) return { ok: false, code: 'superseded' };
  try {
    return await act(view.openId, openGeneration);
  } catch {
    return { ok: false, code: 'core_unavailable' };
  }
}

/** Shows the pane's message file in Finder. */
export function showInFolder(): Promise<ReaderActionResult> {
  return viewAction((openId, generation) => window.pev.showInFolder(openId, generation));
}

/** Copies the pane's message's Message-ID. */
export function copyMessageId(): Promise<ReaderActionResult> {
  return viewAction((openId, generation) => window.pev.copyMessageId(openId, generation));
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

/**
 * Closes the pane and has main revoke its view and any open still under way,
 * so nothing it was showing or about to show stays reachable.
 */
export function closeReaderAndView(): void {
  const open = state.rowid !== null;
  closeReader();
  if (!open) return;
  const generation = getShellState().generation;
  if (generation === null) return;
  void window.pev.closeView(generation).catch(() => undefined);
}

/** Closes the pane when the generation moved on: main has revoked its view. */
export function generationChanged(generation: number | null): void {
  if (state.rowid !== null && openGeneration !== null && generation !== openGeneration) {
    closeReader();
  }
}
