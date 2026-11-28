// SPDX-License-Identifier: AGPL-3.0-or-later
// Grouped search over the whole export. Terms match messages; the matches are
// grouped by conversation and paged 200 at a time, by the newest matching
// message's date or by the best relevance in the conversation, each with a
// keyset on its sort pair. User text only ever reaches SQLite as bound values:
// words become quoted full-text literals inside a bound match expression, and
// every other value is a bound parameter.

import type {
  CardsQuery,
  CardsWindow,
  IndexMatch,
  MarkedSnippet,
  RowDetails,
  SearchCoverage,
  SearchDateKey,
  SearchKey,
  SearchPage,
  SearchQuery,
  SearchRankKey,
  SearchRow,
  SearchSnippets,
  SearchSort,
  SnippetsQuery,
} from '../../shared/index-types';
import { MAX_SNIPPET_THREADS } from '../../shared/index-types';
import type { MatchColumn } from '../../shared/reader-protocol';
import type { Chip, SearchSpec } from '../../shared/search-chips';
import {
  searchTerms,
  wordsOf,
  type ParsedQuery,
  type Term,
  type TextColumn,
} from '../search/query';
import { markedToRanges, stripMarks } from '../search/ranges';
import { SYSTEM_LABELS } from './labels';
import { foldAddress } from './metadata';
import { cardsWindow, rowDetails } from './queries';
import { BODY_STATE, META_STATE } from './schema';
import { asNumber, scalar, type Db, type Row, type SqlValue } from './sql';

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
 * A chip's folder or label ID, if the export has it in that scope: a label
 * for a Label chip; a user folder or a system folder for a Folder chip. An ID
 * the export doesn't have, or one of the other scope, matches nothing.
 */
