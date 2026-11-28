// SPDX-License-Identifier: AGPL-3.0-or-later
// The search box's model. A search runs once typing pauses, and only the
// latest search's answer is shown. Results come a page at a time as the view
// nears their end. Each page is read from the index as it is then, so a
// conversation already shown can come again on a later page; it is left out.
// The next page always continues after the last row core returned, shown or
// not, so a page made only of such rows still moves on. Rows that came
// without a snippet get one when they are on screen, by a request for that
// search.

import type { SearchRequest, SnippetsRequest } from '../shared/api';
import {
  MAX_SNIPPET_THREADS,
  type MarkedSnippet,
  type RowDetails,
  type SearchCoverage,
  type SearchKey,
  type SearchPage,
  type SearchRow,
  type SearchSort,
  type ThreadSnippet,
} from '../shared/index-types';
import { partText } from '../shared/header-text';
import { searchKey, type Chip } from '../shared/search-chips';
import { formatCount } from './format';

/** How long typing must pause before a search runs, in milliseconds. */
export const TYPING_PAUSE_MS = 150;
/** Every result row has this height, in pixels. */
export const RESULT_ROW_HEIGHT = 102;
/** Rows beyond the screen that must be held before the next page is read. */
export const RESULTS_MARGIN = 10;

export interface ResultRow extends SearchRow {
  details: RowDetails | null;
}

export interface SearchSnapshot {
  /** The text in the box. */
  text: string;
  /** The chips beside it. */
  chips: Chip[];
  /** The text the shown results are for; null while none are shown. */
  resultsFor: string | null;
  /** Results show in place of the folder's list: the box has text, or there are chips. */
  active: boolean;
  /** The sort asked for. */
  sort: SearchSort;
  /** A new search's first page is awaited. */
  searching: boolean;
  /** The latest search got no answer. */
  failed: boolean;
  /** Whether the shown query has words that rank its matches. */
  ranked: boolean;
  rows: ResultRow[];
  /** Matching conversations, as the first page counted them. */
  total: number | null;
  coverage: SearchCoverage | null;
  /** The selected result: its conversation and the message it opened. */
  selected: { threadId: number; rowid: number } | null;
  /** Rows of later pages left out because their conversation was already shown. */
  skipped: number;
  /** Bumped when a new search's results are shown: the list starts at the top. */
  shownId: number;
}

/** Runs one search request; null when there is no answer for the current export. */
export type RunSearch = (request: SearchRequest) => Promise<SearchPage | null>;
/** Asks for snippets of a search's rows; null when there is no answer for it. */
export type RunSnippets = (request: SnippetsRequest) => Promise<ThreadSnippet[] | null>;

const IDLE: SearchSnapshot = {
  text: '',
  chips: [],
  resultsFor: null,
  active: false,
  sort: 'date',
  searching: false,
  failed: false,
  ranked: false,
  rows: [],
  total: null,
  coverage: null,
  selected: null,
  skipped: 0,
  shownId: 0,
};

/** A page's rows with their details. */
function rowsOf(page: SearchPage): ResultRow[] {
  return page.rows.map((row, i) => {
    const details = page.details[i];
    return { ...row, details: details?.threadId === row.threadId ? details : null };
  });
}

export class SearchModel {
  private snap: SearchSnapshot = IDLE;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped whenever the shown search is left behind: an edit, a new search
   * or an emptied box. An answer asked for before that is dropped.
   */
  private seq = 0;
  /** The shown search's text and chips, its canonical key, and where its next page starts. */
  private shownText: string | null = null;
  private shownChips: Chip[] = [];
  private shownKey: string | null = null;
  /** The search asked for and not yet answered, with what its answer's query ID resolves to. */
  private inFlight: { seq: number; queryId: Promise<number | null> } | null = null;
  private next: SearchKey | null = null;
  private nextSort: SearchSort = 'date';
  private loading = false;
  private shown = new Set<number>();
  private firstOnScreen = 0;
  private lastOnScreen = 0;
  /** The latest page's query ID, which snippet requests name. */
  private queryId: number | null = null;
  /** Conversations whose snippet was asked for. */
  private asked = new Set<number>();
  private askingSnippets = false;

  constructor(
    private readonly run: RunSearch,
    private readonly runSnippets: RunSnippets,
    private readonly onChange: () => void,
    private readonly pauseMs: number = TYPING_PAUSE_MS,
  ) {}

  /** The ID of the search whose results are shown; null with none. */
  get currentQueryId(): number | null {
    return this.queryId;
  }

  get snapshot(): SearchSnapshot {
    return this.snap;
  }

  private set(patch: Partial<SearchSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.onChange();
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** True if the box has no text and there are no chips. */
  private isEmpty(text: string, chips: Chip[]): boolean {
    return text.trim() === '' && chips.length === 0;
  }

  /**
   * The box's text changed: search once typing pauses; an empty box with no
   * chips shows the list again.
   */
  setText(text: string): void {
    this.cancelTimer();
    if (this.isEmpty(text, this.snap.chips)) {
      this.stop({ text });
      return;
    }
    // The shown search no longer matches the box. Its rows stay on screen
    // until the next search answers, but nothing more of it is asked for or
    // installed while typing pauses.
    this.detach();
    this.set({ text });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, this.pauseMs);
  }

