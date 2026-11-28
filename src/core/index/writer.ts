// SPDX-License-Identifier: AGPL-3.0-or-later
// The index writer: the one write connection, one transaction per batch.
//
// Every pair of files is registered before its metadata is read: it gets a
// rev from the source-wide sequence, which only ever goes up, so no rev is
// used twice, even for a message that was deleted and found again. A parse
// result is written only while its pair still has the rev it was read for;
// anything else is dropped, including a result for a pair that is gone.
//
// Messages are grouped into conversations as they arrive. When a message links
// several conversations, they merge into the one with the most messages (ties
// go to the lower ID), so a long chain read in any order re-points few rows.
// Aggregates are kept incrementally: a join adds the message's values, and a
// merge adds the two conversations' rows together. Taking a message out (its
// metadata changed or is gone) groups the conversation's other members again
// from their stored keys, which can split it, and recomputes their aggregates;
// a changed message is then placed again as if it were new.
//
// On reopen, reconcile compares the folder's files with the stored pairs. A
// file whose name, size or modification time (in nanoseconds) differs has
// changed. Different device or inode numbers alone (the volume was mounted
// again, or the folder was copied with its times) only update the stored
// numbers, so a moved export isn't read again.

import { randomUUID } from 'node:crypto';
import { sameStamp, type Stamp } from '../../shared/sources';
import type { AttachmentRow } from './body';
import { LABEL_CHUNK, REPOINT_CHUNK, TXN_INPUT_BYTES } from './limits';
import type { LabelEntry } from './labels';
import {
  MAX_LABELS,
  addressText,
  conversationKeys,
  foldAddress,
  type MessageRow,
} from './metadata';
import { BODY_STATE, CAPPED, META, META_STATE } from './schema';
import { asNumber, type Db, type Row, type SqlValue } from './sql';
import { stripMarks } from '../search/ranges';

/** One file of a pair as the scan saw it. */
export interface FileStat {
  rel: string;
  size: number;
  mtimeNs: bigint;
  dev: bigint;
  ino: bigint;
}

export interface PairFiles {
  protonId: string;
  meta: FileStat | null;
  eml: FileStat | null;
}

export interface Phase1Item {
  pair: PairFiles;
  /** The rev the pair had when its metadata was queued to be read. */
  expectedRev: number;
  row: MessageRow | null;
  /** Why the metadata couldn't be used, when `row` is null. */
  error: string | null;
}

/** What reconcile does to a pair's metadata: nothing, read it (again), or take its message out. */
export type MetaAction = 'keep' | 'parse' | 'remove';
/** What reconcile does about a pair's message file: nothing, it changed, it is gone, or it is back. */
export type EmlAction = 'keep' | 'changed' | 'missing' | 'back';

export interface PairChange {
  protonId: string;
  /** The index doesn't have the pair yet. */
  fresh: boolean;
  /** Neither file is there any more: everything of the pair goes, its row included. */
  gone: boolean;
  meta: MetaAction;
  eml: EmlAction;
  /** Only device or inode numbers differ: the stored numbers are updated, nothing is read again. */
  refresh: boolean;
}

export interface ReconcilePlan {
  /** Which labels.json the stored labels came from; null if none. */
  labelsStat: string | null;
  /** Every pair with something to do, new ones in the order the scan listed them. */
  changes: PairChange[];
}

export interface ApplyItem {
  change: PairChange;
  /** The pair's files as the scan saw them. */
  files: PairFiles;
}

/** What regrouping did in one transaction. */
export interface GroupStats {
  merges: number;
  /** Conversations made when a conversation split. */
  splits: number;
  /** Conversations grouped again from their members after one left. */
  regrouped: number;
  repointedMessages: number;
  repointedKeys: number;
  repointedLabelRows: number;
  /** The most rows one merge re-pointed (members, keys and per-label rows). */
  maxRepointed: number;
}

export interface Phase1Stats extends GroupStats {
  /** The batch's stamp was no longer current: nothing was written. */
  stale: boolean;
  messages: number;
  /** Messages already in the index that were placed again with their new metadata. */
  replaced: number;
  /** Messages taken out because their new metadata couldn't be used. */
  removed: number;
  failed: number;
  /** Items dropped because their pair's rev had moved on or the pair is gone. */
  dropped: number;
  newThreads: number;
  capped: Array<{ fileId: string; capped: number }>;
  errors: Array<{ fileId: string; code: string }>;
}

export interface ApplyStats extends GroupStats {
  stale: boolean;
  /** The rev each pair whose metadata is to be read now has. */
  revs: Array<[string, number]>;
  registered: number;
  /** Messages taken out because their metadata file is gone. */
  removed: number;
  /** Pairs deleted because both files are gone. */
  deleted: number;
  /** Pairs whose message file changed, went or came back. */
  bodies: number;
  /** Pairs whose stored device numbers were updated. */
  refreshed: number;
  /** Items left alone because the index no longer matched what the plan saw. */
  skipped: number;
}

/** A message whose file phase 2 is to read, with the file as reconcile last saw it. */
export interface BodyTodo {
  protonId: string;
  /** The rev the pair had when it was listed; the result must carry it. */
  rev: number;
  rel: string;
  size: number;
  mtimeNs: string;
  dev: string;
  ino: string;
}

/** What phase 2 read from one message file, for the writer. */
export interface Phase2Item {
  protonId: string;
  rev: number;
  /** BODY_STATE.indexed, truncated or failed. */
  state: number;
  body: string;
  attachments: AttachmentRow[];
  attachmentText: string;
  attachmentsCapped: boolean;
  /** Why the file couldn't be read, at state failed. */
  error: string | null;
}

