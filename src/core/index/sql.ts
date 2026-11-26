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
  const raw = new DatabaseSync(target, { readOnly: readOnly || immutable });
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
    close: () => {
      cache.clear();
      raw.close();
    },
  };
}

/**
 * Connection settings. The writer keeps a small cache, which bounds how much
 * one unit of work can leave unwritten (see limits.ts); the query thread keeps
 * a larger one.
 */
export function configure(db: Db, role: 'writer' | 'reader'): void {
  db.exec('PRAGMA busy_timeout = 5000');
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

export const SQLITE_FULL = 13;
export const SQLITE_CORRUPT = 11;
export const SQLITE_NOTADB = 26;
