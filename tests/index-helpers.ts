// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers for the index tests: synthetic message rows, an in-memory writer,
// the partition and aggregates computed from scratch, and threads that run the
// index's operations in this process.

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, writeSync } from 'node:fs';
import { createSchema } from '../src/core/index/schema';
import { asNumber, openDb, type Db } from '../src/core/index/sql';
import {
  IndexWriter,
  type ApplyItem,
  type PairFiles,
  type Phase1Item,
  type Phase1Stats,
} from '../src/core/index/writer';
import { conversationKeys, type MessageRow } from '../src/core/index/metadata';
import { codeOf, threadHandler } from '../src/core/index/ops';
import { TIMEOUT, ThreadError, type IndexThread, type ThreadRole } from '../src/core/index/pool';
import type { Stamp } from '../src/shared/sources';

export const STAMP: Stamp = { sourceKey: '00000000-0000-4000-8000-000000000001', generation: 3 };

/**
 * A message whose conversation keys are `keys`: the first is its Message-ID,
 * the rest its References.
 */
export function message(id: string, keys: string[], extra: Partial<MessageRow> = {}): MessageRow {
  return {
    protonId: id,
    time: 1000,
    subject: id,
    sender: { name: id, address: `${id}@example.com` },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    flags: 0,
    unread: 0,
    replied: 0,
    repliedAll: 0,
    forwarded: 0,
    size: 1,
    numAttachments: 0,
    mimeType: 'text/plain',
    messageId: keys[0] ?? null,
    inReplyTo: [],
    references: keys.slice(1),
    dmarc: null,
    labelIds: ['5'],
    capped: 0,
    ...extra,
  };
}

/** A message's conversation keys, as the writer takes them. */
export const keysOf = (row: MessageRow): string[] => conversationKeys(row);

/** A pair's two files; `version` stands in for a new size and modification time. */
export function filesOf(id: string, version = 1): PairFiles {
  const stat = (rel: string) => ({
    rel,
    size: version,
    mtimeNs: BigInt(version),
    dev: 1n,
    ino: BigInt(id.length),
  });
  return { protonId: id, meta: stat(`${id}.metadata.json`), eml: stat(`${id}.eml`) };
}

/** Reconcile's change for a pair the index doesn't have yet. */
export function newPair(id: string, files: PairFiles = filesOf(id)): ApplyItem {
  return {
    change: {
      protonId: id,
      fresh: true,
      gone: false,
      meta: files.meta ? 'parse' : 'keep',
      eml: 'keep',
      refresh: false,
    },
    files,
  };
}

/** Registers new pairs and returns the rev each one's metadata is to be read for. */
export function register(writer: IndexWriter, ids: string[]): Map<string, number> {
  return new Map(
    writer.applyChanges(
      STAMP,
      ids.map((id) => newPair(id)),
    ).revs,
  );
}

export function item(
  row: MessageRow,
  rev: number,
  files: PairFiles = filesOf(row.protonId),
): Phase1Item {
  return { pair: files, expectedRev: rev, row, error: null };
}

export function fresh(): { db: Db; writer: IndexWriter } {
  const db = openDb(':memory:');
  createSchema(db, STAMP.generation);
  return { db, writer: new IndexWriter(db, STAMP) };
}

