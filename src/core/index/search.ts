// SPDX-License-Identifier: AGPL-3.0-or-later
// Grouped search over the whole export. Terms match messages; the matches are
// grouped by conversation and paged 200 at a time, by the newest matching
// message's date or by the best relevance in the conversation, each with a
// keyset on its sort pair. User text only ever reaches SQLite as bound values:
// words become quoted full-text literals inside a bound match expression, and
// every other value is a bound parameter.

import type {
  MarkedSnippet,
  SearchCoverage,
  SearchDateKey,
  SearchKey,
  SearchPage,
  SearchQuery,
  SearchRankKey,
  SearchRow,
  SearchSort,
} from '../../shared/index-types';
import { parseQuery, wordsOf, type ParsedQuery, type Term, type TextColumn } from '../search/query';
import { markedToRanges, stripMarks } from '../search/ranges';
import { SYSTEM_LABELS } from './labels';
import { foldAddress } from './metadata';
import { BODY_STATE, META_STATE } from './schema';
import { asNumber, scalar, type Db, type SqlValue } from './sql';

/** The most conversations one results page holds. */
export const SEARCH_PAGE_SIZE = 200;
/** The first rows of a page that get the best match's snippet. */
export const SNIPPET_ROWS = 50;
/** The words a snippet shows around its matches. */
export const SNIPPET_TOKENS = 12;

/** The system folders by the names the sidebar shows them with, for folder:. */
const SYSTEM_FOLDER_NAMES: ReadonlyArray<[string, string]> = [
  [SYSTEM_LABELS.inbox, 'Inbox'],
  [SYSTEM_LABELS.snoozed, 'Snoozed'],
  [SYSTEM_LABELS.drafts, 'Drafts'],
  [SYSTEM_LABELS.outbox, 'Outbox'],
  [SYSTEM_LABELS.allScheduled, 'Scheduled'],
  [SYSTEM_LABELS.sent, 'Sent'],
  [SYSTEM_LABELS.starred, 'Starred'],
  [SYSTEM_LABELS.archive, 'Archive'],
  [SYSTEM_LABELS.spam, 'Spam'],
  [SYSTEM_LABELS.trash, 'Trash'],
  [SYSTEM_LABELS.allMail, 'All Mail'],
];

const WORD_END = /[\p{L}\p{N}\p{M}\p{Co}]$/u;
const MARK = /\p{M}/gu;

