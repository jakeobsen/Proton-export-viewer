// SPDX-License-Identifier: AGPL-3.0-or-later
// The index writer: one write connection, one transaction per batch. Phase 1
// groups messages into conversations as they arrive; when a message links
// conversations, the smaller ones join the largest (ties go to the lower ID),
// so a long chain read in any order re-points few rows.

import { randomBytes } from 'node:crypto';
import { BODY_STATE } from './schema';
import { asNumber, type Db } from './sql';
import { MAX_ATTACHMENTS, MAX_LABELS, addressText, type MessageRow } from './metadata';

export interface PairInfo {
  protonId: string;
  metaRel: string;
  metaSize: number;
  metaMtimeNs: number;
  metaDev: number;
  metaIno: number;
  emlRel: string | null;
  emlSize: number | null;
  emlMtimeNs: number | null;
  emlDev: number | null;
  emlIno: number | null;
}

export interface Phase1Item {
  pair: PairInfo;
  row: MessageRow | null;
  error: string | null;
}

export interface Phase1Stats {
  messages: number;
  failed: number;
  ms: number;
  newThreads: number;
  merges: number;
  repointedMessages: number;
  repointedKeys: number;
  repointedLabelRows: number;
  /** Merges where either side had at least BIG_MERGE messages, as they happened. */
  bigMerges: Array<{
    into: number;
    from: number;
    intoSize: number;
    fromSize: number;
    repointed: number;
  }>;
}

export const BIG_MERGE = 500;

export interface BodyResult {
  protonId: string;
  rev: number;
  state: number;
  text: string;
  error: string | null;
}

export interface Phase2Stats {
  written: number;
  dropped: number;
  ms: number;
}

export interface LabelEntry {
  id: string;
  name: string;
  path: string;
  parentId: string;
  color: string | null;
  type: number;
}

const COLOR = /^#[0-9A-Fa-f]{6}$/;

interface ThreadAgg {
  msg_count: number;
  unread_count: number;
  attach_count: number;
  first_time: number;
  last_time: number;
}

/** Rows one statement may re-point when a merge moves members, keys or per-label rows. */
export const REPOINT_CHUNK = 500;
/** Labels written per checked chunk when labels.json is stored. */
export const LABEL_CHUNK = 500;

export class IndexWriter {
  private revSeq: number;

