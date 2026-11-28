// SPDX-License-Identifier: AGPL-3.0-or-later
// The index service over generated exports, with its threads run in this
// process: phase 1, reopening, resuming, time limits, caps, stale work, idle
// release and the connection registry.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRun, type RunScan } from '../../src/core/containment';
import { parseMetadata, type MessageRow } from '../../src/core/index/metadata';
import { QueryState, WriterState } from '../../src/core/index/ops';
import { IndexService, type IndexOptions } from '../../src/core/index/service';
import { MAX_ATTACHMENTS } from '../../src/core/index/body';
import { BODY_STATE, CAPPED, SCHEMA_VERSION } from '../../src/core/index/schema';
import { validRanges } from '../../src/core/search/ranges';
import { openDb } from '../../src/core/index/sql';
import type { IndexThread, ThreadRole } from '../../src/core/index/pool';
import type { IndexTotals, ListPage, SearchPage, Sidebar } from '../../src/shared/index-types';
import type { Logger } from '../../src/shared/log/writer';
import { sanitizeEvent } from '../../src/shared/log/schema';
import { digest } from '../../tools/gen-export/tree.mjs';
import { writeExport } from '../exports';
import { InlineThread, STAMP, expected, item, message, newPair } from '../index-helpers';
import { testDir } from '../paths';

interface Logged {
  level: string;
  code: string;
  data: Record<string, unknown>;
}

interface Harness {
  service: IndexService;
  threads: InlineThread[];
  logs: Logged[];
  setCurrent: (v: boolean) => void;
}

function harness(
  root: string,
  indexDir: string,
  options: IndexOptions = {},
  hang: (role: ThreadRole, op: string, args: unknown) => boolean = () => false,
  wrap: (role: ThreadRole, thread: IndexThread) => IndexThread = (_, thread) => thread,
): Harness {
  const threads: InlineThread[] = [];
  const logs: Logged[] = [];
  let current = true;
  const push =
    (level: string) =>
    (code: string, data: Record<string, unknown> = {}) => {
      // Every event must pass the redaction schema whole.
      const event = sanitizeEvent({ level: level as 'info', proc: 'core', code, data });
      expect(event, code).not.toBeNull();
      expect(event!.data.dropped, `${code} ${JSON.stringify(data)}`).toBeUndefined();
      logs.push({ level, code, data });
    };
  const log: Logger = {
    log: (level, code, data) => push(level)(code, data),
    error: push('error'),
    warn: push('warn'),
    info: push('info'),
  };
  const service = new IndexService({
    indexDir,
    stamp: STAMP,
    root,
    log,
    thread: (role) => {
      const t = new InlineThread(role, (op, args) => hang(role, op, args));
      threads.push(t);
      return wrap(role, t);
    },
    isCurrent: () => current,
    options,
  });
  return { service, threads, logs, setCurrent: (v) => (current = v) };
}

function exportAt(name: string, messages = 60, seed = 7) {
  const dir = testDir(name);
  const written = writeExport(join(dir, 'export'), { seed, messages });
  return { dir, run: realpathSync(written.run), indexDir: join(dir, 'userdata', 'index') };
}

/** The partition the metadata files give, computed from scratch. */
function partitionOfFiles(run: string): string[][] {
  const rows: MessageRow[] = [];
  for (const name of readdirSync(run)) {
    if (!name.endsWith('.metadata.json')) continue;
    const id = name.slice(0, -'.metadata.json'.length);
    rows.push(parseMetadata(id, readFileSync(join(run, name), 'utf8')));
  }
  return expected(rows);
}

function dbPartition(dbPath: string): string[][] {
  const db = openDb(dbPath, true);
  try {
    const groups = new Map<number, string[]>();
    for (const r of db.stmt('SELECT proton_id, thread_id FROM messages').all()) {
      const t = Number(r.thread_id);
      groups.set(t, [...(groups.get(t) ?? []), String(r.proton_id)]);
    }
    return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
  } finally {
    db.close();
  }
}

