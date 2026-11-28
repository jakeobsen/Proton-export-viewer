// SPDX-License-Identifier: AGPL-3.0-or-later
// An index another connection holds is busy, never damaged: the probe, the
// writer's open and the query thread's open wait for the lock up to their
// timeout, and past it they say INDEX_BUSY. Nothing is deleted or made. Once
// the lock is released inside the timeout, the index opens as it is.

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QueryState, WriterState, codeOf } from '../../src/core/index/ops';
import { ThreadError } from '../../src/core/index/pool';
import {
  SCHEMA_VERSION,
  createSchema,
  identityOf,
  probeIdentity,
  probeMismatch,
  probeSame,
} from '../../src/core/index/schema';
import { IndexBusy, configure, isBusy, openDb, type Db } from '../../src/core/index/sql';
import { InlineThread, STAMP, holdIndexLock } from '../index-helpers';
import { testDir } from '../paths';
import type { ChildProcess } from 'node:child_process';

const holders: ChildProcess[] = [];

afterEach(() => {
  for (const child of holders.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

/** A new index with its schema, closed again; its path and identity. */
function newIndex(name: string): { dbPath: string; dir: string; uuid: string } {
  const dir = testDir(name);
  const dbPath = join(dir, `${STAMP.sourceKey}.sqlite`);
  const db = openDb(dbPath);
  configure(db, 'writer');
  const uuid = createSchema(db, STAMP.generation);
  db.close();
  return { dbPath, dir, uuid };
}

async function held(dbPath: string, holdMs: number, sidecars = true) {
  const lock = await holdIndexLock(dbPath, holdMs, { sidecars });
  holders.push(lock.child);
  return lock;
}

/** Each file of the index folder with its inode. */
function files(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).map((n) => [n, String(lstatSync(join(dir, n), { bigint: true }).ino)]),
  );
}

/** The code a query thread's open fails with, as it crosses the thread; null if it opened. */
async function queryOpenCode(dbPath: string, uuid: string, busyMs: number) {
  try {
    await new InlineThread('query').call('open', { dbPath, expectedUuid: uuid, busyMs });
    return null;
  } catch (err) {
    return err instanceof ThreadError ? err.code : `not a thread error: ${String(err)}`;
  }
}

const sqliteError = (errcode: number) =>
  Object.assign(new Error('sqlite'), { code: 'ERR_SQLITE_ERROR', errcode });

describe('isBusy', () => {
  it('is true for SQLITE_BUSY and SQLITE_LOCKED, with their extended codes', () => {
    // BUSY, LOCKED, BUSY_RECOVERY, BUSY_SNAPSHOT, LOCKED_SHAREDCACHE.
    for (const code of [5, 6, 261, 517, 262]) {
      expect(isBusy(sqliteError(code)), String(code)).toBe(true);
    }
  });

  it('is false for anything else', () => {
    for (const code of [1, 11, 13, 26, 4]) {
      expect(isBusy(sqliteError(code)), String(code)).toBe(false);
    }
    expect(isBusy(new Error('database is locked'))).toBe(false);
    expect(isBusy(null)).toBe(false);
  });

  it('IndexBusy crosses a thread as INDEX_BUSY', () => {
    expect(codeOf(new IndexBusy())).toBe('INDEX_BUSY');
  });
});

describe('the probe', () => {
  it('held past its timeout says busy, never damaged', async () => {
    const { dbPath, uuid } = newIndex('busy-probe-held');
    await held(dbPath, 5000);
    expect(() => probeIdentity(dbPath, 200)).toThrow(IndexBusy);
    expect(() => probeMismatch(dbPath, uuid, 200)).toThrow(IndexBusy);
    expect(() => probeSame(dbPath, uuid, 200)).toThrow(IndexBusy);
  });

  it('released inside its timeout reads the version and identity', async () => {
    const { dbPath, uuid } = newIndex('busy-probe-released');
    const lock = await held(dbPath, 300);
    expect(probeIdentity(dbPath, 5000)).toEqual({ version: SCHEMA_VERSION, uuid });
    await lock.released;
  });
});

describe('identityOf', () => {
  /** A connection whose source_meta read fails with `errcode`. */
  const failing = (errcode: number): Db =>
    ({
      stmt: (sql: string) => ({
        get: () => {
          if (sql.startsWith('PRAGMA user_version')) return { user_version: SCHEMA_VERSION };
          throw sqliteError(errcode);
        },
      }),
    }) as unknown as Db;

  it('says busy when a lock kept it from source_meta', () => {
    expect(() => identityOf(failing(5))).toThrow(IndexBusy);
    expect(() => identityOf(failing(6))).toThrow(IndexBusy);
  });

  it('still gives no identity for a database without source_meta', () => {
    expect(identityOf(failing(1))).toEqual({ version: SCHEMA_VERSION, uuid: null });
    const dir = testDir('busy-identity-none');
    const db = openDb(join(dir, 'other.sqlite'));
    try {
      expect(identityOf(db)).toEqual({ version: 0, uuid: null });
    } finally {
      db.close();
    }
  });
});

describe("the writer's open", () => {
  const open = (dbPath: string, uuid: string, busyMs: number) =>
    new WriterState().open({ dbPath, stamp: STAMP, expectedUuid: uuid, capBytes: null, busyMs });

  for (const sidecars of [true, false]) {
    const how = sidecars ? 'with its -wal and -shm there' : 'with no -shm';
    it(`held past its timeout (${how}) says busy, and deletes or makes nothing`, async () => {
      const { dbPath, dir, uuid } = newIndex(`busy-writer-held-${sidecars}`);
      await held(dbPath, 5000, sidecars);
      const before = files(dir);
      let error: unknown = null;
      try {
        open(dbPath, uuid, 200);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(IndexBusy);
      expect(codeOf(error)).toBe('INDEX_BUSY');
      expect(files(dir)).toEqual(before);
    });
  }

  it('released inside its timeout opens the index there, as it is', async () => {
    const { dbPath, uuid } = newIndex('busy-writer-released');
    const lock = await held(dbPath, 300);
    const writer = new WriterState();
    const opened = writer.open({
      dbPath,
      stamp: STAMP,
      expectedUuid: uuid,
      capBytes: null,
      busyMs: 5000,
    });
    try {
      expect(opened).toMatchObject({ uuid, created: false, replaced: false, mismatch: null });
    } finally {
      writer.close();
    }
    await lock.released;
  });
});

describe("the query thread's open", () => {
  it('held from before its probe says INDEX_BUSY across the thread, not INDEX_DAMAGED', async () => {
    const { dbPath, uuid } = newIndex('busy-query-held');
    await held(dbPath, 5000);
    expect(() => new QueryState().open(dbPath, uuid, 200)).toThrow(IndexBusy);
    expect(await queryOpenCode(dbPath, uuid, 200)).toBe('INDEX_BUSY');
  });

  it('held after a probe that took no lock still waits, then opens', async () => {
    // With no -shm, the probe reads the file as immutable and takes no lock;
    // the identity read on the real connection meets the lock and waits.
    const { dbPath, uuid } = newIndex('busy-query-identity');
    const lock = await held(dbPath, 300, false);
    const query = new QueryState();
    query.open(dbPath, uuid, 5000);
    expect(query.db).not.toBeNull();
    query.close();
    await lock.released;
  });

  it('held after a probe that took no lock, past its timeout, says busy, not damaged', async () => {
    const { dbPath, uuid } = newIndex('busy-query-identity-held');
    await held(dbPath, 5000, false);
    expect(await queryOpenCode(dbPath, uuid, 200)).toBe('INDEX_BUSY');
  });

  it('released inside its timeout opens', async () => {
    const { dbPath, uuid } = newIndex('busy-query-released');
    const lock = await held(dbPath, 300);
    const query = new QueryState();
    query.open(dbPath, uuid, 5000);
    expect(query.db).not.toBeNull();
    query.close();
    await lock.released;
  });
});
