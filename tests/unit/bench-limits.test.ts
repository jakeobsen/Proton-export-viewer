// SPDX-License-Identifier: AGPL-3.0-or-later
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSchema } from '../../src/testhooks/bench/schema';
import { configure, openDb } from '../../src/testhooks/bench/sql';
import { IndexWriter } from '../../src/testhooks/bench/writer';
import { testDir } from '../paths';
import { SHM_HEADROOM, WAL_HEADROOM, maxPages } from '../../src/testhooks/bench/limits';

describe('the index size limit', () => {
  it('keeps the main file below the cap minus the WAL and shared-memory headroom', () => {
    const pages = maxPages(300e6, 4096);
    expect(pages * 4096 + WAL_HEADROOM + SHM_HEADROOM).toBeLessThanOrEqual(300e6);
    expect(() => maxPages(WAL_HEADROOM, 4096)).toThrow('CAP_TOO_SMALL');
  });

  it('fails a write past the page limit with SQLITE_FULL and keeps the file within it', () => {
    const db = openDb(':memory:', { engine: 'node:sqlite' });
    createSchema(db);
    const before = Number(db.stmt('PRAGMA page_count').get()?.page_count);
    db.exec(`PRAGMA max_page_count = ${before + 20}`);
    const put = db.stmt(
      'INSERT INTO message_text(subject, sender, recipients, body, attachments) VALUES (?, ?, ?, ?, ?)',
    );
    expect(() => {
      for (let i = 0; i < 1000; i++) put.run('s', 'a', 'b', `word${i} `.repeat(500), '');
    }).toThrow(expect.objectContaining({ errcode: 13 }));
    expect(Number(db.stmt('PRAGMA page_count').get()?.page_count)).toBeLessThanOrEqual(before + 20);
    db.close();
  });
});

describe('the WAL bound', () => {
  it('leaves the WAL in place while a reader pins a snapshot, and truncates it after', () => {
    const path = join(testDir('bench-wal'), 'index.db');
    const writer = openDb(path, { engine: 'node:sqlite' });
    configure(writer, 'writer');
    writer.exec('PRAGMA busy_timeout = 0');
    createSchema(writer);
    const reader = openDb(path, { engine: 'node:sqlite', readOnly: true });
    reader.exec('BEGIN');
    reader.stmt('SELECT count(*) FROM messages').get();
    writer.exec(
      "INSERT INTO message_text(subject, sender, recipients, body, attachments) VALUES ('a', 'b', 'c', 'd', 'e')",
    );
    const busy = writer.stmt('PRAGMA wal_checkpoint(TRUNCATE)').get();
    expect(Number(busy?.busy)).toBe(1);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    reader.exec('COMMIT');
    const done = writer.stmt('PRAGMA wal_checkpoint(TRUNCATE)').get();
    expect(Number(done?.busy)).toBe(0);
    expect(statSync(`${path}-wal`).size).toBe(0);
    reader.close();
    writer.close();
  });

  it('keeps full-text merges out of write transactions and runs them in bounded steps', () => {
    const db = openDb(':memory:', { engine: 'node:sqlite' });
    createSchema(db);
    const writer = new IndexWriter(db);
    const put = db.stmt(
      'INSERT INTO message_text(subject, sender, recipients, body, attachments) VALUES (?, ?, ?, ?, ?)',
    );
    for (let t = 0; t < 30; t++) {
      db.exec('BEGIN');
      for (let i = 0; i < 20; i++) put.run(`s${t}`, 'a', 'b', `word${i} more${t} text`, '');
      db.exec('COMMIT');
    }
    const rows = () => Number(db.stmt('SELECT count(*) AS n FROM fts_data').get()?.n);
    const before = rows();
    expect(writer.mergeStep(500)).toBeGreaterThan(1);
    expect(rows()).toBeLessThan(before);
    let steps = 0;
    while (writer.mergeStep(500) > 1) steps += 1;
    expect(steps).toBeLessThan(50);
    db.close();
  });
});
