// SPDX-License-Identifier: AGPL-3.0-or-later
// The writer's bounds: batches of at most 1,000 pairs and 4 MiB of input, a
// check before every unit of work (with the transaction rolled back when it
// stops), merges and labels in chunks of 500, and the WAL stop line.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLabels } from '../../src/core/index/labels';
import {
  REPOINT_CHUNK,
  TXN_INPUT_BYTES,
  WAL_STOP,
  WRITE_BATCH_PAIRS,
  WalStop,
  walGuard,
} from '../../src/core/index/limits';
import { CAPPED_LISTS, createSchema } from '../../src/core/index/schema';
import { CAPPED_LIST_NAMES } from '../../src/shared/log/codes';
import { sanitizeEvent } from '../../src/shared/log/schema';
import { splitBatches } from '../../src/core/index/service';
import { asNumber, openDb } from '../../src/core/index/sql';
import { IndexWriter } from '../../src/core/index/writer';
import { STAMP, item, message } from '../index-helpers';
import { testDir } from '../paths';

function counted(stopAfter = Infinity) {
  const db = openDb(':memory:');
  createSchema(db, STAMP.generation);
  let steps = 0;
  const writer = new IndexWriter(db, STAMP, () => {
    steps += 1;
    if (steps > stopAfter) throw new WalStop();
  });
  return { db, writer, steps: () => steps, reset: () => (steps = 0) };
}

describe('write batches', () => {
  it('hold at most 1,000 pairs and 4 MiB of input; a larger item goes alone', () => {
    const sizes = [
      ...Array.from({ length: 2500 }, () => 1000),
      5 * 1024 * 1024,
      ...Array.from({ length: 10 }, () => 1024 * 1024),
    ];
    const batches = splitBatches(sizes, WRITE_BATCH_PAIRS, TXN_INPUT_BYTES, (n) => n);
    expect(batches.flat()).toEqual(sizes);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(WRITE_BATCH_PAIRS);
      const total = b.reduce((a, n) => a + n, 0);
      if (b.length > 1) expect(total).toBeLessThanOrEqual(TXN_INPUT_BYTES);
    }
    expect(batches.filter((b) => b.length === 1 && b[0]! > TXN_INPUT_BYTES)).toHaveLength(1);
  });
});

describe('the check before each unit of work', () => {
  it('runs once per message, and a stop rolls the whole batch back', () => {
    const ok = counted();
    ok.writer.phase1Batch(STAMP, [item(message('a', ['a'])), item(message('b', ['b']))]);
    expect(ok.steps()).toBe(2);

    const { db, writer } = counted(1);
    expect(() =>
      writer.phase1Batch(STAMP, [item(message('c', ['c'])), item(message('d', ['d']))]),
    ).toThrow(WalStop);
    expect(asNumber(db.stmt('SELECT count(*) AS n FROM pairs').get()?.n)).toBe(0);
    expect(asNumber(db.stmt('SELECT count(*) AS n FROM messages').get()?.n)).toBe(0);
    expect(
      asNumber(db.stmt("SELECT value FROM source_meta WHERE key = 'rev_seq'").get()?.value),
    ).toBe(0);
    // A new writer goes on with the rev sequence the database kept.
    new IndexWriter(db, STAMP).phase1Batch(STAMP, [item(message('e', ['e']))]);
    expect(asNumber(db.stmt("SELECT rev FROM pairs WHERE proton_id = 'e'").get()?.rev)).toBe(1);
    db.close();
    ok.db.close();
  });

  it('moves a merge in checked chunks of 500 rows', () => {
    const { db, writer, steps, reset } = counted();
    const n = 3 * REPOINT_CHUNK + 7;
    const small = Array.from({ length: n }, (_, i) => message(`a${i}`, [`a${i}`, 'A']));
    const large = Array.from({ length: n + 1 }, (_, i) => message(`b${i}`, [`b${i}`, 'B']));
    writer.phase1Batch(STAMP, small.map(item));
    writer.phase1Batch(STAMP, large.map(item));
    reset();
    const stats = writer.phase1Batch(STAMP, [item(message('z', ['z', 'A', 'B']))]);
    expect(stats.repointedMessages).toBe(n);
    // One check for the message, then per chunk: members (4), keys (n + 1 keys: 4), labels (1),
    // and one more for the message's own rows after the merge.
    expect(steps()).toBe(1 + 4 + 4 + 1 + 1);
    db.close();
  });

  it('writes labels.json in checked chunks of 500', () => {
    const { db, writer, steps, reset } = counted();
    const many = Array.from({ length: 1234 }, (_, i) => ({ ID: `l${i}`, Name: `L${i}`, Type: 1 }));
    reset();
    writer.writeLabels(STAMP, parseLabels(JSON.stringify({ Payload: many })), '{}');
    // One check for removing (nothing there), then one per chunk of 500.
    expect(steps()).toBe(1 + 3);
    db.close();
  });
});

describe('the WAL stop line', () => {
  it('stops past the line and passes below it', () => {
    const dir = testDir('walstop');
    const wal = join(dir, 'x.sqlite-wal');
    const guard = walGuard(wal);
    expect(() => guard()).not.toThrow();
    writeFileSync(wal, Buffer.alloc(1024));
    expect(() => guard()).not.toThrow();
    expect(() => walGuard(wal, 512)()).toThrow(WalStop);
    expect(WAL_STOP).toBe(24 * 1024 * 1024);
  });
});

describe('capped lists in logs', () => {
  it('names every list the index can cap, and nothing else', () => {
    expect([...CAPPED_LISTS]).toEqual([...CAPPED_LIST_NAMES]);
    const event = (list: unknown) =>
      sanitizeEvent({ level: 'info', proc: 'core', code: 'index.capped', data: { list } });
    for (const list of CAPPED_LISTS) expect(event(list)?.data).toEqual({ list });
    expect(event('someone@example.org')?.data).toEqual({ dropped: 1 });
  });
});
