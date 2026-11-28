// SPDX-License-Identifier: AGPL-3.0-or-later
// What the export index answers: folders and labels with their counts,
// conversation list pages and the details of the rows on screen, plus where
// indexing stands. Shared by core, main and the shell.

export type FolderKind = 'system' | 'folder' | 'label';

export interface FolderRow {
  id: string;
  /** labels.json's name; empty for a system folder the file doesn't list. */
  name: string;
  kind: FolderKind;
  parentId: string | null;
  color: string | null;
  /** Conversations with at least one message in this folder or label. */
  conversations: number;
  /** Conversations with at least one unread message in this folder or label. */
  unread: number;
}

export interface Sidebar {
  folders: FolderRow[];
  /** Label IDs on messages that labels.json doesn't name; they are stored but not shown. */
  hiddenIds: number;
}

/** Where a list page continues: after this conversation, newest first. */
export interface PageKey {
  time: number;
  threadId: number;
}

export interface ListRow {
  threadId: number;
  /** The latest date of the conversation's messages in this folder or label. */
  time: number;
  /** Messages in the whole conversation. */
  count: number;
  /** Unread messages in the whole conversation. */
  unread: number;
  /** Unread messages of this folder or label in the conversation. */
  unreadHere: number;
  /** Whether any of its messages says it has attachments. */
  attachments: boolean;
  /** The conversation's newest message in this folder or label: a selection holds this. */
  anchorRowid: number;
  /** The conversation's newest message in any folder or label: selecting it opens this. */
  newestRowid: number;
}

export interface ListPage {
  rows: ListRow[];
  next: PageKey | null;
}

export interface Participant {
  name: string;
  address: string;
}

export interface RowDetails {
  threadId: number;
  /** The subject of the conversation's earliest message. */
  subject: string;
  /** Up to four distinct senders, oldest first, from its first 200 messages. */
  participants: Participant[];
  /** The folders and labels its messages carry. */
  labelIds: string[];
}

export interface IndexTotals {
  messages: number;
  conversations: number;
  pairs: number;
}

/**
 * Where a list window is placed: at the conversation that holds message
 * `rowid` if there is one, else at the conversation `key` if it is still
 * listed, else at position `index`.
 */
export interface WindowAnchor {
  rowid?: number;
  key?: PageKey;
  index: number;
}

/** The most rows a window holds before its anchor, and from it on. */
export const WINDOW_BEFORE = 100;
export const WINDOW_AFTER = 200;

export interface WindowQuery {
  op: 'window';
  labelId: string;
  anchor: WindowAnchor;
  /** Rows wanted before the anchor row. */
  before: number;
  /** Rows wanted from the anchor row on. */
  after: number;
  /** A selected message, to find the conversation it is in now. */
  selected: number | null;
}

/** A stretch of a folder's or label's list, newest first, read from one snapshot. */
export interface ListWindow {
  /** Conversations in the folder or label. */
  total: number;
  /** The position of the first row. */
  start: number;
  rows: ListRow[];
  /** The details of each row, in the same order. */
  details: RowDetails[];
  /** The anchor row's position, or null if the window was placed by `index`. */
  anchor: number | null;
  /** The conversation the selected message is in now, or null if it is gone. */
  selected: number | null;
}

export type SearchSort = 'date' | 'relevance';

/** The most UTF-16 units of search text a request may carry. */
export const MAX_QUERY_LENGTH = 1000;

/** Where a date-sorted results page continues: after this conversation, newest first. */
export interface SearchDateKey {
  time: number;
  threadId: number;
}

/** Where a relevance-sorted results page continues: after this conversation, best first. */
export interface SearchRankKey {
  rank: number;
  threadId: number;
}

export type SearchKey = SearchDateKey | SearchRankKey;

/** A search of the whole export: one page of matching conversations. */
export type SearchQuery = {
  op: 'search';
  /** Main's ID for this request; the answer carries it back. */
  queryId: number;
  text: string;
} & (
  { sort: 'date'; after: SearchDateKey | null } | { sort: 'relevance'; after: SearchRankKey | null }
);

/** Text with its matches as ranges of UTF-16 code units: ascending, non-overlapping. */
export interface MarkedSnippet {
  text: string;
  ranges: Array<[number, number]>;
}

export interface SearchRow {
  threadId: number;
  /** The date of the conversation's newest matching message. */
  time: number;
  /** The best relevance of its matching messages (lower is better); null when sorted by date. */
  rank: number | null;
  /** Messages in the whole conversation. */
  count: number;
  /** Unread messages in the whole conversation. */
  unread: number;
  /** Whether any of its messages says it has attachments. */
  attachments: boolean;
  /** Its messages that match. */
  matching: number;
  /** The newest matching message (ties to the higher rowid): a selection holds this. */
  anchorRowid: number;
  /**
   * The best-ranked matching message's snippet, for the first rows of a page
   * when the query has words to match; null otherwise.
   */
  snippet: MarkedSnippet | null;
}

/** How much of the export's text the index holds. */
export interface SearchCoverage {
  /** Messages whose body is in the index (whole or its first part). */
  indexed: number;
  /** Messages whose body is still waiting to be indexed. */
  pending: number;
  /** Messages in the index. */
  total: number;
}