  /**
   * The chips changed: the search runs again at once, with the box's text as
   * it is. With no text and no chips left, the list shows again.
   */
  setChips(chips: Chip[]): void {
    this.cancelTimer();
    if (this.isEmpty(this.snap.text, chips)) {
      this.stop({ text: this.snap.text });
      return;
    }
    this.set({ chips });
    this.start();
  }

  /** A whole search, picked from the recent ones: it runs at once. */
  setSearch(text: string, chips: Chip[]): void {
    this.cancelTimer();
    if (this.isEmpty(text, chips)) {
      this.stop({ text });
      return;
    }
    this.set({ text, chips });
    this.start();
  }

  /** Another sort: the search runs again at once. */
  setSort(sort: SearchSort): void {
    if (sort === this.snap.sort) return;
    this.set({ sort });
    if (this.isEmpty(this.snap.text, this.snap.chips)) return;
    this.cancelTimer();
    this.start();
  }

  /** Empties the box, removes the chips and drops the results. */
  clear(): void {
    this.cancelTimer();
    this.stop({ text: '' });
  }

  /**
   * Enter in the box: the query ID of the search for the box's text and
   * chips as they are now, to commit. The typing pause is cut short: that
   * search runs at once, unless it is the one shown. Null if there is none,
   * or if a newer search takes its place before it answers.
   */
  enterQueryId(): Promise<number | null> {
    const { text, chips } = this.snap;
    if (this.isEmpty(text, chips)) return Promise.resolve(null);
    if (this.timer !== null) {
      this.cancelTimer();
    } else if (this.shownKey === searchKey({ text, chips }) && this.queryId !== null) {
      return Promise.resolve(this.queryId);
    } else if (this.inFlight?.seq === this.seq) {
      return this.inFlight.queryId;
    }
    this.start();
    return this.inFlight?.queryId ?? Promise.resolve(null);
  }

  private stop(patch: Partial<SearchSnapshot>): void {
    this.detach();
    this.set({ ...IDLE, sort: this.snap.sort, shownId: this.snap.shownId, ...patch });
  }

  private start(): void {
    this.detach();
    const seq = this.seq;
    const { text, chips, sort } = this.snap;
    this.set({ active: true, searching: true, failed: false });
    const request: SearchRequest = { text, chips, sort, after: null } as SearchRequest;
    let answered: (queryId: number | null) => void = () => {};
    this.inFlight = { seq, queryId: new Promise((resolve) => (answered = resolve)) };
    void this.run(request)
      .catch(() => null)
      .then((page) => {
        if (seq !== this.seq) {
          answered(null);
          return;
        }
        this.forget();
        answered(page ? page.queryId : null);
        if (!page) {
          this.set({
            searching: false,
            failed: true,
            resultsFor: null,
            rows: [],
            total: null,
            skipped: 0,
          });
          return;
        }
        const rows = rowsOf(page).filter(
          (row, i, all) => all.findIndex((r) => r.threadId === row.threadId) === i,
        );
        this.shownText = text;
        this.shownChips = chips;
        this.shownKey = searchKey({ text, chips });
        this.queryId = page.queryId;
        this.next = page.next;
        this.nextSort = page.sort;
        this.shown = new Set(rows.map((r) => r.threadId));
        // The view starts at the top again, as tall as it was.
        this.lastOnScreen -= this.firstOnScreen;
        this.firstOnScreen = 0;
        this.set({
          searching: false,
          resultsFor: text,
          rows,
          total: page.total,
          coverage: page.coverage,
          ranked: page.ranked,
          skipped: 0,
          shownId: this.snap.shownId + 1,
        });
        this.readMore();
        this.readSnippets();
      });
  }

  /**
   * Answers still coming for the shown search no longer count, and none of
   * its pages or snippets are asked for again. Its rows stay as they are.
   */
  private detach(): void {
    this.seq += 1;
    this.forget();
  }

  /** Drops what belongs to the shown search. */
  private forget(): void {
    this.shownText = null;
    this.shownChips = [];
    this.shownKey = null;
    this.inFlight = null;
    this.queryId = null;
    this.next = null;
    this.loading = false;
    this.shown = new Set();
    this.asked = new Set();
    this.askingSnippets = false;
  }

  /**
   * The positions on screen, first and last. The next page is read when the
   * view nears the end, and the rows on screen get their snippets.
   */
  setViewport(first: number, last: number): void {
    this.firstOnScreen = Math.max(0, first);
    this.lastOnScreen = Math.max(this.firstOnScreen, last);
    this.readMore();
    this.readSnippets();
  }

