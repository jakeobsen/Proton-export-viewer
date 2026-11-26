// SPDX-License-Identifier: AGPL-3.0-or-later
// The open export's folders, the folder on screen and its list, and where
// indexing stands. Everything is read for the shell's current generation and
// read again when main reports that the index moved on.

import { useSyncExternalStore } from 'react';
import type { IndexResult, IndexUpdate } from '../shared/api';
import type { IndexProgress, Sidebar } from '../shared/index-types';
import { INBOX, sidebarModel, type SidebarModel } from './folders';
import { ListModel } from './list';
import { getShellState, refreshGeneration } from './shell';

export interface MailboxState {
  /** The export and generation everything below was read for. */
  key: string | null;
  sidebar: SidebarModel | null;
  folder: string;
  progress: IndexProgress | null;
}

let state: MailboxState = { key: null, sidebar: null, folder: INBOX, progress: null };
const listeners = new Set<() => void>();

function update(patch: Partial<MailboxState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMailboxState(): MailboxState {
  return state;
}

export function useMailbox(): MailboxState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Runs an index read for the current generation; null if there is no answer for it. */
async function ask<T>(run: (generation: number) => Promise<IndexResult<T>>): Promise<T | null> {
  const generation = getShellState().generation ?? (await refreshGeneration());
  if (generation === null) return null;
  const result = await run(generation);
  if (!result.ok) {
    if (result.code === 'stale_generation') await refreshGeneration();
    return null;
  }
  if (state.key === null || keyOf(result.generation) !== state.key) return null;
  setProgress(result.progress);
  return result.answer;
}

/**
 * Answers and reports arrive by different routes, so an older one can come
 * last: within a phase, a count never goes back.
 */
function setProgress(next: IndexProgress): void {
  const now = state.progress;
  if (
    now &&
    now.phase === next.phase &&
    now.condition === next.condition &&
    next.loaded < now.loaded
  ) {
    return;
  }
  update({ progress: next });
}

export const list = new ListModel(
  (query) => ask((generation) => window.pev.listWindow(query, generation)),
  () => {
    for (const listener of listeners) listener();
  },
);

export function useList() {
  return useSyncExternalStore(subscribe, () => list.snapshot);
}

const keyOf = (generation: number | null): string | null => {
  const active = getShellState().sources?.active;
  return active && generation !== null ? `${active.sourceKey}:${generation}` : null;
};

let readingSidebar = false;
let sidebarAgain = false;

async function readSidebar(): Promise<void> {
  if (readingSidebar) {
    sidebarAgain = true;
    return;
  }
  readingSidebar = true;
  try {
    const answer: Sidebar | null = await ask((generation) => window.pev.sidebar(generation));
    if (answer) update({ sidebar: sidebarModel(answer) });
  } finally {
    readingSidebar = false;
    if (sidebarAgain) {
      sidebarAgain = false;
      void readSidebar();
    }
  }
}

/**
 * Follows the shell's export and generation. A new one starts over: its
 * index is read from scratch, in the same folder for the same export, else
 * in the Inbox. The same one is read again.
 */
export function syncMailbox(): void {
  const key = keyOf(getShellState().generation);
  if (key === state.key) {
    if (key !== null) {
      void readSidebar();
      list.refresh();
    }
    return;
  }
  const sameExport = key !== null && state.key?.split(':')[0] === key.split(':')[0];
  const folder = sameExport ? state.folder : INBOX;
  update({ key, sidebar: null, progress: null, folder });
  list.reset(key === null ? null : folder);
  if (key !== null) void readSidebar();
}

/** Main reports that the index moved on. */
export function indexChanged(update_: IndexUpdate): void {
  if (keyOf(update_.generation) !== state.key || state.key === null) return;
  setProgress(update_.progress);
  void readSidebar();
  list.refresh();
}

export function showFolder(id: string): void {
  if (id === state.folder) return;
  update({ folder: id });
  list.reset(id);
}
