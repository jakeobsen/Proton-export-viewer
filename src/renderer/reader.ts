// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader state: the message in the reader pane and how it is shown. Every
// open, a switch between plain text and HTML included, is a new open in main
// with its own token. The old body frame goes as soon as an open starts. The
// source view of the message shows in the pane in its place, under the same
// open.

import { useSyncExternalStore } from 'react';
import type {
  MessageOpenResult,
  ReaderActionResult,
  RejectCode,
  SourceNode,
  SourceResult,
} from '../shared/api';
import type { OpenMode } from '../shared/reader-protocol';
import { clearLink, getShellState, refreshGeneration } from './shell';

export type ReaderView = Extract<MessageOpenResult, { outcome: 'view' }>;

/** The source view of the pane's message. */
export interface SourceState {
  /** The body frame's URL for the header block shown; null until the first arrives. */
  url: string | null;
  /** The block shown was cut to the cap. */
  truncated: boolean;
  /** The tree; null while it loads, or when the structure couldn't be read. */
  parts: SourceNode[] | null;
  tree: 'loading' | 'ready' | 'none';
  /** The part whose headers show, by path; '1' is the message. */
  selected: string;
  /** Main refused the source view. */
  refused: RejectCode | null;
}

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
  /** The open the pane shows, a view or a fallback; actions on it name it. */
  openId: number | null;
  /** Set while the source view shows. */
  source: SourceState | null;
}

const CLOSED: ReaderState = {
  rowid: null,
  mode: 'html',
  pending: false,
  view: null,
  fallback: false,
  refused: null,
  openId: null,
  source: null,
};

let state: ReaderState = CLOSED;
let latest = 0;
let openGeneration: number | null = null;
/** Counts source views opened and left, so a late answer for an old one is dropped. */
let sourceSession = 0;
/** Counts part selections, so a late answer for an older one is dropped. */
let selection = 0;
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
  sourceSession += 1;
  update({
    rowid,
    mode,
    pending: true,
    view: null,
    fallback: false,
    refused: null,
    openId: null,
    source: null,
  });
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
    update({ pending: false, fallback: true, openId: result.openId });
  } else {
    update({ pending: false, view: result, openId: result.openId });
  }
  return result;
}

async function guardedCall<T extends { ok: boolean }>(
  call: () => Promise<T>,
): Promise<T | { ok: false; code: RejectCode }> {
  try {
    return await call();
  } catch {
    return { ok: false, code: 'core_unavailable' };
  }
}

/**
 * Shows the source view of the pane's message, a view or a fallback: the
 * message's raw headers first, then the tree, which the headers never wait for.
 */
export async function openSource(): Promise<void> {
  const { openId } = state;
  const generation = openGeneration;
  if (openId === null || generation === null || state.source !== null) return;
  sourceSession += 1;
  selection += 1;
  const session = sourceSession;
  const mine = selection;
  update({
    source: {
      url: null,
      truncated: false,
      parts: null,
      tree: 'loading',
      selected: '1',
      refused: null,
    },
  });
  const shown = await guardedCall(() => window.pev.viewSource(openId, generation));
  const afterShow = sourceNow();
  if (session !== sourceSession || !afterShow) return;
  if (!shown.ok) {
    update({ source: { ...afterShow, refused: shown.code, tree: 'none' } });
    return;
  }
  if (mine === selection) {
    update({ source: { ...afterShow, url: shown.url, truncated: shown.truncated } });
  }
  const tree = await guardedCall(() => window.pev.sourceTree(openId, generation));
  const afterTree = sourceNow();
  if (session !== sourceSession || !afterTree) return;
  const parts = tree.ok ? tree.parts : null;
  update({ source: { ...afterTree, parts, tree: parts ? 'ready' : 'none' } });
}

/** The source view as it is now, read again after each wait. */
function sourceNow(): SourceState | null {
  return state.source;
}

/** Shows one part's raw headers in the source view; '1' is the message. */
export async function selectPart(path: string): Promise<SourceResult | null> {
  const { openId } = state;
  const generation = openGeneration;
  if (openId === null || generation === null || !state.source) return null;
  if (state.source.selected === path && state.source.url !== null) return null;
  selection += 1;
  const session = sourceSession;
  const mine = selection;
  update({ source: { ...state.source, selected: path } });
  const shown = await guardedCall(() =>
    window.pev.sourcePart(openId, path === '1' ? null : path, generation),
  );
  if (session !== sourceSession || mine !== selection || !state.source) return shown;
  if (shown.ok) {
    update({
      source: { ...state.source, url: shown.url, truncated: shown.truncated, refused: null },
    });
  } else if (shown.code !== 'superseded') {
    update({ source: { ...state.source, url: null, refused: shown.code } });
  }
  return shown;
}

/** Copies the header block the source view shows. */
export async function copyHeaders(): Promise<ReaderActionResult> {
  const { openId } = state;
  const generation = openGeneration;
  if (openId === null || generation === null || !state.source) {
    return { ok: false, code: 'superseded' };
  }
  return guardedCall(() => window.pev.copyHeaders(openId, generation));
}

/**
 * Leaves the source view. Main authorizes the message's body again first;
 * only then does the pane show it.
 */
export async function leaveSource(): Promise<void> {
  const { openId } = state;
  const generation = openGeneration;
  if (!state.source || openId === null || generation === null) return;
  sourceSession += 1;
  selection += 1;
  const session = sourceSession;
  await guardedCall(() => window.pev.sourceBack(openId, generation));
  if (session === sourceSession && state.openId === openId) update({ source: null });
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
  // A source view still showing is left in main too, so nothing more is authorized for it.
  const { openId, source } = state;
  const generation = openGeneration;
  if (source !== null && openId !== null && generation !== null) {
    void guardedCall(() => window.pev.sourceBack(openId, generation));
  }
  sourceSession += 1;
  selection += 1;
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
