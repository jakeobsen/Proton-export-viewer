// SPDX-License-Identifier: AGPL-3.0-or-later
// The bench's worker threads in core. One entry serves four roles, chosen at
// spawn: an index pool worker, the writer (the only write connection), the
// query thread (a read-only connection) and the reader lane.

import { statSync } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getHeapStatistics } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import { simpleParser } from 'mailparser';
import { largeMessage } from '../../../tools/gen-export/stream.mjs';
import { extractText } from './extract';
import {
  FileError,
  MAX_METADATA_BYTES,
  readContained,
  streamContained,
  type FileRef,
} from './files';
import { MetadataError, parseMetadata } from './metadata';
import { listPage, searchByDate, searchByRelevance, ftsLiteral } from './queries';
import {
  CHECKPOINT_RETRY_MS,
  MERGE_PAGES,
  MERGE_STEPS_PER_BATCH,
  WAL_HEADROOM,
  WAL_TRUNCATE_AT,
  maxPages,
} from './limits';
import { checkIdentity, createSchema } from './schema';
import { configure, engineInfo, openDb, type Db, type EngineName } from './sql';
import { IndexWriter, type BodyResult, type LabelEntry, type Phase1Item } from './writer';

export type Role = 'index' | 'writer' | 'query' | 'reader';

export interface DbTarget {
  dbPath: string;
  engine: EngineName;
  addonDir?: string;
  /** FTS5 prefix lengths; the default is the app's. */
  ftsPrefix?: string;
  /** The most the index may take on disk, with its -wal and -shm files. */
  capBytes: number;
}

interface WalRecord {
  peakWalBytes: number;
  checkpoints: number;
  busyCheckpoints: number;
  /** The most one write transaction, or one merge transaction, added to the WAL. */
  maxWriteGrowth: number;
  maxMergeGrowth: number;
  merges: number;
}

const wal: WalRecord = {
  peakWalBytes: 0,
  checkpoints: 0,
  busyCheckpoints: 0,
  maxWriteGrowth: 0,
  maxMergeGrowth: 0,
  merges: 0,
};

interface Request {
  id: number;
  op: string;
  [key: string]: unknown;
}

const role = (workerData as { role: Role }).role;
let heapPeak = 0;
let db: Db | null = null;
let writer: IndexWriter | null = null;

function heap(): number {
  const used = getHeapStatistics().used_heap_size;
  if (used > heapPeak) heapPeak = used;
  return used;
}

const codeOf = (err: unknown): string => {
  if (err instanceof FileError || err instanceof MetadataError) return err.code;
  const message = String((err as Error)?.message ?? '');
  const e = err as { errcode?: number; code?: string };
  // SQLITE_FULL: node:sqlite reports the result code, better-sqlite3 its name.
  if (e?.errcode === 13 || e?.code === 'SQLITE_FULL' || /database or disk is full/i.test(message))
    return 'INDEX_CAP';
  return ((err as NodeJS.ErrnoException)?.code ?? (message || 'FAILED')).slice(0, 64);
};

/**
 * After each transaction: records what it added to the WAL, fails the run if
 * the WAL passed its headroom, and once the WAL is large checkpoints and
 * truncates it. A reader holding an old snapshot makes the checkpoint report
 * busy and leaves the WAL in place, so it is retried (each try waits up to the
 * busy timeout) and nothing more is written until it succeeds.
 */
function afterCommit(dbPath: string, before: number, kind: 'write' | 'merge'): void {
  const size = fileSize(`${dbPath}-wal`);
  const growth = size - before;
  if (kind === 'write') wal.maxWriteGrowth = Math.max(wal.maxWriteGrowth, growth);
  else wal.maxMergeGrowth = Math.max(wal.maxMergeGrowth, growth);
  wal.peakWalBytes = Math.max(wal.peakWalBytes, size);
  if (size > WAL_HEADROOM) throw new Error('WAL_HEADROOM');
  if (size <= WAL_TRUNCATE_AT) return;
  const deadline = performance.now() + CHECKPOINT_RETRY_MS;
  for (;;) {
    const row = db!.stmt('PRAGMA wal_checkpoint(TRUNCATE)').get();
    wal.checkpoints += 1;
    if (Number(row?.busy ?? 0) === 0) return;
    wal.busyCheckpoints += 1;
    if (performance.now() > deadline) throw new Error('WAL_BUSY');
  }
}