function dbRows(dbPath: string, sql: string): Array<Record<string, unknown>> {
  const db = openDb(dbPath, true);
  try {
    return db.stmt(sql).all();
  } finally {
    db.close();
  }
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe('phase 1', () => {
  it('indexes every metadata file with conversations, labels and safe file modes', async () => {
    const { run, indexDir } = exportAt('phase1');
    const scan = scanRun(run);
    const h = harness(run, indexDir);
    const opened = await h.service.open(null);
    expect(opened).toMatchObject({ created: true, replaced: false });
    expect(
      h.service.connections
        .list()
        .map((c) => c.role)
        .sort(),
    ).toEqual(['query', 'writer']);
    await h.service.startIndexing(scan);
    expect(h.service.progress).toMatchObject({
      phase: 'done',
      loaded: scan.metadata.size,
      total: scan.metadata.size,
      failed: 0,
      timeouts: 0,
    });
    const totals = (await h.service.ask({ op: 'totals' })) as IndexTotals;
    expect(totals.messages).toBe(scan.metadata.size);
    expect(dbPartition(h.service.dbPath)).toEqual(partitionOfFiles(run));
    expect(totals.conversations).toBe(partitionOfFiles(run).length);

    const sidebar = (await h.service.ask({ op: 'sidebar' })) as Sidebar;
    expect(sidebar.folders.some((f) => f.kind === 'folder')).toBe(true);
    expect(sidebar.folders.find((f) => f.id === '5')?.conversations).toBe(totals.conversations);
    const page = (await h.service.ask({ op: 'page', labelId: '5', after: null })) as ListPage;
    expect(page.rows).toHaveLength(totals.conversations);

    // The identity is in the database; the files are private.
    const meta = dbRows(h.service.dbPath, "SELECT value FROM source_meta WHERE key = 'db_uuid'");
    expect(meta[0]?.value).toBe(opened.dbUuid);
    expect(mode(indexDir)).toBe(0o700);
    for (const name of readdirSync(indexDir)) {
      expect(name.startsWith(STAMP.sourceKey)).toBe(true);
      expect(mode(join(indexDir, name)), name).toBe(0o600);
    }
    expect(readdirSync(indexDir)).toContain(`${STAMP.sourceKey}.sqlite-wal`);
    expect(h.logs.map((l) => l.code)).toEqual([
      'index.created',
      'index.phase1_done',
      'index.phase2_done',
    ]);
    await h.service.close();
    expect(h.service.connections.size).toBe(0);
  });

  it('reopens the same index, resumes, and replaces one that is not this source', async () => {
    const { run, indexDir } = exportAt('reopen');
    const scan = scanRun(run);
    const partial: RunScan = {
      ...scan,
      metadata: new Map([...scan.metadata].slice(0, 20)),
      eml: new Map([...scan.eml].slice(0, 20)),
    };
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(partial);
    expect(first.service.progress).toMatchObject({ loaded: 20, total: 20 });
    await first.service.close();

    const second = harness(run, indexDir);
    expect(await second.service.open(opened.dbUuid)).toEqual({
      dbUuid: opened.dbUuid,
      created: false,
      replaced: false,
    });
    await second.service.startIndexing(scan);
    expect(second.service.progress).toMatchObject({ phase: 'done', loaded: 60, total: 60 });
    const revs = dbRows(second.service.dbPath, 'SELECT rev FROM pairs').map((r) => Number(r.rev));
    expect(revs).toHaveLength(60);
    expect(new Set(revs).size).toBe(60);
    expect(dbPartition(second.service.dbPath)).toEqual(partitionOfFiles(run));
    await second.service.close();

    // Another identity, or none, means the file there isn't this source's index.
    for (const expectedUuid of ['00000000-0000-4000-8000-00000000abcd', null]) {
      const other = harness(run, indexDir);
      const again = await other.service.open(expectedUuid);
      expect(again).toMatchObject({ created: true, replaced: true });
      expect(again.dbUuid).not.toBe(opened.dbUuid);
      expect(other.logs.map((l) => [l.code, l.data.reason])).toEqual([
        ['index.damaged', 'identity'],
        ['index.created', undefined],
      ]);
      expect(other.service.progress.condition).toBe('rebuilding');
      const n = dbRows(other.service.dbPath, 'SELECT count(*) AS n FROM pairs')[0]?.n;
      expect(Number(n)).toBe(0);
      await other.service.close();
    }
  });

  it('ends a job past its limit, retries its files alone, and records the one that breached', async () => {
    const { run, indexDir } = exportAt('timeout', 40);
    const scan = scanRun(run);
    const slow = [...scan.metadata.keys()][7]!;
    const h = harness(run, indexDir, { jobMs: 150, metaJob: 10 }, (role, op, args) => {
      if (role !== 'parse' || op !== 'meta') return false;
      return (args as { items: Array<{ protonId: string }> }).items.some(
        (i) => i.protonId === slow,
      );
    });
    await h.service.open(null);
    await h.service.startIndexing(scan);
    expect(h.service.progress).toMatchObject({
      phase: 'done',
      loaded: 40,
      failed: 1,
      timeouts: 2,
    });
    const respawns = h.threads.filter((t) => t.calls.includes('meta')).map((t) => t.respawns);
    expect(respawns.reduce((a, b) => a + b, 0)).toBe(2);
    const [pair] = dbRows(
      h.service.dbPath,
      `SELECT file_id, meta_state, error_code FROM pairs WHERE proton_id = '${slow}'`,
    );
    expect(pair).toMatchObject({ meta_state: 3, error_code: 'META_TIMEOUT' });
    const timeouts = h.logs.filter((l) => l.code === 'index.timeout');
    expect(timeouts).toEqual([
      { level: 'info', code: 'index.timeout', data: { fileId: pair!.file_id, reason: 'timeout' } },
    ]);
    const messages = dbRows(h.service.dbPath, 'SELECT count(*) AS n FROM messages')[0]?.n;
    expect(Number(messages)).toBe(39);
    await h.service.close();
  });

  it('keeps the first entries of an over-long list, flags the message and logs the code', async () => {
    const { run, indexDir } = exportAt('caps', 5);
    const name = readdirSync(run).find((n) => n.endsWith('.metadata.json'))!;
    const id = name.slice(0, -'.metadata.json'.length);
    const doc = JSON.parse(readFileSync(join(run, name), 'utf8')) as {
      Payload: Record<string, unknown>;
    };
    const addrs = (tag: string) =>
      Array.from({ length: 4000 }, (_, i) => ({ Name: '', Address: `${tag}${i}@example.com` }));
    doc.Payload.LabelIDs = Array.from({ length: 4000 }, (_, i) => `x${i}`);
    doc.Payload.ToList = addrs('t');
    doc.Payload.CCList = addrs('c');
    doc.Payload.BCCList = addrs('b');
    doc.Payload.ReplyTos = addrs('r');
    writeFileSync(join(run, name), JSON.stringify(doc));
    const scan = scanRun(run);
    const h = harness(run, indexDir);
    await h.service.open(null);
    await h.service.startIndexing(scan);
    expect(h.service.progress).toMatchObject({ phase: 'done', capped: 1 });
    const [row] = dbRows(
      h.service.dbPath,
      `SELECT m.rowid, m.capped, m.to_json, m.cc_json, m.bcc_json, m.reply_to_json, p.file_id
       FROM messages m JOIN pairs p ON p.proton_id = m.proton_id WHERE m.proton_id = '${id}'`,
    );
    // labels, to, cc, bcc and reply-to.
    expect(row!.capped).toBe(1 | 4 | 8 | 16 | 32);
    for (const col of ['to_json', 'cc_json', 'bcc_json', 'reply_to_json']) {
      expect((JSON.parse(String(row![col])) as unknown[]).length).toBe(1000);
    }
    const labels = dbRows(
      h.service.dbPath,
      `SELECT label_id FROM message_labels WHERE message_rowid = ${Number(row!.rowid)}`,
    );
    expect(labels).toHaveLength(200);
    expect(labels.map((l) => l.label_id)).toContain('x0');
    expect(labels.map((l) => l.label_id)).not.toContain('x200');
    const capped = h.logs.filter((l) => l.code === 'index.capped');
    expect(capped.map((l) => l.data.list)).toEqual(['labels', 'to', 'cc', 'bcc', 'replyTo']);
    expect(new Set(capped.map((l) => l.data.fileId))).toEqual(new Set([row!.file_id]));
    await h.service.close();
  });

  it('records a pair with a file missing, and refuses a file swapped after the scan', async () => {
    const { run, indexDir } = exportAt('broken', 6);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.eml'))
      .map((n) => n.slice(0, -'.eml'.length))
      .sort();
    rmSync(join(run, `${ids[0]}.metadata.json`));
    rmSync(join(run, `${ids[1]}.eml`));
    const scan = scanRun(run);
    // After the scan, a metadata file becomes a FIFO; reading it must not block.
    rmSync(join(run, `${ids[2]}.metadata.json`));
    const made = spawnSync('/usr/bin/mkfifo', ['-m', '0644', join(run, `${ids[2]}.metadata.json`)]);
    expect(made.status).toBe(0);
    const h = harness(run, indexDir, { jobMs: 2000 });
    await h.service.open(null);
    await h.service.startIndexing(scan);
    expect(h.service.progress).toMatchObject({ phase: 'done', total: 5, loaded: 5, failed: 1 });
    const pairs = Object.fromEntries(
      dbRows(
        h.service.dbPath,
        'SELECT proton_id, meta_state, body_state, error_code FROM pairs',
      ).map((r) => [String(r.proton_id), [r.meta_state, r.body_state, r.error_code]]),
    );
    expect(pairs[ids[0]!]).toEqual([4, 0, 'PAIR_META_MISSING']);
    expect(pairs[ids[1]!]).toEqual([1, 4, null]);
    expect(pairs[ids[2]!]).toEqual([3, 0, 'FILE_FIFO']);
    expect(Object.keys(pairs)).toHaveLength(6);
    expect(h.logs.find((l) => l.code === 'index.meta_failed')?.data.reason).toBe('fifo');
    await h.service.close();
  });

  it('never groups through the internal References entry of the message files', async () => {
    const dir = testDir('internalid');
    const run = join(dir, 'run');
    mkdirSync(run);
    const meta = (id: string) =>
      JSON.stringify({
        Version: 1,
        Payload: {
          ID: id,
          LabelIDs: ['5'],
          Time: 1,
          Headers: `Message-ID: <${id}@example.com>\r\n`,
        },
      });
    // Both message files name the same internal ID; their metadata shares nothing.
    for (const id of ['aaaa', 'bbbb']) {
      writeFileSync(join(run, `${id}.metadata.json`), meta(id));
      writeFileSync(
        join(run, `${id}.eml`),
        `Message-ID: <${id}@example.com>\r\nReferences: <aaaa@protonmail.internalid>\r\n\r\nx`,
      );
    }
    const h = harness(realpathSync(run), join(dir, 'index'));
    await h.service.open(null);
    await h.service.startIndexing(scanRun(realpathSync(run)));
    expect(dbPartition(h.service.dbPath)).toEqual([['aaaa'], ['bbbb']]);
    await h.service.close();
  });

  it('keeps the 4 MiB budget for files that grew after the scan', async () => {
    const { run, indexDir } = exportAt('grown', 6);
    const scan = scanRun(run);
    const names = [...scan.metadata.keys()].slice(0, 3);
    const big = (id: string) => {
      const doc = JSON.parse(readFileSync(join(run, `${id}.metadata.json`), 'utf8')) as {
        Payload: Record<string, unknown>;
      };
      doc.Payload.Subject = 'x'.repeat(3 * 1024 * 1024);
      return JSON.stringify(doc);
    };
    // One grows in place; two are replaced by a new, larger file.
    writeFileSync(join(run, `${names[0]}.metadata.json`), big(names[0]!));
    for (const id of names.slice(1)) {
      writeFileSync(join(run, `${id}.tmp`), big(id));
      renameSync(join(run, `${id}.tmp`), join(run, `${id}.metadata.json`));
    }
    const h = harness(run, indexDir);
    await h.service.open(null);
    await h.service.startIndexing(scan);
    expect(h.service.progress).toMatchObject({ phase: 'done', loaded: 6, failed: 0 });
    const writer = h.threads.find((t) => t.role === 'writer')!;
    // Each 3 MiB file needs a transaction of its own; the scan saw them all small.
    expect(writer.calls.filter((c) => c === 'phase1').length).toBeGreaterThanOrEqual(3);
    const subjects = dbRows(
      h.service.dbPath,
      `SELECT length(subject) AS n FROM messages WHERE proton_id IN ('${names.join("','")}')`,
    );
    expect(subjects.map((r) => Number(r.n))).toEqual([3145728, 3145728, 3145728]);
    await h.service.close();
  });

  it('stops writing once the generation has moved on', async () => {
    const { run, indexDir } = exportAt('stale', 10);
    const h = harness(run, indexDir);
    await h.service.open(null);
    h.setCurrent(false);
    await h.service.startIndexing(scanRun(run));
    expect(h.service.progress.phase).toBe('failed');
    const n = dbRows(h.service.dbPath, 'SELECT count(*) AS n FROM pairs')[0]?.n;
    expect(Number(n)).toBe(0);
    expect(h.logs.map((l) => l.code)).toContain('writer.stale_dropped');
    expect(h.logs.find((l) => l.code === 'index.phase1_failed')?.data.reason).toBe(
      'stale_generation',
    );
    await h.service.close();
  });

  it('writes batches in name order with readByName, even when a later batch is read first', async () => {
    /**
     * Runs phase 1 with the first batch's read held until the second batch's
     * read has ended. Returns the IDs of each read and each write, in order.
     */
    const runHeld = async (readByName: boolean) => {
      const { run, indexDir } = exportAt(`order-${readByName}`, 30, 11);
      const reads: string[][] = [];
      const writes: string[][] = [];
      let secondRead = (): void => undefined;
      const secondDone = new Promise<void>((resolve) => (secondRead = resolve));
      const ids = (args: unknown, key: 'protonId' | 'pair') =>
        (args as { items: Array<Record<string, unknown>> }).items.map((i) =>
          key === 'pair' ? String((i.pair as { protonId: string }).protonId) : String(i.protonId),
        );
      const wrap = (role: ThreadRole, inner: IndexThread): IndexThread => ({
        get respawns() {
          return inner.respawns;
        },
        get onRespawn() {
          return inner.onRespawn;
        },
        set onRespawn(f) {
          inner.onRespawn = f;
        },
        stop: () => inner.stop(),
        call: <T>(op: string, args?: unknown, timeoutMs?: number): Promise<T> => {
          if (role === 'writer' && op === 'phase1') writes.push(ids(args, 'pair'));
          if (role !== 'parse' || op !== 'meta') return inner.call<T>(op, args, timeoutMs);
          reads.push(ids(args, 'protonId'));
          const n = reads.length;
          if (n === 1) return secondDone.then(() => inner.call<T>(op, args, timeoutMs));
          const read = inner.call<T>(op, args, timeoutMs);
          if (n === 2) void read.finally(secondRead);
          return read;
        },
      });
      const scan = scanRun(run);
      const h = harness(run, indexDir, { batchPairs: 10, readByName }, undefined, wrap);
      await h.service.open(null);
      await h.service.startIndexing(scan);
      expect(h.service.progress).toMatchObject({ phase: 'done', loaded: 30, total: 30, failed: 0 });
      expect(dbPartition(h.service.dbPath)).toEqual(partitionOfFiles(run));
      await h.service.close();
      return { reads, writes };
    };

    // Without it, the held first batch is written after the second.
    const free = await runHeld(false);
    expect(free.reads).toHaveLength(3);
    expect(free.writes[0]).toEqual(free.reads[1]);
    expect(free.writes).not.toEqual(free.reads);

    // With it, every batch is written in the order it was made: name order.
    const ordered = await runHeld(true);
    expect(ordered.reads).toHaveLength(3);
    expect(ordered.writes).toEqual(ordered.reads);
    const all = ordered.writes.flat();
    expect(all).toEqual([...all].sort());
  });
});

describe('reconcile on reopen', () => {
  it('brings the index in line with the folder, reads only what changed, and writes nothing there', async () => {
    const { dir, run, indexDir } = exportAt('reconcile', 30);
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scanRun(run));
    await first.service.close();
    const revSeq = (path: string) =>
      Number(dbRows(path, "SELECT value FROM source_meta WHERE key = 'rev_seq'")[0]?.value);
    const highest = revSeq(first.service.dbPath);

    const metaPath = (id: string) => join(run, `${id}.metadata.json`);
    const emlPath = (id: string) => join(run, `${id}.eml`);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.metadata.json'))
      .map((n) => n.slice(0, -'.metadata.json'.length))
      .sort();
    const [metaGone, bothGone, changed, emlChanged, emlGone, linkTarget, template] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    rmSync(metaPath(metaGone));
    rmSync(metaPath(bothGone));
    rmSync(emlPath(bothGone));
    // New metadata for one message: another subject, and a reply to another conversation.
    const target = parseMetadata(linkTarget, readFileSync(metaPath(linkTarget), 'utf8'));
    const doc = JSON.parse(readFileSync(metaPath(changed), 'utf8')) as {
      Payload: Record<string, unknown>;
    };
    doc.Payload.Subject = 'Changed subject';
    doc.Payload.Headers = `Message-ID: <changed@example.com>\r\nReferences: <${target.messageId}>\r\n`;
    writeFileSync(metaPath(changed), JSON.stringify(doc));
    writeFileSync(
      emlPath(emlChanged),
      Buffer.concat([readFileSync(emlPath(emlChanged)), Buffer.from('\r\n')]),
    );
    rmSync(emlPath(emlGone));
    // A new pair.
    const added = `${template}Added`;
    const copy = JSON.parse(readFileSync(metaPath(template), 'utf8')) as {
      Payload: Record<string, unknown>;
    };
    copy.Payload.ID = added;
    writeFileSync(metaPath(added), JSON.stringify(copy));
    writeFileSync(emlPath(added), readFileSync(emlPath(template)));
    // labels.json gets one more label.
    const labelsPath = join(run, 'labels.json');
    const labels = JSON.parse(readFileSync(labelsPath, 'utf8')) as { Payload: unknown[] };
    labels.Payload.push({ ID: 'added-label', Name: 'Added', Path: 'Added', Type: 1 });
    writeFileSync(labelsPath, JSON.stringify(labels));
    const exportRoot = join(dir, 'export');
    const folderBefore = digest(exportRoot);

    const second = harness(run, indexDir, { metaJob: 1 });
    await second.service.open(opened.dbUuid);
    await second.service.startIndexing(scanRun(run));
    const files = ids.length - 2 + 1;
    expect(second.service.progress).toMatchObject({
      phase: 'done',
      loaded: files,
      total: files,
      failed: 0,
    });
    expect(dbPartition(second.service.dbPath)).toEqual(partitionOfFiles(run));
    const totals = (await second.service.ask({ op: 'totals' })) as IndexTotals;
    expect(totals).toMatchObject({ messages: files, pairs: ids.length });
    // Only the changed and the new metadata files were read, and labels.json once.
    const parse = second.threads.filter((t) => t.role === 'parse').flatMap((t) => t.calls);
    expect(parse.filter((op) => op === 'meta')).toHaveLength(2);
    expect(parse.filter((op) => op === 'labels')).toHaveLength(1);
    const sidebar = (await second.service.ask({ op: 'sidebar' })) as Sidebar;
    expect(sidebar.folders.find((f) => f.id === 'added-label')?.name).toBe('Added');

    const pairs = new Map(
      dbRows(
        second.service.dbPath,
        'SELECT proton_id, rev, meta_state, body_state, error_code FROM pairs',
      ).map((r) => [String(r.proton_id), r]),
    );
    expect(pairs.has(bothGone)).toBe(false);
    expect(pairs.get(metaGone)).toMatchObject({ meta_state: 4, error_code: 'PAIR_META_MISSING' });
    expect(pairs.get(emlGone)).toMatchObject({ meta_state: 1, body_state: 4 });
    // Phase 2 read the changed message file again.
    expect(pairs.get(emlChanged)).toMatchObject({ meta_state: 1, body_state: 1 });
    expect(pairs.get(added)).toMatchObject({ meta_state: 1, body_state: 1 });
    for (const id of [metaGone, changed, emlChanged, emlGone, added]) {
      expect(Number(pairs.get(id)?.rev), id).toBeGreaterThan(highest);
    }
    expect(Number(pairs.get(template)?.rev)).toBeLessThanOrEqual(highest);
    const subject = dbRows(
      second.service.dbPath,
      `SELECT subject FROM messages WHERE proton_id = '${changed}'`,
    )[0]?.subject;
    expect(subject).toBe('Changed subject');
    expect(
      second.logs.find((l) => l.code === 'index.reconciled')?.data.count,
      'pairs the index had that changed',
    ).toBe(5);
    await second.service.close();
    // The folder is read, never written.
    expect(digest(exportRoot)).toBe(folderBefore);

    // Nothing changed since: nothing is written or read but the plan.
    const third = harness(run, indexDir);
    await third.service.open(opened.dbUuid);
    await third.service.startIndexing(scanRun(run));
    expect(third.service.progress).toMatchObject({
      phase: 'done',
      loaded: files,
      total: files,
      bodyPhase: 'done',
      bodiesTotal: 0,
    });
    const writer = third.threads.find((t) => t.role === 'writer')!;
    // Phase 2 only finds that no message waits for its text.
    expect(writer.calls.filter((op) => op !== 'shrink')).toEqual([
      'open',
      'plan',
      'finish',
      'bodyOrder',
    ]);
    expect(third.threads.filter((t) => t.role === 'parse').flatMap((t) => t.calls)).toEqual([]);
    expect(third.logs.map((l) => l.code)).not.toContain('index.reconciled');
    await third.service.close();
  });
});

