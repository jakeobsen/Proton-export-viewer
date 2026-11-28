// SPDX-License-Identifier: AGPL-3.0-or-later
// The index service over generated exports, with its threads run in this
// process: phase 1, reopening, resuming, time limits, caps, stale work, idle
// release and the connection registry; where files listed by name get their
// identity, the bytes a batch reads, and files refused after the listing.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_LABELS_BYTES,
  MAX_METADATA_BYTES,
  countRejections,
  fileKindOf,
  openContainedAsync,
  scanRun,
  type FileRef,
  type Rejection,
  type RejectKind,
  type RunScan,
} from '../../src/core/containment';
import { parseMetadata, type MessageRow } from '../../src/core/index/metadata';
import { QueryState, WriterState, type ApplyResult } from '../../src/core/index/ops';
import { TXN_INPUT_BYTES } from '../../src/core/index/limits';
import { IndexService, type IndexOptions } from '../../src/core/index/service';
import type { Phase1Item } from '../../src/core/index/writer';
import { MAX_ATTACHMENTS } from '../../src/core/index/body';
import { BODY_STATE, CAPPED, SCHEMA_VERSION } from '../../src/core/index/schema';
import { validRanges } from '../../src/core/search/ranges';
import { openDb } from '../../src/core/index/sql';
import { ThreadError, TIMEOUT, type IndexThread, type ThreadRole } from '../../src/core/index/pool';
import type { IndexTotals, ListPage, SearchPage, Sidebar } from '../../src/shared/index-types';
import type { Logger } from '../../src/shared/log/writer';
import { sanitizeEvent } from '../../src/shared/log/schema';
import { RUN_FOLDER } from '../../tools/gen-export/generator.mjs';
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
  hooks: {
    onChange?: () => void;
    onDamage?: (reason: string) => void;
    onRejected?: (rejected: Rejection[]) => void;
    openFile?: (root: string, ref: FileRef) => Promise<number>;
  } = {},
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
    ...hooks,
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

