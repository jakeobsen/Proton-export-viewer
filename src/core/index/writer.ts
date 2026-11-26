// SPDX-License-Identifier: AGPL-3.0-or-later
// The index writer: the one write connection, one transaction per batch.
// Phase 1 groups messages into conversations as they arrive. When a message
// links several conversations, they merge into the one with the most messages
// (ties go to the lower ID), so a long chain read in any order re-points few
// rows. Aggregates are kept incrementally: a join adds the message's values,
// and a merge adds the two conversations' rows together.

import { randomUUID } from 'node:crypto';
import { sameStamp, type Stamp } from '../../shared/sources';
import { LABEL_CHUNK, REPOINT_CHUNK } from './limits';
import type { LabelEntry } from './labels';
import { MAX_LABELS, addressText, type MessageRow } from './metadata';
import { BODY_STATE, META, META_STATE } from './schema';
import { asNumber, type Db, type SqlValue } from './sql';

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
  /** The pair's current rev the result was made for; null for a pair not yet in the index. */
  expectedRev: number | null;
  row: MessageRow | null;
  /** Why the metadata couldn't be used, when `row` is null and the file exists. */
  error: string | null;
}

export interface Phase1Stats {
  /** The batch's stamp was no longer current: nothing was written. */
  stale: boolean;
  messages: number;
  failed: number;
  /** Items dropped because their pair's rev had moved on (or the pair already existed). */
  dropped: number;
  newThreads: number;
  merges: number;
  repointedMessages: number;
  repointedKeys: number;
  repointedLabelRows: number;
  /** The most rows one merge re-pointed (members, keys and per-label rows). */
  maxRepointed: number;
  capped: Array<{ fileId: string; capped: number }>;
  errors: Array<{ fileId: string; code: string }>;
}

export const PAIR_META_MISSING = 'PAIR_META_MISSING';

interface ThreadAgg {
  msg_count: number;
  unread_count: number;
  attach_count: number;
  first_time: number;
  last_time: number;
}

export class StaleBatch extends Error {
  constructor() {
    super('STALE');
  }
}

const emptyStats = (): Phase1Stats => ({
  stale: false,
  messages: 0,
  failed: 0,
  dropped: 0,
  newThreads: 0,
  merges: 0,
  repointedMessages: 0,
  repointedKeys: 0,
  repointedLabelRows: 0,
  maxRepointed: 0,
  capped: [],
  errors: [],
});

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
   * chunks too. `stat` records which file it was.
   */
  writeLabels(stamp: Stamp, labels: LabelEntry[], stat: string): void {
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
      this.db
        .stmt(
          'INSERT INTO source_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(META.labelsStat, stat);
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

  /** The IDs of every pair in the index. */
  pairIds(): string[] {
    return this.db
      .stmt('SELECT proton_id FROM pairs')
      .all()
      .map((r) => String(r.proton_id));
  }

  /**
   * Writes one batch of phase-1 results in one transaction. Each item is
   * checked against its pair's current rev inside the transaction: a new pair
   * (expectedRev null) is written only if the index doesn't have it yet.
   */
  phase1Batch(stamp: Stamp, items: Phase1Item[]): Phase1Stats {
    const stats = emptyStats();
    if (!sameStamp(stamp, this.stamp)) {
      stats.stale = true;
      return stats;
    }
    this.transaction(() => {
      const revOf = this.db.stmt('SELECT rev FROM pairs WHERE proton_id = ?');
      for (const item of items) {
        this.step();
        const current = revOf.get(item.pair.protonId);
        const currentRev = current ? asNumber(current.rev) : null;
        if (currentRev !== item.expectedRev) {
          stats.dropped += 1;
          continue;
        }
        if (currentRev !== null) {
          // Changed pairs are reconciled elsewhere; phase 1 only adds.
          stats.dropped += 1;
          continue;
        }
        const fileId = this.insertPair(item);
        if (item.row) {
          this.insertMessage(item.row, stats);
          stats.messages += 1;
          if (item.row.capped !== 0) stats.capped.push({ fileId, capped: item.row.capped });
        } else if (item.pair.meta) {
          stats.failed += 1;
          stats.errors.push({ fileId, code: item.error ?? 'META_FAILED' });
        }
      }
    });
    return stats;
  }

  private insertPair(item: Phase1Item): string {
    const { meta, eml, protonId } = item.pair;
    this.revSeq += 1;
    const fileId = randomUUID();
    const metaState = !meta
      ? META_STATE.missing
      : item.row
        ? META_STATE.indexed
        : META_STATE.failed;
    const error = !meta ? PAIR_META_MISSING : item.row ? null : (item.error ?? 'META_FAILED');
    const file = (f: FileStat | null): SqlValue[] =>
      f ? [f.rel, f.size, f.mtimeNs, f.dev, f.ino] : [null, null, null, null, null];
    this.db
      .stmt(
        `INSERT INTO pairs(proton_id, file_id, rev, meta_rel, meta_size, meta_mtime_ns, meta_dev, meta_ino,
           meta_state, eml_rel, eml_size, eml_mtime_ns, eml_dev, eml_ino, body_state, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        protonId,
        fileId,
        this.revSeq,
        ...file(meta),
        metaState,
        ...file(eml),
        eml ? BODY_STATE.pending : BODY_STATE.emlMissing,
        error,
      );
    return fileId;
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
  private merge(into: number, from: number, stats: Phase1Stats): void {
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

  private insertMessage(row: MessageRow, stats: Phase1Stats): void {
    const found = new Set<number>();
    for (const key of row.keys) {
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
    for (const key of row.keys) keyPut.run(key, threadId);

    const rowid = asNumber(
      this.db
        .stmt(
          `INSERT INTO messages(proton_id, time, subject, sender_name, sender_addr, to_json, cc_json,
             bcc_json, reply_to_json, flags, unread, replied, replied_all, forwarded, size,
             num_attachments, mime_type, message_id, in_reply_to, references_json, dmarc, capped, thread_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.protonId,
          row.time,
          row.subject,
          row.sender.name,
          row.sender.address,
          JSON.stringify(row.to),
          JSON.stringify(row.cc),
          JSON.stringify(row.bcc),
          JSON.stringify(row.replyTo),
          row.flags,
          row.unread,
          row.replied,
          row.repliedAll,
          row.forwarded,
          row.size,
          row.numAttachments,
          row.mimeType,
          row.messageId,
          row.inReplyTo,
          JSON.stringify(row.references),
          row.dmarc,
          row.capped,
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
    for (const label of row.labelIds.slice(0, MAX_LABELS)) {
      labelPut.run(rowid, label);
      threadLabelPut.run(label, threadId, row.time, row.unread);
    }
    this.db
      .stmt(
        `UPDATE threads SET msg_count = msg_count + 1, unread_count = unread_count + ?,
           attach_count = attach_count + ?, first_time = min(first_time, ?), last_time = max(last_time, ?)
         WHERE thread_id = ?`,
      )
      .run(row.unread, attach, row.time, row.time, threadId);
    this.db
      .stmt(
        'INSERT INTO message_text(rowid, subject, sender, recipients, body, attachments) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        rowid,
        row.subject,
        addressText([row.sender]),
        addressText([...row.to, ...row.cc, ...row.bcc]),
        '',
        '',
      );
  }
}

function metaRow(db: Db, key: string): unknown {
  return db.stmt('SELECT value FROM source_meta WHERE key = ?').get(key)?.value;
}