export interface SearchPage {
  queryId: number;
  /** The sort used: a query with no words to match is sorted by date. */
  sort: SearchSort;
  /** Whether the query has words that rank its matches, so it can be sorted by relevance. */
  ranked: boolean;
  /** Matching conversations in all, on a first page; null on the pages after it. */
  total: number | null;
  rows: SearchRow[];
  /** The details of each row, in the same order. */
  details: RowDetails[];
  next: SearchKey | null;
  coverage: SearchCoverage;
  /** Snippets whose match ranges failed the check and were given without them. */
  dropped: number;
}

/** The most conversations one snippets request covers. */
export const MAX_SNIPPET_THREADS = 50;

/** Snippets for result rows that came without one: the best match of each conversation. */
export interface SnippetsQuery {
  op: 'snippets';
  /** The search the rows belong to; the answer carries it back. */
  queryId: number;
  text: string;
  threadIds: number[];
}

export interface ThreadSnippet {
  threadId: number;
  /** Null when the conversation has no match with text to show. */
  snippet: MarkedSnippet | null;
}

export interface SearchSnippets {
  queryId: number;
  /** One per conversation asked for, in the same order. */
  snippets: ThreadSnippet[];
  /** Snippets whose match ranges failed the check and were given without them. */
  dropped: number;
}

/** One message of a conversation, as its card shows it. */
export interface CardRow {
  rowid: number;
  time: number;
  senderName: string;
  senderAddress: string;
  /** The message is in Spam (label ID 4). */
  spam: boolean;
  /** The message is in Trash (label ID 3). */
  trash: boolean;
}

/** Where a card stands in its conversation, oldest first: by date, then by rowid. */
export interface CardKey {
  time: number;
  rowid: number;
}

/**
 * Where a cards window is placed: at message `rowid` if it is still in the
 * conversation, else at the card nearest `key` (the next newer one first),
 * else at position `index`.
 */
export interface CardsAnchor {
  rowid?: number;
  key?: CardKey;
  index: number;
}

/** The most cards a window holds before its anchor, and from it on. */
export const CARDS_BEFORE = 100;
export const CARDS_AFTER = 200;
/** The most messages a cards query may name to follow. */
export const CARDS_FOLLOW = 4;

export interface CardsQuery {
  op: 'cards';
  /**
   * Messages that say which conversation to show, in order of preference:
   * the conversation of the first one still in the index.
   */
  follow: number[];
  /** The conversation to show if none of `follow` is left. */
  threadId: number | null;
  anchor: CardsAnchor;
  before: number;
  after: number;
}

/** A stretch of one conversation's cards, oldest first, read from one snapshot. */
export interface CardsWindow {
  /** The conversation shown, or null when there is none left. */
  threadId: number | null;
  /** The message of `follow` that named it; null if none is left. */
  followed: number | null;
  /** The subject of its earliest message. */
  subject: string;
  /** Messages in the conversation, from every folder. */
  total: number;
  /** The position of the first card. */
  start: number;
  cards: CardRow[];
  /** The anchor card's position; null for an empty window. */
  anchor: number | null;
  /** The anchor card is message `anchor.rowid` itself. */
  anchorFound: boolean;
}

export type IndexQuery =
  | { op: 'sidebar' }
  | { op: 'page'; labelId: string; after: PageKey | null; limit?: number }
  | { op: 'details'; threadIds: number[] }
  | { op: 'resolve'; rowid: number }
  | { op: 'totals' }
  | { op: 'eml'; rowid: number }
  | WindowQuery
  | SearchQuery
  | SnippetsQuery
  | CardsQuery;

export type IndexAnswer =
  | Sidebar
  | ListPage
  | RowDetails[]
  | number
  | null
  | IndexTotals
  | ListWindow
  | CardsWindow
  | EmlFile
  | SearchPage
  | SearchSnippets;

/**
 * Where a message's file is, as the scan last saw it: its name relative to the
 * export's folder and its identity. Core only; it never leaves core.
 */
export interface EmlFile {
  /** Null once the pair has no message file. */
  rel: string | null;
  size: number;
  mtimeNs: string;
  dev: string;
  ino: string;
  bodyState: number;
}

/**
 * The index's own state: 'verifying' while an index that was already there
 * is checked; 'rebuilding' while an index made in place of a damaged one is
 * filled; 'damaged' once a damaged index was deleted and the export can't be
 * read to rebuild it.
 */
export type IndexCondition = 'ok' | 'verifying' | 'rebuilding' | 'damaged';

/**
 * Where indexing stands. During phase 1, list pages hold the rows loaded so
 * far; during phase 2, searches find the text of the messages read so far.
 * 'unavailable': the export can't be read, and the index shows what it holds.
 */
export interface IndexProgress {
  phase: 'opening' | 'loading' | 'done' | 'failed' | 'unavailable';
  /** Metadata files handled so far (indexed or failed). */
  loaded: number;
  /** Metadata files the scan found. */
  total: number;
  /** Metadata files that couldn't be used. */
  failed: number;
  /** Jobs that ran past their time limit. */
  timeouts: number;
  /** Messages with a list cut to its limit. */
  capped: number;
  condition: IndexCondition;
  /** Where phase 2, the text of the message files, stands: 'waiting' until phase 1 is done. */
  bodyPhase: 'waiting' | 'indexing' | 'done' | 'failed';
  /** Message files phase 2 has handled in this run: indexed, cut to the limit, or failed. */
  bodiesDone: number;
  /** Message files phase 2 has to read in this run. */
  bodiesTotal: number;
  /** Message files whose text couldn't be read. */
  bodiesFailed: number;
}

/** What core reports once a source's index is open. */
export interface IndexOpened {
  dbUuid: string;
  created: boolean;
  replaced: boolean;
}
