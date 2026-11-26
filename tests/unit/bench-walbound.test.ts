// SPDX-License-Identifier: AGPL-3.0-or-later
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STEP_SLACK,
  TXN_INPUT_BYTES,
  WAL_HEADROOM,
  WAL_STOP,
  walGuard,
} from '../../src/testhooks/bench/limits';
import type { MessageRow } from '../../src/testhooks/bench/metadata';
import { createSchema } from '../../src/testhooks/bench/schema';
import { configure, openDb, type Db } from '../../src/testhooks/bench/sql';
import { IndexWriter, REPOINT_CHUNK, type Phase1Item } from '../../src/testhooks/bench/writer';
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
    for (const [unit, bytes] of Object.entries(growths))
      expect(bytes, unit).toBeLessThanOrEqual(STEP_SLACK);
    expect(REPOINT_CHUNK).toBe(500);
    // The stop line plus the slack never passes the room kept for the WAL.
    expect(WAL_STOP + STEP_SLACK).toBeLessThanOrEqual(WAL_HEADROOM);
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