/** The partition as sorted member lists, independent of conversation IDs. */
export function partition(db: Db): string[][] {
  const groups = new Map<number, string[]>();
  for (const r of db.stmt('SELECT proton_id, thread_id FROM messages').all()) {
    const t = asNumber(r.thread_id);
    groups.set(t, [...(groups.get(t) ?? []), String(r.proton_id)]);
  }
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

/** Grouping from scratch: union-find over shared keys. */
export function expected(rows: MessageRow[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const owner = new Map<string, string>();
  for (const r of rows) parent.set(r.protonId, r.protonId);
  for (const r of rows)
    for (const k of keysOf(r)) {
      const o = owner.get(k);
      if (o === undefined) owner.set(k, r.protonId);
      else parent.set(find(r.protonId), find(o));
    }
  const groups = new Map<string, string[]>();
  for (const r of rows)
    groups.set(find(r.protonId), [...(groups.get(find(r.protonId)) ?? []), r.protonId]);
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

/**
 * Checks the stored conversations against the current set of messages: the
 * partition, each conversation's aggregates, its per-label rows and its keys,
 * all recomputed from the members.
 */
export function checkAgainstScratch(db: Db, rows: MessageRow[]): void {
  const got = partition(db);
  const want = expected(rows);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`partition differs: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  }
  const byId = new Map(rows.map((r) => [r.protonId, r]));
  const members = new Map<number, MessageRow[]>();
  for (const r of db.stmt('SELECT proton_id, thread_id FROM messages').all()) {
    const t = asNumber(r.thread_id);
    members.set(t, [...(members.get(t) ?? []), byId.get(String(r.proton_id))!]);
  }
  const threads = db.stmt('SELECT * FROM threads').all();
  if (threads.length !== members.size) throw new Error('conversation rows differ from groups');
  for (const t of threads) {
    const list = members.get(asNumber(t.thread_id));
    if (!list) throw new Error('conversation without members');
    const want = {
      msg_count: list.length,
      unread_count: list.reduce((n, m) => n + m.unread, 0),
      attach_count: list.filter((m) => m.numAttachments > 0).length,
      first_time: Math.min(...list.map((m) => m.time)),
      last_time: Math.max(...list.map((m) => m.time)),
    };
    const have = {
      msg_count: asNumber(t.msg_count),
      unread_count: asNumber(t.unread_count),
      attach_count: asNumber(t.attach_count),
      first_time: asNumber(t.first_time),
      last_time: asNumber(t.last_time),
    };
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      throw new Error(`aggregates differ: ${JSON.stringify(have)} vs ${JSON.stringify(want)}`);
    }
  }
  const labelRows = new Map<string, [number, number, number]>();
  for (const [threadId, list] of members) {
    for (const m of list) {
      for (const label of m.labelIds) {
        const key = `${label}|${threadId}`;
        const [n, u, last] = labelRows.get(key) ?? [0, 0, -Infinity];
        labelRows.set(key, [n + 1, u + m.unread, Math.max(last, m.time)]);
      }
    }
  }
  const stored = new Map(
    db
      .stmt('SELECT label_id, thread_id, msg_count, unread_count, last_time FROM thread_labels')
      .all()
      .map((r) => [
        `${String(r.label_id)}|${asNumber(r.thread_id)}`,
        [asNumber(r.msg_count), asNumber(r.unread_count), asNumber(r.last_time)],
      ]),
  );
  if (JSON.stringify([...stored].sort()) !== JSON.stringify([...labelRows].sort())) {
    throw new Error('per-label rows differ');
  }
  for (const r of db.stmt('SELECT key, thread_id FROM thread_keys').all()) {
    const owner = rows.find((m) => keysOf(m).includes(String(r.key)));
    const t = db.stmt('SELECT thread_id FROM messages WHERE proton_id = ?').get(owner!.protonId);
    if (asNumber(t?.thread_id) !== asNumber(r.thread_id)) throw new Error('key points elsewhere');
  }
  // Every key of every member is stored, for its member's conversation, and no other.
  const wantKeys = new Map<string, number>();
  for (const [threadId, list] of members) {
    for (const m of list) for (const key of keysOf(m)) wantKeys.set(key, threadId);
  }
  const haveKeys = new Map(
    db
      .stmt('SELECT key, thread_id FROM thread_keys')
      .all()
      .map((r) => [String(r.key), asNumber(r.thread_id)] as const),
  );
  if (JSON.stringify([...haveKeys].sort()) !== JSON.stringify([...wantKeys].sort())) {
    throw new Error('conversation keys differ');
  }
}

export function shuffled<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Registers and writes new rows in batches; `after` runs after every batch
 * with the rows written so far.
 */
export function ingest(
  writer: IndexWriter,
  rows: MessageRow[],
  batch: number,
  after?: (written: MessageRow[]) => void,
): Phase1Stats[] {
  const stats: Phase1Stats[] = [];
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    const revs = register(
      writer,
      part.map((r) => r.protonId),
    );
    stats.push(
      writer.phase1Batch(
        STAMP,
        part.map((r) => item(r, revs.get(r.protonId)!)),
      ),
    );
    after?.(rows.slice(0, i + batch));
  }
  return stats;
}

/**
 * A thread that runs the index's operations in this process. `hang` makes a
 * call never answer, so its time limit ends it; the thread is then replaced,
 * as a worker thread would be. A call past its limit says, as `exited`, when
 * the operation it started has ended: nothing of it runs after that.
 */
export class InlineThread implements IndexThread {
  respawns = 0;
  onRespawn: (() => void) | null = null;
  readonly calls: string[] = [];
  private handle: (op: string, args: unknown) => unknown;

  constructor(
    readonly role: ThreadRole,
    private readonly hang: (op: string, args: unknown) => boolean = () => false,
  ) {
    this.handle = threadHandler(role);
  }

  call<T>(op: string, args: unknown = {}, timeoutMs = 0): Promise<T> {
    this.calls.push(op);
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      let ended: () => void = () => {};
      const exited = new Promise<void>((done) => (ended = done));
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          this.respawns += 1;
          this.handle = threadHandler(this.role);
          this.onRespawn?.();
          reject(new ThreadError(TIMEOUT, exited));
        }, timeoutMs);
      }
      if (this.hang(op, args)) {
        ended();
        return;
      }
      const handle = this.handle;
      setImmediate(() => {
        // An operation may answer with a promise, as in the worker thread.
        void (async () => {
          let value: unknown;
          try {
            value = await handle(op, args);
          } catch (err) {
            if (timer) clearTimeout(timer);
            if (!timedOut) reject(new ThreadError(codeOf(err)));
            return;
          } finally {
            ended();
          }
          if (timer) clearTimeout(timer);
          if (!timedOut) resolve(value as T);
        })();
      });
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Damages the b-tree page header of a table's root page, an allocated page,
 * so SQLite's quick check reports the file. The WAL is checkpointed into the
 * file first, so no newer copy of the page shadows the damage. Nothing may
 * have the database open.
 */
export function damageTablePage(dbPath: string, table: string): number {
  const db = openDb(dbPath);
  let page: number;
  let pageSize: number;
  try {
    db.stmt('PRAGMA wal_checkpoint(TRUNCATE)').get();
    page = asNumber(
      db.stmt('SELECT rootpage FROM sqlite_schema WHERE name = ?').get(table)?.rootpage,
    );
    pageSize = asNumber(db.stmt('PRAGMA page_size').get()?.page_size);
  } finally {
    db.close();
  }
  if (page < 2) throw new Error('no such table page');
  // Byte 0 of a b-tree page header is its type; 0 is no valid type.
  const fd = openSync(dbPath, 'r+');
  try {
    writeSync(fd, Buffer.from([0x00, 0xff, 0xff, 0xff]), 0, 4, (page - 1) * pageSize);
  } finally {
    closeSync(fd);
  }
  return page;
}

// Opens the database at argv[1] and takes an exclusive lock on it, which
// SQLite keeps in EXCLUSIVE locking mode: every other connection gets
// SQLITE_BUSY. With argv[3] '1' it reads the database first as any connection
// would, so its -wal and -shm files are there, as while the app runs. The
// write rewrites the schema version with its own value. After argv[2] ms it
// closes the database, which releases the lock.
const LOCK_HOLDER = `
const { DatabaseSync } = require('node:sqlite');
const [path, holdMs, shm] = process.argv.slice(1);
const db = new DatabaseSync(path);
if (shm === '1') db.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
db.exec('PRAGMA locking_mode = EXCLUSIVE');
const version = db.prepare('PRAGMA user_version').get().user_version;
db.exec('PRAGMA user_version = ' + Number(version));
process.stdout.write('held\\n');
setTimeout(() => {
  db.close();
  process.stdout.write('released\\n');
  process.exit(0);
}, Number(holdMs));
`;

/**
 * A child process holding an exclusive lock on the database at `path` for
 * `holdMs`, then releasing it. Resolves once the lock is held. A child is
 * used because a connection waiting on a lock blocks its own thread.
 */
export async function holdIndexLock(
  path: string,
  holdMs: number,
  options: { sidecars?: boolean } = {},
): Promise<{ child: ChildProcess; released: Promise<void> }> {
  const child = spawn(
    process.execPath,
    ['-e', LOCK_HOLDER, path, String(holdMs), options.sidecars === false ? '0' : '1'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  let heard: () => void = () => {};
  child.stdout!.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    heard();
  });
  const waitFor = (line: string) =>
    new Promise<void>((resolve, reject) => {
      heard = () => {
        if (out.includes(`${line}\n`)) resolve();
      };
      child.once('exit', () =>
        out.includes(`${line}\n`) ? resolve() : reject(new Error('holder exited')),
      );
      heard();
    });
  await waitFor('held');
  const released = Promise.all([waitFor('released'), once(child, 'exit')]).then(() => undefined);
  return { child, released };
}
