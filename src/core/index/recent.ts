// SPDX-License-Identifier: AGPL-3.0-or-later
// Recent searches in the index's `recent_searches` table. Each row holds one
// search's canonical JSON and main's receipt time. The jobs run on a write
// connection, each in one transaction: the writer thread's, or, while the
// export is unavailable, the recent-only connection's, which opens an
// existing index of this identity and schema version and runs nothing but
// these statements.

import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { overlaps } from '../../shared/overlap';
import {
  parseRecent,
  type RecentAnswer,
  type RecentJob,
  type RecentRow,
} from '../../shared/recent-search';
import { probeSame, sameIdentity } from './schema';
import { asNumber, configure, openExistingDb, type Db } from './sql';

/** The most recent searches kept. */
export const MAX_RECENT = 20;
/** The rows a list reads, newest first, to find MAX_RECENT valid ones. */
export const RECENT_READ = 40;

function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already rolled back.
    }
    throw err;
  }
}

/**
 * Records one search: rows that fail the check go, then any row of the same
 * search, then the new row is added and only the newest MAX_RECENT are kept,
 * by time and then by insertion order.
 */
function record(db: Db, q: string, at: number): RecentAnswer {
  if (parseRecent(q) === null || !Number.isSafeInteger(at) || at < 0) {
    throw new Error('RECENT_INVALID');
  }
  return transaction(db, () => {
    let invalid = 0;
    const drop = db.stmt('DELETE FROM recent_searches WHERE id = ?');
    for (const r of db.stmt('SELECT id, q FROM recent_searches').all()) {
      if (parseRecent(r.q) !== null) continue;
      drop.run(asNumber(r.id));
      invalid += 1;
    }
    db.stmt('DELETE FROM recent_searches WHERE q = ?').run(q);
    db.stmt('INSERT INTO recent_searches(q, at) VALUES (?, ?)').run(q, at);
    db.stmt(
      `DELETE FROM recent_searches WHERE id NOT IN
         (SELECT id FROM recent_searches ORDER BY at DESC, id DESC LIMIT ?)`,
    ).run(MAX_RECENT);
    return { op: 'record', invalid };
  });
}

/** The newest MAX_RECENT valid rows among the newest RECENT_READ, newest first. */
function list(db: Db): RecentAnswer {
  return transaction(db, () => {
    const rows: RecentRow[] = [];
    let invalid = 0;
    for (const r of db
      .stmt('SELECT q, at FROM recent_searches ORDER BY at DESC, id DESC LIMIT ?')
      .all(RECENT_READ)) {
      if (parseRecent(r.q) === null) {
        invalid += 1;
        continue;
      }
      if (rows.length < MAX_RECENT) rows.push({ q: String(r.q), at: asNumber(r.at) });
    }
    return { op: 'list', rows, invalid };
  });
}

function wipe(db: Db): RecentAnswer {
  return transaction(db, () => {
    const deleted = asNumber(db.stmt('DELETE FROM recent_searches').run().changes);
    return { op: 'wipe', deleted };
  });
}

/** Runs one recent job on a write connection. */
export function recentJob(db: Db | null, job: RecentJob): RecentAnswer {
  if (!db) throw new Error('NOT_OPEN');
  switch (job.op) {
    case 'record':
      return record(db, job.q, job.at);
    case 'list':
      return list(db);
    case 'wipe':
      return wipe(db);
  }
  throw new Error('UNKNOWN_OP');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The recent-only connection, for an export that is unavailable: it opens
 * the index only if the file has this identity and schema version, never
 * creates, replaces or migrates it, and runs only the recent jobs.
 */
export class RecentOnlyState {
  db: Db | null = null;

  open(args: { dbPath: string; expectedUuid: string; exportRoots?: string[] }): void {
    this.close();
    const dir = dirname(args.dbPath);
    if ((args.exportRoots ?? []).some((root) => overlaps(root, dir))) {
      throw new Error('INDEX_OVERLAP');
    }
    if (!isFile(args.dbPath)) throw new Error('NO_INDEX');
    if (!probeSame(args.dbPath, args.expectedUuid)) throw new Error('INDEX_DAMAGED');
    const db = openExistingDb(args.dbPath);
    let usable: boolean;
    try {
      usable = sameIdentity(db, args.expectedUuid);
      if (usable) configure(db, 'writer');
    } catch {
      usable = false;
    }
    if (!usable) {
      db.close();
      throw new Error('INDEX_DAMAGED');
    }
    this.db = db;
  }

  run(job: RecentJob): RecentAnswer {
    return recentJob(this.db, job);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
