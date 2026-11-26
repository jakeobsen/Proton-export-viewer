// SPDX-License-Identifier: AGPL-3.0-or-later
// What each of the index's threads does, one function per operation. The
// writer thread holds the only write connection, the query thread a read-only
// one, and the index pool's threads read and parse export files. These run in
// worker threads (see thread.ts); tests call them directly.

import { chmodSync, closeSync, openSync, rmSync, statSync } from 'node:fs';
import type { Stamp } from '../../shared/sources';
import { readWithRescan, type FileRef } from '../containment';
import { LabelsError, SYSTEM_LABELS, parseLabels, type LabelEntry } from './labels';
import {
  CHECKPOINT_RETRY_MS,
  MERGE_PAGES,
  MERGE_STEPS_PER_BATCH,
  WAL_HEADROOM,
  WAL_TRUNCATE_AT,
  WalStop,
  maxPages,
  walGuard,
} from './limits';
import { MetadataError, parseMetadata, type MessageRow } from './metadata';
import type { IndexAnswer, IndexQuery } from '../../shared/index-types';
import { listPage, rowDetails, sidebar, threadOfMessage } from './queries';
import { META, createSchema, metaValue, sameIdentity } from './schema';
import { SQLITE_FULL, configure, openDb, scalar, sqliteCode, type Db } from './sql';
import type { ThreadRole } from './pool';
import { IndexWriter, StaleBatch, type Phase1Item, type Phase1Stats } from './writer';

/** The database file and its sidecars. */
export const FAMILY_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

export function familyBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of FAMILY_SUFFIXES) {
    try {
      total += statSync(dbPath + suffix).size;
    } catch {
      // A file of the family that doesn't exist counts as empty.
    }
  }
  return total;
}

/** Deletes the database and every sidecar. Only with no connection open on it. */
export function deleteFamily(dbPath: string): void {
  for (const suffix of FAMILY_SUFFIXES) rmSync(dbPath + suffix, { force: true });
}

/** A failure the core side reports by code. */
export function codeOf(err: unknown): string {
  if (err instanceof MetadataError || err instanceof LabelsError) return err.code;
  if (err instanceof WalStop) return 'WAL_STOP';
  if (err instanceof StaleBatch) return 'STALE';
  if (sqliteCode(err) === SQLITE_FULL) return 'INDEX_FULL';
  const message = String((err as Error)?.message ?? '');
  if (/^[A-Z][A-Z0-9_]{1,40}$/.test(message)) return message;
  return 'FAILED';
}

// --- Writer --------------------------------------------------------------------

export interface WriterOpen {
  dbPath: string;
  stamp: Stamp;
  /** The identity the registry has for this source's index; null if none. */
  expectedUuid: string | null;
  /** The most the index may take on disk with its WAL and shared memory; null for no cap. */
  capBytes: number | null;
  /** False: open only an index with the expected identity, and change nothing on disk. */
  create?: boolean;
}

export interface WriterOpened {
  uuid: string;
  /** A new database was made (none existed, or the one there wasn't this source's). */
  created: boolean;
  /** An existing database was replaced because its version or identity didn't match. */
  replaced: boolean;
  phase1Done: boolean;
}

export interface BatchResult extends Phase1Stats {
  indexBytes: number;
}

export class WriterState {
  db: Db | null = null;
  writer: IndexWriter | null = null;
  private dbPath = '';
  private walPath = '';
  peakWalBytes = 0;

  open(args: WriterOpen): WriterOpened {
    this.close();
    this.dbPath = args.dbPath;
    this.walPath = `${args.dbPath}-wal`;
    let replaced = false;
    let exists = false;
    try {
      exists = statSync(args.dbPath).isFile();
    } catch {
      // No database yet.
    }
    if (exists && args.expectedUuid !== null) {
      try {
        chmodSync(args.dbPath, 0o600);
        const db = openDb(args.dbPath);
        configure(db, 'writer');
        if (sameIdentity(db, args.expectedUuid)) {
          return this.ready(db, args, args.expectedUuid, false, false);
        }
        db.close();
      } catch {
        // Not a database this source can use; it is replaced below.
      }
      replaced = true;
    } else if (exists) {
      replaced = true;
    }
    if (args.create === false) throw new Error('NO_INDEX');
    deleteFamily(args.dbPath);
    // SQLite gives the WAL and shared-memory files the database file's mode,
    // so the file is made 0600 before SQLite opens it.
    closeSync(openSync(args.dbPath, 'wx', 0o600));
    const db = openDb(args.dbPath);
    configure(db, 'writer');
    const uuid = createSchema(db, args.stamp.generation);
    return this.ready(db, args, uuid, true, replaced);
  }