/** One write transaction, then bounded full-text merge steps, each in its own transaction. */
function commitBatch<T>(dbPath: string, write: () => T): T {
  let before = fileSize(`${dbPath}-wal`);
  const stats = write();
  afterCommit(dbPath, before, 'write');
  for (let step = 0; step < MERGE_STEPS_PER_BATCH; step++) {
    before = fileSize(`${dbPath}-wal`);
    const work = writer!.mergeStep(MERGE_PAGES);
    wal.merges += 1;
    afterCommit(dbPath, before, 'merge');
    if (work <= 1) break;
  }
  return stats;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function indexSizes(dbPath: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(dbPath + suffix).size;
    } catch {
      // A file of the family that doesn't exist counts as empty.
    }
  }
  return total;
}

function openTarget(t: DbTarget, readOnly: boolean): Db {
  const opened = openDb(t.dbPath, { engine: t.engine, addonDir: t.addonDir, readOnly });
  configure(opened, readOnly ? 'reader' : 'writer');
  return opened;
}

async function indexOp(r: Request): Promise<unknown> {
  switch (r.op) {
    case 'meta': {
      const items = r.items as Array<{ protonId: string; ref: FileRef }>;
      return items.map(({ protonId, ref }) => {
        try {
          const text = readContained(ref, MAX_METADATA_BYTES).toString('utf8');
          return { protonId, row: parseMetadata(protonId, text), error: null };
        } catch (err) {
          return { protonId, row: null, error: codeOf(err) };
        }
      });
    }
    case 'body': {
      const started = performance.now();
      const result = await extractText(streamContained(r.ref as FileRef));
      return {
        state: result.state,
        text: result.text,
        ms: performance.now() - started,
        inputBytes: result.inputBytes,
        rawTextBytes: result.rawTextBytes,
      };
    }
    case 'large': {
      const opts = {
        kind: r.kind as 'text' | 'html' | 'attachment',
        bytes: r.bytes as number,
        seed: 1,
      };
      const started = performance.now();
      if (r.mode === 'generate') {
        let n = 0;
        await pipeline(
          largeMessage(opts),
          new Writable({
            write(chunk: Buffer, _enc, done) {
              n += chunk.length;
              done();
            },
          }),
        );
        return { ms: performance.now() - started, inputBytes: n };
      }
      const result = await extractText(largeMessage(opts));
      return {
        ms: performance.now() - started,
        state: result.state,
        rawTextBytes: result.rawTextBytes,
        textBytes: result.textBytes,
        inputBytes: result.inputBytes,
      };
    }
  }
  throw new Error(`unknown op ${r.op}`);
}