export interface Phase2Stats {
  stale: boolean;
  /** Items written, failed ones included. */
  written: number;
  /** Items dropped because their pair's rev had moved on, or it no longer waits for a body. */
  dropped: number;
  /** Items left for another transaction, from the end of the batch: the text budget was reached. */
  rest: number;
  /** UTF-8 bytes of text the transaction wrote. */
  bytes: number;
  truncated: number;
  /** File IDs of the messages whose attachment list was cut to its limit. */
  capped: string[];
  /** Of those, the messages that had no other list cut. */
  cappedNew: number;
  failed: Array<{ fileId: string; code: string }>;
}

/** A message whose text alone is over the transaction budget. */
export const BODY_TOO_LARGE = 'BODY_TOO_LARGE';

export const PAIR_META_MISSING = 'PAIR_META_MISSING';

interface ThreadAgg {
  msg_count: number;
  unread_count: number;
  attach_count: number;
  first_time: number;
  last_time: number;
}

/** One stored member of a conversation, with the keys it is grouped by. */
export interface Member {
  rowid: number;
  time: number;
  unread: number;
  numAttachments: number;
  keys: string[];
}

export class StaleBatch extends Error {
  constructor() {
    super('STALE');
  }
}

const emptyGroupStats = (): GroupStats => ({
  merges: 0,
  splits: 0,
  regrouped: 0,
  repointedMessages: 0,
  repointedKeys: 0,
  repointedLabelRows: 0,
  maxRepointed: 0,
});

const emptyStats = (): Phase1Stats => ({
  ...emptyGroupStats(),
  stale: false,
  messages: 0,
  replaced: 0,
  removed: 0,
  failed: 0,
  dropped: 0,
  newThreads: 0,
  capped: [],
  errors: [],
});

const emptyApplyStats = (): ApplyStats => ({
  ...emptyGroupStats(),
  stale: false,
  revs: [],
  registered: 0,
  removed: 0,
  deleted: 0,
  bodies: 0,
  refreshed: 0,
  skipped: 0,
});

/** How labels.json is recorded, to tell on reopen whether it changed. */
export function labelsStatOf(f: FileStat): string {
  return JSON.stringify({ rel: f.rel, size: f.size, mtimeNs: String(f.mtimeNs) });
}

/** A pair as stored, with its 64-bit numbers as text. */
export interface StoredPair {
  protonId: string;
  metaState: number;
  meta: StoredFile | null;
  eml: StoredFile | null;
}

interface StoredFile {
  rel: string;
  size: number;
  mtimeNs: string;
  dev: string;
  ino: string;
}

const sameContent = (stored: StoredFile, f: FileStat): boolean =>
  stored.rel === f.rel && stored.size === f.size && stored.mtimeNs === String(f.mtimeNs);

const sameNumbers = (stored: StoredFile, f: FileStat): boolean =>
  stored.dev === String(f.dev) && stored.ino === String(f.ino);

/**
 * What a stored pair needs, given the files the scan found for it; null for
 * nothing. Metadata is read again when its file changed, came back, or was
 * queued and never written; a failed file that is unchanged isn't.
 */
export function classify(
  stored: StoredPair,
  meta: FileStat | undefined,
  eml: FileStat | undefined,
): PairChange | null {
  const base = { protonId: stored.protonId, fresh: false, gone: false, refresh: false };
  if (!meta && !eml) return { ...base, gone: true, meta: 'remove', eml: 'missing' };
  let refresh = false;
  let metaAction: MetaAction = 'keep';
  if (meta) {
    if (!stored.meta || stored.metaState === META_STATE.missing) metaAction = 'parse';
    else if (!sameContent(stored.meta, meta)) metaAction = 'parse';
    else if (stored.metaState === META_STATE.pending) metaAction = 'parse';
    else if (!sameNumbers(stored.meta, meta)) refresh = true;
  } else if (stored.metaState !== META_STATE.missing) {
    metaAction = 'remove';
  }
  let emlAction: EmlAction = 'keep';
  if (eml) {
    if (!stored.eml) emlAction = 'back';
    else if (!sameContent(stored.eml, eml)) emlAction = 'changed';
    else if (!sameNumbers(stored.eml, eml)) refresh = true;
  } else if (stored.eml) {
    emlAction = 'missing';
  }
  if (metaAction === 'keep' && emlAction === 'keep' && !refresh) return null;
  return { ...base, meta: metaAction, eml: emlAction, refresh };
}

/**
 * Groups members by shared keys (union-find). The largest group comes first,
 * ties going to the group with the lowest rowid; members must be in rowid
 * order.
 */
export function groupMembers(members: Member[]): number[][] {
  const parent = members.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const owner = new Map<string, number>();
  members.forEach((m, i) => {
    for (const key of m.keys) {
      const o = owner.get(key);
      if (o === undefined) {
        owner.set(key, i);
        continue;
      }
      const a = find(i);
      const b = find(o);
      if (a !== b) parent[a] = b;
    }
  });
  const groups = new Map<number, number[]>();
  members.forEach((_, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });
  return [...groups.values()].sort(
    (a, b) => b.length - a.length || members[a[0]!]!.rowid - members[b[0]!]!.rowid,
  );
}

/**
 * A group's message, unread and attachment counts and its first and last
 * times, in one pass: a conversation can have more members than a function
 * call takes arguments, so the times are never spread into Math.min/max.
 */
export function groupTotals(
  members: readonly Member[],
  group: readonly number[],
): { count: number; unread: number; withAttachments: number; first: number; last: number } {
  let unread = 0;
  let withAttachments = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const i of group) {
    const m = members[i]!;
    unread += m.unread;
    if (m.numAttachments > 0) withAttachments += 1;
    if (m.time < first) first = m.time;
    if (m.time > last) last = m.time;
  }
  return { count: group.length, unread, withAttachments, first, last };
}

