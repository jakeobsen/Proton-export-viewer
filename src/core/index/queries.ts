// SPDX-License-Identifier: AGPL-3.0-or-later
// The index's read side for the shell: folders and labels with their
// unread-conversation counts, conversation list pages and windows (newest
// first, keyset on the last date and conversation ID), the subject and
// participants of the rows on screen, and the conversation a message is in now.

import {
  WINDOW_AFTER,
  WINDOW_BEFORE,
  type FolderRow,
  type ListPage,
  type ListRow,
  type ListWindow,
  type PageKey,
  type Participant,
  type RowDetails,
  type Sidebar,
  type WindowQuery,
} from '../../shared/index-types';
import type { LabelKind } from './labels';
import { asNumber, scalar, type Db } from './sql';

/** The most conversations one list page holds. */
export const PAGE_SIZE = 200;
/** The most conversations one details request covers. */
export const MAX_DETAILS = 100;
/** A row's participants come from at most this many of its first messages by time. */
export const PARTICIPANT_SCAN = 200;
/** A row shows at most this many distinct senders, oldest first. */
export const MAX_PARTICIPANTS = 4;

/**
 * Every folder and label labels.json names (system ones by ID, whether or not
 * the file lists them), with their counts. Unknown IDs and entries of an
 * unknown type are left out.
 */
export function sidebar(db: Db, systemIds: readonly string[]): Sidebar {
  const counts = new Map<string, { conversations: number; unread: number }>();
  for (const r of db
    .stmt(
      `SELECT label_id, count(*) AS n, sum(unread_count > 0) AS u FROM thread_labels GROUP BY label_id`,
    )
    .all()) {
    counts.set(String(r.label_id), { conversations: asNumber(r.n), unread: asNumber(r.u) });
  }
  const folders: FolderRow[] = [];
  const named = new Set<string>();
  for (const r of db
    .stmt('SELECT proton_id, name, parent_id, color, kind FROM labels ORDER BY rowid')
    .all()) {
    const id = String(r.proton_id);
    const kind = String(r.kind) as LabelKind;
    named.add(id);
    // Entries of an unknown type, and system IDs that aren't shown, stay hidden.
    if (kind === 'other' || (kind === 'system' && !systemIds.includes(id))) continue;
    folders.push({
      id,
      name: String(r.name ?? ''),
      kind: kind as FolderRow['kind'],
      parentId: r.parent_id === null ? null : String(r.parent_id),
      color: r.color === null ? null : String(r.color),
      ...(counts.get(id) ?? { conversations: 0, unread: 0 }),
    });
  }
  for (const id of systemIds) {
    if (named.has(id)) continue;
    named.add(id);
    folders.push({
      id,
      name: '',
      kind: 'system',
      parentId: null,
      color: null,
      ...(counts.get(id) ?? { conversations: 0, unread: 0 }),
    });
  }
  let hiddenIds = 0;
  for (const id of counts.keys()) if (!named.has(id)) hiddenIds += 1;
  return { folders, hiddenIds };
}

const ROW_SELECT = `SELECT tl.thread_id AS thread_id, tl.last_time AS last_time,
    tl.unread_count AS unread_here, t.msg_count AS msg_count, t.unread_count AS unread_count,
    t.attach_count AS attach_count
  FROM thread_labels tl JOIN threads t ON t.thread_id = tl.thread_id`;

/** List rows from query rows, each with its newest message in the folder or label. */
function toListRows(db: Db, labelId: string, rows: Record<string, unknown>[]): ListRow[] {
  const anchor = db.stmt(
    `SELECT m.rowid AS rowid FROM messages m JOIN message_labels ml
       ON ml.message_rowid = m.rowid AND ml.label_id = ?
     WHERE m.thread_id = ? ORDER BY m.time DESC, m.rowid DESC LIMIT 1`,
  );
  return rows.map((r) => {
    const threadId = asNumber(r.thread_id);
    return {
      threadId,
      time: asNumber(r.last_time),
      count: asNumber(r.msg_count),
      unread: asNumber(r.unread_count),
      unreadHere: asNumber(r.unread_here),
      attachments: asNumber(r.attach_count) > 0,
      anchorRowid: asNumber(anchor.get(labelId, threadId)?.rowid),
    };
  });
}

/** Up to `n` rows from `key` on (or after it), newest first; from the top with no key. */
function olderRows(
  db: Db,
  labelId: string,
  key: PageKey | null,
  inclusive: boolean,
  n: number,
): ListRow[] {
  const from = key ? `AND (tl.last_time, tl.thread_id) ${inclusive ? '<=' : '<'} (?, ?)` : '';
  const rows = db
    .stmt(
      `${ROW_SELECT} WHERE tl.label_id = ? ${from}
       ORDER BY tl.last_time DESC, tl.thread_id DESC LIMIT ?`,
    )
    .all(labelId, ...(key ? [key.time, key.threadId] : []), n);
  return toListRows(db, labelId, rows);
}