function writerOp(r: Request): unknown {
  switch (r.op) {
    case 'init': {
      const t = r.target as DbTarget;
      db = openTarget(t, false);
      const pageSize = Number(db.stmt('PRAGMA page_size').get()?.page_size);
      const limit = maxPages(t.capBytes, pageSize);
      db.exec(`PRAGMA max_page_count = ${limit}`);
      db.exec(`PRAGMA journal_size_limit = ${WAL_TRUNCATE_AT}`);
      db.exec('PRAGMA wal_autocheckpoint = 1000');
      const uuid = createSchema(db, t.ftsPrefix);
      writer = new IndexWriter(db);
      return {
        uuid,
        info: engineInfo(db),
        limits: {
          maxPageCount: Number(db.stmt('PRAGMA max_page_count').get()?.max_page_count),
          mainFileLimitBytes: limit * pageSize,
          walHeadroomBytes: WAL_HEADROOM,
          walTruncateAtBytes: WAL_TRUNCATE_AT,
          capBytes: t.capBytes,
        },
      };
    }
    case 'labels':
      writer!.writeLabels(r.labels as LabelEntry[]);
      return null;
    case 'phase1': {
      const stats = commitBatch(r.dbPath as string, () =>
        writer!.phase1Batch(r.items as Phase1Item[]),
      );
      return {
        ...stats,
        indexBytes: indexSizes(r.dbPath as string),
      };
    }
    case 'revs': {
      const ids = r.ids as string[];
      return ids.map((id) => writer!.revOf(id));
    }
    case 'phase2': {
      const stats = commitBatch(r.dbPath as string, () =>
        writer!.phase2Batch(r.results as BodyResult[]),
      );
      return {
        ...stats,
        indexBytes: indexSizes(r.dbPath as string),
      };
    }
    case 'totals': {
      const one = (sql: string) => Number(Object.values(db!.stmt(sql).get() ?? {})[0] ?? 0);
      const states = db!
        .stmt('SELECT body_state AS s, count(*) AS n FROM pairs GROUP BY body_state')
        .all();
      return {
        messages: one('SELECT count(*) FROM messages'),
        conversations: one('SELECT count(*) FROM threads'),
        largest: one('SELECT max(msg_count) FROM threads'),
        singletons: one('SELECT count(*) FROM threads WHERE msg_count = 1'),
        keys: one('SELECT count(*) FROM thread_keys'),
        size: {
          pageSize: one('PRAGMA page_size'),
          pages: one('PRAGMA page_count'),
          freePages: one('PRAGMA freelist_count'),
          walBytes: fileSize(`${r.dbPath as string}-wal`),
          bodyTextBytes: one('SELECT sum(length(CAST(body AS BLOB))) FROM message_text'),
          otherTextBytes: one(
            'SELECT sum(length(CAST(subject AS BLOB)) + length(CAST(sender AS BLOB)) + length(CAST(recipients AS BLOB)) + length(CAST(attachments AS BLOB))) FROM message_text',
          ),
          ftsDataBytes: one('SELECT sum(length(block)) FROM fts_data'),
          ftsDataRows: one('SELECT count(*) FROM fts_data'),
        },
        bodyStates: Object.fromEntries(states.map((s) => [String(s.s), Number(s.n)])),
        indexBytes: indexSizes(r.dbPath as string),
        wal,
      };
    }
    case 'shrink':
      db?.exec('PRAGMA shrink_memory');
      return null;
    case 'merge-all': {
      // Finishes the full-text merges after indexing, in bounded steps.
      let steps = 0;
      for (; steps < 10_000; steps++) {
        const before = fileSize(`${r.dbPath as string}-wal`);
        const work = writer!.mergeStep(MERGE_PAGES);
        wal.merges += 1;
        afterCommit(r.dbPath as string, before, 'merge');
        if (work <= 1) break;
      }
      return { steps, indexBytes: indexSizes(r.dbPath as string) };
    }
    case 'checkpoint':
      db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return { indexBytes: indexSizes(r.dbPath as string) };
    case 'close':
      db?.close();
      db = null;
      writer = null;
      return null;
  }
  throw new Error(`unknown op ${r.op}`);
}

function queryOp(r: Request): unknown {
  switch (r.op) {
    case 'open': {
      const started = performance.now();
      db = openTarget(r.target as DbTarget, true);
      const identity = r.uuid ? checkIdentity(db, r.uuid as string) : null;
      return { ms: performance.now() - started, identity };
    }
    case 'list': {
      const started = performance.now();
      const page = listPage(db!, r.labelId as string, (r.after as never) ?? null);
      return { ms: performance.now() - started, rows: page.rows.length, next: page.next };
    }
    case 'search': {
      const started = performance.now();
      const match = ftsLiteral(r.term as string);
      const page =
        r.mode === 'relevance'
          ? searchByRelevance(db!, match, (r.after as never) ?? null)
          : searchByDate(db!, match, (r.after as never) ?? null);
      return {
        ms: performance.now() - started,
        rows: page.rows.length,
        matching: page.rows.reduce((n, row) => n + row.matching, 0),
        snippets: page.rows.filter((row) => row.snippet).length,
        next: page.next,
      };
    }
    case 'shrink':
      db?.exec('PRAGMA shrink_memory');
      return null;
    case 'close':
      db?.close();
      db = null;
      return null;
  }
  throw new Error(`unknown op ${r.op}`);
}

async function readerOp(r: Request): Promise<unknown> {
  if (r.op !== 'open') throw new Error(`unknown op ${r.op}`);
  const started = performance.now();
  const parsed = await simpleParser(streamContained(r.ref as FileRef), {
    skipImageLinks: true,
    skipTextLinks: true,
    skipTextToHtml: true,
  });
  return {
    ms: performance.now() - started,
    htmlBytes: typeof parsed.html === 'string' ? parsed.html.length : 0,
    textBytes: parsed.text?.length ?? 0,
    attachments: parsed.attachments.length,
  };
}

async function handle(r: Request): Promise<unknown> {
  switch (role) {
    case 'index':
      return indexOp(r);
    case 'writer':
      return writerOp(r);
    case 'query':
      return queryOp(r);
    case 'reader':
      return readerOp(r);
  }
}

parentPort?.on('message', (r: Request) => {
  void (async () => {
    try {
      const data = await handle(r);
      parentPort?.postMessage({ id: r.id, ok: true, data, heap: heap(), heapPeak });
    } catch (err) {
      parentPort?.postMessage({ id: r.id, ok: false, error: codeOf(err), heap: heap(), heapPeak });
    }
  })();
});
