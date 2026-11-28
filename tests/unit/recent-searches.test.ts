// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_RECENT, RECENT_READ, RecentOnlyState, recentJob } from '../../src/core/index/recent';
import { SCHEMA_VERSION, createSchema } from '../../src/core/index/schema';
import { asNumber, configure, openDb, scalar, type Db } from '../../src/core/index/sql';
import type { RecentAnswer } from '../../src/shared/recent-search';
import { searchKey, type SearchSpec } from '../../src/shared/search-chips';
import { STAMP } from '../index-helpers';
import { testDir } from '../paths';

const q = (text: string, spec: Partial<SearchSpec> = {}) => searchKey({ text, chips: [], ...spec });

function memory(): Db {
  const db = openDb(':memory:');
  createSchema(db, STAMP.generation);
  return db;
}

const record = (db: Db, text: string, at: number) =>
  recentJob(db, { op: 'record', q: q(text), at });
const listed = (db: Db): string[] => {
  const answer = recentJob(db, { op: 'list' }) as Extract<RecentAnswer, { op: 'list' }>;
  return answer.rows.map((r) => JSON.parse(r.q).text as string);
};
const rows = (db: Db) => scalar(db, 'SELECT count(*) FROM recent_searches');

describe('recent searches in the index', () => {
  it('keeps the newest 20, ties on time broken by insertion order', () => {
    const db = memory();
    for (let i = 0; i < 25; i += 1) record(db, `s${i}`, 1000 + Math.floor(i / 2));
    expect(rows(db)).toBe(MAX_RECENT);
    const shown = listed(db);
    expect(shown).toHaveLength(MAX_RECENT);
    expect(shown.slice(0, 3)).toEqual(['s24', 's23', 's22']);
    expect(shown.at(-1)).toBe('s5');
  });

  it('records a repeat once, at the top', () => {
    const db = memory();
    record(db, 'a', 1);
    record(db, 'b', 2);
    record(db, 'a', 3);
    expect(listed(db)).toEqual(['a', 'b']);
    // The same search with chips in another order is the same row.
    recentJob(db, {
      op: 'record',
      q: searchKey({ text: 'c', chips: [{ k: 'unread' }, { k: 'label', id: 'l1' }] }),
      at: 4,
    });
    recentJob(db, {
      op: 'record',
      q: searchKey({ text: 'c', chips: [{ k: 'label', id: 'l1' }, { k: 'unread' }] }),
      at: 5,
    });
    expect(rows(db)).toBe(3);
  });

  it('deletes rows that fail the check at the next recording, and never lists them', () => {
    const db = memory();
    const bad = db.stmt('INSERT INTO recent_searches(q, at) VALUES (?, ?)');
    bad.run('not json', 50);
    bad.run('{"text":"x","v":1,"chips":[]}', 60);
    bad.run(null, 70);
    record(db, 'good', 10);
    expect(rows(db)).toBe(1);
    bad.run('{"v":1,"text":"","chips":[]}', 80);
    const answer = recentJob(db, { op: 'list' });
    expect(answer).toEqual({ op: 'list', rows: [{ q: q('good'), at: 10 }], invalid: 1 });
    const next = recentJob(db, { op: 'record', q: q('other'), at: 11 });
    expect(next).toEqual({ op: 'record', invalid: 1 });
    expect(listed(db)).toEqual(['other', 'good']);
  });

  it('lists at most 20 valid rows among the newest 40', () => {
    const db = memory();
    const raw = db.stmt('INSERT INTO recent_searches(q, at) VALUES (?, ?)');
    for (let i = 0; i < 30; i += 1) raw.run(q(`v${i}`), i);
    for (let i = 0; i < 15; i += 1) raw.run('bad', 100 + i);
    const answer = recentJob(db, { op: 'list' }) as Extract<RecentAnswer, { op: 'list' }>;
    expect(answer.invalid).toBe(15);
    expect(answer.rows.map((r) => r.at)).toEqual(
      Array.from({ length: RECENT_READ - 15 }, (_, i) => 29 - i).slice(0, MAX_RECENT),
    );
  });

  it('refuses to record what is not a canonical search, writing nothing', () => {
    const db = memory();
    for (const [bad, at] of [
      ['{"v":1,"text":"x", "chips":[]}', 1],
      [q(''), 1],
      [q('x'), -1],
      [q('x'), 1.5],
    ] as const) {
      expect(() => recentJob(db, { op: 'record', q: bad, at })).toThrow('RECENT_INVALID');
    }
    expect(rows(db)).toBe(0);
  });

  it('wipes every row', () => {
    const db = memory();
    record(db, 'a', 1);
    record(db, 'b', 2);
    expect(recentJob(db, { op: 'wipe' })).toEqual({ op: 'wipe', deleted: 2 });
    expect(rows(db)).toBe(0);
  });

  it('needs an open connection', () => {
    expect(() => recentJob(null, { op: 'list' })).toThrow('NOT_OPEN');
  });
});

describe('the recent-only connection', () => {
  function index(dir: string, version = SCHEMA_VERSION): { path: string; uuid: string } {
    const path = join(dir, 'idx.sqlite');
    const db = openDb(path);
    configure(db, 'writer');
    const uuid = createSchema(db, STAMP.generation);
    db.exec("INSERT INTO labels(proton_id, kind) VALUES ('l1', 'label')");
    if (version !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${version}`);
    db.close();
    return { path, uuid };
  }

  it('opens an index of this identity and schema version, and runs only the recent jobs', () => {
    const dir = testDir('recent-only');
    const { path, uuid } = index(dir);
    const state = new RecentOnlyState();
    state.open({ dbPath: path, expectedUuid: uuid });
    state.run({ op: 'record', q: q('kept'), at: 5 });
    expect(state.run({ op: 'list' })).toMatchObject({ rows: [{ q: q('kept'), at: 5 }] });
    state.close();
    const db = openDb(path, true);
    expect(scalar(db, 'SELECT count(*) FROM recent_searches')).toBe(1);
    // Nothing else changed.
    expect(scalar(db, 'SELECT count(*) FROM labels')).toBe(1);
    expect(asNumber(db.stmt('PRAGMA user_version').get()?.user_version)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('refuses another identity, another schema version, a missing file and an overlap', () => {
    const dir = testDir('recent-only-refused');
    const { path, uuid } = index(dir);
    const state = new RecentOnlyState();
    expect(() => state.open({ dbPath: path, expectedUuid: crypto.randomUUID() })).toThrow(
      'INDEX_DAMAGED',
    );
    expect(() => state.open({ dbPath: path, expectedUuid: uuid, exportRoots: [dir] })).toThrow(
      'INDEX_OVERLAP',
    );
    const older = testDir('recent-only-older');
    const old = index(older, SCHEMA_VERSION - 1);
    expect(() => state.open({ dbPath: old.path, expectedUuid: old.uuid })).toThrow('INDEX_DAMAGED');
    const empty = testDir('recent-only-none');
    const missing = join(empty, 'none.sqlite');
    expect(() => state.open({ dbPath: missing, expectedUuid: uuid })).toThrow('NO_INDEX');
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(empty)).toEqual([]);
    expect(() => state.run({ op: 'list' })).toThrow('NOT_OPEN');
  });
});
