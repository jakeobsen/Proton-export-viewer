// SPDX-License-Identifier: AGPL-3.0-or-later
// The index service over generated exports, with its threads run in this
// process: phase 1, reopening, resuming, time limits, caps, stale work, idle
// release and the connection registry.

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRun, type RunScan } from '../../src/core/containment';
import { parseMetadata, type MessageRow } from '../../src/core/index/metadata';
import { IndexService, type IndexOptions } from '../../src/core/index/service';
import { openDb } from '../../src/core/index/sql';
import type { ThreadRole } from '../../src/core/index/pool';
import type { IndexTotals, ListPage, Sidebar } from '../../src/shared/index-types';
import type { Logger } from '../../src/shared/log/writer';
import { sanitizeEvent } from '../../src/shared/log/schema';
import { writeExport } from '../exports';
import { InlineThread, STAMP, expected } from '../index-helpers';
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
      return t;
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
    await h.service.startPhase1(scan);
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
    expect(h.logs.map((l) => l.code)).toEqual(['index.created', 'index.phase1_done']);
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
    await first.service.startPhase1(partial);
    expect(first.service.progress).toMatchObject({ loaded: 20, total: 20 });
    await first.service.close();

    const second = harness(run, indexDir);
    expect(await second.service.open(opened.dbUuid)).toEqual({
      dbUuid: opened.dbUuid,
      created: false,
      replaced: false,
    });
    await second.service.startPhase1(scan);
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
      expect(other.logs.map((l) => l.code)).toEqual(['index.replaced', 'index.created']);
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
    await h.service.startPhase1(scan);
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
    await h.service.startPhase1(scan);
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
    await h.service.startPhase1(scan);
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
    await h.service.startPhase1(scanRun(realpathSync(run)));
    expect(dbPartition(h.service.dbPath)).toEqual([['aaaa'], ['bbbb']]);
    await h.service.close();
  });

  it('stops writing once the generation has moved on', async () => {
    const { run, indexDir } = exportAt('stale', 10);
    const h = harness(run, indexDir);
    await h.service.open(null);
    h.setCurrent(false);
    await h.service.startPhase1(scanRun(run));
    expect(h.service.progress.phase).toBe('failed');
    const n = dbRows(h.service.dbPath, 'SELECT count(*) AS n FROM pairs')[0]?.n;
    expect(Number(n)).toBe(0);
    expect(h.logs.map((l) => l.code)).toContain('writer.stale_dropped');
    expect(h.logs.find((l) => l.code === 'index.phase1_failed')?.data.reason).toBe(
      'stale_generation',
    );
    await h.service.close();
  });
});

describe('an unavailable export', () => {
  it('opens only its own existing index, for browsing, and creates or deletes nothing', async () => {
    const { run, indexDir } = exportAt('offline', 10);
    const first = harness(run, indexDir);
    const opened = await first.service.open(null);
    await first.service.startPhase1(scanRun(run));
    await first.service.close();
    const before = readdirSync(indexDir).sort();

    const browse = harness('', indexDir);
    expect(await browse.service.open(opened.dbUuid, false)).toMatchObject({
      dbUuid: opened.dbUuid,
      created: false,
    });
    expect(browse.service.progress.phase).toBe('unavailable');
    expect(((await browse.service.ask({ op: 'totals' })) as IndexTotals).messages).toBe(10);
    await browse.service.close();

    for (const uuid of ['00000000-0000-4000-8000-00000000abcd', null]) {
      const other = harness('', indexDir);
      await expect(other.service.open(uuid, false)).rejects.toMatchObject({ code: 'NO_INDEX' });
      await other.service.close();
      expect(readdirSync(indexDir).sort()).toEqual(before);
    }
    const kept = dbRows(
      join(indexDir, `${STAMP.sourceKey}.sqlite`),
      "SELECT value FROM source_meta WHERE key = 'db_uuid'",
    );
    expect(kept[0]?.value).toBe(opened.dbUuid);

    rmSync(indexDir, { recursive: true });
    const none = harness('', indexDir);
    await expect(none.service.open(opened.dbUuid, false)).rejects.toMatchObject({
      code: 'NO_INDEX',
    });
    expect(readdirSync(indexDir)).toEqual([]);
    await none.service.close();
  });
});

describe('when idle', () => {
  it('ends the pool after phase 1 and releases both caches after the idle time', async () => {
    const { run, indexDir } = exportAt('idle', 10);
    const h = harness(run, indexDir, { idleMs: 60_000 });
    await h.service.open(null);
    await h.service.startPhase1(scanRun(run));
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
