// SPDX-License-Identifier: AGPL-3.0-or-later
// What each of the index's threads does, one function per operation. The
// writer thread holds the only write connection, the query thread a read-only
// one, and the index pool's threads read and parse export files. These run in
// worker threads (see thread.ts); tests call them directly.

import { chmodSync, closeSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { overlaps } from '../../shared/overlap';
import type { Stamp } from '../../shared/sources';
import { readWithRescan, type FileRef } from '../containment';
import { FamilyInUse, deleteFamily, familyBytes } from './family';
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
import {
  cardsWindow,
  emlFile,
  listPage,
  listWindow,
  rowDetails,
  sidebar,
  threadOfMessage,
} from './queries';
import { searchPage } from './search';
import {
  META,
  createSchema,
  identityOf,
  metaValue,
  mismatchOf,
  probeMismatch,
  probeSame,
  sameIdentity,
  type Mismatch,
} from './schema';
import {
  SQLITE_CORRUPT,
  SQLITE_FULL,
  SQLITE_NOTADB,
  configure,
  openDb,
  scalar,
  sqliteCode,
  type Db,
} from './sql';
import type { ThreadRole } from './pool';
import {
  IndexWriter,
  StaleBatch,
  type ApplyItem,
  type ApplyStats,
  type FileStat,
  type Phase1Item,
  type Phase1Stats,
  type ReconcilePlan,
} from './writer';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A write stopped part-way because the index is being torn down; it was rolled back. */
export class Cancelled extends Error {
  constructor() {
    super('CANCELLED');
  }
}

/** A failure the core side reports by code. */
export function codeOf(err: unknown): string {
  if (err instanceof MetadataError || err instanceof LabelsError) return err.code;
  if (err instanceof WalStop) return 'WAL_STOP';
  if (err instanceof StaleBatch) return 'STALE';
  if (err instanceof Cancelled) return 'CANCELLED';
  if (err instanceof FamilyInUse) return 'FAMILY_IN_USE';
  const sqlite = sqliteCode(err);
  if (sqlite === SQLITE_FULL) return 'INDEX_FULL';
  if (sqlite === SQLITE_CORRUPT || sqlite === SQLITE_NOTADB) return 'INDEX_CORRUPT';
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
  /**
   * The folders of the exports the app knows. While one of them overlaps the
   * index folder, no index file is opened for writing, deleted or made.
   */
  exportRoots?: string[];
  /**
   * Set to 1 when the index is torn down: the write in flight stops at its
   * next unit of work and rolls back.
   */
  cancel?: SharedArrayBuffer;
}

export interface WriterOpened {
  uuid: string;
  /** A new database was made (none existed, or the one there wasn't this source's). */
  created: boolean;
  /** An existing database was replaced because its version or identity didn't match. */
  replaced: boolean;
  /** Why it was replaced. */
  mismatch: Mismatch | null;
  phase1Done: boolean;
}

export interface BatchResult extends Phase1Stats {
  indexBytes: number;
}

export interface ApplyResult extends ApplyStats {
  indexBytes: number;
}

/**
 * Throws INDEX_OVERLAP if a known export overlaps the index folder now, with
 * links resolved at this moment: then nothing of an export may be written,
 * deleted or made in its place. Asked right before each such step.
 */
function refuseOverlap(args: WriterOpen): void {
  const dir = dirname(args.dbPath);
  if ((args.exportRoots ?? []).some((root) => overlaps(root, dir))) {
    throw new Error('INDEX_OVERLAP');
  }
}

/** The pause between checkpoint tries while readers keep the WAL busy. */
const CHECKPOINT_PAUSE_MS = 50;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

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
    const exists = isFile(args.dbPath);
    let mismatch: Mismatch | null = null;
    if (exists) {
      mismatch = probeMismatch(args.dbPath, args.expectedUuid);
      if (mismatch === null && args.expectedUuid !== null) {
        refuseOverlap(args);
        const kept = this.openExisting(args, args.expectedUuid);
        if (typeof kept !== 'string') return kept;
        mismatch = kept;
      }
    }
    refuseOverlap(args);
    // A failed candidate was closed; this refuses if anything still holds the family.
    deleteFamily(args.dbPath);
    // SQLite gives the WAL and shared-memory files the database file's mode,
    // so the file is made 0600 before SQLite opens it.
    closeSync(openSync(args.dbPath, 'wx', 0o600));
    const db = openDb(args.dbPath);
    try {
      configure(db, 'writer');
      const uuid = createSchema(db, args.stamp.generation);
      return this.ready(db, args, uuid, true, exists, mismatch);
    } catch (err) {
      this.drop(db);
      throw err;
    }
  }

  /**
   * Opens the database there, which the probe found to have this schema
   * version and identity. If the open connection finds otherwise, or the
   * open fails, it is closed again, and the answer is why.
   */
  private openExisting(args: WriterOpen, expectedUuid: string): WriterOpened | Mismatch {
    let db: Db | null = null;
    try {
      chmodSync(args.dbPath, 0o600);
      db = openDb(args.dbPath);
      configure(db, 'writer');
      const mismatch = mismatchOf(identityOf(db), expectedUuid);
      if (mismatch) return mismatch;
      const opened = this.ready(db, args, expectedUuid, false, false, null);
      db = null;
      return opened;
    } catch {
      return 'corrupt';
    } finally {
      if (db) this.drop(db);
    }
  }

  /** Closes a connection that didn't become the writer's. */
  private drop(db: Db): void {
    if (this.db === db) {
      this.db = null;
      this.writer = null;
    }
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }

  private ready(
    db: Db,
    args: WriterOpen,
    uuid: string,
    created: boolean,
    replaced: boolean,
    mismatch: Mismatch | null,
  ): WriterOpened {
    if (args.capBytes !== null) {
      const pageSize = scalar(db, 'PRAGMA page_size');
      db.exec(`PRAGMA max_page_count = ${maxPages(args.capBytes, pageSize)}`);
    }
    db.exec(`PRAGMA journal_size_limit = ${WAL_TRUNCATE_AT}`);
    db.exec('PRAGMA wal_autocheckpoint = 1000');
    this.db = db;
    const guard = walGuard(this.walPath);
    const cancel = args.cancel ? new Int32Array(args.cancel) : null;
    this.writer = new IndexWriter(db, args.stamp, () => {
      if (cancel && Atomics.load(cancel, 0) !== 0) throw new Cancelled();
      guard();
    });
    return {
      uuid,
      created,
      replaced,
      mismatch,
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
      // Each try already waits up to the busy timeout; this keeps a reader
      // that holds an old snapshot from turning the retries into a spin.
      Atomics.wait(PAUSE, 0, 0, CHECKPOINT_PAUSE_MS);
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

  labels(stamp: Stamp, labels: LabelEntry[], stat: string | null): void {
    const { writer } = this.need();
    this.commit(() => writer.writeLabels(stamp, labels, stat));
  }

  plan(metadata: Map<string, FileStat>, eml: Map<string, FileStat>): ReconcilePlan {
    return this.need().writer.planReconcile(metadata, eml);
  }

  apply(stamp: Stamp, items: ApplyItem[]): ApplyResult {
    const { writer } = this.need();
    const stats = this.commit(() => writer.applyChanges(stamp, items));
    return { ...stats, indexBytes: familyBytes(this.dbPath) };
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

  /**
   * Opens a read-only connection, only to a database with this schema version
   * and identity. The identity is checked first without changing anything on
   * disk; once it matches, SQLite may create the shared-memory and WAL files
   * beside the database, as for any reader of a WAL database.
   */
  open(dbPath: string, expectedUuid: string): void {
    this.close();
    // No file: there is no index. A file that isn't this index: a damaged one.
    if (!isFile(dbPath)) throw new Error('NO_INDEX');
    if (!probeSame(dbPath, expectedUuid)) throw new Error('INDEX_DAMAGED');
    const db = openDb(dbPath, true);
    let usable: boolean;
    try {
      usable = sameIdentity(db, expectedUuid);
      if (usable) configure(db, 'reader');
    } catch {
      usable = false;
    }
    if (!usable) {
      db.close();
      throw new Error('INDEX_DAMAGED');
    }
    this.db = db;
  }

  /** Answers a query from one read snapshot, however many statements it takes. */
  run(call: IndexQuery): IndexAnswer {
    const db = this.db;
    if (!db) throw new Error('NOT_OPEN');
    db.exec('BEGIN');
    try {
      return this.answer(db, call);
    } finally {
      db.exec('COMMIT');
    }
  }

  private answer(db: Db, call: IndexQuery): IndexAnswer {
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
      case 'window':
        return listWindow(db, call);
      case 'cards':
        return cardsWindow(db, call);
      case 'eml':
        return emlFile(db, call.rowid);
      case 'search':
        return searchPage(db, call);
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

// --- Verifier ------------------------------------------------------------------

export interface CheckResult {
  /** True: the check passed. False: the index is damaged. Null: the check couldn't run. */
  ok: boolean | null;
  /** Why it is damaged: 'identity', 'schema' or 'quick_check'. */
  reason: string | null;
}

/**
 * Runs SQLite's quick check on its own read-only connection, after the same
 * identity check every connection makes, and closes it again.
 */
export function quickCheck(dbPath: string, expectedUuid: string): CheckResult {
  if (!isFile(dbPath)) return { ok: null, reason: null };
  let db: Db | null = null;
  try {
    db = openDb(dbPath, true);
    db.exec('PRAGMA busy_timeout = 5000');
    const mismatch = mismatchOf(identityOf(db), expectedUuid);
    if (mismatch) return { ok: false, reason: mismatch };
    const rows = db.stmt('PRAGMA quick_check').all();
    const fine = rows.length === 1 && Object.values(rows[0]!)[0] === 'ok';
    return fine ? { ok: true, reason: null } : { ok: false, reason: 'quick_check' };
  } catch (err) {
    return codeOf(err) === 'INDEX_CORRUPT'
      ? { ok: false, reason: 'quick_check' }
      : { ok: null, reason: null };
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
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
  /** The bytes read: a file can have changed since the scan sized it. */
  bytes: number;
}

/** Reads and parses metadata files; each failure becomes the pair's code. */
export function parseMetaJob(root: string, items: MetaJobItem[]): MetaJobResult[] {
  return items.map(({ protonId, ref }) => {
    const read = readWithRescan(root, ref);
    if (!read.ok) {
      return { protonId, row: null, error: rejectCode(read.rejection.kind), ref, bytes: 0 };
    }
    const bytes = read.bytes.length;
    try {
      return {
        protonId,
        row: parseMetadata(protonId, read.bytes.toString('utf8')),
        error: null,
        ref: read.ref,
        bytes,
      };
    } catch (err) {
      return { protonId, row: null, error: codeOf(err), ref: read.ref, bytes };
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
          writer.labels(a.stamp as Stamp, a.labels as LabelEntry[], a.stat as string | null);
          return null;
        case 'plan':
          return writer.plan(a.metadata as Map<string, FileStat>, a.eml as Map<string, FileStat>);
        case 'apply':
          return writer.apply(a.stamp as Stamp, a.items as ApplyItem[]);
        case 'phase1':
          return writer.phase1(a.stamp as Stamp, a.items as Phase1Item[]);
        case 'finish':
          writer.finish(a.stamp as Stamp);
          return null;
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
  if (role === 'verify') {
    return (op, args) => {
      if (op !== 'check') throw new Error('UNKNOWN_OP');
      const a = args as { dbPath: string; expectedUuid: string };
      return quickCheck(a.dbPath, a.expectedUuid);
    };
  }
  if (role === 'query') {
    const query = new QueryState();
    return (op, args) => {
      switch (op) {
        case 'open': {
          const a = args as { dbPath: string; expectedUuid: string };
          query.open(a.dbPath, a.expectedUuid);
          return null;
        }
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