  /**
   * Asks for the snippets of rows on screen that have none, for the shown
   * search, one request at a time. A conversation is asked for once; if no
   * answer comes, the next change of view asks again.
   */
  private readSnippets(): void {
    if (this.askingSnippets || !this.snap.ranked || this.queryId === null) return;
    const rows = this.snap.rows;
    const want: number[] = [];
    const last = Math.min(this.lastOnScreen, rows.length - 1);
    for (let i = this.firstOnScreen; i <= last && want.length < MAX_SNIPPET_THREADS; i += 1) {
      const row = rows[i]!;
      if (row.snippet === null && !this.asked.has(row.threadId)) want.push(row.threadId);
    }
    if (want.length === 0) return;
    for (const threadId of want) this.asked.add(threadId);
    this.askingSnippets = true;
    const seq = this.seq;
    void this.runSnippets({ queryId: this.queryId, threadIds: want })
      .catch(() => null)
      .then((snippets) => {
        if (seq !== this.seq) return;
        this.askingSnippets = false;
        if (!snippets) {
          for (const threadId of want) this.asked.delete(threadId);
          return;
        }
        const found = new Map<number, MarkedSnippet>();
        for (const s of snippets)
          if (s.snippet && want.includes(s.threadId)) found.set(s.threadId, s.snippet);
        if (found.size > 0) {
          this.set({
            rows: this.snap.rows.map((row) => {
              const snippet = row.snippet === null ? found.get(row.threadId) : undefined;
              return snippet ? { ...row, snippet } : row;
            }),
          });
        }
        this.readSnippets();
      });
  }

  private readMore(): void {
    if (this.loading || this.snap.searching || this.next === null || this.shownText === null) {
      return;
    }
    if (this.lastOnScreen + RESULTS_MARGIN < this.snap.rows.length) return;
    this.loading = true;
    const seq = this.seq;
    // The keyset is for the sort core used, which is by date for a query with no words.
    const request = {
      text: this.shownText,
      chips: this.shownChips,
      sort: this.nextSort,
      after: this.next,
    } as SearchRequest;
    void this.run(request)
      .catch(() => null)
      .then((page) => {
        if (seq !== this.seq) return;
        this.loading = false;
        // Without an answer, the next scroll tries again.
        if (!page) return;
        this.next = page.next;
        this.queryId = page.queryId;
        const fresh = rowsOf(page).filter((row) => {
          if (this.shown.has(row.threadId)) return false;
          this.shown.add(row.threadId);
          return true;
        });
        this.set({
          rows: fresh.length > 0 ? [...this.snap.rows, ...fresh] : this.snap.rows,
          coverage: page.coverage,
          skipped: this.snap.skipped + page.rows.length - fresh.length,
        });
        this.readMore();
        this.readSnippets();
      });
  }

  /** The row at a position, if it is held. */
  rowAt(index: number): ResultRow | null {
    return this.snap.rows[index] ?? null;
  }

  select(row: ResultRow): void {
    this.set({ selected: { threadId: row.threadId, rowid: row.anchorRowid } });
  }

  /** The position of the selected row, if it is shown. */
  selectedIndex(): number | null {
    const selected = this.snap.selected;
    if (!selected) return null;
    const i = this.snap.rows.findIndex((r) => r.threadId === selected.threadId);
    return i < 0 ? null : i;
  }
}

export interface SnippetPart {
  text: string;
  mark: boolean;
}

/**
 * A snippet's parts as a line shows them: each cleaned on its own, so a
 * removed character only shortens its part and a mark stays on its text,
 * with the line's ends trimmed. Parts left empty are dropped.
 */
export function cleanParts(parts: SnippetPart[]): SnippetPart[] {
  const last = parts.length - 1;
  return parts
    .map((part, i) => {
      let text = partText(part.text);
      if (i === 0) text = text.trimStart();
      if (i === last) text = text.trimEnd();
      return { text, mark: part.mark };
    })
    .filter((part) => part.text !== '');
}

/**
 * A snippet as plain and marked parts. Ranges that aren't ascending,
 * separate and within the text give the text without marks.
 */
export function snippetParts(snippet: MarkedSnippet): SnippetPart[] {
  const { text, ranges } = snippet;
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const range of ranges) {
    const [start, end] = range;
    const valid =
      Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= at && end > start;
    if (!valid || end > text.length) return text === '' ? [] : [{ text, mark: false }];
    if (start > at) parts.push({ text: text.slice(at, start), mark: false });
    parts.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}

/** "1 conversation", "1,200 conversations". */
export function conversationsText(n: number): string {
  return `${formatCount(n)} ${n === 1 ? 'conversation' : 'conversations'}`;
}

/** The partial line, while bodies still wait to be indexed; null once none do. */
export function partialText(coverage: SearchCoverage | null): string | null {
  if (coverage === null || coverage.pending === 0) return null;
  return `Partial results: ${formatCount(coverage.indexed)} of ${formatCount(coverage.total)} bodies indexed.`;
}
