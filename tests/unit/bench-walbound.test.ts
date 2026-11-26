// SPDX-License-Identifier: AGPL-3.0-or-later
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STEP_SLACK,
  TXN_INPUT_BYTES,
  WAL_HEADROOM,
  WAL_STOP,
  WRITER_CACHE_BYTES,
  walGuard,
} from '../../src/testhooks/bench/limits';
import {
  MAX_ATTACHMENTS,
  MAX_LABEL_ID_LENGTH,
  MAX_LABELS,
  MAX_RECIPIENTS,
  parseMetadata,
  type MessageRow,
} from '../../src/testhooks/bench/metadata';
import { createSchema } from '../../src/testhooks/bench/schema';
import { configure, openDb, type Db } from '../../src/testhooks/bench/sql';
import {
  IndexWriter,
  LABEL_CHUNK,
  REPOINT_CHUNK,
  type Phase1Item,
} from '../../src/testhooks/bench/writer';
import { testDir } from '../paths';

/** Words that are all different, so the full-text index gets no help from repeats. */
function uniqueText(bytes: number, seed: number): string {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const w = `w${seed.toString(36)}x${i.toString(36)}`;
    out.push(w);
    size += w.length + 1;
  }
  return out.join(' ').slice(0, bytes);
}

function row(id: string, keys: string[], extra: Partial<MessageRow> = {}): MessageRow {
  return {
    protonId: id,
    time: 1,
    subject: id,
    sender: { name: id, address: `${id}@example.com` },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    flags: 0,
    unread: 1,
    replied: 0,
    repliedAll: 0,
    forwarded: 0,
    size: 1,
    numAttachments: 0,
    mimeType: 'text/plain',
    messageId: keys[0] ?? null,
    inReplyTo: null,
    references: [],
    dmarc: null,
    labelIds: ['5', '0'],
    keys,
    attachments: [],
    ...extra,
  };
}

const item = (r: MessageRow): Phase1Item => ({
  pair: {
    protonId: r.protonId,
    metaRel: 'm',
    metaSize: 1,
    metaMtimeNs: 0,
    metaDev: 0,
    metaIno: 0,
    emlRel: 'e',
    emlSize: 1,
    emlMtimeNs: 0,
    emlDev: 0,
    emlIno: 0,
  },
  row: r,
  error: null,
});

function walBytes(path: string): number {
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}

