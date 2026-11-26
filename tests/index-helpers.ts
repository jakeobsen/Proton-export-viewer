// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers for the index tests: synthetic message rows, an in-memory writer,
// the partition and aggregates computed from scratch, and threads that run the
// index's operations in this process.

import { createSchema } from '../src/core/index/schema';
import { asNumber, openDb, type Db } from '../src/core/index/sql';
import { IndexWriter, type Phase1Item, type Phase1Stats } from '../src/core/index/writer';
import type { MessageRow } from '../src/core/index/metadata';
import { codeOf, threadHandler } from '../src/core/index/ops';
import { TIMEOUT, ThreadError, type IndexThread, type ThreadRole } from '../src/core/index/pool';
import type { Stamp } from '../src/shared/sources';

export const STAMP: Stamp = { sourceKey: '00000000-0000-4000-8000-000000000001', generation: 3 };

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
    inReplyTo: null,
    references: [],
    dmarc: null,
    labelIds: ['5'],
    keys,
    capped: 0,
    ...extra,
  };
}

export function item(row: MessageRow): Phase1Item {
  return {
    pair: {
      protonId: row.protonId,
      meta: { rel: `${row.protonId}.metadata.json`, size: 1, mtimeNs: 0n, dev: 0n, ino: 0n },
      eml: { rel: `${row.protonId}.eml`, size: 1, mtimeNs: 0n, dev: 0n, ino: 0n },
    },
    expectedRev: null,
    row,
    error: null,
  };
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
    for (const k of r.keys) {
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
    const owner = rows.find((m) => m.keys.includes(String(r.key)));
    const t = db.stmt('SELECT thread_id FROM messages WHERE proton_id = ?').get(owner!.protonId);
    if (asNumber(t?.thread_id) !== asNumber(r.thread_id)) throw new Error('key points elsewhere');
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

/** Writes rows in batches; `after` runs after every batch with the rows written so far. */
export function ingest(
  writer: IndexWriter,
  rows: MessageRow[],
  batch: number,
  after?: (written: MessageRow[]) => void,
): Phase1Stats[] {
  const stats: Phase1Stats[] = [];
  for (let i = 0; i < rows.length; i += batch) {
    stats.push(writer.phase1Batch(STAMP, rows.slice(i, i + batch).map(item)));
    after?.(rows.slice(0, i + batch));
  }
  return stats;
}

/**
 * A thread that runs the index's operations in this process. `hang` makes a
 * call never answer, so its time limit ends it; the thread is then replaced,
 * as a worker thread would be.
 */
export class InlineThread implements IndexThread {
  respawns = 0;
  onRespawn: (() => void) | null = null;
  readonly calls: string[] = [];
  private handle: (op: string, args: unknown) => unknown;

  constructor(
    private readonly role: ThreadRole,
    private readonly hang: (op: string, args: unknown) => boolean = () => false,
  ) {
    this.handle = threadHandler(role);
  }

  call<T>(op: string, args: unknown = {}, timeoutMs = 0): Promise<T> {
    this.calls.push(op);
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.respawns += 1;
          this.handle = threadHandler(this.role);
          this.onRespawn?.();
          reject(new ThreadError(TIMEOUT));
        }, timeoutMs);
      }
      if (this.hang(op, args)) return;
      setImmediate(() => {
        if (timer) clearTimeout(timer);
        try {
          resolve(this.handle(op, args) as T);
        } catch (err) {
          reject(new ThreadError(codeOf(err)));
        }
      });
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