  private ready(
    db: Db,
    args: WriterOpen,
    uuid: string,
    created: boolean,
    replaced: boolean,
  ): WriterOpened {
    if (args.capBytes !== null) {
      const pageSize = scalar(db, 'PRAGMA page_size');
      db.exec(`PRAGMA max_page_count = ${maxPages(args.capBytes, pageSize)}`);
    }
    db.exec(`PRAGMA journal_size_limit = ${WAL_TRUNCATE_AT}`);
    db.exec('PRAGMA wal_autocheckpoint = 1000');
    this.db = db;
    this.writer = new IndexWriter(db, args.stamp, walGuard(this.walPath));
    return {
      uuid,
      created,
      replaced,
      phase1Done: Number(metaValue(db, META.phase1Done) ?? 0) === 1,
    };
  }

  private need(): { db: Db; writer: IndexWriter } {
    if (!this.db || !this.writer) throw new Error('NOT_OPEN');
    return { db: this.db, writer: this.writer };
  }

  private walBytes(): number {
    try {
      return statSync(this.walPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Checkpoints and truncates a WAL above WAL_TRUNCATE_AT. A reader holding an
   * old snapshot makes the checkpoint report busy, so it is retried for a
   * while; nothing more is written until it succeeds.
   */
  private truncateWal(): void {
    const { db } = this.need();
    if (this.walBytes() <= WAL_TRUNCATE_AT) return;
    const deadline = performance.now() + CHECKPOINT_RETRY_MS;
    for (;;) {
      const row = db.stmt('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (Number(row?.busy ?? 0) === 0) return;
      if (performance.now() > deadline) throw new Error('WAL_BUSY');
    }
  }

  private afterCommit(): void {
    const size = this.walBytes();
    this.peakWalBytes = Math.max(this.peakWalBytes, size);
    if (size > WAL_HEADROOM) throw new Error('WAL_HEADROOM');
    this.truncateWal();
  }

  /** One write transaction, then bounded full-text merge steps, each in its own transaction. */
  private commit<T>(write: () => T): T {
    const { writer } = this.need();
    this.truncateWal();
    let result: T;
    try {
      result = write();
    } catch (err) {
      if (!(err instanceof WalStop)) throw err;
      // The WAL outgrew its stop line inside the batch; checkpoint and try once more.
      const { db } = this.need();
      db.stmt('PRAGMA wal_checkpoint(TRUNCATE)').get();
      result = write();
    }
    this.afterCommit();
    for (let step = 0; step < MERGE_STEPS_PER_BATCH; step++) {
      const work = writer.mergeStep(MERGE_PAGES);
      this.afterCommit();
      if (work <= 1) break;
    }
    return result;
  }

  labels(stamp: Stamp, labels: LabelEntry[], stat: string): void {
    const { writer } = this.need();
    this.commit(() => writer.writeLabels(stamp, labels, stat));
  }

  phase1(stamp: Stamp, items: Phase1Item[]): BatchResult {
    const { writer } = this.need();
    const stats = this.commit(() => writer.phase1Batch(stamp, items));
    return { ...stats, indexBytes: familyBytes(this.dbPath) };
  }

  finish(stamp: Stamp): void {
    this.need().writer.finishPhase1(stamp);
    this.truncateWal();
  }

  pairIds(): string[] {
    return this.need().writer.pairIds();
  }

  shrink(): void {
    this.db?.exec('PRAGMA shrink_memory');
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.writer = null;
  }
}

// --- Query thread ------------------------------------------------------------

export const SYSTEM_IDS: readonly string[] = Object.values(SYSTEM_LABELS).filter(
  (id) => id !== SYSTEM_LABELS.allMailCopy,
);

export class QueryState {
  db: Db | null = null;

  open(dbPath: string): void {
    this.close();
    const db = openDb(dbPath, true);
    configure(db, 'reader');
    this.db = db;
  }

  run(call: IndexQuery): IndexAnswer {
    const db = this.db;
    if (!db) throw new Error('NOT_OPEN');
    switch (call.op) {
      case 'sidebar':
        return sidebar(db, SYSTEM_IDS);
      case 'page':
        return listPage(db, call.labelId, call.after, call.limit);
      case 'details':
        return rowDetails(db, call.threadIds);
      case 'resolve':
        return threadOfMessage(db, call.rowid);
      case 'totals':
        return {
          messages: scalar(db, 'SELECT count(*) FROM messages'),
          conversations: scalar(db, 'SELECT count(*) FROM threads'),
          pairs: scalar(db, 'SELECT count(*) FROM pairs'),
        };
    }
  }

  shrink(): void {
    this.db?.exec('PRAGMA shrink_memory');
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

// --- Index pool --------------------------------------------------------------

export interface MetaJobItem {
  protonId: string;
  ref: FileRef;
}

export interface MetaJobResult {
  protonId: string;
  row: MessageRow | null;
  error: string | null;
  /** The file as it was read (a rescan can find it at a new inode). */
  ref: FileRef;
}

/** Reads and parses metadata files; each failure becomes the pair's code. */
export function parseMetaJob(root: string, items: MetaJobItem[]): MetaJobResult[] {
  return items.map(({ protonId, ref }) => {
    const read = readWithRescan(root, ref);
    if (!read.ok) {
      return { protonId, row: null, error: rejectCode(read.rejection.kind), ref };
    }
    try {
      return {
        protonId,
        row: parseMetadata(protonId, read.bytes.toString('utf8')),
        error: null,
        ref: read.ref,
      };
    } catch (err) {
      return { protonId, row: null, error: codeOf(err), ref: read.ref };
    }
  });
}

export interface LabelsJobResult {
  labels: LabelEntry[] | null;
  error: string | null;
  ref: FileRef;
}

export function parseLabelsJob(root: string, ref: FileRef): LabelsJobResult {
  const read = readWithRescan(root, ref);
  if (!read.ok) return { labels: null, error: rejectCode(read.rejection.kind), ref };
  try {
    return { labels: parseLabels(read.bytes.toString('utf8')), error: null, ref: read.ref };
  } catch (err) {
    return { labels: null, error: codeOf(err), ref: read.ref };
  }
}

/** The pair code for a file the containment checks refused when it was read. */
export function rejectCode(kind: string): string {
  return `FILE_${kind.toUpperCase()}`;
}

// --- Dispatch ----------------------------------------------------------------

/** The operations of one thread role, by name. */
export function threadHandler(role: ThreadRole): (op: string, args: unknown) => unknown {
  if (role === 'writer') {
    const writer = new WriterState();
    return (op, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (op) {
        case 'open':
          return writer.open(a as unknown as WriterOpen);
        case 'labels':
          writer.labels(a.stamp as Stamp, a.labels as LabelEntry[], a.stat as string);
          return null;
        case 'phase1':
          return writer.phase1(a.stamp as Stamp, a.items as Phase1Item[]);
        case 'finish':
          writer.finish(a.stamp as Stamp);
          return null;
        case 'pair-ids':
          return writer.pairIds();
        case 'shrink':
          writer.shrink();
          return null;
        case 'close':
          writer.close();
          return null;
      }
      throw new Error('UNKNOWN_OP');
    };
  }
  if (role === 'query') {
    const query = new QueryState();
    return (op, args) => {
      switch (op) {
        case 'open':
          query.open((args as { dbPath: string }).dbPath);
          return null;
        case 'query':
          return query.run((args as { call: IndexQuery }).call);
        case 'shrink':
          query.shrink();
          return null;
        case 'close':
          query.close();
          return null;
      }
      throw new Error('UNKNOWN_OP');
    };
  }
  return (op, args) => {
    const a = args as { root: string; items?: MetaJobItem[]; ref?: FileRef };
    switch (op) {
      case 'meta':
        return parseMetaJob(a.root, a.items ?? []);
      case 'labels':
        return parseLabelsJob(a.root, a.ref as FileRef);
    }
    throw new Error('UNKNOWN_OP');
  };
}