export function labelIdById(db: Db, scope: 'label' | 'folder', id: string): string[] {
  const r = db.stmt('SELECT kind FROM labels WHERE proton_id = ?').get(id);
  if (r) {
    const kind = String(r.kind);
    const fits = scope === 'label' ? kind === 'label' : kind === 'folder' || kind === 'system';
    return fits ? [id] : [];
  }
  return scope === 'folder' && SYSTEM_FOLDER_NAMES.some(([system]) => system === id) ? [id] : [];
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
      const ids =
        term.id === undefined
          ? labelIds(db, term.scope, term.name)
          : labelIdById(db, term.scope, term.id);
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
 * Where hits are looked for: everywhere, within some conversations, among
 * some messages, or in one message.
 */
type HitScope = 'all' | 'threads' | 'rowids' | 'one';

/**
 * The matching messages as (rid, tid, time[, rank]) rows, optionally within
 * some conversations or among some messages, whose IDs come as one JSON
 * array parameter after the others, or in one message, whose rowid comes as
 * the last parameter. Its text depends on the query's terms, so statements
 * built on it are prepared uncached.
 */
function hits(
  built: BuiltQuery,
  withRank: boolean,
  scope: HitScope,
): { sql: string; params: SqlValue[] } {
  const where = built.conditions.map((c) => ` AND ${c.sql}`).join('');
  const params = built.conditions.flatMap((c) => c.params);
  // A rowid bound as a plain number can be ignored next to a full-text match;
  // as an explicit integer it always applies. The values json_each reads from
  // an array of whole numbers are integers already.
  const threads =
    scope === 'threads'
      ? ' AND m.thread_id IN (SELECT value FROM json_each(?))'
      : scope === 'rowids'
        ? ' AND m.rowid IN (SELECT value FROM json_each(?))'
        : scope === 'one'
          ? ' AND m.rowid = CAST(? AS INTEGER)'
          : '';
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

/** A page of grouped matches; on a first page, also how many conversations match in all. */
interface GroupedPage {
  groups: Grouped[];
  total: number | null;
}

/**
 * On a first page, each row also carries the number of matching
 * conversations: the window counts the groups before the limit applies, so
 * the matches are read once.
 */
const TOTAL_COLUMN = ', count(*) OVER () AS total';

function groupedPage(rows: Row[], first: boolean): GroupedPage {
  const groups = rows.map((r) => ({
    threadId: asNumber(r.tid),
    time: asNumber(r.max_time),
    rank: r.best_rank === undefined ? null : Number(r.best_rank),
    matching: asNumber(r.n),
  }));
  return { groups, total: first ? (rows.length > 0 ? asNumber(rows[0]!.total) : 0) : null };
}

function pageByDate(db: Db, built: BuiltQuery, after: SearchDateKey | null): GroupedPage {
  const h = hits(built, false, 'all');
  const rows = db
    .once(
      `WITH hit AS MATERIALIZED (${h.sql})
       SELECT tid, max(time) AS max_time, count(*) AS n${after ? '' : TOTAL_COLUMN}
       FROM hit GROUP BY tid
       ${after ? 'HAVING max(time) < ? OR (max(time) = ? AND tid < ?)' : ''}
       ORDER BY max_time DESC, tid DESC LIMIT ?`,
    )
    .all(...h.params, ...(after ? [after.time, after.time, after.threadId] : []), SEARCH_PAGE_SIZE);
  return groupedPage(rows, after === null);
}

function pageByRelevance(db: Db, built: BuiltQuery, after: SearchRankKey | null): GroupedPage {
  const h = hits(built, true, 'all');
  const rows = db
    .once(
      `WITH hit AS MATERIALIZED (${h.sql})
       SELECT tid, min(rank) AS best_rank, max(time) AS max_time, count(*) AS n${after ? '' : TOTAL_COLUMN}
       FROM hit GROUP BY tid
       ${after ? 'HAVING min(rank) > ? OR (min(rank) = ? AND tid < ?)' : ''}
       ORDER BY best_rank ASC, tid DESC LIMIT ?`,
    )
    .all(...h.params, ...(after ? [after.rank, after.rank, after.threadId] : []), SEARCH_PAGE_SIZE);
  return groupedPage(rows, after === null);
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
  const h = hits(built, ranked, 'threads');
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

/** The full-text columns a match line can name, by their position in the index. */
const MATCH_COLUMN_AT: ReadonlyArray<[MatchColumn, number]> = [
  ['subject', 0],
  ['sender', 1],
  ['recipients', 2],
  ['attachments', 4],
];
/** The body's position in the full-text index. */
const BODY_COLUMN = 3;

/**
 * How one message matches a search, for the reader: the columns other than
 * the body that hold a match, and the stored body with its match ranges when
 * the body holds any and was indexed. Null when the search has no word to
 * mark (filters only, or only negated words) or the message doesn't match the
 * whole search. Only the search's positive words are marked: negated words
 * and the words that narrow an address match aren't.
 */
export function matchInfo(db: Db, rowid: number, search: SearchSpec): IndexMatch | null {
  const parsed = searchTerms(search);
  const built = buildQuery(db, parsed);
  if (!built.hasText || built.match === null) return null;
  const whole = hits(built, false, 'one');
  if (!db.once(whole.sql).get(...whole.params, rowid)) return null;

  const pair = db
    .stmt(
      `SELECT p.body_state AS body_state, p.error_code AS error_code
       FROM messages m JOIN pairs p ON p.proton_id = m.proton_id WHERE m.rowid = ?`,
    )
    .get(rowid);
  const state = asNumber(pair?.body_state);
  const reason =
    state === BODY_STATE.failed
      ? String(pair?.error_code ?? '') === 'BODY_TIMEOUT'
        ? 'timeout'
        : 'unreadable'
      : null;

  const positive = parsed.terms
    .filter((t): t is Extract<Term, { kind: 'text' }> => t.kind === 'text' && !t.negated)
    .map((t) => ftsItem(t.text, t.exact, t.column));
  const withBody = state === BODY_STATE.indexed || state === BODY_STATE.truncated;
  const marks = (column: number) =>
    `highlight(fts, ${column}, char(57344), char(57345)) AS c${column}`;
  const columns = [...MATCH_COLUMN_AT.map(([, at]) => at), ...(withBody ? [BODY_COLUMN] : [])];
  const row = db
    .once(
      `SELECT ${columns.map(marks).join(', ')}
       FROM fts WHERE fts MATCH ? AND rowid = CAST(? AS INTEGER)`,
    )
    .get(positive.join(' OR '), rowid);

  let dropped = 0;
  const matched: MatchColumn[] = [];
  for (const [name, at] of MATCH_COLUMN_AT) {
    const converted = markedToRanges(String(row?.[`c${at}`] ?? ''));
    // A column whose marks fail the check still matched; only its marks go.
    if (converted === null) dropped += 1;
    if (converted === null || converted.ranges.length > 0) matched.push(name);
  }
  let body: IndexMatch['body'] = null;
  if (withBody) {
    const converted = markedToRanges(String(row?.[`c${BODY_COLUMN}`] ?? ''));
    if (converted === null) dropped += 1;
    else if (converted.ranges.length > 0) body = converted;
  }
  return {
    state,
    reason,
    columns: matched,
    bodyMatches: body?.ranges.length ?? 0,
    changed: false,
    body,
    dropped,
  };
}

const coverageCache = new WeakMap<Db, { version: number; coverage: SearchCoverage }>();

/**
 * How many messages have their body in the index, and how many still wait for
 * it, out of all of them. Read again only when another connection has
 * committed since the last read.
 */
export function coverageOf(db: Db): SearchCoverage {
  const version = scalar(db, 'PRAGMA data_version');
  const cached = coverageCache.get(db);
  if (cached && cached.version === version) return cached.coverage;
  const bodies = db
    .stmt(
      `SELECT coalesce(sum(body_state IN (?, ?)), 0) AS indexed,
              coalesce(sum(body_state = ?), 0) AS pending
       FROM pairs WHERE meta_state = ?`,
    )
    .get(BODY_STATE.indexed, BODY_STATE.truncated, BODY_STATE.pending, META_STATE.indexed);
  const coverage = {
    indexed: asNumber(bodies?.indexed),
    pending: asNumber(bodies?.pending),
    total: scalar(db, 'SELECT count(*) FROM messages'),
  };
  coverageCache.set(db, { version, coverage });
  return coverage;
}

/** One page of a search: matching conversations by date or relevance. */
export function searchPage(db: Db, call: SearchQuery): SearchPage {
  const built = buildQuery(db, searchTerms(call));
  // With no words to rank by, results are by date only.
  const sort: SearchSort = call.sort === 'relevance' && built.hasText ? 'relevance' : 'date';
  const page = (
    rows: SearchRow[],
    next: SearchKey | null,
    total: number | null,
    details: RowDetails[] = [],
    dropped = 0,
  ): SearchPage => ({
    queryId: call.queryId,
    sort,
    ranked: built.hasText,
    total,
    rows,
    details,
    next,
    coverage: coverageOf(db),
    dropped,
  });
  const first = call.after === null;
  // A relevance keyset for a query sorted by date continues nothing.
  if (built.empty || (sort !== call.sort && !first)) return page([], null, first ? 0 : null);

  const { groups: grouped, total } =
    sort === 'relevance'
      ? pageByRelevance(db, built, call.after as SearchRankKey | null)
      : pageByDate(db, built, call.after as SearchDateKey | null);
  if (grouped.length === 0) return page([], null, total);
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
  return page(rows, next, total, rowDetails(db, threadIds, threadIds.length), snipped.dropped);
}

/**
 * Snippets for conversations of a search's results: each one's best-ranked
 * matching message, as the page gives its first rows. Null for a conversation
 * with no match, or when the query has no words to match.
 */
export function searchSnippets(db: Db, call: SnippetsQuery): SearchSnippets {
  const threadIds = [...new Set(call.threadIds)].slice(0, MAX_SNIPPET_THREADS);
  const built = buildQuery(db, searchTerms(call));
  const none = (dropped = 0, byThread = new Map<number, MarkedSnippet>()): SearchSnippets => ({
    queryId: call.queryId,
    snippets: threadIds.map((threadId) => ({ threadId, snippet: byThread.get(threadId) ?? null })),
    dropped,
  });
  if (!built.hasText || built.match === null || threadIds.length === 0) return none();
  const { best } = pickMessages(db, built, threadIds);
  const { byRowid, dropped } = snippets(db, built.match, [...best.values()]);
  const byThread = new Map<number, MarkedSnippet>();
  for (const [threadId, rowid] of best) {
    const snippet = byRowid.get(rowid);
    if (snippet) byThread.set(threadId, snippet);
  }
  return none(dropped, byThread);
}

/** Which of these messages match a query, by the search's own hits: its words and its operators. */
function matchedAmong(db: Db, built: BuiltQuery, rowids: number[]): Set<number> {
  if (built.empty || rowids.length === 0) return new Set();
  const h = hits(built, false, 'rowids');
  const rows = db.once(`SELECT rid FROM (${h.sql})`).all(...h.params, JSON.stringify(rowids));
  return new Set(rows.map((r) => asNumber(r.rid)));
}

/**
 * How many messages of a conversation match a query: the same hits a
 * result row counts as its "N matching".
 */
function matchingIn(db: Db, built: BuiltQuery, threadId: number): number {
  if (built.empty) return 0;
  const h = hits(built, false, 'threads');
  return asNumber(
    db.once(`SELECT count(*) AS n FROM (${h.sql})`).get(...h.params, JSON.stringify([threadId]))?.n,
  );
}

/**
 * A cards window as the shell gets it: with the revision of the snapshot it
 * was read from and, when the conversation was opened from a search, which
 * cards match it. The matching count is read in the same snapshot, but only
 * when the count the header shows is from another revision (or there is
 * none): while nothing commits, a scroll doesn't count again.
 */
export function cardsAnswer(db: Db, call: CardsQuery, rev: number): CardsWindow {
  const window = cardsWindow(db, call);
  const text = call.search?.text;
  if (text === undefined || window.threadId === null) return { ...window, rev, searched: false };
  const built = buildQuery(db, searchTerms({ text, chips: call.search?.chips ?? [] }));
  const matched = matchedAmong(
    db,
    built,
    window.cards.map((c) => c.rowid),
  );
  const answer: CardsWindow = {
    ...window,
    cards: window.cards.map((c) => ({ ...c, matched: matched.has(c.rowid) })),
    rev,
    searched: true,
  };
  const countRev = call.search?.countRev ?? null;
  if (countRev === null || countRev !== rev)
    answer.matching = matchingIn(db, built, window.threadId);
  return answer;
}

/**
 * The snippets of those of these messages that match a query with words,
 * matched as the search (its text and chips) matches them, with their ranges
 * checked.
 */
export function matchedSnippets(
  db: Db,
  text: string,
  rowids: number[],
  chips: Chip[] = [],
): { byRowid: Map<number, MarkedSnippet>; dropped: number } {
  const built = buildQuery(db, searchTerms({ text, chips }));
  if (!built.hasText || built.match === null) return { byRowid: new Map(), dropped: 0 };
  return snippets(db, built.match, [...matchedAmong(db, built, rowids)]);
}