  /**
   * `step` runs before every bounded unit of work inside a transaction (one
   * message, one chunk of a merge, one body, one merge step). It throws to stop
   * the transaction, which is then rolled back.
   */
  constructor(
    private readonly db: Db,
    private readonly step: () => void = () => {},
  ) {
    this.revSeq = asNumber(
      db.stmt("SELECT value FROM source_meta WHERE key = 'rev_seq'").get()?.value,
    );
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.stmt("UPDATE source_meta SET value = ? WHERE key = 'rev_seq'").run(this.revSeq);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      // Some errors (SQLITE_FULL among them) have already rolled the transaction back.
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No transaction left to roll back.
      }
      throw err;
    }
  }

  /**
   * Stores labels.json, in chunks of LABEL_CHUNK labels, each checked first.
   * The labels written before are removed in chunks too.
   */
  writeLabels(labels: LabelEntry[]): void {
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
        const kind =
          /^\d+$/.test(l.id) && Number(l.id) <= 16 ? 'system' : l.type === 3 ? 'folder' : 'label';
        put.run(
          l.id,
          l.name,
          l.path,
          l.parentId,
          l.color && COLOR.test(l.color) ? l.color : null,
          l.type,
          kind,
        );
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

  /** The current rev of a pair, for parse jobs to carry. */
  revOf(protonId: string): number | null {
    const row = this.db.stmt('SELECT rev FROM pairs WHERE proton_id = ?').get(protonId);
    return row ? asNumber(row.rev) : null;
  }

  phase1Batch(items: Phase1Item[]): Phase1Stats {
    const started = performance.now();
    const stats: Phase1Stats = {
      messages: 0,
      failed: 0,
      ms: 0,
      newThreads: 0,
      merges: 0,
      repointedMessages: 0,
      repointedKeys: 0,
      repointedLabelRows: 0,
      bigMerges: [],
    };
    this.transaction(() => {
      for (const item of items) {
        this.step();
        this.insertPair(item);
        if (item.row) {
          this.insertMessage(item.row, stats);
          stats.messages += 1;
        } else {
          stats.failed += 1;
        }
      }
    });
    stats.ms = performance.now() - started;
    return stats;
  }

  private insertPair(item: Phase1Item): void {
    const p = item.pair;
    this.revSeq += 1;
    this.db
      .stmt(
        `INSERT INTO pairs(proton_id, file_id, rev, meta_rel, meta_size, meta_mtime_ns, meta_dev, meta_ino,
           meta_state, eml_rel, eml_size, eml_mtime_ns, eml_dev, eml_ino, body_state, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.protonId,
        randomBytes(8).toString('hex'),
        this.revSeq,
        p.metaRel,
        p.metaSize,
        p.metaMtimeNs,
        p.metaDev,
        p.metaIno,
        item.row ? 1 : 3,
        p.emlRel,
        p.emlSize,
        p.emlMtimeNs,
        p.emlDev,
        p.emlIno,
        p.emlRel === null ? BODY_STATE.emlMissing : BODY_STATE.pending,
        item.error,
      );
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
  private merge(into: number, from: number, intoSize: number, stats: Phase1Stats): void {
    const a = this.agg(from);
    stats.merges += 1;
    // Members and keys move in chunks, each its own bounded statement.
    const repointed = this.repointChunks(
      'UPDATE messages SET thread_id = ? WHERE rowid IN (SELECT rowid FROM messages WHERE thread_id = ? LIMIT ?)',
      into,
      from,
    );
    stats.repointedMessages += repointed;
    if (Math.max(intoSize, a.msg_count) >= BIG_MERGE && stats.bigMerges.length < 1000) {
      stats.bigMerges.push({ into, from, intoSize, fromSize: a.msg_count, repointed });
    }
    stats.repointedKeys += this.repointChunks(
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
    stats.repointedLabelRows += this.moveThreadLabels(into, from);
    this.db.stmt('DELETE FROM threads WHERE thread_id = ?').run(from);
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
      let size = sized[0]!.n;
      for (const other of sized.slice(1)) {
        this.merge(threadId, other.id, size, stats);
        size += other.n;
      }
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
             num_attachments, mime_type, message_id, in_reply_to, references_json, dmarc, thread_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(row.references.slice(-100)),
          row.dmarc,
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
    // At most MAX_LABELS labels and MAX_ATTACHMENTS attachments per message, as parsed.
    for (const label of row.labelIds.slice(0, MAX_LABELS)) {
      labelPut.run(rowid, label);
      threadLabelPut.run(label, threadId, row.time, row.unread);
    }
    const attachPut = this.db.stmt(
      'INSERT INTO attachments(message_rowid, idx, filename, mime, size, content_id, source) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    );
    row.attachments
      .slice(0, MAX_ATTACHMENTS)
      .forEach((a, i) => attachPut.run(rowid, i, a.name, a.mime, a.size, 'meta'));
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
        row.attachments.map((a) => a.name).join(' '),
      );
  }

  /** Writes body text. A result whose rev no longer matches its pair is dropped. */
  phase2Batch(results: BodyResult[]): Phase2Stats {
    const started = performance.now();
    const stats: Phase2Stats = { written: 0, dropped: 0, ms: 0 };
    this.transaction(() => {
      const target = this.db.stmt(
        'SELECT m.rowid AS rowid FROM pairs p JOIN messages m ON m.proton_id = p.proton_id WHERE p.proton_id = ? AND p.rev = ?',
      );
      const setBody = this.db.stmt('UPDATE message_text SET body = ? WHERE rowid = ?');
      const setState = this.db.stmt(
        'UPDATE pairs SET body_state = ?, error_code = ? WHERE proton_id = ? AND rev = ?',
      );
      for (const r of results) {
        this.step();
        const hit = target.get(r.protonId, r.rev);
        if (!hit) {
          stats.dropped += 1;
          continue;
        }
        if (r.text.length > 0) setBody.run(r.text, asNumber(hit.rowid));
        setState.run(r.state, r.error, r.protonId, r.rev);
        stats.written += 1;
      }
    });
    stats.ms = performance.now() - started;
    return stats;
  }
}
