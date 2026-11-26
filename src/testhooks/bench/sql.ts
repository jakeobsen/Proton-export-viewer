// SPDX-License-Identifier: AGPL-3.0-or-later
// SQLite access for the index bench. The bench runs the same statements on
// the built-in node:sqlite and, for comparison only, on better-sqlite3 loaded
// from a package directory given at run time. Nothing outside the test hooks
// can reach the second engine.

import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;
export type EngineName = 'node:sqlite' | 'better-sqlite3';

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

export interface Db {
  readonly engine: EngineName;
  exec(sql: string): void;
  /** A prepared statement, cached per SQL text for the connection's lifetime. */
  stmt(sql: string): Statement;
  close(): void;
}

export interface OpenOptions {
  engine: EngineName;
  /** better-sqlite3 only: the absolute path of its package directory. */
  addonDir?: string;
  readOnly?: boolean;
}

interface RawDb {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): unknown;
}

type BetterSqlite3 = new (path: string, options?: { readonly?: boolean }) => RawDb;

function loadBetterSqlite3(addonDir: string | undefined): BetterSqlite3 {
  if (!__PEV_TEST_HOOKS__) throw new Error('better-sqlite3 is only for test builds');
  if (!addonDir || !isAbsolute(addonDir)) throw new Error('better-sqlite3 needs an absolute path');
  const load = createRequire(import.meta.url);
  return load(addonDir) as BetterSqlite3;
}

function wrap(engine: EngineName, raw: RawDb): Db {
  const cache = new Map<string, Statement>();
  return {
    engine,
    exec: (sql) => {
      raw.exec(sql);
    },
    stmt: (sql) => {
      let statement = cache.get(sql);
      if (!statement) {
        statement = raw.prepare(sql);
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

export function openDb(path: string, options: OpenOptions): Db {
  const readOnly = options.readOnly ?? false;
  if (options.engine === 'better-sqlite3') {
    const Database = loadBetterSqlite3(options.addonDir);
    return wrap('better-sqlite3', new Database(path, { readonly: readOnly }));
  }
  const raw = new DatabaseSync(path, { readOnly });
  return wrap('node:sqlite', raw as unknown as RawDb);
}

/** The settings both engines use, so their numbers compare like for like. */
export function configure(db: Db, role: 'writer' | 'reader'): void {
  db.exec('PRAGMA busy_timeout = 5000');
  if (role === 'writer') {
    db.exec('PRAGMA page_size = 4096');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA cache_size = -65536');
  db.exec('PRAGMA temp_store = MEMORY');
}

export interface EngineInfo {
  engine: EngineName;
  sqliteVersion: string;
  compileOptions: string[];
  fts5: boolean;
  journalMode: string;
  pageSize: number;
}

export function engineInfo(db: Db): EngineInfo {
  const version = db.stmt('SELECT sqlite_version() AS v').get()?.v;
  const options = db
    .stmt('PRAGMA compile_options')
    .all()
    .map((row) => String(Object.values(row)[0]));
  return {
    engine: db.engine,
    sqliteVersion: String(version),
    compileOptions: options,
    fts5: options.includes('ENABLE_FTS5'),
    journalMode: String(db.stmt('PRAGMA journal_mode').get()?.journal_mode),
    pageSize: Number(db.stmt('PRAGMA page_size').get()?.page_size),
  };
}

export function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}