describe('an unavailable export', () => {
  it('opens only its own index, read-only, and leaves a rejected one untouched', async () => {
    const { run, indexDir } = exportAt('offline', 10);
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scanRun(run));
    await first.service.close();
    const dbPath = join(indexDir, `${STAMP.sourceKey}.sqlite`);
    const family = () =>
      readdirSync(indexDir)
        .sort()
        .map((name) => [
          name,
          mode(join(indexDir, name)),
          createHash('sha256')
            .update(readFileSync(join(indexDir, name)))
            .digest('hex'),
        ]);
    // A WAL-mode index closed cleanly: no WAL or shared-memory file beside it.
    expect(dbRows(dbPath, 'PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }]);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    const before = family();
    expect(before.map((f) => f[0])).toEqual([`${STAMP.sourceKey}.sqlite`]);

    // Another identity, or none: refused, with the family byte for byte as it was.
    // The index itself never deletes anything; another identity is reported as damage.
    for (const uuid of ['00000000-0000-4000-8000-00000000abcd', null]) {
      const other = harness('', indexDir);
      await expect(other.service.open(uuid, false)).rejects.toMatchObject({
        code: uuid === null ? 'NO_INDEX' : 'INDEX_DAMAGED',
      });
      expect(other.threads.every((t) => t.role === 'query')).toBe(true);
      expect(other.service.connections.size).toBe(0);
      await other.service.close();
      expect(family()).toEqual(before);
    }

    // Its own identity: browsed through the read-only query connection only.
    const browse = harness('', indexDir);
    expect(await browse.service.open(opened.dbUuid, false)).toEqual({
      dbUuid: opened.dbUuid,
      created: false,
      replaced: false,
    });
    // It is checked on its own short-lived connection, read-only too.
    await browse.service.checkEnded();
    expect(browse.threads.map((t) => t.role)).toEqual(['query', 'verify']);
    expect(browse.service.connections.list().map((c) => c.role)).toEqual(['query']);
    expect(browse.service.progress.phase).toBe('unavailable');
    expect(((await browse.service.ask({ op: 'totals' })) as IndexTotals).messages).toBe(10);
    await browse.service.close();
    expect(family()[0]).toEqual(before[0]);

    rmSync(indexDir, { recursive: true });
    const none = harness('', indexDir);
    await expect(none.service.open(opened.dbUuid, false)).rejects.toMatchObject({
      code: 'NO_INDEX',
    });
    expect(existsSync(indexDir)).toBe(false);
    await none.service.close();
  });

  it('reads rows still in the WAL', async () => {
    const { run, indexDir } = exportAt('offline-wal', 8);
    const h = harness(run, indexDir);
    const opened = await h.service.open(null);
    await h.service.startIndexing(scanRun(run));
    // The writer is still open, so the last batches may be in the WAL only.
    const query = new QueryState();
    query.open(h.service.dbPath, opened.dbUuid);
    expect((query.run({ op: 'totals' }) as IndexTotals).messages).toBe(8);
    query.close();
    await h.service.close();
  });
});

describe('the query thread', () => {
  it('reads a page and its anchors from one snapshot while the writer merges', () => {
    const dir = testDir('snapshot');
    const dbPath = join(dir, 'x.sqlite');
    const writer = new WriterState();
    const opened = writer.open({ dbPath, stamp: STAMP, expectedUuid: null, capBytes: null });
    const revs = new Map(
      writer.apply(
        STAMP,
        ['a', 'b', 'z'].map((id) => newPair(id)),
      ).revs,
    );
    writer.phase1(STAMP, [
      item(message('a', ['a'], { time: 1 }), revs.get('a')!),
      item(message('b', ['b'], { time: 2 }), revs.get('b')!),
    ]);
    const query = new QueryState();
    query.open(dbPath, opened.uuid);
    const db = query.db!;
    const prepare = db.stmt.bind(db);
    let merged = false;
    // The writer links the two conversations right after the page's first statement.
    db.stmt = (sql) => {
      const statement = prepare(sql);
      if (!merged && sql.includes('JOIN message_labels ml')) {
        merged = true;
        writer.phase1(STAMP, [item(message('z', ['z', 'a', 'b'], { time: 3 }), revs.get('z')!)]);
      }
      return statement;
    };
    const page = query.run({ op: 'page', labelId: '5', after: null }) as ListPage;
    expect(merged).toBe(true);
    // Still the page from before the merge, each row with its anchor.
    expect(page.rows).toHaveLength(2);
    expect(page.rows.every((r) => r.anchorRowid > 0)).toBe(true);
    // The next query sees the merge.
    const after = query.run({ op: 'page', labelId: '5', after: null }) as ListPage;
    expect(after.rows).toHaveLength(1);
    query.close();
    writer.close();
  });
});

describe('the writer', () => {
  it('closes a database it cannot use before it replaces it', async () => {
    const dir = testDir('writer-candidate');
    const dbPath = join(dir, 'x.sqlite');
    const fds = () => readdirSync('/dev/fd').length;
    const writer = new WriterState();
    const start = fds();
    for (let i = 0; i < 20; i++) {
      writeFileSync(dbPath, 'not a database, just some text that is long enough'.repeat(100));
      const opened = writer.open({
        dbPath,
        stamp: STAMP,
        expectedUuid: '00000000-0000-4000-8000-00000000abcd',
        capBytes: null,
      });
      expect(opened).toMatchObject({ created: true, replaced: true });
      writer.close();
    }
    expect(fds()).toBeLessThanOrEqual(start + 1);
  });
});

describe('when idle', () => {
  it('ends the pool once indexing is done and releases both caches after the idle time', async () => {
    const { run, indexDir } = exportAt('idle', 10);
    const h = harness(run, indexDir, { idleMs: 60_000 });
    await h.service.open(null);
    await h.service.startIndexing(scanRun(run));
    const writer = h.threads.find((t) => t.calls[0] === 'open' && t.calls.includes('phase1'))!;
    const query = h.threads.find((t) => t.calls[0] === 'open' && !t.calls.includes('phase1'))!;
    expect(await h.service.releaseIfIdle(Date.now())).toBe(false);
    expect(await h.service.releaseIfIdle(Date.now() + 60_001)).toBe(true);
    expect(writer.calls.at(-1)).toBe('shrink');
    expect(query.calls.at(-1)).toBe('shrink');
    expect(h.logs.map((l) => l.code)).toContain('index.idle_release');
    // Released once until something runs again.
    expect(await h.service.releaseIfIdle(Date.now() + 120_000)).toBe(false);
    await h.service.ask({ op: 'totals' });
    expect(await h.service.releaseIfIdle(Date.now() + 120_000)).toBe(true);
    await h.service.close();
  });
});

// --- Phase 2 ---------------------------------------------------------------------

/** The message IDs of a run folder, sorted. */
const idsOf = (run: string) =>
  readdirSync(run)
    .filter((n) => n.endsWith('.metadata.json'))
    .map((n) => n.slice(0, -'.metadata.json'.length))
    .sort();

/** A message file with this text and these attachment parts. */
function eml(body: string, attachments: string[] = []): string {
  return [
    'From: <sender@example.com>',
    'Subject: replaced',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    ...attachments.flatMap((name) => [
      '--m',
      `Content-Type: application/pdf; name="${name}"`,
      'Content-Disposition: attachment',
      '',
      'x',
    ]),
    '--m--',
    '',
  ].join('\r\n');
}

let searches = 0;
async function search(service: IndexService, text: string): Promise<SearchPage> {
  searches += 1;
  return (await service.ask({
    op: 'search',
    queryId: searches,
    text,
    sort: 'date',
    after: null,
  })) as SearchPage;
}

/** The message IDs a search finds, by the newest match of each conversation. */
async function found(service: IndexService, text: string): Promise<string[]> {
  const page = await search(service, text);
  const ids = page.rows.map((r) =>
    String(
      dbRows(service.dbPath, `SELECT proton_id FROM messages WHERE rowid = ${r.anchorRowid}`)[0]
        ?.proton_id,
    ),
  );
  return ids.sort();
}

const states = (dbPath: string) =>
  Object.fromEntries(
    dbRows(dbPath, 'SELECT proton_id, body_state, error_code FROM pairs').map((r) => [
      String(r.proton_id),
      [Number(r.body_state), r.error_code === null ? null : String(r.error_code)],
    ]),
  );

describe('phase 2', () => {
  it('reads every message file, newest first, and search finds its text and attachment names', async () => {
    const { run, indexDir } = exportAt('phase2-all', 30);
    const [first, second] = idsOf(run) as [string, string];
    writeFileSync(
      join(run, `${first}.eml`),
      eml('periwinkle zeppelin harbour', ['budget plan.pdf']),
    );
    const read: string[] = [];
    const h = harness(run, indexDir, {}, (role, op, args) => {
      if (op === 'body') read.push((args as { item: { protonId: string } }).item.protonId);
      return false;
    });
    const scan = scanRun(run);
    await h.service.open(null);
    await h.service.startIndexing(scan);
    const files = scan.eml.size;
    expect(h.service.progress).toMatchObject({
      phase: 'done',
      bodyPhase: 'done',
      bodiesDone: files,
      bodiesTotal: files,
      bodiesFailed: 0,
      timeouts: 0,
    });
    const newestFirst = dbRows(
      h.service.dbPath,
      'SELECT proton_id FROM messages ORDER BY time DESC, rowid DESC',
    ).map((r) => String(r.proton_id));
    expect(read).toEqual(newestFirst);
    expect(Object.values(states(h.service.dbPath)).every(([s]) => s === BODY_STATE.indexed)).toBe(
      true,
    );
    expect(await found(h.service, 'zeppelin')).toEqual([first]);
    expect(await found(h.service, 'filename:"budget plan.pdf"')).toEqual([first]);
    expect((await search(h.service, 'zeppelin')).coverage).toEqual({
      indexed: files,
      pending: 0,
      total: files,
    });
    // A word of a generated message's body.
    const body = String(
      dbRows(
        h.service.dbPath,
        `SELECT t.body FROM message_text t JOIN messages m ON m.rowid = t.rowid
         WHERE m.proton_id = '${second}'`,
      )[0]?.body,
    );
    const word = body.match(/[A-Za-z]{6,}/)![0];
    expect(await found(h.service, word)).toContain(second);
    expect(h.logs.find((l) => l.code === 'index.phase2_done')?.data).toMatchObject({
      count: files,
    });
    // Every body went through the pool, in transactions of at most 500.
    const writer = h.threads.find((t) => t.role === 'writer')!;
    expect(writer.calls.filter((c) => c === 'phase2').length).toBeGreaterThanOrEqual(1);
    await h.service.close();
  });

  it('fails a file past its time limit alone, and reads the others', async () => {
    const { run, indexDir } = exportAt('phase2-timeout', 12);
    const slow = idsOf(run)[3]!;
    const h = harness(
      run,
      indexDir,
      { jobMs: 300 },
      (_role, op, args) =>
        op === 'body' && (args as { item: { protonId: string } }).item.protonId === slow,
    );
    await h.service.open(null);
    await h.service.startIndexing(scanRun(run));
    expect(h.service.progress).toMatchObject({
      bodyPhase: 'done',
      bodiesDone: 12,
      bodiesFailed: 1,
      timeouts: 1,
    });
    const all = states(h.service.dbPath);
    expect(all[slow]).toEqual([BODY_STATE.failed, 'BODY_TIMEOUT']);
    for (const [id, state] of Object.entries(all)) {
      if (id !== slow) expect(state, id).toEqual([BODY_STATE.indexed, null]);
    }
    const fileId = String(
      dbRows(h.service.dbPath, `SELECT file_id FROM pairs WHERE proton_id = '${slow}'`)[0]?.file_id,
    );
    expect(h.logs.filter((l) => l.code === 'index.timeout').map((l) => l.data)).toEqual([
      { fileId, reason: 'timeout' },
    ]);
    // The thread that ran it was replaced.
    expect(h.threads.filter((t) => t.role === 'parse').reduce((n, t) => n + t.respawns, 0)).toBe(1);
    await h.service.close();
  });

  it('leaves a file that changed or went since the scan for the next reconcile', async () => {
    const { run, indexDir } = exportAt('phase2-changed', 10);
    const [changed, gone, linked] = idsOf(run) as [string, string, string];
    const scan = scanRun(run);
    // After the scan, before phase 2 reads them.
    writeFileSync(join(run, `${changed}.eml`), eml('rewritten afterwards'));
    rmSync(join(run, `${gone}.eml`));
    // A link the open refuses, in place of a file.
    const target = join(run, `${linked}.eml`);
    renameSync(target, `${target}.moved`);
    symlinkSync(`${target}.moved`, target);
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scan);
    expect(first.service.progress).toMatchObject({
      bodyPhase: 'done',
      bodiesDone: 10,
      bodiesFailed: 1,
    });
    const after = states(first.service.dbPath);
    expect(after[changed]).toEqual([BODY_STATE.pending, null]);
    expect(after[gone]).toEqual([BODY_STATE.pending, null]);
    expect(after[linked]).toEqual([BODY_STATE.failed, 'FILE_SYMLINK']);
    expect(
      first.logs.filter((l) => l.code === 'index.body_failed').map((l) => l.data.reason),
    ).toEqual(['symlink']);
    await first.service.close();

    // The next open reconciles them: the changed file is read, the gone one is marked.
    const second = harness(run, indexDir);
    await second.service.open(opened.dbUuid);
    await second.service.startIndexing(scanRun(run));
    const again = states(second.service.dbPath);
    expect(again[changed]).toEqual([BODY_STATE.indexed, null]);
    expect(again[gone]).toEqual([BODY_STATE.emlMissing, null]);
    expect(await found(second.service, 'rewritten')).toEqual([changed]);
    await second.service.close();
  });

  it('writes nothing once the generation has moved on', async () => {
    const { run, indexDir } = exportAt('phase2-stale', 10);
    let bodies = 0;
    const h = harness(run, indexDir, {}, (_role, op) => {
      // The source switches while the first file is read.
      if (op === 'body' && (bodies += 1) === 1) h.setCurrent(false);
      return false;
    });
    await h.service.open(null);
    await h.service.startIndexing(scanRun(run));
    expect(h.service.progress).toMatchObject({ phase: 'done', bodyPhase: 'failed' });
    expect(Object.values(states(h.service.dbPath)).every(([s]) => s === BODY_STATE.pending)).toBe(
      true,
    );
    const writer = h.threads.find((t) => t.role === 'writer')!;
    expect(writer.calls).not.toContain('phase2');
    expect(h.logs.map((l) => l.code)).toContain('writer.stale_dropped');
    expect(h.logs.find((l) => l.code === 'index.phase2_failed')?.data).toEqual({
      reason: 'stale_generation',
    });
    await h.service.close();
  });

  it('stops at a close, keeps what was written, and the next open reads the rest', async () => {
    const { run, indexDir } = exportAt('phase2-close', 40);
    let writes = 0;
    let closing: Promise<void> | null = null;
    // Transactions smaller than the bodies of 40 messages; the close comes with the second.
    const first = harness(run, indexDir, { txnBytes: 24_000 }, (role, op) => {
      if (role === 'writer' && op === 'phase2' && (writes += 1) === 2) {
        closing = first.service.close();
      }
      return false;
    });
    const opened = await first.service.open(null);
    await first.service.startIndexing(scanRun(run));
    await closing;
    const after = Object.values(states(first.service.dbPath));
    const written = after.filter(([s]) => s === BODY_STATE.indexed).length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(40);
    expect(after.filter(([s]) => s === BODY_STATE.pending)).toHaveLength(40 - written);
    expect(first.logs.find((l) => l.code === 'index.phase2_done')).toBeUndefined();

    const second = harness(run, indexDir);
    await second.service.open(opened.dbUuid);
    await second.service.startIndexing(scanRun(run));
    expect(second.service.progress).toMatchObject({
      bodyPhase: 'done',
      bodiesTotal: 40 - written,
      bodiesDone: 40 - written,
    });
    expect(
      Object.values(states(second.service.dbPath)).every(([s]) => s === BODY_STATE.indexed),
    ).toBe(true);
    await second.service.close();
  });

  it('keeps the first 1,000 attachments, flags and logs the cut, and finds a kept name only', async () => {
    const { run, indexDir } = exportAt('phase2-attachments', 4);
    const [many] = idsOf(run) as [string];
    const names = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `part-${i}.pdf`);
    writeFileSync(join(run, `${many}.eml`), eml('many parts', names));
    const h = harness(run, indexDir);
    await h.service.open(null);
    await h.service.startIndexing(scanRun(run));
    const [row] = dbRows(
      h.service.dbPath,
      `SELECT m.rowid, m.capped, p.file_id FROM messages m JOIN pairs p ON p.proton_id = m.proton_id
       WHERE m.proton_id = '${many}'`,
    );
    expect(Number(row!.capped)).toBe(CAPPED.attachments);
    const rows = dbRows(
      h.service.dbPath,
      `SELECT count(*) AS n FROM attachments WHERE message_rowid = ${Number(row!.rowid)} AND source = 'eml'`,
    );
    expect(Number(rows[0]?.n)).toBe(MAX_ATTACHMENTS);
    expect(h.service.progress.capped).toBe(1);
    expect(h.logs.filter((l) => l.code === 'index.capped').map((l) => l.data)).toEqual([
      { fileId: row!.file_id, list: 'attachments' },
    ]);
    expect(await found(h.service, 'filename:part-999.pdf')).toEqual([many]);
    expect(await found(h.service, 'filename:part-1000.pdf')).toEqual([]);
    await h.service.close();
  });

  it('splits writes by the text budget, and fails with its own code a message alone over it', async () => {
    const { run, indexDir } = exportAt('phase2-budget', 6);
    const [big, ...rest] = idsOf(run) as [string, ...string[]];
    writeFileSync(join(run, `${big}.eml`), eml('x'.repeat(5000)));
    for (const id of rest) writeFileSync(join(run, `${id}.eml`), eml(`${id} ${'y'.repeat(600)}`));
    const h = harness(run, indexDir, { txnBytes: 4000 });
    await h.service.open(null);
    await h.service.startIndexing(scanRun(run));
    const all = states(h.service.dbPath);
    expect(all[big]).toEqual([BODY_STATE.failed, 'BODY_TOO_LARGE']);
    for (const id of rest) expect(all[id], id).toEqual([BODY_STATE.indexed, null]);
    const writer = h.threads.find((t) => t.role === 'writer')!;
    // Five bodies of about 700 bytes take at least two transactions of 4,000.
    expect(writer.calls.filter((c) => c === 'phase2').length).toBeGreaterThanOrEqual(2);
    const fileId = String(
      dbRows(h.service.dbPath, `SELECT file_id FROM pairs WHERE proton_id = '${big}'`)[0]?.file_id,
    );
    expect(
      h.logs.filter((l) => l.code === 'index.body_too_large').map((l) => [l.level, l.data]),
    ).toEqual([['warn', { fileId }]]);
    expect(h.service.progress).toMatchObject({ bodiesFailed: 1, bodiesDone: 6 });
    await h.service.close();
  });

  it('rebuilds an index of the older schema with marker characters, with the schema code, and leaves none', async () => {
    const { run, indexDir } = exportAt('phase2-older', 8);
    const [marked] = idsOf(run) as [string];
    const metaFile = join(run, `${marked}.metadata.json`);
    const doc = JSON.parse(readFileSync(metaFile, 'utf8')) as { Payload: Record<string, unknown> };
    const M = '\uE000';
    const E = '\uE001';
    doc.Payload.Subject = `Quarterly ${M}tangerine${E} figures`;
    doc.Payload.Sender = { Name: `Ann ${E}Lee`, Address: 'ann@example.com' };
    doc.Payload.ToList = [{ Name: `Bo ${M}Ek`, Address: 'bo@example.com' }];
    writeFileSync(metaFile, JSON.stringify(doc));
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scanRun(run));
    await first.service.close();

    // As an older build stored it: the marker characters kept, also in the full-text index.
    const db = openDb(first.service.dbPath);
    db.stmt(
      `UPDATE message_text SET subject = ?, sender = ?, recipients = ?
       WHERE rowid = (SELECT rowid FROM messages WHERE proton_id = ?)`,
    ).run(
      String(doc.Payload.Subject),
      `Ann ${E}Lee ann@example.com`,
      `Bo ${M}Ek bo@example.com`,
      marked,
    );
    // The marker characters are part of the word there: the older index can't find it.
    expect(db.stmt("SELECT count(*) AS n FROM fts WHERE fts MATCH 'tangerine'").get()?.n).toBe(0);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    db.close();

    const second = harness(run, indexDir);
    const reopened = await second.service.open(opened.dbUuid);
    expect(reopened).toMatchObject({ created: true, replaced: true });
    expect(second.service.progress.condition).toBe('ok');
    expect(
      second.logs.filter((l) => ['index.schema_rebuild', 'index.damaged'].includes(l.code)),
    ).toEqual([{ level: 'info', code: 'index.schema_rebuild', data: { reason: 'schema' } }]);
    await second.service.startIndexing(scanRun(run));
    const withMarks = dbRows(
      second.service.dbPath,
      `SELECT count(*) AS n FROM message_text WHERE
         instr(subject, char(57344)) OR instr(subject, char(57345)) OR
         instr(sender, char(57344)) OR instr(sender, char(57345)) OR
         instr(recipients, char(57344)) OR instr(recipients, char(57345)) OR
         instr(body, char(57344)) OR instr(body, char(57345)) OR
         instr(attachments, char(57344)) OR instr(attachments, char(57345))`,
    );
    expect(Number(withMarks[0]?.n)).toBe(0);
    const page = await search(second.service, 'tangerine');
    expect(page.rows).toHaveLength(1);
    const snippet = page.rows[0]!.snippet!;
    expect(snippet.text).toContain('Quarterly tangerine figures');
    expect(validRanges(snippet.text, snippet.ranges)).toBe(true);
    expect(snippet.ranges.map(([a, b]) => snippet.text.slice(a, b))).toEqual(['tangerine']);
    await second.service.close();
  });
});
