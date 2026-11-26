// SPDX-License-Identifier: AGPL-3.0-or-later
// The conversation list and grouped search: conversations ordered by date or
// by best relevance, with a keyset on the sort pair, 200 conversations a page.
// Subjects, participants and snippets are read only for the visible rows.

import { MARK_END, MARK_START } from './schema';
import { asNumber, type Db } from './sql';

export const PAGE_SIZE = 200;
/** Rows a list or result page fills in subjects, participants and snippets for. */
export const VISIBLE_ROWS = 50;

export interface DateKey {
  time: number;
  threadId: number;
}

export interface RankKey {
  rank: number;
  threadId: number;
}

export interface ConversationRow {
  threadId: number;
  time: number;
  rank: number | null;
  matching: number;
  subject?: string;
  participants?: string[];
  snippet?: { text: string; ranges: Array<[number, number]> };
}

export interface Page<K> {
  rows: ConversationRow[];
  next: K | null;
}

function fillVisible(db: Db, rows: ConversationRow[]): void {
  const subject = db.stmt(
    'SELECT subject FROM messages WHERE thread_id = ? ORDER BY time ASC, rowid ASC LIMIT 1',
  );
  const senders = db.stmt(
    'SELECT sender_name, sender_addr FROM messages WHERE thread_id = ? ORDER BY time ASC, rowid ASC LIMIT 50',
  );
  for (const row of rows.slice(0, VISIBLE_ROWS)) {
    row.subject = String(subject.get(row.threadId)?.subject ?? '');
    const seen = new Set<string>();
    const names: string[] = [];
    for (const s of senders.all(row.threadId)) {
      const addr = String(s.sender_addr ?? '');
      if (seen.has(addr)) continue;
      seen.add(addr);
      names.push(String(s.sender_name || addr));
      if (names.length === 4) break;
    }
    row.participants = names;
  }
}

/** The conversation list of one folder or label, newest first. */
export function listPage(db: Db, labelId: string, after: DateKey | null): Page<DateKey> {
  const rows = db
    .stmt(
      `SELECT thread_id, last_time, msg_count FROM thread_labels
       WHERE label_id = ? ${after ? 'AND (last_time < ? OR (last_time = ? AND thread_id < ?))' : ''}
       ORDER BY last_time DESC, thread_id DESC LIMIT ?`,
    )
    .all(labelId, ...(after ? [after.time, after.time, after.threadId] : []), PAGE_SIZE)
    .map((r) => ({
      threadId: asNumber(r.thread_id),
      time: asNumber(r.last_time),
      rank: null,
      matching: asNumber(r.msg_count),
    }));
  fillVisible(db, rows);
  const last = rows.at(-1);
  return {
    rows,
    next: rows.length === PAGE_SIZE && last ? { time: last.time, threadId: last.threadId } : null,
  };
}

/** A user's word as an FTS5 string literal, so operators in it stay plain text. */
export function ftsLiteral(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/**
 * Converts snippet text with marker characters into plain text and match
 * ranges in UTF-16 code units: ascending, non-overlapping, inside the text,
 * and never splitting a surrogate pair.
 */
export function markedToRanges(marked: string): { text: string; ranges: Array<[number, number]> } {
  let text = '';
  const ranges: Array<[number, number]> = [];
  let open: number | null = null;
  for (const ch of marked) {
    if (ch === MARK_START) {
      if (open === null) open = text.length;
    } else if (ch === MARK_END) {
      if (open !== null && text.length > open) ranges.push([open, text.length]);
      open = null;
    } else {
      text += ch;
    }
  }
  if (open !== null && text.length > open) ranges.push([open, text.length]);
  return { text, ranges };
}

function fillSnippets(db: Db, match: string, rows: ConversationRow[]): void {
  const visible = rows.slice(0, VISIBLE_ROWS);
  if (visible.length === 0) return;
  const best = db
    .stmt(
      `WITH r AS (
         SELECT m.thread_id AS thread_id, fts.rowid AS rid, bm25(fts) AS rank, m.time AS time
         FROM fts JOIN messages m ON m.rowid = fts.rowid
         WHERE fts MATCH ? AND m.thread_id IN (SELECT value FROM json_each(?))),
       b AS (SELECT thread_id, rid, row_number() OVER (
               PARTITION BY thread_id ORDER BY rank ASC, time DESC, rid DESC) AS k FROM r)
       SELECT thread_id, rid FROM b WHERE k = 1`,
    )
    .all(match, JSON.stringify(visible.map((r) => r.threadId)));
  const ridOf = new Map(best.map((b) => [asNumber(b.thread_id), asNumber(b.rid)]));
  const snippets = db
    .stmt(
      `SELECT rowid, snippet(fts, -1, char(57344), char(57345), '…', 12) AS s
       FROM fts WHERE fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
    )
    .all(match, JSON.stringify([...ridOf.values()]));
  const byRid = new Map(snippets.map((s) => [asNumber(s.rowid), String(s.s ?? '')]));
  for (const row of visible) {
    const rid = ridOf.get(row.threadId);
    const marked = rid === undefined ? undefined : byRid.get(rid);
    if (marked !== undefined) row.snippet = markedToRanges(marked);
  }
}

/** Search results by date: conversations by their newest matching message. */
export function searchByDate(db: Db, match: string, after: DateKey | null): Page<DateKey> {
  const rows = db
    .stmt(
      `SELECT m.thread_id AS thread_id, max(m.time) AS max_time, count(*) AS n
       FROM fts JOIN messages m ON m.rowid = fts.rowid
       WHERE fts MATCH ?
       GROUP BY m.thread_id
       ${after ? 'HAVING max_time < ? OR (max_time = ? AND m.thread_id < ?)' : ''}
       ORDER BY max_time DESC, thread_id DESC LIMIT ?`,
    )
    .all(match, ...(after ? [after.time, after.time, after.threadId] : []), PAGE_SIZE)
    .map((r) => ({
      threadId: asNumber(r.thread_id),
      time: asNumber(r.max_time),
      rank: null,
      matching: asNumber(r.n),
    }));
  fillVisible(db, rows);
  fillSnippets(db, match, rows);
  const last = rows.at(-1);
  return {
    rows,
    next: rows.length === PAGE_SIZE && last ? { time: last.time, threadId: last.threadId } : null,
  };
}

/** Search results by relevance: conversations by their best-ranked matching message. */
export function searchByRelevance(db: Db, match: string, after: RankKey | null): Page<RankKey> {
  const rows = db
    .stmt(
      `WITH r AS MATERIALIZED (SELECT rowid AS rid, bm25(fts) AS rank FROM fts WHERE fts MATCH ?)
       SELECT m.thread_id AS thread_id, min(r.rank) AS best_rank, max(m.time) AS max_time, count(*) AS n
       FROM r JOIN messages m ON m.rowid = r.rid
       GROUP BY m.thread_id
       ${after ? 'HAVING best_rank > ? OR (best_rank = ? AND m.thread_id < ?)' : ''}
       ORDER BY best_rank ASC, thread_id DESC LIMIT ?`,
    )
    .all(match, ...(after ? [after.rank, after.rank, after.threadId] : []), PAGE_SIZE)
    .map((r) => ({
      threadId: asNumber(r.thread_id),
      time: asNumber(r.max_time),
      rank: Number(r.best_rank),
      matching: asNumber(r.n),
    }));
  fillVisible(db, rows);
  fillSnippets(db, match, rows);
  const last = rows.at(-1);
  return {
    rows,
    next:
      rows.length === PAGE_SIZE && last ? { rank: last.rank ?? 0, threadId: last.threadId } : null,
  };
}