/** Text as one full-text string literal: inside it, nothing is an operator. */
export function ftsLiteral(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/** A text term as a full-text item, with its column filter if it has one. */
function ftsItem(text: string, exact: boolean, column: TextColumn | null): string {
  const phrase = `${ftsLiteral(text)}${exact ? '' : '*'}`;
  return column === null ? phrase : `{${column}} : ${phrase}`;
}

/**
 * The full-text item that narrows an address search to messages whose sender
 * or recipients text holds the address's words. It never leaves out a message
 * whose stored address starts with the value: an unfinished last word is a
 * prefix, and a one-character last word is left out rather than matched whole.
 * Null if the value holds no word.
 */
export function addressItem(value: string, column: TextColumn): string | null {
  const words = wordsOf(value);
  let prefix = WORD_END.test(value);
  const last = words.at(-1);
  if (last !== undefined && prefix && [...last.replace(MARK, '')].length < 2) {
    words.pop();
    prefix = false;
  }
  if (words.length === 0) return null;
  return ftsItem(words.join(' '), !prefix, column);
}

interface Condition {
  sql: string;
  params: SqlValue[];
}

/** A query turned into its parts: what the full-text index matches and what the messages must meet. */
export interface BuiltQuery {
  /** The match expression for the positive words, with the negated ones after NOT; null if none. */
  match: string | null;
  /** With no positive words: the negated words, whose matches are left out. */
  exclude: string | null;
  /** Conditions on `messages m`, each with its parameters. */
  conditions: Condition[];
  /** True if the query has words that rank matches; only then is relevance and a snippet offered. */
  hasText: boolean;
  /** True if the query has nothing to match. */
  empty: boolean;
}

/** The folder and label IDs a label: or folder: value names, by exact name or path, any case. */
export function labelIds(db: Db, scope: 'label' | 'folder', name: string): string[] {
  const want = name.toLowerCase();
  const ids = new Set<string>();
  for (const r of db.stmt('SELECT proton_id, name, path, kind FROM labels').all()) {
    const kind = String(r.kind);
    const fits = scope === 'label' ? kind === 'label' : kind === 'folder' || kind === 'system';
    if (!fits) continue;
    const named = String(r.name ?? '').toLowerCase() === want;
    if (named || String(r.path ?? '').toLowerCase() === want) ids.add(String(r.proton_id));
  }
  if (scope === 'folder') {
    for (const [id, folder] of SYSTEM_FOLDER_NAMES) if (folder.toLowerCase() === want) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * The stored address starts with the value, ignoring case: both are folded
 * by JavaScript (the stored one when it was written), so letters outside
 * ASCII compare without case too.
 */
const ADDRESS_PREFIX = (column: string) => `substr(${column}, 1, length(?)) = ?`;

function condition(db: Db, term: Exclude<Term, { kind: 'text' }>): Condition {
  switch (term.kind) {
    case 'address': {
      const v = foldAddress(term.value);
      if (term.field === 'from') return { sql: ADDRESS_PREFIX('m.sender_fold'), params: [v, v] };
      const list = term.field === 'to' ? 'm.to_fold' : 'm.cc_fold';
      return {
        sql: `CASE WHEN json_valid(${list}) THEN EXISTS (SELECT 1 FROM json_each(${list}) j
                WHERE ${ADDRESS_PREFIX('j.value')}) ELSE 0 END`,
        params: [v, v],
      };
    }
    case 'label': {
      const ids = labelIds(db, term.scope, term.name);
      if (ids.length === 0) return { sql: '0', params: [] };
      return {
        sql: `EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_rowid = m.rowid
                AND ml.label_id IN (SELECT value FROM json_each(?)))`,
        params: [JSON.stringify(ids)],
      };
    }
    case 'flag':
      switch (term.flag) {
        case 'unread':
          return { sql: 'm.unread <> 0', params: [] };
        case 'replied':
          return { sql: 'm.replied <> 0 OR m.replied_all <> 0', params: [] };
        case 'attachment':
          return { sql: 'm.num_attachments > 0', params: [] };
        case 'starred':
          return {
            sql: `EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_rowid = m.rowid
                    AND ml.label_id = ?)`,
            params: [SYSTEM_LABELS.starred],
          };
      }
      break;
    case 'date':
      return { sql: term.op === 'before' ? 'm.time < ?' : 'm.time >= ?', params: [term.time] };
    case 'size':
      return { sql: term.op === 'larger' ? 'm.size > ?' : 'm.size < ?', params: [term.bytes] };
  }
  return { sql: '0', params: [] };
}

/** Turns parsed terms into a match expression and conditions. */
export function buildQuery(db: Db, parsed: ParsedQuery): BuiltQuery {
  const positive: string[] = [];
  const negative: string[] = [];
  const conditions: Condition[] = [];
  let hasText = false;
  for (const term of parsed.terms) {
    if (term.kind === 'text') {
      const item = ftsItem(term.text, term.exact, term.column);
      if (term.negated) negative.push(item);
      else {
        positive.push(item);
        hasText = true;
      }
      continue;
    }
    if (term.kind === 'address' && !term.negated) {
      const item = addressItem(term.value, term.field === 'from' ? 'sender' : 'recipients');
      if (item !== null) positive.push(item);
    }
    const c = condition(db, term);
    // A missing value counts as not meeting the condition, negated or not.
    conditions.push({
      sql: term.negated ? `NOT coalesce((${c.sql}), 0)` : `coalesce((${c.sql}), 0)`,
      params: c.params,
    });
  }
  const not = negative.length > 0 ? `(${negative.join(' OR ')})` : null;
  if (positive.length > 0) {
    const all = `(${positive.join(' AND ')})`;
    return {
      match: not ? `${all} NOT ${not}` : all,
      exclude: null,
      conditions,
      hasText,
      empty: false,
    };
  }
  return {
    match: null,
    exclude: not,
    conditions,
    hasText: false,
    empty: not === null && conditions.length === 0,
  };
}

/**
 * The matching messages as (rid, tid, time[, rank]) rows, optionally within
 * some conversations. Its text depends on the query's terms, so statements
 * built on it are prepared uncached.
 */
function hits(
  built: BuiltQuery,
  withRank: boolean,
  inThreads: boolean,
): { sql: string; params: SqlValue[] } {
  const where = built.conditions.map((c) => ` AND ${c.sql}`).join('');
  const params = built.conditions.flatMap((c) => c.params);
  const threads = inThreads ? ' AND m.thread_id IN (SELECT value FROM json_each(?))' : '';
  const cols = 'm.rowid AS rid, m.thread_id AS tid, coalesce(m.time, 0) AS time';
  if (built.match !== null) {
    return {
      sql: `SELECT ${cols}${withRank ? ', bm25(fts) AS rank' : ''}
            FROM fts JOIN messages m ON m.rowid = fts.rowid
            WHERE fts MATCH ?${where}${threads}`,
      params: [built.match, ...params],
    };
  }
  if (built.exclude !== null) {
    return {
      sql: `SELECT ${cols} FROM messages m
            WHERE m.rowid NOT IN (SELECT rowid FROM fts WHERE fts MATCH ?)${where}${threads}`,
      params: [built.exclude, ...params],
    };
  }
  return { sql: `SELECT ${cols} FROM messages m WHERE 1${where}${threads}`, params };
}

interface Grouped {
  threadId: number;
  time: number;
  rank: number | null;
  matching: number;
}

function pageByDate(db: Db, built: BuiltQuery, after: SearchDateKey | null): Grouped[] {
  const h = hits(built, false, false);
  return db
    .once(
      `WITH hit AS MATERIALIZED (${h.sql})
       SELECT tid, max(time) AS max_time, count(*) AS n FROM hit GROUP BY tid
       ${after ? 'HAVING max(time) < ? OR (max(time) = ? AND tid < ?)' : ''}
       ORDER BY max_time DESC, tid DESC LIMIT ?`,
    )
    .all(...h.params, ...(after ? [after.time, after.time, after.threadId] : []), SEARCH_PAGE_SIZE)
    .map((r) => ({
      threadId: asNumber(r.tid),
      time: asNumber(r.max_time),
      rank: null,
      matching: asNumber(r.n),
    }));
}

function pageByRelevance(db: Db, built: BuiltQuery, after: SearchRankKey | null): Grouped[] {
  const h = hits(built, true, false);
  return db
    .once(
      `WITH hit AS MATERIALIZED (${h.sql})
       SELECT tid, min(rank) AS best_rank, max(time) AS max_time, count(*) AS n FROM hit GROUP BY tid
       ${after ? 'HAVING min(rank) > ? OR (min(rank) = ? AND tid < ?)' : ''}
       ORDER BY best_rank ASC, tid DESC LIMIT ?`,
    )
    .all(...h.params, ...(after ? [after.rank, after.rank, after.threadId] : []), SEARCH_PAGE_SIZE)
    .map((r) => ({
      threadId: asNumber(r.tid),
      time: asNumber(r.max_time),
      rank: Number(r.best_rank),
      matching: asNumber(r.n),
    }));
}

/**
 * Per conversation on the page: its newest matching message (ties to the
 * higher rowid) and, when the query ranks, its best-ranked one (ties to the
 * newer time, then the higher rowid).
 */
function pickMessages(
  db: Db,
  built: BuiltQuery,
  threadIds: number[],
): { newest: Map<number, number>; best: Map<number, number> } {
  const ranked = built.hasText;
  const h = hits(built, ranked, true);
  const rows = db
    .once(
      `WITH hit AS (${h.sql}),
       k AS (SELECT tid, rid,
               row_number() OVER (PARTITION BY tid ORDER BY time DESC, rid DESC) AS kn
               ${ranked ? ', row_number() OVER (PARTITION BY tid ORDER BY rank ASC, time DESC, rid DESC) AS kb' : ', 0 AS kb'}
             FROM hit)
       SELECT tid, rid, kn, kb FROM k WHERE kn = 1 OR kb = 1`,
    )
    .all(...h.params, JSON.stringify(threadIds));
  const newest = new Map<number, number>();
  const best = new Map<number, number>();
  for (const r of rows) {
    if (asNumber(r.kn) === 1) newest.set(asNumber(r.tid), asNumber(r.rid));
    if (asNumber(r.kb) === 1) best.set(asNumber(r.tid), asNumber(r.rid));
  }
  return { newest, best };
}

/** Snippets of these messages, with their match ranges checked; `dropped` counts the ones given without. */
function snippets(
  db: Db,
  match: string,
  rowids: number[],
): { byRowid: Map<number, MarkedSnippet>; dropped: number } {
  const byRowid = new Map<number, MarkedSnippet>();
  let dropped = 0;
  if (rowids.length === 0) return { byRowid, dropped };
  const rows = db
    .stmt(
      `SELECT rowid, snippet(fts, -1, char(57344), char(57345), '…', ${SNIPPET_TOKENS}) AS s
       FROM fts WHERE fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
    )
    .all(match, JSON.stringify(rowids));
  for (const r of rows) {
    const marked = String(r.s ?? '');
    const converted = markedToRanges(marked);
    if (converted === null) dropped += 1;
    byRowid.set(asNumber(r.rowid), converted ?? { text: stripMarks(marked), ranges: [] });
  }
  return { byRowid, dropped };
}

const coverageCache = new WeakMap<Db, { version: number; coverage: SearchCoverage }>();

/**
 * How many messages have their body in the index, out of all of them. Read
 * again only when another connection has committed since the last read.
 */
export function coverageOf(db: Db): SearchCoverage {
  const version = scalar(db, 'PRAGMA data_version');
  const cached = coverageCache.get(db);
  if (cached && cached.version === version) return cached.coverage;
  const coverage = {
    indexed: scalar(
      db,
      'SELECT count(*) FROM pairs WHERE meta_state = ? AND body_state IN (?, ?)',
      META_STATE.indexed,
      BODY_STATE.indexed,
      BODY_STATE.truncated,
    ),
    total: scalar(db, 'SELECT count(*) FROM messages'),
  };
  coverageCache.set(db, { version, coverage });
  return coverage;
}

/** One page of a search: matching conversations by date or relevance. */
export function searchPage(db: Db, call: SearchQuery): SearchPage {
  const built = buildQuery(db, parseQuery(call.text));
  // With no words to rank by, results are by date only.
  const sort: SearchSort = call.sort === 'relevance' && built.hasText ? 'relevance' : 'date';
  const page = (rows: SearchRow[], next: SearchKey | null, dropped = 0): SearchPage => ({
    queryId: call.queryId,
    sort,
    rows,
    next,
    coverage: coverageOf(db),
    dropped,
  });
  // A relevance keyset for a query sorted by date continues nothing.
  if (built.empty || (sort !== call.sort && call.after !== null)) return page([], null);

  const grouped =
    sort === 'relevance'
      ? pageByRelevance(db, built, call.after as SearchRankKey | null)
      : pageByDate(db, built, call.after as SearchDateKey | null);
  if (grouped.length === 0) return page([], null);
  const threadIds = grouped.map((g) => g.threadId);
  const { newest, best } = pickMessages(db, built, threadIds);
  const threads = new Map(
    db
      .stmt(
        `SELECT thread_id, msg_count, unread_count, attach_count FROM threads
         WHERE thread_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(threadIds))
      .map((r) => [asNumber(r.thread_id), r]),
  );
  let snipped = { byRowid: new Map<number, MarkedSnippet>(), dropped: 0 };
  if (built.hasText && built.match !== null) {
    const rowids = grouped
      .slice(0, SNIPPET_ROWS)
      .map((g) => best.get(g.threadId))
      .filter((rid): rid is number => rid !== undefined);
    snipped = snippets(db, built.match, rowids);
  }
  const rows: SearchRow[] = grouped.map((g) => {
    const t = threads.get(g.threadId);
    const bestRowid = best.get(g.threadId);
    return {
      threadId: g.threadId,
      time: g.time,
      rank: sort === 'relevance' ? g.rank : null,
      count: asNumber(t?.msg_count),
      unread: asNumber(t?.unread_count),
      attachments: asNumber(t?.attach_count) > 0,
      matching: g.matching,
      anchorRowid: newest.get(g.threadId) ?? 0,
      snippet: bestRowid === undefined ? null : (snipped.byRowid.get(bestRowid) ?? null),
    };
  });
  const last = grouped.at(-1)!;
  const next: SearchKey | null =
    grouped.length < SEARCH_PAGE_SIZE
      ? null
      : sort === 'relevance'
        ? { rank: last.rank ?? 0, threadId: last.threadId }
        : { time: last.time, threadId: last.threadId };
  return page(rows, next, snipped.dropped);
}
