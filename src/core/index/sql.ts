// SPDX-License-Identifier: AGPL-3.0-or-later
// SQLite access for the export index, on the built-in node:sqlite. Prepared
// statements are cached per connection.

import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { WRITER_CACHE_BYTES } from './limits';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
  /** The rows one at a time, so a long result is never held whole. */
  iterate(...params: SqlValue[]): IterableIterator<Row>;
}

export interface Db {
  exec(sql: string): void;
  /** A prepared statement, cached per SQL text for the connection's lifetime. */
  stmt(sql: string): Statement;
  /**
   * A prepared statement that isn't cached, for SQL whose text varies, so the
   * cache can't grow without bound. It is finalized once nothing holds it.
   */
  once(sql: string): Statement;
  close(): void;
}

/** The query thread's page cache; released when the index is idle. */
export const READER_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Opens a database. `immutable` reads the file as it is, read-only and
 * without locks, so SQLite creates no WAL or shared-memory file beside it;
 * it is only right for a file nothing is writing and whose WAL, if any, has
 * been checkpointed.
 */
export function openDb(path: string, readOnly = false, immutable = false): Db {
  let target: string | URL = path;
  if (immutable) {
    target = pathToFileURL(path);
    target.searchParams.set('immutable', '1');
  }
  return wrap(new DatabaseSync(target, { readOnly: readOnly || immutable }));
}

/** Opens an existing database for reading and writing; it fails, creating nothing, if there is none. */
export function openExistingDb(path: string): Db {
  const target = pathToFileURL(path);
  target.searchParams.set('mode', 'rw');
  return wrap(new DatabaseSync(target));
}

function wrap(raw: DatabaseSync): Db {
  const cache = new Map<string, Statement>();
  return {
    exec: (sql) => {
      raw.exec(sql);
    },
    stmt: (sql) => {
      let statement = cache.get(sql);
      if (!statement) {
        statement = raw.prepare(sql) as unknown as Statement;
        cache.set(sql, statement);
      }
      return statement;
    },
    once: (sql) => raw.prepare(sql) as unknown as Statement,
    close: () => {
      cache.clear();
      raw.close();
    },
  };
}

/** How long a connection waits for another one's lock before it gives up as busy. */
export const INDEX_BUSY_MS = 5000;

/** Sets how long `db` waits for another connection's lock, in whole milliseconds. */
export function setBusyTimeout(db: Db, busyMs: number = INDEX_BUSY_MS): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyMs))}`);
}

/**
 * Connection settings. The writer keeps a small cache, which bounds how much
 * one unit of work can leave unwritten (see limits.ts); the query thread keeps
 * a larger one.
 */
export function configure(db: Db, role: 'writer' | 'reader', busyMs: number = INDEX_BUSY_MS): void {
  setBusyTimeout(db, busyMs);
  if (role === 'writer') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  const cache = role === 'writer' ? WRITER_CACHE_BYTES : READER_CACHE_BYTES;
  db.exec(`PRAGMA cache_size = ${-cache / 1024}`);
  db.exec('PRAGMA temp_store = MEMORY');
}

export function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/** The first column of the first row, as a number. */
export function scalar(db: Db, sql: string, ...params: SqlValue[]): number {
  return asNumber(Object.values(db.stmt(sql).get(...params) ?? {})[0]);
}

/** The SQLite result code of an error from node:sqlite, if it has one. */
export function sqliteCode(err: unknown): number | null {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code & 0xff : null;
}

export const SQLITE_BUSY = 5;
export const SQLITE_LOCKED = 6;
export const SQLITE_FULL = 13;
export const SQLITE_CORRUPT = 11;
export const SQLITE_NOTADB = 26;

/**
 * Whether an error says another connection holds a lock the operation needs:
 * SQLITE_BUSY or SQLITE_LOCKED, with any extended code (such as
 * BUSY_RECOVERY or BUSY_SNAPSHOT).
 */
export function isBusy(err: unknown): boolean {
  const code = sqliteCode(err);
  return code === SQLITE_BUSY || code === SQLITE_LOCKED;
}

/**
 * The index can't be read yet: another connection held a lock past the busy
 * timeout. That says nothing about the file, so it is never taken as damage.
 */
export class IndexBusy extends Error {
  constructor() {
    super('INDEX_BUSY');
  }
}