/** A populated index with the writer's settings, its WAL truncated. */
function populated(name: string): { db: Db; path: string; writer: IndexWriter } {
  const path = join(testDir(name), 'index.db');
  const db = openDb(path, { engine: 'node:sqlite' });
  configure(db, 'writer');
  createSchema(db);
  const writer = new IndexWriter(db);
  for (let b = 0; b < 6; b++) {
    const items: Phase1Item[] = [];
    for (let i = 0; i < 500; i++) {
      const n = b * 500 + i;
      // Two large conversations (for a merge) and many small ones.
      const keys = n < 1200 ? [`a${n}`, 'root-a'] : n < 2400 ? [`b${n}`, 'root-b'] : [`k${n}`];
      items.push(
        item(row(`m${n.toString().padStart(6, '0')}`, keys, { subject: uniqueText(400, n) })),
      );
    }
    writer.phase1Batch(items);
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { db, path, writer };
}

/** WAL growth of one transaction, from a truncated WAL. */
function growth(db: Db, path: string, fn: () => void): number {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = walBytes(path);
  fn();
  return walBytes(path) - before;
}

/**
 * One transaction through a writer whose check records the WAL's size: the
 * whole growth, the largest growth between two checks (or from the last
 * check to the commit) and how many checks ran.
 */
function checked(
  db: Db,
  path: string,
  fn: (writer: IndexWriter) => void,
): { total: number; betweenChecks: number; checks: number } {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const sizes = [walBytes(path)];
  const writer = new IndexWriter(db, () => {
    sizes.push(walBytes(path));
  });
  fn(writer);
  sizes.push(walBytes(path));
  let betweenChecks = 0;
  for (let i = 1; i < sizes.length; i++)
    betweenChecks = Math.max(betweenChecks, sizes[i]! - sizes[i - 1]!);
  return { total: sizes.at(-1)! - sizes[0]!, betweenChecks, checks: sizes.length - 2 };
}

/** A label ID of the longest kept length, distinct per `n`. */
const longId = (prefix: string, n: number) =>
  `${prefix}${n.toString(36)}`.padEnd(MAX_LABEL_ID_LENGTH, '.');

/**
 * A metadata file far past every per-message limit: 4,000 long label IDs,
 * 4,000 attachments and 2,000 addresses in each list, all different.
 */
function labelHeavyMetadata(id: string): string {
  const addr = (list: string, i: number) => ({
    Name: `${list}${i}`,
    Address: `${list}${i}@x.example`,
  });
  const list = (name: string) =>
    Array.from({ length: 2 * MAX_RECIPIENTS }, (_, i) => addr(name, i));
  return JSON.stringify({
    Payload: {
      ID: id,
      Time: 2,
      Subject: 'labels',
      Sender: addr('from', 0),
      ToList: list('to'),
      CCList: list('cc'),
      BCCList: list('bcc'),
      ReplyTos: list('reply'),
      LabelIDs: Array.from({ length: 20 * MAX_LABELS }, (_, i) => longId(`${id}-`, i)),
      Attachments: Array.from({ length: 4 * MAX_ATTACHMENTS }, (_, i) => ({
        Name: `attachment-${id}-${i}.pdf`,
        MIMEType: 'application/pdf',
        Size: i,
      })),
      NumAttachments: 4 * MAX_ATTACHMENTS,
      Headers: `Message-ID: <${id}@x.example>\r\n`,
    },
  });
}

describe('the WAL stop line', () => {
  it('leaves room for the largest growth any single unit of work can cause', () => {
    const { db, path, writer } = populated('bench-walbound-units');
    const growths: Record<string, number> = {};
    // One message whose metadata takes a whole transaction's input, all distinct words.
    growths.messageAtInputLimit = growth(db, path, () =>
      writer.phase1Batch([
        item(
          row('big-meta', ['big-meta'], { subject: uniqueText(TXN_INPUT_BYTES - 64 * 1024, 7) }),
        ),
      ]),
    );
    // A merge of two conversations of 1,200: the smaller side moves in chunks.
    growths.mergeOf1200 = growth(db, path, () =>
      writer.phase1Batch([item(row('linker', ['linker', 'root-a', 'root-b']))]),
    );
    // One body at the stored-text ceiling.
    const rev = writer.revOf('m002500')!;
    growths.bodyAtCeiling = growth(db, path, () =>
      writer.phase2Batch([
        { protonId: 'm002500', rev, state: 1, text: uniqueText(1024 * 1024, 9), error: null },
      ]),
    );
    // A full body transaction: 4 MiB of distinct words over many messages.
    growths.bodyTransaction = growth(db, path, () =>
      writer.phase2Batch(
        Array.from({ length: 400 }, (_, i) => {
          const id = `m${(3000 - 400 + i).toString().padStart(6, '0')}`;
          return {
            protonId: id,
            rev: writer.revOf(id)!,
            state: 1,
            text: uniqueText(TXN_INPUT_BYTES / 400, 100 + i),
            error: null,
          };
        }),
      ),
    );
    // One merge step after many small segments.
    growths.mergeStep = growth(db, path, () => writer.mergeStep(500));
    console.log(
      'WAL growth per unit (MiB):',
      Object.fromEntries(Object.entries(growths).map(([k, v]) => [k, +(v / 2 ** 20).toFixed(2)])),
    );
    // A unit's own pages plus a full cache of pages dirtied before its check
    // (written at a spill or at commit) stay within the slack.
    for (const [unit, bytes] of Object.entries(growths))
      expect(bytes + WRITER_CACHE_BYTES, unit).toBeLessThanOrEqual(STEP_SLACK);
    expect(REPOINT_CHUNK).toBe(500);
    // The stop line plus the slack never passes the room kept for the WAL.
    expect(WAL_STOP + STEP_SLACK).toBeLessThanOrEqual(WAL_HEADROOM);
    db.close();
  });

  it('keeps label-heavy messages, many-label merges and labels.json in checked units', () => {
    const { db, path } = populated('bench-walbound-labels');
    const units: Record<string, { total: number; betweenChecks: number; checks: number }> = {};
    // One message past every per-message limit: stored capped.
    const heavy = parseMetadata('heavy', labelHeavyMetadata('heavy'));
    expect(heavy.labelIds).toHaveLength(MAX_LABELS);
    expect(heavy.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(heavy.to).toHaveLength(MAX_RECIPIENTS);
    expect(heavy.bcc).toHaveLength(MAX_RECIPIENTS);
    units.labelHeavyMessage = checked(db, path, (w) => w.phase1Batch([item(heavy)]));
    expect(db.stmt('SELECT count(*) AS n FROM message_labels').get()?.n).toBe(
      2 * 3000 + MAX_LABELS,
    );

    // Two conversations of 30 messages, each message with MAX_LABELS labels of
    // its own: 6,000 per-label rows each, then one message joins them.
    for (const side of ['x', 'y']) {
      new IndexWriter(db).phase1Batch(
        Array.from({ length: 30 }, (_, i) =>
          item(
            row(`${side}${i}`, [`${side}${i}`, `root-${side}`], {
              labelIds: Array.from({ length: MAX_LABELS }, (_, j) =>
                longId(`${side}-`, i * MAX_LABELS + j),
              ),
            }),
          ),
        ),
      );
    }
    const rowsOf = (key: string) =>
      db
        .stmt(
          'SELECT count(*) AS n FROM thread_labels WHERE thread_id = (SELECT thread_id FROM thread_keys WHERE key = ?)',
        )
        .get(key)?.n;
    expect(rowsOf('root-x')).toBe(30 * MAX_LABELS);
    units.manyLabelMerge = checked(db, path, (w) =>
      w.phase1Batch([item(row('xy', ['xy', 'root-x', 'root-y']))]),
    );
    // Moved in checked chunks: every row now on the one conversation left.
    expect(units.manyLabelMerge.checks).toBeGreaterThanOrEqual((30 * MAX_LABELS) / REPOINT_CHUNK);
    expect(rowsOf('root-x')).toBe(2 * 30 * MAX_LABELS + 2);
    expect(rowsOf('root-y')).toBe(2 * 30 * MAX_LABELS + 2);

    // labels.json with 20,000 long labels, stored in checked chunks.
    const labels = Array.from({ length: 20_000 }, (_, i) => ({
      id: longId('l-', i),
      name: longId('name-', i),
      path: longId('path-', i),
      parentId: '',
      color: '#123456',
      type: 1,
    }));
    units.labelsFile = checked(db, path, (w) => w.writeLabels(labels));
    expect(units.labelsFile.checks).toBeGreaterThanOrEqual(20_000 / LABEL_CHUNK);
    units.labelsFileAgain = checked(db, path, (w) => w.writeLabels(labels.slice(0, 10)));
    expect(db.stmt('SELECT count(*) AS n FROM labels').get()?.n).toBe(10);

    console.log(
      'WAL growth (MiB):',
      Object.fromEntries(
        Object.entries(units).map(([k, v]) => [
          k,
          {
            total: +(v.total / 2 ** 20).toFixed(2),
            betweenChecks: +(v.betweenChecks / 2 ** 20).toFixed(2),
            checks: v.checks,
          },
        ]),
      ),
    );
    for (const [unit, u] of Object.entries(units)) {
      expect(u.betweenChecks + WRITER_CACHE_BYTES, unit).toBeLessThanOrEqual(STEP_SLACK);
      expect(u.checks, unit).toBeGreaterThan(0);
    }
    // A single label-heavy message is one unit: all of it, plus a full cache, fits the slack.
    expect(units.labelHeavyMessage.total + WRITER_CACHE_BYTES).toBeLessThanOrEqual(STEP_SLACK);
    db.close();
  });

  it('stops a transaction before the WAL passes the stop line plus one unit, and rolls it back', () => {
    const path = join(testDir('bench-walbound-stop'), 'index.db');
    const db = openDb(path, { engine: 'node:sqlite' });
    configure(db, 'writer');
    createSchema(db);
    const plain = new IndexWriter(db);
    plain.phase1Batch(
      Array.from({ length: 400 }, (_, i) =>
        item(row(`s${i.toString().padStart(4, '0')}`, [`s${i}`])),
      ),
    );
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const stop = 2 * 1024 * 1024;
    let largest = 0;
    const guarded = new IndexWriter(
      db,
      walGuard(`${path}-wal`, stop, (size) => (largest = Math.max(largest, size))),
    );
    const results = Array.from({ length: 400 }, (_, i) => {
      const id = `s${i.toString().padStart(4, '0')}`;
      return {
        protonId: id,
        rev: plain.revOf(id)!,
        state: 1,
        text: uniqueText(20 * 1024, 500 + i),
        error: null,
      };
    });
    expect(() => guarded.phase2Batch(results)).toThrow('WAL_STOP');
    expect(walBytes(path)).toBeLessThanOrEqual(stop + STEP_SLACK);
    expect(largest).toBeGreaterThan(stop);
    // Rolled back: no body of the batch is searchable.
    expect(db.stmt("SELECT count(*) AS n FROM message_text WHERE body != ''").get()?.n).toBe(0);
    db.close();
  });
});