/** Up to `n` rows just before `key`, newest first. */
function newerRows(db: Db, labelId: string, key: PageKey, n: number): ListRow[] {
  if (n <= 0) return [];
  const rows = db
    .stmt(
      `${ROW_SELECT} WHERE tl.label_id = ? AND (tl.last_time, tl.thread_id) > (?, ?)
       ORDER BY tl.last_time ASC, tl.thread_id ASC LIMIT ?`,
    )
    .all(labelId, key.time, key.threadId, n);
  return toListRows(db, labelId, rows.reverse());
}

/** One page of a folder's or label's conversations, newest first. */
export function listPage(
  db: Db,
  labelId: string,
  after: PageKey | null,
  limit: number = PAGE_SIZE,
): ListPage {
  const n = Math.max(1, Math.min(PAGE_SIZE, Math.trunc(limit)));
  const out = olderRows(db, labelId, after, false, n);
  const last = out.at(-1);
  return {
    rows: out,
    next: out.length === n && last ? { time: last.time, threadId: last.threadId } : null,
  };
}

const clampCount = (n: number, max: number) => Math.max(0, Math.min(max, Math.trunc(n)));

/**
 * A stretch of a folder's or label's list around an anchor, from one read
 * snapshot: the anchor row is the conversation that holds message
 * `anchor.rowid`, else conversation `anchor.key` if it is still listed, else
 * the row at `anchor.index`. Rows are found by their (date, conversation)
 * key; only the last case seeks by position. A row's position is the number
 * of rows before it.
 */
export function listWindow(db: Db, query: Omit<WindowQuery, 'op'>): ListWindow {
  const { labelId, anchor } = query;
  const before = clampCount(query.before, WINDOW_BEFORE);
  const after = Math.max(1, clampCount(query.after, WINDOW_AFTER));
  const total = scalar(db, 'SELECT count(*) FROM thread_labels WHERE label_id = ?', labelId);
  const selected = query.selected === null ? null : threadOfMessage(db, query.selected);
  const keyOf = (threadId: number): PageKey | null => {
    const r = db
      .stmt('SELECT last_time FROM thread_labels WHERE label_id = ? AND thread_id = ?')
      .get(labelId, threadId);
    return r ? { time: asNumber(r.last_time), threadId } : null;
  };
  let key: PageKey | null = null;
  if (anchor.rowid !== undefined) {
    const threadId = threadOfMessage(db, anchor.rowid);
    if (threadId !== null) key = keyOf(threadId);
  }
  if (!key && anchor.key) key = keyOf(anchor.key.threadId);
  let index: number;
  let found = key !== null;
  if (key) {
    index = scalar(
      db,
      'SELECT count(*) FROM thread_labels WHERE label_id = ? AND (last_time, thread_id) > (?, ?)',
      labelId,
      key.time,
      key.threadId,
    );
  } else {
    index = Math.max(0, Math.min(Math.trunc(anchor.index), total - 1));
    const r = db
      .stmt(
        `SELECT last_time, thread_id FROM thread_labels WHERE label_id = ?
         ORDER BY last_time DESC, thread_id DESC LIMIT 1 OFFSET ?`,
      )
      .get(labelId, index);
    key = r ? { time: asNumber(r.last_time), threadId: asNumber(r.thread_id) } : null;
    found = false;
  }
  if (!key) {
    return { total, start: 0, rows: [], details: [], anchor: null, selected };
  }
  const newer = newerRows(db, labelId, key, before);
  const rows = [...newer, ...olderRows(db, labelId, key, true, after)];
  return {
    total,
    start: index - newer.length,
    rows,
    details: rowDetails(
      db,
      rows.map((r) => r.threadId),
      rows.length,
    ),
    anchor: found ? index : null,
    selected,
  };
}

/** Subject, participants and labels of the conversations on screen. */
export function rowDetails(
  db: Db,
  threadIds: readonly number[],
  max: number = MAX_DETAILS,
): RowDetails[] {
  const subject = db.stmt(
    'SELECT subject FROM messages WHERE thread_id = ? ORDER BY time ASC, rowid ASC LIMIT 1',
  );
  const senders = db.stmt(
    `SELECT sender_name, sender_addr FROM messages WHERE thread_id = ?
     ORDER BY time ASC, rowid ASC LIMIT ${PARTICIPANT_SCAN}`,
  );
  const labels = db.stmt(
    'SELECT label_id FROM thread_labels WHERE thread_id = ? ORDER BY label_id',
  );
  return threadIds.slice(0, max).map((threadId) => {
    const seen = new Set<string>();
    const participants: Participant[] = [];
    for (const s of senders.all(threadId)) {
      const address = String(s.sender_addr ?? '');
      const name = String(s.sender_name ?? '');
      const key = address.toLowerCase() || `name:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      participants.push({ name, address });
      if (participants.length === MAX_PARTICIPANTS) break;
    }
    return {
      threadId,
      subject: String(subject.get(threadId)?.subject ?? ''),
      participants,
      labelIds: labels.all(threadId).map((r) => String(r.label_id)),
    };
  });
}

/** The conversation a message is in now, or null if the message is gone. */
export function threadOfMessage(db: Db, rowid: number): number | null {
  const row = db.stmt('SELECT thread_id FROM messages WHERE rowid = ?').get(rowid);
  return row ? asNumber(row.thread_id) : null;
}