function jsonList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const list = JSON.parse(value) as unknown;
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function storedFile(r: Row, side: 'meta' | 'eml'): StoredFile | null {
  const rel = r[`${side}_rel`];
  if (rel === null || rel === undefined) return null;
  return {
    rel: String(rel),
    size: asNumber(r[`${side}_size`]),
    mtimeNs: text(r[`${side}_mtime`]) ?? '',
    dev: text(r[`${side}_dev`]) ?? '',
    ino: text(r[`${side}_ino`]) ?? '',
  };
}

const fileValues = (f: FileStat | null): SqlValue[] =>
  f ? [f.rel, f.size, f.mtimeNs, f.dev, f.ino] : [null, null, null, null, null];

export class IndexWriter {
  private revSeq: number;

  /**
   * `step` runs before every bounded unit of work inside a transaction (one
   * message, one chunk of a merge, one chunk of labels). It throws to stop the
   * transaction, which is then rolled back. `stamp` is the source and
   * generation this writer works for; a batch with any other is dropped.
   */
  constructor(
    private readonly db: Db,
    private readonly stamp: Stamp,
    private readonly step: () => void = () => {},
  ) {
    this.revSeq = asNumber(metaRow(db, META.revSeq));
  }

  private transaction<T>(fn: () => T): T {
    const revBefore = this.revSeq;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (this.revSeq !== revBefore) {
        this.db
          .stmt('UPDATE source_meta SET value = ? WHERE key = ?')
          .run(this.revSeq, META.revSeq);
      }
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.revSeq = revBefore;
      // Some errors (SQLITE_FULL among them) have already rolled the transaction back.
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No transaction left to roll back.
      }
      throw err;
    }
  }

  private check(stamp: Stamp): void {
    if (!sameStamp(stamp, this.stamp)) throw new StaleBatch();
  }

  /**
   * Stores labels.json in place of the labels stored before, in chunks of
   * LABEL_CHUNK labels, each checked first; the old ones are removed in
   * chunks too. `stat` records which file it was; null (no file any more)
   * leaves no labels and no record.
   */
  writeLabels(stamp: Stamp, labels: LabelEntry[], stat: string | null): void {
    this.check(stamp);
    this.transaction(() => {
      const drop = this.db.stmt(
        'DELETE FROM labels WHERE proton_id IN (SELECT proton_id FROM labels LIMIT ?)',
      );
      for (;;) {
        this.step();
        if (asNumber(drop.run(LABEL_CHUNK).changes) < LABEL_CHUNK) break;
      }
      const put = this.db.stmt(
        'INSERT OR REPLACE INTO labels(proton_id, name, path, parent_id, color, type, kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const [i, l] of labels.entries()) {
        if (i % LABEL_CHUNK === 0) this.step();
        put.run(l.id, l.name, l.path, l.parentId, l.color, l.type, l.kind);
      }
      if (stat === null) {
        this.db.stmt('DELETE FROM source_meta WHERE key = ?').run(META.labelsStat);
      } else {
        this.db
          .stmt(
            'INSERT INTO source_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          )
          .run(META.labelsStat, stat);
      }
    });
  }

  /**
   * One bounded full-text merge step, in its own transaction. Returns the rows
   * it changed; 1 or less means there was nothing left to merge.
   */
  mergeStep(pages: number): number {
    return this.transaction(() => {
      this.step();
      const before = asNumber(this.db.stmt('SELECT total_changes() AS c').get()?.c);
      this.db.stmt("INSERT INTO fts(fts, rank) VALUES ('merge', ?)").run(pages);
      return asNumber(this.db.stmt('SELECT total_changes() AS c').get()?.c) - before;
    });
  }

  /** Marks phase 1 complete. */
  finishPhase1(stamp: Stamp): void {
    this.check(stamp);
    this.transaction(() => {
      this.db.stmt('UPDATE source_meta SET value = 1 WHERE key = ?').run(META.phase1Done);
    });
  }

  /**
   * Compares the scan with the stored pairs, writing nothing: every pair with
   * something to do, and which labels.json the stored labels came from.
   */
  planReconcile(metadata: Map<string, FileStat>, eml: Map<string, FileStat>): ReconcilePlan {
    const changes: PairChange[] = [];
    const known = new Set<string>();
    const rows = this.db
      .stmt(
        `SELECT proton_id, meta_state,
           meta_rel, meta_size, CAST(meta_mtime_ns AS TEXT) AS meta_mtime,
           CAST(meta_dev AS TEXT) AS meta_dev, CAST(meta_ino AS TEXT) AS meta_ino,
           eml_rel, eml_size, CAST(eml_mtime_ns AS TEXT) AS eml_mtime,
           CAST(eml_dev AS TEXT) AS eml_dev, CAST(eml_ino AS TEXT) AS eml_ino
         FROM pairs`,
      )
      .iterate();
    for (const r of rows) {
      const stored: StoredPair = {
        protonId: String(r.proton_id),
        metaState: asNumber(r.meta_state),
        meta: storedFile(r, 'meta'),
        eml: storedFile(r, 'eml'),
      };
      known.add(stored.protonId);
      const change = classify(stored, metadata.get(stored.protonId), eml.get(stored.protonId));
      if (change) changes.push(change);
    }
    const fresh = { fresh: true, gone: false, eml: 'keep' as const, refresh: false };
    for (const id of metadata.keys()) {
      if (!known.has(id)) changes.push({ ...fresh, protonId: id, meta: 'parse' });
    }
    for (const id of eml.keys()) {
      if (!known.has(id) && !metadata.has(id))
        changes.push({ ...fresh, protonId: id, meta: 'keep' });
    }
    const labels = metaRow(this.db, META.labelsStat);
    return { labelsStat: typeof labels === 'string' ? labels : null, changes };
  }

  /**
   * Applies reconcile's changes in one transaction, each pair checked first.
   * Every change gives its pair a new rev; a new pair is registered with one.
   * The revs of pairs whose metadata is to be read are returned, and their
   * results must carry them. A message whose metadata is gone is taken out,
   * and a pair with neither file is deleted; a changed or missing message file
   * clears the text read from it and leaves the body for phase 2.
   */
  applyChanges(stamp: Stamp, items: ApplyItem[]): ApplyStats {
    const stats = emptyApplyStats();
    if (!sameStamp(stamp, this.stamp)) {
      stats.stale = true;
      return stats;
    }
    this.transaction(() => {
      const current = this.db.stmt(
        'SELECT rev, meta_state, error_code, body_state FROM pairs WHERE proton_id = ?',
      );
      for (const { change, files } of items) {
        this.step();
        const id = change.protonId;
        const row = current.get(id);
        if (change.fresh) {
          if (row) {
            stats.skipped += 1;
            continue;
          }
          const rev = this.registerPair(files);
          stats.registered += 1;
          if (files.meta) stats.revs.push([id, rev]);
          continue;
        }
        if (!row) {
          stats.skipped += 1;
          continue;
        }
        if (change.gone) {
          if (this.removeMessage(id, stats)) stats.removed += 1;
          this.db.stmt('DELETE FROM pairs WHERE proton_id = ?').run(id);
          stats.deleted += 1;
          continue;
        }
        const bump = change.meta !== 'keep' || change.eml !== 'keep';
        let rev = asNumber(row.rev);
        if (bump) {
          this.revSeq += 1;
          rev = this.revSeq;
        } else {
          stats.refreshed += 1;
        }
        let metaState = asNumber(row.meta_state);
        let error = text(row.error_code);
        if (change.meta === 'parse') {
          metaState = META_STATE.pending;
          error = null;
          stats.revs.push([id, rev]);
        } else if (change.meta === 'remove') {
          if (this.removeMessage(id, stats)) stats.removed += 1;
          metaState = META_STATE.missing;
          error = PAIR_META_MISSING;
        }
        // Taking the message out may have set its body back to waiting.
        let bodyState = asNumber(
          change.meta === 'remove'
            ? this.db.stmt('SELECT body_state FROM pairs WHERE proton_id = ?').get(id)?.body_state
            : row.body_state,
        );
        if (change.eml !== 'keep') {
          if (change.eml !== 'back') this.clearBody(id);
          bodyState = change.eml === 'missing' ? BODY_STATE.emlMissing : BODY_STATE.pending;
          stats.bodies += 1;
        }
        // The stored numbers always become the scan's, so a device number
        // that moved is updated with everything else.
        this.db
          .stmt(
            `UPDATE pairs SET rev = ?, meta_rel = ?, meta_size = ?, meta_mtime_ns = ?, meta_dev = ?,
               meta_ino = ?, meta_state = ?, eml_rel = ?, eml_size = ?, eml_mtime_ns = ?, eml_dev = ?,
               eml_ino = ?, body_state = ?, error_code = ?
             WHERE proton_id = ?`,
          )
          .run(
            rev,
            ...fileValues(files.meta),
            metaState,
            ...fileValues(files.eml),
            bodyState,
            error,
            id,
          );
      }
    });
    return stats;
  }

  /** Registers a new pair with the next rev; its metadata, if any, is still to be read. */
  private registerPair(files: PairFiles): number {
    this.revSeq += 1;
    this.db
      .stmt(
        `INSERT INTO pairs(proton_id, file_id, rev, meta_rel, meta_size, meta_mtime_ns, meta_dev, meta_ino,
           meta_state, eml_rel, eml_size, eml_mtime_ns, eml_dev, eml_ino, body_state, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        files.protonId,
        randomUUID(),
        this.revSeq,
        ...fileValues(files.meta),
        files.meta ? META_STATE.pending : META_STATE.missing,
        ...fileValues(files.eml),
        files.eml ? BODY_STATE.pending : BODY_STATE.emlMissing,
        files.meta ? null : PAIR_META_MISSING,
      );
    return this.revSeq;
  }

  /**
   * Clears what was read from a pair's message file: its body text and
   * attachment names (and their full-text entries), the attachments listed
   * from it, and its attachments cap flag. The message's other cap flags stay.
   */
  private clearBody(protonId: string): void {
    const m = this.db.stmt('SELECT rowid FROM messages WHERE proton_id = ?').get(protonId);
    if (!m) return;
    const rowid = asNumber(m.rowid);
    this.db
      .stmt(
        "UPDATE message_text SET body = '', attachments = '' WHERE rowid = ? AND (body <> '' OR attachments <> '')",
      )
      .run(rowid);
    this.db.stmt("DELETE FROM attachments WHERE message_rowid = ? AND source = 'eml'").run(rowid);
    this.db
      .stmt('UPDATE messages SET capped = capped & ? WHERE rowid = ? AND capped & ?')
      .run(~CAPPED.attachments, rowid, CAPPED.attachments);
  }

  /**
   * Writes one batch of parse results in one transaction. Each item is checked
   * against its pair's current rev inside the transaction, and dropped unless
   * it matches and the pair still waits for it. A message already in the index is taken out of its
   * conversation and placed again with its new metadata, keeping its rowid and
   * its body; one whose new metadata can't be used is taken out.
   */
  phase1Batch(stamp: Stamp, items: Phase1Item[]): Phase1Stats {
    const stats = emptyStats();
    if (!sameStamp(stamp, this.stamp)) {
      stats.stale = true;
      return stats;
    }
    this.transaction(() => {
      const pairOf = this.db.stmt('SELECT rev, file_id, meta_state FROM pairs WHERE proton_id = ?');
      const messageOf = this.db.stmt(
        'SELECT rowid, thread_id, capped FROM messages WHERE proton_id = ?',
      );
      const setMeta = this.db.stmt(
        `UPDATE pairs SET meta_rel = ?, meta_size = ?, meta_mtime_ns = ?, meta_dev = ?, meta_ino = ?,
           meta_state = ?, error_code = ? WHERE proton_id = ?`,
      );
      for (const item of items) {
        this.step();
        const id = item.pair.protonId;
        const pair = pairOf.get(id);
        // Written once: only while the pair still has this rev and waits for it.
        if (
          !pair ||
          asNumber(pair.rev) !== item.expectedRev ||
          asNumber(pair.meta_state) !== META_STATE.pending ||
          !item.pair.meta
        ) {
          stats.dropped += 1;
          continue;
        }
        const fileId = String(pair.file_id);
        const old = messageOf.get(id);
        const oldRowid = old ? asNumber(old.rowid) : null;
        if (item.row) {
          if (old) {
            this.detach(asNumber(old.rowid), asNumber(old.thread_id), stats);
            stats.replaced += 1;
          }
          // The attachments flag comes from the message file, which stays.
          const kept = old ? asNumber(old.capped) & CAPPED.attachments : 0;
          this.insertMessage(item.row, stats, oldRowid, kept);
          stats.messages += 1;
          if (item.row.capped !== 0) stats.capped.push({ fileId, capped: item.row.capped });
          setMeta.run(...fileValues(item.pair.meta), META_STATE.indexed, null, id);
        } else {
          if (this.removeMessage(id, stats)) stats.removed += 1;
          const code = item.error ?? 'META_FAILED';
          stats.failed += 1;
          stats.errors.push({ fileId, code });
          setMeta.run(...fileValues(item.pair.meta), META_STATE.failed, code, id);
        }
      }
    });
    return stats;
  }

  /**
   * The messages whose body phase 2 still has to read, newest first (ties to
   * the higher rowid), as rowids. A message without a message file, or whose
   * metadata isn't indexed, has none to read.
   */
  bodyOrder(): number[] {
    return this.db
      .stmt(
        `SELECT m.rowid AS rowid FROM messages m JOIN pairs p ON p.proton_id = m.proton_id
         WHERE p.body_state = ? AND p.eml_rel IS NOT NULL
         ORDER BY m.time DESC, m.rowid DESC`,
      )
      .all(BODY_STATE.pending)
      .map((r) => asNumber(r.rowid));
  }

  /** Of these messages, in this order, the ones that still wait for their body, with their files. */
  bodyTodo(rowids: number[]): BodyTodo[] {
    const one = this.db.stmt(
      `SELECT p.proton_id, p.rev, p.eml_rel, p.eml_size, CAST(p.eml_mtime_ns AS TEXT) AS mtime,
         CAST(p.eml_dev AS TEXT) AS dev, CAST(p.eml_ino AS TEXT) AS ino
       FROM messages m JOIN pairs p ON p.proton_id = m.proton_id
       WHERE m.rowid = ? AND p.body_state = ? AND p.eml_rel IS NOT NULL`,
    );
    const out: BodyTodo[] = [];
    for (const rowid of rowids) {
      const r = one.get(rowid, BODY_STATE.pending);
      if (!r) continue;
      out.push({
        protonId: String(r.proton_id),
        rev: asNumber(r.rev),
        rel: String(r.eml_rel),
        size: asNumber(r.eml_size),
        mtimeNs: text(r.mtime) ?? '0',
        dev: text(r.dev) ?? '0',
        ino: text(r.ino) ?? '0',
      });
    }
    return out;
  }

  /**
   * Writes one batch of phase 2 results in one transaction, each checked
   * against its pair's current rev inside the transaction and dropped unless
   * it matches and the pair still waits for its body. A result sets the
   * body, the attachment names (the full-text entry is rewritten with them),
   * the attachment rows read from the file, the attachments cap flag and the
   * body state. The transaction writes at most `budget` bytes of text,
   * counting the message's other columns, which its full-text entry rewrites
   * too: the items past that are left for another transaction. One message
   * that alone is over the budget gets the failed state and BODY_TOO_LARGE.
   */
  phase2Batch(stamp: Stamp, items: Phase2Item[], budget = TXN_INPUT_BYTES): Phase2Stats {
    const stats: Phase2Stats = {
      stale: false,
      written: 0,
      dropped: 0,
      rest: 0,
      bytes: 0,
      truncated: 0,
      capped: [],
      cappedNew: 0,
      failed: [],
    };
    if (!sameStamp(stamp, this.stamp)) {
      stats.stale = true;
      return stats;
    }
    this.transaction(() => {
      const target = this.db.stmt(
        `SELECT m.rowid AS rowid, m.capped AS capped, p.rev AS rev, p.file_id AS file_id,
           p.body_state AS body_state, coalesce(length(CAST(t.subject AS BLOB)), 0) + coalesce(length(CAST(t.sender AS BLOB)), 0)
             + coalesce(length(CAST(t.recipients AS BLOB)), 0) AS other
         FROM pairs p JOIN messages m ON m.proton_id = p.proton_id
           LEFT JOIN message_text t ON t.rowid = m.rowid
         WHERE p.proton_id = ?`,
      );
      const setText = this.db.stmt(
        'UPDATE message_text SET body = ?, attachments = ? WHERE rowid = ?',
      );
      const dropRows = this.db.stmt(
        "DELETE FROM attachments WHERE message_rowid = ? AND source = 'eml'",
      );
      const putRow = this.db.stmt(
        `INSERT OR REPLACE INTO attachments(message_rowid, idx, filename, mime, size, content_id, source)
         VALUES (?, ?, ?, ?, ?, ?, 'eml')`,
      );
      const setCapped = this.db.stmt('UPDATE messages SET capped = capped | ? WHERE rowid = ?');
      const setState = this.db.stmt(
        'UPDATE pairs SET body_state = ?, error_code = ? WHERE proton_id = ?',
      );
      for (const [i, item] of items.entries()) {
        this.step();
        const row = target.get(item.protonId);
        if (
          !row ||
          asNumber(row.rev) !== item.rev ||
          asNumber(row.body_state) !== BODY_STATE.pending
        ) {
          stats.dropped += 1;
          continue;
        }
        const rowid = asNumber(row.rowid);
        const fileId = String(row.file_id);
        if (item.state === BODY_STATE.failed) {
          setState.run(BODY_STATE.failed, item.error ?? 'BODY_FAILED', item.protonId);
          stats.failed.push({ fileId, code: item.error ?? 'BODY_FAILED' });
          stats.written += 1;
          continue;
        }
        const bytes = textBytes(item) + asNumber(row.other);
        if (bytes > budget) {
          setState.run(BODY_STATE.failed, BODY_TOO_LARGE, item.protonId);
          stats.failed.push({ fileId, code: BODY_TOO_LARGE });
          stats.written += 1;
          continue;
        }
        if (stats.bytes + bytes > budget) {
          stats.rest = items.length - i;
          break;
        }
        stats.bytes += bytes;
        if (item.body !== '' || item.attachmentText !== '') {
          setText.run(item.body, item.attachmentText, rowid);
        }
        dropRows.run(rowid);
        for (const [idx, a] of item.attachments.entries()) {
          if (idx > 0 && idx % REPOINT_CHUNK === 0) this.step();
          putRow.run(rowid, idx, a.name, a.mime, a.size, a.contentId);
        }
        if (item.attachmentsCapped) {
          setCapped.run(CAPPED.attachments, rowid);
          stats.capped.push(fileId);
          if (asNumber(row.capped) === 0) stats.cappedNew += 1;
        }
        if (item.state === BODY_STATE.truncated) stats.truncated += 1;
        setState.run(item.state, null, item.protonId);
        stats.written += 1;
      }
    });
    return stats;
  }

  private threadOf(key: string): number | null {
    const row = this.db.stmt('SELECT thread_id FROM thread_keys WHERE key = ?').get(key);
    return row ? asNumber(row.thread_id) : null;
  }

  private agg(threadId: number): ThreadAgg {
    const row = this.db
      .stmt(
        'SELECT msg_count, unread_count, attach_count, first_time, last_time FROM threads WHERE thread_id = ?',
      )
      .get(threadId);
    if (!row) throw new Error('missing conversation');
    return {
      msg_count: asNumber(row.msg_count),
      unread_count: asNumber(row.unread_count),
      attach_count: asNumber(row.attach_count),
      first_time: asNumber(row.first_time),
      last_time: asNumber(row.last_time),
    };
  }

  private repointChunks(sql: string, into: number, from: number): number {
    let total = 0;
    for (;;) {
      this.step();
      const n = asNumber(this.db.stmt(sql).run(into, from, REPOINT_CHUNK).changes);
      total += n;
      if (n < REPOINT_CHUNK) return total;
    }
  }

  /** Merges `from` into `into`: members, keys, aggregates and per-label rows. */
  private merge(into: number, from: number, stats: GroupStats): void {
    const a = this.agg(from);
    stats.merges += 1;
    const members = this.repointChunks(
      'UPDATE messages SET thread_id = ? WHERE rowid IN (SELECT rowid FROM messages WHERE thread_id = ? LIMIT ?)',
      into,
      from,
    );
    const keys = this.repointChunks(
      'UPDATE thread_keys SET thread_id = ? WHERE key IN (SELECT key FROM thread_keys WHERE thread_id = ? LIMIT ?)',
      into,
      from,
    );
    this.db
      .stmt(
        `UPDATE threads SET msg_count = msg_count + ?, unread_count = unread_count + ?,
           attach_count = attach_count + ?, first_time = min(first_time, ?), last_time = max(last_time, ?)
         WHERE thread_id = ?`,
      )
      .run(a.msg_count, a.unread_count, a.attach_count, a.first_time, a.last_time, into);
    const labelRows = this.moveThreadLabels(into, from);
    this.db.stmt('DELETE FROM threads WHERE thread_id = ?').run(from);
    stats.repointedMessages += members;
    stats.repointedKeys += keys;
    stats.repointedLabelRows += labelRows;
    stats.maxRepointed = Math.max(stats.maxRepointed, members + keys + labelRows);
  }

  /**
   * Moves `from`'s per-label rows onto `into`, REPOINT_CHUNK rows at a time,
   * each chunk checked first: the same first rows (by label) are added to
   * `into` and then removed from `from`.
   */
  private moveThreadLabels(into: number, from: number): number {
    const add = this.db.stmt(
      `INSERT INTO thread_labels(label_id, thread_id, last_time, msg_count, unread_count)
       SELECT label_id, ?, last_time, msg_count, unread_count FROM thread_labels
         WHERE thread_id = ? ORDER BY label_id LIMIT ?
       ON CONFLICT(label_id, thread_id) DO UPDATE SET
         last_time = max(last_time, excluded.last_time),
         msg_count = msg_count + excluded.msg_count,
         unread_count = unread_count + excluded.unread_count`,
    );
    const drop = this.db.stmt(
      `DELETE FROM thread_labels WHERE thread_id = ? AND label_id IN
         (SELECT label_id FROM thread_labels WHERE thread_id = ? ORDER BY label_id LIMIT ?)`,
    );
    let moved = 0;
    for (;;) {
      this.step();
      add.run(into, from, REPOINT_CHUNK);
      const n = asNumber(drop.run(from, from, REPOINT_CHUNK).changes);
      moved += n;
      if (n < REPOINT_CHUNK) return moved;
    }
  }

  /**
   * Takes a message out of the index: its row, labels, text (with its
   * full-text entry) and attachments, and its place in its conversation.
   * Its message file, if still there, waits to be read again, so the text
   * is back once the message is. Returns whether there was one.
   */
  private removeMessage(protonId: string, stats: GroupStats): boolean {
    const m = this.db
      .stmt('SELECT rowid, thread_id FROM messages WHERE proton_id = ?')
      .get(protonId);
    if (!m) return false;
    const rowid = asNumber(m.rowid);
    this.detach(rowid, asNumber(m.thread_id), stats);
    this.db.stmt('DELETE FROM message_text WHERE rowid = ?').run(rowid);
    this.db.stmt('DELETE FROM attachments WHERE message_rowid = ?').run(rowid);
    this.db
      .stmt(
        'UPDATE pairs SET body_state = ? WHERE proton_id = ? AND eml_rel IS NOT NULL AND body_state <> ?',
      )
      .run(BODY_STATE.pending, protonId, BODY_STATE.emlMissing);
    return true;
  }

  /**
   * Takes a message's row and labels out and groups the rest of its
   * conversation again. Its text stays, for a message placed again.
   */
  private detach(rowid: number, threadId: number, stats: GroupStats): void {
    this.db.stmt('DELETE FROM message_labels WHERE message_rowid = ?').run(rowid);
    this.db.stmt('DELETE FROM messages WHERE rowid = ?').run(rowid);
    this.regroup(threadId, stats);
  }

  /** A conversation's members in rowid order, with the keys they are grouped by. */
  private members(threadId: number): Member[] {
    return this.db
      .stmt(
        `SELECT rowid, time, unread, num_attachments, message_id, in_reply_to_json, references_json
         FROM messages WHERE thread_id = ? ORDER BY rowid`,
      )
      .all(threadId)
      .map((r) => ({
        rowid: asNumber(r.rowid),
        time: asNumber(r.time),
        unread: asNumber(r.unread),
        numAttachments: asNumber(r.num_attachments),
        keys: conversationKeys({
          messageId: text(r.message_id),
          inReplyTo: jsonList(r.in_reply_to_json),
          references: jsonList(r.references_json),
        }),
      }));
  }

  /** Runs `sql` (one bounded chunk, `LIMIT ?` last) until it changes fewer rows than a chunk. */
  private chunked(sql: string, ...params: SqlValue[]): number {
    let total = 0;
    for (;;) {
      this.step();
      const n = asNumber(this.db.stmt(sql).run(...params, REPOINT_CHUNK).changes);
      total += n;
      if (n < REPOINT_CHUNK) return total;
    }
  }

  /**
   * Groups a conversation's members again from scratch after one left: its
   * keys and per-label rows are dropped, the members are grouped by their
   * stored keys, the largest group keeps the conversation's ID and every
   * other group becomes a new conversation. Keys, aggregates and per-label
   * rows are then made again from the members. With no members left, the
   * conversation is deleted.
   */
  private regroup(threadId: number, stats: GroupStats): void {
    stats.regrouped += 1;
    this.chunked(
      'DELETE FROM thread_keys WHERE key IN (SELECT key FROM thread_keys WHERE thread_id = ? LIMIT ?)',
      threadId,
    );
    this.chunked(
      `DELETE FROM thread_labels WHERE thread_id = ? AND label_id IN
         (SELECT label_id FROM thread_labels WHERE thread_id = ? LIMIT ?)`,
      threadId,
      threadId,
    );
    this.step();
    const members = this.members(threadId);
    if (members.length === 0) {
      this.db.stmt('DELETE FROM threads WHERE thread_id = ?').run(threadId);
      return;
    }
    const repoint = this.db.stmt('UPDATE messages SET thread_id = ? WHERE rowid = ?');
    const keyPut = this.db.stmt('INSERT INTO thread_keys(key, thread_id) VALUES (?, ?)');
    const groups = groupMembers(members);
    // Every group but the largest moves to a conversation of its own first, so
    // each conversation's rows below are made from its own members only.
    const ids = groups.map((group, i) => {
      if (i === 0) return threadId;
      this.step();
      const id = asNumber(
        this.db
          .stmt(
            'INSERT INTO threads(msg_count, unread_count, attach_count, first_time, last_time) VALUES (0, 0, 0, 0, 0)',
          )
          .run().lastInsertRowid,
      );
      stats.splits += 1;
      for (const [n, m] of group.entries()) {
        if (n > 0 && n % REPOINT_CHUNK === 0) this.step();
        repoint.run(id, members[m]!.rowid);
      }
      stats.repointedMessages += group.length;
      return id;
    });
    for (const [i, group] of groups.entries()) {
      this.step();
      const id = ids[i]!;
      // Members of one group can share keys; each key is stored once. No key
      // is in two groups, by how they were made.
      const keys = new Set<string>();
      for (const m of group) for (const key of members[m]!.keys) keys.add(key);
      let written = 0;
      for (const key of keys) {
        if (written > 0 && written % REPOINT_CHUNK === 0) this.step();
        keyPut.run(key, id);
        written += 1;
      }
      const totals = groupTotals(members, group);
      this.db
        .stmt(
          `UPDATE threads SET msg_count = ?, unread_count = ?, attach_count = ?, first_time = ?, last_time = ?
           WHERE thread_id = ?`,
        )
        .run(totals.count, totals.unread, totals.withAttachments, totals.first, totals.last, id);
      this.step();
      this.db
        .stmt(
          `INSERT INTO thread_labels(label_id, thread_id, last_time, msg_count, unread_count)
           SELECT ml.label_id, m.thread_id, max(m.time), count(*), sum(m.unread)
           FROM messages m JOIN message_labels ml ON ml.message_rowid = m.rowid
           WHERE m.thread_id = ? GROUP BY ml.label_id`,
        )
        .run(id);
    }
  }

  /**
   * Places a message: joins the conversation of its keys, merges the ones it
   * links, or starts a new one. `rowid` keeps the row of a message placed
   * again, whose text (and body) stays where it is; `keptCapped` holds the
   * cap flags it keeps from before.
   */
  private insertMessage(
    row: MessageRow,
    stats: Phase1Stats,
    rowid: number | null = null,
    keptCapped = 0,
  ): void {
    const keys = conversationKeys(row);
    const found = new Set<number>();
    for (const key of keys) {
      const t = this.threadOf(key);
      if (t !== null) found.add(t);
    }
    const attach = row.numAttachments > 0 ? 1 : 0;
    let threadId: number;
    if (found.size === 0) {
      threadId = asNumber(
        this.db
          .stmt(
            'INSERT INTO threads(msg_count, unread_count, attach_count, first_time, last_time) VALUES (0, 0, 0, ?, ?)',
          )
          .run(row.time, row.time).lastInsertRowid,
      );
      stats.newThreads += 1;
    } else {
      // Union by size: the largest conversation stays, ties go to the lower ID.
      const sized = [...found].map((id) => ({ id, n: this.agg(id).msg_count }));
      sized.sort((x, y) => y.n - x.n || x.id - y.id);
      threadId = sized[0]!.id;
      for (const other of sized.slice(1)) this.merge(threadId, other.id, stats);
      // The message's own rows are a unit of their own after the merges.
      if (sized.length > 1) this.step();
    }
    const keyPut = this.db.stmt(
      'INSERT INTO thread_keys(key, thread_id) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
    );
    for (const key of keys) keyPut.run(key, threadId);

    const messageRowid = asNumber(
      this.db
        .stmt(
          `INSERT INTO messages(rowid, proton_id, time, subject, sender_name, sender_addr, to_json, cc_json,
             bcc_json, reply_to_json, sender_fold, to_fold, cc_fold, flags, unread, replied, replied_all,
             forwarded, size, num_attachments, mime_type, message_id, in_reply_to_json, references_json,
             dmarc, capped, thread_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rowid,
          row.protonId,
          row.time,
          row.subject,
          row.sender.name,
          row.sender.address,
          JSON.stringify(row.to),
          JSON.stringify(row.cc),
          JSON.stringify(row.bcc),
          JSON.stringify(row.replyTo),
          foldAddress(row.sender.address),
          JSON.stringify(row.to.map((a) => foldAddress(a.address))),
          JSON.stringify(row.cc.map((a) => foldAddress(a.address))),
          row.flags,
          row.unread,
          row.replied,
          row.repliedAll,
          row.forwarded,
          row.size,
          row.numAttachments,
          row.mimeType,
          row.messageId,
          JSON.stringify(row.inReplyTo),
          JSON.stringify(row.references),
          row.dmarc,
          row.capped | keptCapped,
          threadId,
        ).lastInsertRowid,
    );
    const labelPut = this.db.stmt(
      'INSERT OR IGNORE INTO message_labels(message_rowid, label_id) VALUES (?, ?)',
    );
    const threadLabelPut = this.db.stmt(
      `INSERT INTO thread_labels(label_id, thread_id, last_time, msg_count, unread_count)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(label_id, thread_id) DO UPDATE SET last_time = max(last_time, excluded.last_time),
         msg_count = msg_count + 1, unread_count = unread_count + excluded.unread_count`,
    );
    // Each label counts once per message, as in message_labels.
    for (const label of new Set(row.labelIds.slice(0, MAX_LABELS))) {
      labelPut.run(messageRowid, label);
      threadLabelPut.run(label, threadId, row.time, row.unread);
    }
    this.db
      .stmt(
        `UPDATE threads SET msg_count = msg_count + 1, unread_count = unread_count + ?,
           attach_count = attach_count + ?, first_time = min(first_time, ?), last_time = max(last_time, ?)
         WHERE thread_id = ?`,
      )
      .run(row.unread, attach, row.time, row.time, threadId);
    // The characters snippets mark matches with never reach the full-text index.
    const subject = stripMarks(row.subject);
    const sender = stripMarks(addressText([row.sender]));
    const recipients = stripMarks(addressText([...row.to, ...row.cc, ...row.bcc]));
    const kept =
      rowid !== null &&
      asNumber(
        this.db
          .stmt('UPDATE message_text SET subject = ?, sender = ?, recipients = ? WHERE rowid = ?')
          .run(subject, sender, recipients, messageRowid).changes,
      ) > 0;
    if (!kept) {
      this.db
        .stmt(
          'INSERT INTO message_text(rowid, subject, sender, recipients, body, attachments) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(messageRowid, subject, sender, recipients, '', '');
    }
  }
}

/** The UTF-8 bytes of text a phase 2 result writes: body, attachment names and rows. */
export function textBytes(item: Phase2Item): number {
  let n = Buffer.byteLength(item.body) + Buffer.byteLength(item.attachmentText);
  for (const a of item.attachments) {
    n += Buffer.byteLength(a.name) + Buffer.byteLength(a.mime) + Buffer.byteLength(a.contentId);
  }
  return n;
}

function metaRow(db: Db, key: string): unknown {
  return db.stmt('SELECT value FROM source_meta WHERE key = ?').get(key)?.value;
}
