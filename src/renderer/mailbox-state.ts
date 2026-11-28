// SPDX-License-Identifier: AGPL-3.0-or-later
// The open export's folders, the folder on screen and its list, the search
// and its results, and where indexing stands. Everything is read for the
// shell's current generation; the folders and the list are read again when
// main reports that the index moved on, and results are not.

import { useSyncExternalStore } from 'react';
import type {
  CardKeyName,
  IndexResult,
  IndexUpdate,
  SearchRequest,
  SnippetsRequest,
} from '../shared/api';
import type {
  CardRow,
  IndexProgress,
  SearchSort,
  Sidebar,
  ThreadSnippet,
} from '../shared/index-types';
import { INBOX, sidebarModel, type SidebarModel } from './folders';
import { CardsModel } from './cards';
import { ListModel, type Row } from './list';
import { closeReaderAndView, getReaderState, openInReader, setReaderSearch } from './reader';
import { SearchModel, type ResultRow } from './search';
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

/**
 * Runs an index read for the current generation; null if there is no answer
 * for it, or the call failed.
 */
async function ask<T>(run: (generation: number) => Promise<IndexResult<T>>): Promise<T | null> {
  let result: IndexResult<T>;
  try {
    const generation = getShellState().generation ?? (await refreshGeneration());
    if (generation === null) return null;
    result = await run(generation);
  } catch {
    return null;
  }
  if (!result.ok) {
    if (result.code === 'stale_generation') await refreshGeneration().catch(() => null);
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

/** Snippets for rows of the shown search; null if the answer isn't for the current export. */
async function askSnippets(request: SnippetsRequest): Promise<ThreadSnippet[] | null> {
  try {
    const generation = getShellState().generation;
    if (generation === null) return null;
    const result = await window.pev.searchSnippets(request, generation);
    if (!result.ok || state.key === null || keyOf(result.generation) !== state.key) return null;
    return result.snippets;
  } catch {
    return null;
  }
}

export const search = new SearchModel(
  (request: SearchRequest) =>
    ask(async (generation) => {
      const result = await window.pev.search(request, generation);
      return result.ok
        ? {
            ok: true,
            generation: result.generation,
            answer: result.page,
            progress: result.progress,
          }
        : result;
    }),
  askSnippets,
  () => {
    for (const listener of listeners) listener();
  },
);

export function useSearch() {
  return useSyncExternalStore(subscribe, () => search.snapshot);
}

/**
 * The showing of cards a selected result put on screen. A conversation's ID
 * can change while it shows (a merge or split), so what a result opened is
 * told by its showing, not by its conversation.
 */
let resultShowing: number | null = null;

/** Results go away: the conversation a result opened goes with them. */
function leaveSearch(drop: () => void): void {
  const owned = resultShowing;
  resultShowing = null;
  setReaderSearch(null);
  drop();
  if (owned !== null && cards.showing === owned) {
    cards.hide();
    closeReaderAndView();
  }
}

/** The search box's text changed. */
export function setSearchText(text: string): void {
  if (text.trim() === '') leaveSearch(() => search.setText(text));
  else search.setText(text);
}

export function setSearchSort(sort: SearchSort): void {
  search.setSort(sort);
}

/** Empties the search box; the folder's list shows again. */
export function clearSearch(): void {
  leaveSearch(() => search.clear());
}

/**
 * Selects a result and shows its conversation's cards, with its newest
 * matching message expanded in the reader. The list's selection goes: the
 * reader no longer shows it. Opens in that conversation are made from the
 * search, so the reader shows how each message matched it.
 */
export function selectResult(row: ResultRow): void {
  search.select(row);
  list.clearSelection();
  setReaderSearch(search.currentQueryId);
  const reader = getReaderState();
  const shown = cards.snapshot;
  if (
    shown.shown &&
    shown.expanded === row.anchorRowid &&
    reader.rowid === row.anchorRowid &&
    reader.refused === null
  ) {
    // Shown already; with the list's selection gone, the result owns it. Its
    // next open, by a card, a key or the body switch, is made from the search.
    resultShowing = cards.showing;
    return;
  }
  cards.show(row.anchorRowid, row.threadId);
  resultShowing = cards.showing;
}

/** The selected conversation's cards; the expanded one is open in the reader. */
export const cards = new CardsModel(
  (query) => ask((generation) => window.pev.cards(query, generation)),
  () => {
    for (const listener of listeners) listener();
  },
  {
    open: (rowid) => void openInReader(rowid),
    close: closeReaderAndView,
  },
);

export function useCards() {
  return useSyncExternalStore(subscribe, () => cards.snapshot);
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
      cards.refresh();
    }
    return;
  }
  const sameExport = key !== null && state.key?.split(':')[0] === key.split(':')[0];
  const folder = sameExport ? state.folder : INBOX;
  // Results belong to the generation that answered them.
  search.clear();
  update({ key, sidebar: null, progress: null, folder });
  list.reset(key === null ? null : folder);
  // A new export or generation: main revoked the reader's view, and nothing is selected.
  setReaderSearch(null);
  cards.hide();
  if (key !== null) void readSidebar();
}

/** Main reports that the index moved on. */
export function indexChanged(update_: IndexUpdate): void {
  if (keyOf(update_.generation) !== state.key || state.key === null) return;
  setProgress(update_.progress);
  void readSidebar();
  list.refresh();
  cards.refresh();
}

export function showFolder(id: string): void {
  // A folder picked while results show takes their place.
  if (search.snapshot.active || search.snapshot.text !== '') clearSearch();
  if (id === state.folder) return;
  update({ folder: id });
  list.reset(id);
  // Nothing is selected in the new folder, so nothing is open.
  cards.hide();
  closeReaderAndView();
}

/**
 * Selects a conversation, by a click or a key, and shows its cards with its
 * newest message, in whatever folder or label it is, expanded in the reader.
 * The conversation already shown stays as it is, unless its open was refused.
 */
export function selectRow(row: Row): void {
  list.select(row);
  // A row of the folder's list: its opens aren't from a search.
  setReaderSearch(null);
  const reader = getReaderState();
  const shown = cards.snapshot;
  if (
    shown.shown &&
    shown.expanded === row.newestRowid &&
    reader.rowid === row.newestRowid &&
    reader.refused === null
  ) {
    return;
  }
  cards.show(row.newestRowid, row.threadId);
}

/** Expands a card: its message opens in the reader, and the old view is revoked. */
export function expandCard(card: CardRow): void {
  if (cards.expand(card)) return;
  // The card already expanded: open it again only if its open was refused.
  const reader = getReaderState();
  if (reader.rowid === card.rowid && reader.refused !== null) void openInReader(card.rowid);
}

/**
 * `n` expands the next newer card, `p` the next older one, stopping at either
 * end; the list selection stays. Nothing moves while the link dialog is open.
 */
export function moveCard(key: CardKeyName): void {
  if (getShellState().link !== null) return;
  cards.move(key === 'n' ? 1 : -1);
}
