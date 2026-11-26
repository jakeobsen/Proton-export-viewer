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

export type IndexQuery =
  | { op: 'sidebar' }
  | { op: 'page'; labelId: string; after: PageKey | null; limit?: number }
  | { op: 'details'; threadIds: number[] }
  | { op: 'resolve'; rowid: number }
  | { op: 'totals' };

export type IndexAnswer = Sidebar | ListPage | RowDetails[] | number | null | IndexTotals;

/**
 * The index's own state: 'verifying' while an index that was already there
 * is checked; 'rebuilding' while an index made in place of a damaged one is
 * filled; 'damaged' once a damaged index was deleted and the export can't be
 * read to rebuild it.
 */
export type IndexCondition = 'ok' | 'verifying' | 'rebuilding' | 'damaged';

/**
 * Where phase 1 stands. During it, list pages hold the rows loaded so far.
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
}

/** What core reports once a source's index is open. */
export interface IndexOpened {
  dbUuid: string;
  created: boolean;
  replaced: boolean;
}