function mkfifo(path: string) {
  const made = spawnSync('/usr/bin/mkfifo', ['-m', '0644', path]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${String(made.stderr)}`);
}

/**
 * Wraps the threads to record what phase 1 asks of them: the files looked
 * at, the metadata jobs, the revs registered and the items written. `before`
 * runs ahead of each call.
 */
function recording(
  before: (role: ThreadRole, op: string, args: unknown) => Promise<void> | void = () => undefined,
) {
  const seen = {
    stat: [] as string[],
    meta: [] as string[][],
    revs: [] as Array<[string, number]>,
    written: [] as Array<{ id: string; rev: number }>,
    /** The IDs of each write transaction. */
    writes: [] as string[][],
  };
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
    call: async <T>(op: string, args?: unknown, timeoutMs?: number): Promise<T> => {
      await before(role, op, args);
      if (role === 'parse' && op === 'stat') {
        seen.stat.push(...(args as { files: Array<{ rel: string }> }).files.map((f) => f.rel));
      }
      if (role === 'parse' && op === 'meta') {
        seen.meta.push(
          (args as { items: Array<{ protonId: string }> }).items.map((i) => i.protonId),
        );
      }
      if (role === 'writer' && op === 'phase1') {
        const items = (args as { items: Phase1Item[] }).items;
        for (const i of items) seen.written.push({ id: i.pair.protonId, rev: i.expectedRev });
        seen.writes.push(items.map((i) => i.pair.protonId));
      }
      const result = await inner.call<T>(op, args, timeoutMs);
      if (role === 'writer' && op === 'apply') seen.revs.push(...(result as ApplyResult).revs);
      return result;
    },
  });
  return { seen, wrap };
}

/**
 * The run folder as a scan that looks at every entry with lstat sees it:
 * the files it refuses, by reason (metadata over 4 MiB included), and the
 * message IDs of the metadata and message files it accepts.
 */
function lstatWalk(run: string): {
  rejected: Record<RejectKind, number>;
  metadata: Set<string>;
  eml: Set<string>;
} {
  const rejected: Rejection[] = [];
  const metadata = new Set<string>();
  const eml = new Set<string>();
  for (const name of readdirSync(run)) {
    const st = lstatSync(join(run, name));
    const type = st.isFile()
      ? 'file'
      : st.isSymbolicLink()
        ? 'symlink'
        : st.isDirectory()
          ? 'directory'
          : st.isFIFO()
            ? 'fifo'
            : st.isSocket()
              ? 'socket'
              : st.isBlockDevice() || st.isCharacterDevice()
                ? 'device'
                : 'other_type';
    if (type !== 'file') {
      rejected.push({ rel: name, kind: type });
      continue;
    }
    const kind = fileKindOf(name);
    if (!kind) continue;
    const limit = kind.kind === 'metadata' ? MAX_METADATA_BYTES : MAX_LABELS_BYTES;
    if (kind.kind !== 'eml' && st.size > limit) {
      rejected.push({ rel: name, kind: 'too_large' });
      continue;
    }
    if (kind.kind === 'metadata') metadata.add(kind.id!);
    if (kind.kind === 'eml') eml.add(kind.id!);
  }
  return { rejected: countRejections(rejected), metadata, eml };
}

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

  it('records a pair with a file missing, and refuses a file that changed type before its first look as the listing would', async () => {
    const { run, indexDir } = exportAt('broken', 8);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.eml'))
      .map((n) => n.slice(0, -'.eml'.length))
      .sort();
    rmSync(join(run, `${ids[0]}.metadata.json`));
    rmSync(join(run, `${ids[1]}.eml`));
    rmSync(join(run, `${ids[6]}.eml`));
    const scan = scanRun(run);
    // After the listing, before any look: a metadata file becomes a FIFO
    // (reading it must not block), and a message file a link.
    rmSync(join(run, `${ids[2]}.metadata.json`));
    mkfifo(join(run, `${ids[2]}.metadata.json`));
    rmSync(join(run, `${ids[3]}.eml`));
    symlinkSync(join(run, `${ids[4]}.eml`), join(run, `${ids[3]}.eml`));
    // A pair with metadata only, whose metadata goes: nothing of it is left.
    rmSync(join(run, `${ids[6]}.metadata.json`));
    const rejected: Rejection[] = [];
    const h = harness(run, indexDir, { jobMs: 2000 }, undefined, undefined, {
      onRejected: (found) => rejected.push(...found),
    });
    await h.service.open(null);
    await h.service.startIndexing(scan);
    // The FIFO counts as a refused file, not as metadata, and the gone one
    // as never listed: 5 metadata files are left.
    expect(h.service.progress).toMatchObject({ phase: 'done', total: 5, loaded: 5, failed: 0 });
    const pairs = Object.fromEntries(
      dbRows(
        h.service.dbPath,
        'SELECT proton_id, meta_state, body_state, error_code, eml_rel FROM pairs',
      ).map((r) => [String(r.proton_id), [r.meta_state, r.body_state, r.error_code, r.eml_rel]]),
    );
    expect(pairs[ids[0]!]).toEqual([4, 0, 'PAIR_META_MISSING', `${ids[0]}.eml`]);
    expect(pairs[ids[1]!]).toEqual([1, 4, null, null]);
    expect(pairs[ids[2]!]).toEqual([4, 0, 'PAIR_META_MISSING', `${ids[2]}.eml`]);
    expect(pairs[ids[3]!]).toEqual([1, 4, null, null]);
    expect(pairs[ids[6]!]).toBeUndefined();
    expect(Object.keys(pairs)).toHaveLength(7);
    expect(rejected.sort((a, b) => (a.rel < b.rel ? -1 : 1))).toEqual(
      [
        { rel: `${ids[2]}.metadata.json`, kind: 'fifo' },
        { rel: `${ids[3]}.eml`, kind: 'symlink' },
      ].sort((a, b) => (a.rel < b.rel ? -1 : 1)),
    );
    // The eml's identity is its lstat's.
    const [stored] = dbRows(
      h.service.dbPath,
      `SELECT CAST(eml_ino AS TEXT) AS ino FROM pairs WHERE proton_id = '${ids[5]}'`,
    );
    expect(stored?.ino).toBe(String(lstatSync(join(run, `${ids[5]}.eml`), { bigint: true }).ino));
    expect(h.logs.some((l) => l.code === 'index.meta_failed')).toBe(false);
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

  it('reports phase 1 failing at once, but a damaged index only as damage', async () => {
    for (const [code, reason] of [
      ['WAL_STOP', 'wal'],
      ['INDEX_CORRUPT', 'corrupt'],
    ] as const) {
      const { run, indexDir } = exportAt(`phase-fail-${code}`, 6);
      const phases: string[] = [];
      const damage: string[] = [];
      // The writer fails phase 1's first write.
      const failing = (thread: IndexThread): IndexThread => ({
        call: <T>(op: string, args?: unknown, timeoutMs?: number) =>
          op === 'phase1'
            ? Promise.reject(new ThreadError(code))
            : thread.call<T>(op, args, timeoutMs),
        stop: () => thread.stop(),
        get respawns() {
          return thread.respawns;
        },
        onRespawn: null,
      });
      const h: Harness = harness(
        run,
        indexDir,
        {},
        () => false,
        (role, thread) => (role === 'writer' ? failing(thread) : thread),
        {
          onChange: () => phases.push(h.service.progress.phase),
          onDamage: (r) => damage.push(r),
        },
      );
      await h.service.open(null);
      await h.service.startIndexing(scanRun(run));
      expect(h.service.progress.phase).toBe('failed');
      expect(h.logs.find((l) => l.code === 'index.phase1_failed')?.data.reason).toBe(reason);
      if (code === 'WAL_STOP') {
        expect(phases.at(-1)).toBe('failed');
        expect(damage).toEqual([]);
      } else {
        // Main rebuilds a damaged index; a 'failed' report first would close it instead.
        expect(phases).not.toContain('failed');
        expect(damage).toEqual(['corrupt']);
      }
      await h.service.close();
    }
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

  it('reads batches one after another and writes them in that order; with readByName, in name order', async () => {
    /** Runs phase 1 with the first read held a while. Returns the IDs of each read and each write. */
    const run1 = async (readByName: boolean) => {
      const { run, indexDir } = exportAt(`order-${readByName}`, 30, 11);
      let reads = 0;
      const { seen, wrap } = recording(async (role, op) => {
        if (role !== 'parse' || op !== 'meta') return;
        reads += 1;
        if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const scan = scanRun(run);
      const h = harness(run, indexDir, { batchPairs: 10, readByName }, undefined, wrap);
      await h.service.open(null);
      await h.service.startIndexing(scan);
      expect(h.service.progress).toMatchObject({ phase: 'done', loaded: 30, total: 30, failed: 0 });
      expect(dbPartition(h.service.dbPath)).toEqual(partitionOfFiles(run));
      await h.service.close();
      return { reads: seen.meta, writes: seen.written.map((w) => w.id) };
    };

    // The held first batch still comes first: a batch is read only after the one before it.
    const free = await run1(false);
    expect(free.reads).toHaveLength(3);
    expect(free.writes).toEqual(free.reads.flat());

    const ordered = await run1(true);
    expect(ordered.writes).toEqual(ordered.reads.flat());
    expect(ordered.writes).toEqual([...ordered.writes].sort());
  });

  it('looks only at the files of stored pairs: none on a first open, all on a reopen, and reads nothing unchanged', async () => {
    const { run, indexDir } = exportAt('looks', 12);
    // One message file without metadata: nothing reads it, so it is looked at.
    writeFileSync(join(run, 'lonely.eml'), 'Subject: lonely\r\n\r\n');
    const first = recording();
    const h = harness(run, indexDir, {}, undefined, first.wrap);
    const opened = await h.service.open(null);
    await h.service.startIndexing(scanRun(run));
    expect(first.seen.stat).toEqual(['lonely.eml']);
    expect(first.seen.meta.flat()).toHaveLength(12);
    await h.service.close();

    const second = recording();
    const again = harness(run, indexDir, {}, undefined, second.wrap);
    await again.service.open(opened.dbUuid);
    await again.service.startIndexing(scanRun(run));
    const files = readdirSync(run).filter((n) => n !== 'labels.json');
    expect(second.seen.stat.sort()).toEqual(files.sort());
    expect(second.seen.meta).toEqual([]);
    expect(again.service.progress).toMatchObject({ phase: 'done', loaded: 12, total: 12 });
    await again.service.close();
  });

  it('reads a batch up to its share of bytes; the pairs it left are read next, each rev written once', async () => {
    const { run, indexDir } = exportAt('budget', 40);
    const sizes = readdirSync(run)
      .filter((n) => n.endsWith('.metadata.json'))
      .map((n) => statSync(join(run, n)).size);
    const largest = Math.max(...sizes);
    const share = 3 * largest;
    const options = { batchPairs: 10, metaJob: 2, poolSize: 2, readBytes: share };
    const { seen, wrap } = recording();
    const h = harness(run, indexDir, options, undefined, wrap);
    await h.service.open(null);
    await h.service.startIndexing(scanRun(run));
    expect(h.service.progress).toMatchObject({ phase: 'done', loaded: 40, total: 40, failed: 0 });
    // Pairs were left for later batches: more batches than 40 / 10.
    expect(h.service.reads.batches).toBeGreaterThan(4);
    // Bytes in flight at most: the share, plus per thread a job's share and the file past it.
    const jobShare = Math.ceil(share / options.poolSize);
    const bound = share + options.poolSize * (jobShare + largest);
    expect(h.service.reads.peakBytes).toBeGreaterThan(0);
    expect(h.service.reads.peakBytes).toBeLessThanOrEqual(bound);
    console.log('budget:', JSON.stringify({ ...h.service.reads, share, bound, largest }));
    // Every registered rev is written once, with its own pair.
    const written = seen.written.map((w) => `${w.id}:${w.rev}`);
    expect(new Set(written).size).toBe(written.length);
    expect(written.sort()).toEqual(seen.revs.map(([id, rev]) => `${id}:${rev}`).sort());
    expect(seen.revs).toHaveLength(40);
    expect(dbPartition(h.service.dbPath)).toEqual(partitionOfFiles(run));
    await h.service.close();
  });

  it('charges refused reads to both shares: files over the limit in a row are read a few per batch', async () => {
    for (const [poolSize, metaJob] of [
      [1, 50],
      [2, 1],
    ] as const) {
      const { run, indexDir } = exportAt(`over-limit-${poolSize}`, 6);
      const ids = readdirSync(run)
        .filter((n) => n.endsWith('.metadata.json'))
        .map((n) => n.slice(0, -'.metadata.json'.length))
        .sort();
      // Sparse: each read gets the limit and one byte more, of zeros.
      for (const id of ids.slice(0, 3)) {
        truncateSync(join(run, `${id}.metadata.json`), MAX_METADATA_BYTES + 1);
      }
      const rejected: Rejection[] = [];
      const h = harness(
        run,
        indexDir,
        { poolSize, metaJob, readByName: true },
        undefined,
        undefined,
        {
          onRejected: (found) => rejected.push(...found),
        },
      );
      await h.service.open(null);
      await h.service.startIndexing(scanRun(run));
      const label = `pool ${poolSize}`;
      expect(
        rejected.map((r) => r.kind),
        label,
      ).toEqual(['too_large', 'too_large', 'too_large']);
      expect(h.service.progress, label).toMatchObject({ phase: 'done', total: 3, loaded: 3 });
      // A refused read uses up the share like any other, so they don't all go in one batch.
      expect(h.service.reads.batches, label).toBeGreaterThanOrEqual(2);
      const jobShare = Math.ceil(TXN_INPUT_BYTES / poolSize);
      const bound = TXN_INPUT_BYTES + poolSize * (jobShare + MAX_METADATA_BYTES + 1);
      expect(h.service.reads.peakBytes, label).toBeGreaterThan(MAX_METADATA_BYTES);
      expect(h.service.reads.peakBytes, label).toBeLessThanOrEqual(bound);
      await h.service.close();
    }
  });

  it('reads the files of a job that failed one per job under the same share, and leaves the rest for the next batch, read alone', async () => {
    const { run, indexDir } = exportAt('retry-share', 8);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.metadata.json'))
      .map((n) => n.slice(0, -'.metadata.json'.length))
      .sort();
    // About 100 kB each, so three of them pass the share.
    for (const id of ids) {
      const path = join(run, `${id}.metadata.json`);
      const doc = JSON.parse(readFileSync(path, 'utf8')) as { Payload: Record<string, unknown> };
      doc.Payload.Subject = 'x'.repeat(100_000);
      writeFileSync(path, JSON.stringify(doc));
    }
    const largest = Math.max(...ids.map((id) => statSync(join(run, `${id}.metadata.json`)).size));
    const share = 250_000;
    const first = ids.slice(0, 4);
    const { seen, wrap } = recording();
    // The job with the first four files runs past its limit; each alone doesn't.
    const h = harness(
      run,
      indexDir,
      { poolSize: 1, metaJob: 4, jobMs: 300, readBytes: share, readByName: true },
      (role, op, args) => {
        const items = (args as { items?: Array<{ protonId: string }> }).items ?? [];
        return (
          role === 'parse' && op === 'meta' && items.length > 1 && items[0]!.protonId === ids[0]
        );
      },
      wrap,
    );
    await h.service.open(null);
    await h.service.startIndexing(scanRun(run));
    expect(h.service.progress).toMatchObject({ phase: 'done', loaded: 8, failed: 0, timeouts: 1 });
    // After the failed job, its files are only ever read alone.
    const after = seen.meta.slice(1);
    expect(seen.meta[0]).toEqual(first);
    expect(
      after.filter((job) => job.some((id) => first.includes(id))).every((j) => j.length === 1),
    ).toBe(true);
    // The retries stop at the share: the first batch writes three, the fourth comes next.
    expect(seen.writes[0]).toEqual(first.slice(0, 3));
    // At most the share, plus for the one thread a job's share and the file past it.
    expect(h.service.reads.peakBytes).toBeLessThanOrEqual(share + (share + largest));
    // Every registered rev is written once, the carried ones included.
    const written = seen.written.map((w) => `${w.id}:${w.rev}`);
    expect(new Set(written).size).toBe(written.length);
    expect(written.sort()).toEqual(seen.revs.map(([id, rev]) => `${id}:${rev}`).sort());
    await h.service.close();
  });

  it('stops reading once closed: pairs left for the next batch wait, and the next open reads them', async () => {
    const { run, indexDir } = exportAt('budget-close', 30);
    const largest = Math.max(
      ...readdirSync(run)
        .filter((n) => n.endsWith('.metadata.json'))
        .map((n) => statSync(join(run, n)).size),
    );
    let reads = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached = (): void => undefined;
    const atThird = new Promise<void>((resolve) => (reached = resolve));
    const { seen, wrap } = recording(async (role, op) => {
      if (role !== 'parse' || op !== 'meta') return;
      reads += 1;
      if (reads === 3) {
        reached();
        await held;
      }
    });
    const options = { batchPairs: 10, metaJob: 2, poolSize: 1, readBytes: 2 * largest };
    const h = harness(run, indexDir, options, undefined, wrap);
    const opened = await h.service.open(null);
    const phase1 = h.service.startIndexing(scanRun(run));
    await atThird;
    const closing = h.service.close();
    release();
    await closing;
    await phase1;
    expect(h.service.progress.phase).toBe('failed');
    // The held read was the last one asked for.
    expect(reads).toBe(3);
    expect(seen.meta).toHaveLength(3);
    const states = dbRows(h.service.dbPath, 'SELECT meta_state AS s FROM pairs').map((r) => r.s);
    expect(states.filter((x) => x === 0).length).toBeGreaterThan(0);

    const again = harness(run, indexDir);
    await again.service.open(opened.dbUuid);
    await again.service.startIndexing(scanRun(run));
    expect(again.service.progress).toMatchObject({ phase: 'done', loaded: 30, total: 30 });
    expect(dbPartition(again.service.dbPath)).toEqual(partitionOfFiles(run));
    await again.service.close();
  });

  it('gives the hostile corpus the totals, pairs and refused files that an lstat of every entry gives', async () => {
    const dir = testDir('hostile-scan');
    const out = join(dir, 'export');
    const made = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'tools', 'gen-export', 'gen-export.mjs'),
        'hostile',
        '--seed',
        '1',
        '--nonce',
        'n0nce1234',
        '--out',
        out,
      ],
      { encoding: 'utf8' },
    );
    expect(made.status, made.stderr).toBe(0);
    const run = realpathSync(join(out, 'hostile1@example.com', RUN_FOLDER));
    // Metadata over its limit (sparse), with its message file.
    writeFileSync(join(run, 'zzbig.metadata.json'), '');
    truncateSync(join(run, 'zzbig.metadata.json'), MAX_METADATA_BYTES + 1);
    writeFileSync(join(run, 'zzbig.eml'), 'Subject: big\r\n\r\n');
    const scan = scanRun(run);
    // After the listing: a metadata file becomes a FIFO, a message file a
    // link, and another message file goes.
    const accepted = [...scan.metadata.keys()]
      .filter((id) => scan.eml.has(id) && id !== 'zzbig')
      .sort();
    const [fifo, link, gone, target] = accepted.slice(-4) as [string, string, string, string];
    rmSync(join(run, `${fifo}.metadata.json`));
    mkfifo(join(run, `${fifo}.metadata.json`));
    rmSync(join(run, `${link}.eml`));
    symlinkSync(join(run, `${target}.eml`), join(run, `${link}.eml`));
    rmSync(join(run, `${gone}.eml`));
    const walk = lstatWalk(run);
    let failing = 0;
    for (const id of walk.metadata) {
      try {
        parseMetadata(id, readFileSync(join(run, `${id}.metadata.json`), 'utf8'));
      } catch {
        failing += 1;
      }
    }

    const later: Rejection[] = [];
    const h = harness(run, join(dir, 'index'), { jobMs: 5000 }, undefined, undefined, {
      onRejected: (found) => later.push(...found),
    });
    await h.service.open(null);
    await h.service.startIndexing(scan);
    expect(countRejections([...scan.rejected, ...later])).toEqual(walk.rejected);
    expect(walk.rejected.too_large).toBe(1);
    expect(h.service.progress).toMatchObject({
      phase: 'done',
      total: walk.metadata.size,
      loaded: walk.metadata.size,
      failed: failing,
    });
    expect(h.logs.find((l) => l.code === 'index.phase1_done')?.data.count).toBe(walk.metadata.size);
    const pairs = dbRows(h.service.dbPath, 'SELECT proton_id, eml_rel FROM pairs');
    expect(new Set(pairs.map((r) => String(r.proton_id)))).toEqual(
      new Set([...walk.metadata, ...walk.eml]),
    );
    expect(
      pairs
        .filter((r) => r.eml_rel !== null)
        .map((r) => String(r.proton_id))
        .sort(),
    ).toEqual([...walk.eml].sort());
    await h.service.close();
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

    // Nothing changed since: nothing is written or read but the plan. The
    // stored pairs' files are only looked at.
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
      'known',
      'plan',
      'finish',
      'bodyOrder',
    ]);
    const looks = third.threads.filter((t) => t.role === 'parse').flatMap((t) => t.calls);
    expect(looks.length).toBeGreaterThan(0);
    expect(new Set(looks)).toEqual(new Set(['stat']));
    expect(third.logs.map((l) => l.code)).not.toContain('index.reconciled');
    await third.service.close();
  });
});

describe('files that change after the listing', () => {
  it('removes a stored message whose metadata grew past its limit, and counts the file once as too large', async () => {
    const { run, indexDir } = exportAt('grown-cap', 6);
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scanRun(run));
    await first.service.close();
    const id = readdirSync(run)
      .filter((n) => n.endsWith('.metadata.json'))
      .map((n) => n.slice(0, -'.metadata.json'.length))
      .sort()[0]!;
    const [before] = dbRows(
      first.service.dbPath,
      `SELECT rowid FROM messages WHERE proton_id = '${id}'`,
    );
    expect(before).toBeDefined();
    // Its text, and an attachment as reading its message file lists one.
    const db = openDb(first.service.dbPath);
    db.stmt(
      "INSERT INTO attachments(message_rowid, idx, filename, mime, size, content_id, source) VALUES (?, 0, 'a.pdf', 'application/pdf', 1, NULL, 'eml')",
    ).run(Number(before!.rowid));
    db.close();
    expect(
      dbRows(
        first.service.dbPath,
        `SELECT 1 FROM message_text WHERE rowid = ${Number(before!.rowid)}`,
      ),
    ).toHaveLength(1);
    truncateSync(join(run, `${id}.metadata.json`), MAX_METADATA_BYTES + 1);

    const rejected: Rejection[] = [];
    const { seen, wrap } = recording();
    const h = harness(run, indexDir, {}, undefined, wrap, {
      onRejected: (found) => rejected.push(...found),
    });
    await h.service.open(opened.dbUuid);
    await h.service.startIndexing(scanRun(run));
    expect(rejected).toEqual([{ rel: `${id}.metadata.json`, kind: 'too_large' }]);
    // Its look gave its size: it is refused without being read.
    expect(seen.meta.flat()).not.toContain(id);
    expect(h.service.progress).toMatchObject({ phase: 'done', total: 5, loaded: 5, failed: 0 });
    const rowid = Number(before!.rowid);
    expect(dbRows(h.service.dbPath, `SELECT 1 FROM messages WHERE proton_id = '${id}'`)).toEqual(
      [],
    );
    expect(dbRows(h.service.dbPath, `SELECT 1 FROM message_text WHERE rowid = ${rowid}`)).toEqual(
      [],
    );
    expect(
      dbRows(h.service.dbPath, `SELECT 1 FROM attachments WHERE message_rowid = ${rowid}`),
    ).toEqual([]);
    const [pair] = dbRows(
      h.service.dbPath,
      `SELECT meta_state, error_code, meta_rel FROM pairs WHERE proton_id = '${id}'`,
    );
    expect(pair).toEqual({ meta_state: 4, error_code: 'PAIR_META_MISSING', meta_rel: null });
    await h.service.close();
  });

  it('refuses a stored file that grows past its limit between its look and its read', async () => {
    const { run, indexDir } = exportAt('grown-late', 5);
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scanRun(run));
    await first.service.close();
    const id = readdirSync(run)
      .filter((n) => n.endsWith('.metadata.json'))
      .map((n) => n.slice(0, -'.metadata.json'.length))
      .sort()[0]!;
    const path = join(run, `${id}.metadata.json`);
    // Changed, so it is read again; it grows past the limit after its look.
    writeFileSync(path, readFileSync(path, 'utf8').replace('"Subject"', '"Subject" '));
    const { wrap } = recording((role, op) => {
      if (role === 'parse' && op === 'meta') truncateSync(path, MAX_METADATA_BYTES + 1);
    });
    const rejected: Rejection[] = [];
    const h = harness(run, indexDir, {}, undefined, wrap, {
      onRejected: (found) => rejected.push(...found),
    });
    await h.service.open(opened.dbUuid);
    await h.service.startIndexing(scanRun(run));
    expect(rejected).toEqual([{ rel: `${id}.metadata.json`, kind: 'too_large' }]);
    expect(h.service.progress).toMatchObject({ phase: 'done', total: 4, loaded: 4, failed: 0 });
    const [pair] = dbRows(
      h.service.dbPath,
      `SELECT meta_state, error_code FROM pairs WHERE proton_id = '${id}'`,
    );
    expect(pair).toEqual({ meta_state: 4, error_code: 'PAIR_META_MISSING' });
    expect(dbRows(h.service.dbPath, `SELECT 1 FROM messages WHERE proton_id = '${id}'`)).toEqual(
      [],
    );
    await h.service.close();
  });

  it('looks at stored files without a time limit: a slow look does not fail phase 1', async () => {
    const { run, indexDir } = exportAt('slow-look', 6);
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scanRun(run));
    await first.service.close();
    // Each look takes 150 ms; any limit below that would end it.
    const { seen, wrap } = recording(async (role, op) => {
      if (role !== 'parse' || op !== 'stat') return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const limits: number[] = [];
    const timed = (role: ThreadRole, inner: IndexThread): IndexThread => {
      const outer = wrap(role, inner);
      return {
        get respawns() {
          return outer.respawns;
        },
        get onRespawn() {
          return outer.onRespawn;
        },
        set onRespawn(f) {
          outer.onRespawn = f;
        },
        stop: () => outer.stop(),
        call: <T>(op: string, args?: unknown, timeoutMs?: number): Promise<T> => {
          if (role === 'parse' && op === 'stat') {
            limits.push(timeoutMs ?? 0);
            if (timeoutMs) return Promise.reject(new ThreadError(TIMEOUT));
          }
          return outer.call<T>(op, args, timeoutMs);
        },
      };
    };
    const h = harness(run, indexDir, { jobMs: 100 }, undefined, timed);
    await h.service.open(opened.dbUuid);
    await h.service.startIndexing(scanRun(run));
    expect(h.service.progress).toMatchObject({ phase: 'done', loaded: 6, total: 6 });
    expect(seen.stat.length).toBeGreaterThan(0);
    expect(limits.every((ms) => ms === 0)).toBe(true);
    await h.service.close();
  });

  it('gives a new file whose read failed its identity, so an unchanged one is not read again', async () => {
    const { run, indexDir } = exportAt('failed-identity', 6);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.metadata.json'))
      .map((n) => n.slice(0, -'.metadata.json'.length))
      .sort();
    const [locked, slow] = ids as [string, string];
    const lockedPath = join(run, `${locked}.metadata.json`);
    // One can't be opened; the other's read always runs past its limit.
    chmodSync(lockedPath, 0o000);
    try {
      const first = harness(run, indexDir, { jobMs: 200, metaJob: 1 }, (role, op, args) => {
        const items = (args as { items?: Array<{ protonId: string }> }).items ?? [];
        return role === 'parse' && op === 'meta' && items.some((i) => i.protonId === slow);
      });
      const opened = await first.service.open(null);
      await first.service.startIndexing(scanRun(run));
      expect(first.service.progress).toMatchObject({ phase: 'done', loaded: 6, failed: 2 });
      const stored = Object.fromEntries(
        dbRows(
          first.service.dbPath,
          'SELECT proton_id, error_code, CAST(meta_ino AS TEXT) AS ino FROM pairs',
        ).map((r) => [String(r.proton_id), [r.error_code, r.ino]]),
      );
      expect(stored[locked]).toEqual([
        'FILE_UNREADABLE',
        String(lstatSync(lockedPath, { bigint: true }).ino),
      ]);
      expect(stored[slow]).toEqual([
        'META_TIMEOUT',
        String(lstatSync(join(run, `${slow}.metadata.json`), { bigint: true }).ino),
      ]);
      await first.service.close();

      // Unchanged since: neither is read again.
      const { seen, wrap } = recording();
      const again = harness(run, indexDir, {}, undefined, wrap);
      await again.service.open(opened.dbUuid);
      await again.service.startIndexing(scanRun(run));
      expect(seen.meta).toEqual([]);
      expect(again.service.progress).toMatchObject({ phase: 'done', loaded: 6 });
      await again.service.close();
    } finally {
      chmodSync(lockedPath, 0o644);
    }
  });

  it('refuses a labels.json over its limit when it is listed, and clears the stored labels', async () => {
    const { run, indexDir } = exportAt('labels-over', 6);
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scanRun(run));
    await first.service.close();
    expect(dbRows(first.service.dbPath, 'SELECT 1 FROM labels').length).toBeGreaterThan(0);
    truncateSync(join(run, 'labels.json'), MAX_LABELS_BYTES + 1);
    const scan = scanRun(run);
    expect(scan.labels).toBeNull();
    expect(scan.rejected).toEqual([{ rel: 'labels.json', kind: 'too_large' }]);
    const { wrap } = recording();
    const h = harness(run, indexDir, {}, undefined, wrap);
    await h.service.open(opened.dbUuid);
    await h.service.startIndexing(scan);
    expect(h.service.progress.phase).toBe('done');
    expect(dbRows(h.service.dbPath, 'SELECT 1 FROM labels')).toEqual([]);
    expect(h.threads.filter((t) => t.role === 'parse').flatMap((t) => t.calls)).not.toContain(
      'labels',
    );
    await h.service.close();
  });

  it('leaves no failed registration unhandled while it waits for writes', async () => {
    const { run, indexDir } = exportAt('register-fails', 12);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let applies = 0;
    let release = (): void => undefined;
    const writesHeld = new Promise<void>((resolve) => (release = resolve));
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
      call: async <T>(op: string, args?: unknown, timeoutMs?: number): Promise<T> => {
        if (role === 'writer' && op === 'phase1') await writesHeld;
        if (role === 'writer' && op === 'apply') {
          applies += 1;
          // The registration made while the batches before wait for their writes.
          if (applies === 4) throw new ThreadError('WRITER_DOWN');
        }
        return inner.call<T>(op, args, timeoutMs);
      },
    });
    try {
      const h = harness(run, indexDir, { batchPairs: 2 }, undefined, wrap);
      await h.service.open(null);
      const phase1 = h.service.startIndexing(scanRun(run));
      await expect.poll(() => applies).toBe(4);
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await phase1;
      expect(h.service.progress.phase).toBe('failed');
      expect(unhandled).toEqual([]);
      await h.service.close();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it("gives a stored pair whose file became a FIFO after its look the pair's code, as before", async () => {
    const { run, indexDir } = exportAt('swapped-late', 5);
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scanRun(run));
    await first.service.close();
    const id = readdirSync(run)
      .filter((n) => n.endsWith('.metadata.json'))
      .map((n) => n.slice(0, -'.metadata.json'.length))
      .sort()[0]!;
    const path = join(run, `${id}.metadata.json`);
    // Changed, so it is read again; it becomes a FIFO between its look and its read.
    writeFileSync(path, readFileSync(path, 'utf8').replace('"Subject"', '"Subject" '));
    const { wrap } = recording((role, op) => {
      if (role !== 'parse' || op !== 'meta') return;
      rmSync(path);
      mkfifo(path);
    });
    const rejected: Rejection[] = [];
    const h = harness(run, indexDir, { jobMs: 2000 }, undefined, wrap, {
      onRejected: (found) => rejected.push(...found),
    });
    await h.service.open(opened.dbUuid);
    await h.service.startIndexing(scanRun(run));
    expect(h.service.progress).toMatchObject({ phase: 'done', total: 5, loaded: 5, failed: 1 });
    const [pair] = dbRows(
      h.service.dbPath,
      `SELECT meta_state, error_code FROM pairs WHERE proton_id = '${id}'`,
    );
    expect(pair).toEqual({ meta_state: 3, error_code: 'FILE_FIFO' });
    expect(h.logs.find((l) => l.code === 'index.meta_failed')?.data.reason).toBe('fifo');
    expect(rejected).toEqual([]);
    await h.service.close();
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

  it('leaves a file that changed or went since phase 1 for the next reconcile', async () => {
    const { run, indexDir } = exportAt('phase2-changed', 10);
    const [changed, gone, linked, replaced, renamed, unlisted] = idsOf(run) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const file = (id: string) => join(run, `${id}.eml`);
    // Whole seconds, so a replacement can carry the very same mtime.
    const whole = new Date(1_700_000_000_000);
    utimesSync(file(replaced), whole, whole);
    const scan = scanRun(run);
    // After phase 1 recorded each file's identity, before phase 2 reads them.
    let changedOnce = false;
    const afterPhase1 = (role: ThreadRole, op: string) => {
      if (role !== 'writer' || op !== 'bodyOrder' || changedOnce) return false;
      changedOnce = true;
      // Rewritten in place: the same inode, with a new size and mtime.
      writeFileSync(file(changed), eml('rewritten afterwards'));
      rmSync(file(gone));
      // A link the open refuses, in place of a file.
      renameSync(file(linked), `${file(linked)}.moved`);
      symlinkSync(`${file(linked)}.moved`, file(linked));
      // Another file of the same size and mtime takes its place: only the inode differs.
      const bytes = readFileSync(file(replaced));
      const at = bytes.lastIndexOf(0x65);
      bytes[at] = 0x61;
      writeFileSync(`${file(replaced)}.new`, bytes);
      utimesSync(`${file(replaced)}.new`, whole, whole);
      renameSync(`${file(replaced)}.new`, file(replaced));
      renameSync(file(renamed), `${file(renamed)}.away`);
      // Still there, but the scan no longer lists it under its recorded name.
      scan.eml.set(unlisted, { rel: `${unlisted}.other.eml`, kind: 'eml' });
      return false;
    };
    const first = harness(run, indexDir, {}, afterPhase1);
    const opened = await first.service.open(null);
    await first.service.startIndexing(scan);
    expect(changedOnce).toBe(true);
    expect(first.service.progress).toMatchObject({
      bodyPhase: 'done',
      bodiesDone: 10,
      bodiesFailed: 1,
    });
    const after = states(first.service.dbPath);
    for (const id of [changed, gone, replaced, renamed, unlisted]) {
      expect(after[id], id).toEqual([BODY_STATE.pending, null]);
    }
    expect(after[linked]).toEqual([BODY_STATE.failed, 'FILE_SYMLINK']);
    expect(
      first.logs.filter((l) => l.code === 'index.body_failed').map((l) => l.data.reason),
    ).toEqual(['symlink']);
    // Nothing of a file that changed was kept.
    expect(await found(first.service, 'rewritten')).toEqual([]);
    await first.service.close();

    // The next open reconciles them: the changed file is read, the gone one is marked.
    rmSync(file(linked));
    renameSync(`${file(linked)}.moved`, file(linked));
    renameSync(`${file(renamed)}.away`, file(renamed));
    const second = harness(run, indexDir);
    await second.service.open(opened.dbUuid);
    await second.service.startIndexing(scanRun(run));
    const again = states(second.service.dbPath);
    expect(again[changed]).toEqual([BODY_STATE.indexed, null]);
    expect(again[gone]).toEqual([BODY_STATE.emlMissing, null]);
    expect(again[replaced]).toEqual([BODY_STATE.indexed, null]);
    expect(again[renamed]).toEqual([BODY_STATE.indexed, null]);
    expect(again[unlisted]).toEqual([BODY_STATE.indexed, null]);
    expect(await found(second.service, 'rewritten')).toEqual([changed]);
    await second.service.close();
  });

  it('never opens a message file whose row has no whole identity, and leaves it waiting', async () => {
    const { run, indexDir } = exportAt('phase2-no-identity', 8);
    const [noDevIno, noSize, badMtime] = idsOf(run) as [string, string, string];
    const scan = scanRun(run);
    let dbPath = '';
    const afterPhase1 = (role: ThreadRole, op: string) => {
      if (role !== 'writer' || op !== 'bodyOrder' || !dbPath) return false;
      const db = openDb(dbPath);
      try {
        db.exec(`UPDATE pairs SET eml_dev = NULL, eml_ino = NULL WHERE proton_id = '${noDevIno}'`);
        db.exec(`UPDATE pairs SET eml_size = NULL WHERE proton_id = '${noSize}'`);
        db.exec(`UPDATE pairs SET eml_mtime_ns = 'soon' WHERE proton_id = '${badMtime}'`);
      } finally {
        db.close();
      }
      dbPath = '';
      return false;
    };
    const openedRels: string[] = [];
    const h = harness(run, indexDir, {}, afterPhase1, undefined, {
      openFile: (root, ref) => {
        openedRels.push(ref.rel);
        return openContainedAsync(root, ref);
      },
    });
    await h.service.open(null);
    dbPath = h.service.dbPath;
    await h.service.startIndexing(scan);
    expect(dbPath).toBe('');
    expect(h.service.progress).toMatchObject({ bodyPhase: 'done', bodiesDone: 8, bodiesFailed: 0 });
    const after = states(h.service.dbPath);
    for (const id of [noDevIno, noSize, badMtime]) {
      expect(after[id], id).toEqual([BODY_STATE.pending, null]);
      expect(openedRels, id).not.toContain(`${id}.eml`);
    }
    expect(openedRels).toHaveLength(5);
    await h.service.close();
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
