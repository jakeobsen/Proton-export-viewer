// SPDX-License-Identifier: AGPL-3.0-or-later
// The index's lifecycle in core, with its threads run in this process: damage
// found on open, by the check or by SQLite at any time, and the index torn
// down and deleted under the source's lock; Forget and Reset; and the races
// between them. The export is never changed.

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { descriptorsOn } from '../../src/core/index/family';
import type { CheckResult } from '../../src/core/index/ops';
import {
  THREAD_STOPPED,
  ThreadError,
  type IndexThread,
  type ThreadRole,
} from '../../src/core/index/pool';
import { SCHEMA_VERSION } from '../../src/core/index/schema';
import type { IndexOptions } from '../../src/core/index/service';
import { SourceSession } from '../../src/core/source';
import type { CoreEvent, CoreRequest, CoreResult } from '../../src/shared/core-protocol';
import type { IndexTotals } from '../../src/shared/index-types';
import type { Logger } from '../../src/shared/log/writer';
import { sanitizeEvent } from '../../src/shared/log/schema';
import type { Stamp } from '../../src/shared/sources';
import { digest } from '../../tools/gen-export/tree.mjs';
import { writeExport } from '../exports';
import { InlineThread, damageTablePage } from '../index-helpers';
import { testDir } from '../paths';

const KEY = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

interface Logged {
  level: string;
  code: string;
  data: Record<string, unknown>;
  src: string | undefined;
}

/** A check thread the test answers: it reports `onStop` if it is ended while it runs. */
class HeldCheck implements IndexThread {
  respawns = 0;
  onRespawn: (() => void) | null = null;
  stopped = false;
  private pending: { resolve: (r: CheckResult) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly onStop: CheckResult | null = null) {}

  get running(): boolean {
    return this.pending !== null;
  }

  call<T>(): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending = { resolve: resolve as (r: CheckResult) => void, reject };
    });
  }

  finish(result: CheckResult): void {
    this.pending?.resolve(result);
    this.pending = null;
  }

  stop(): Promise<void> {
    this.stopped = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      // A completion that arrives just as the teardown ends the thread.
      if (this.onStop) pending.resolve(this.onStop);
      else pending.reject(new ThreadError(THREAD_STOPPED));
    }
    return Promise.resolve();
  }
}

/** A query thread that starts reporting SQLite corruption once told to. */
class CorruptingQuery extends InlineThread {
  corrupt = false;

  constructor() {
    super('query');
  }

  override call<T>(op: string, args: unknown = {}, timeoutMs = 0): Promise<T> {
    if (this.corrupt && op === 'query') return Promise.reject(new ThreadError('INDEX_CORRUPT'));
    return super.call<T>(op, args, timeoutMs);
  }
}

interface CoreOptions {
  root: string | null;
  indexDir: string;
  generation?: number;
  sourceKey?: string;
  check?: HeldCheck;
  query?: CorruptingQuery;
  options?: IndexOptions;
  /** Other exports the app knows. */
  exports?: string[];
  /** Runs as each writer operation reaches the writer thread, before it starts. */
  atWriter?: (op: string) => void;
}

let reqSeq = 0;

function core(o: CoreOptions) {
  const replies: CoreResult[] = [];
  const events: CoreEvent[] = [];
  const logs: Logged[] = [];
  const push =
    (level: string) =>
    (code: string, data: Record<string, unknown> = {}, meta?: { src?: string }) => {
      const event = sanitizeEvent({ level: level as 'info', proc: 'core', code, data });
      expect(event, code).not.toBeNull();
      expect(event!.data.dropped, `${code} ${JSON.stringify(data)}`).toBeUndefined();
      logs.push({ level, code, data, src: meta?.src });
    };
  const log: Logger = {
    log: (level, code, data, meta) => push(level)(code, data, meta),
    error: push('error'),
    warn: push('warn'),
    info: push('info'),
  };
  const stamp: Stamp = { sourceKey: o.sourceKey ?? KEY, generation: o.generation ?? 1 };
  const thread = (role: ThreadRole): IndexThread => {
    if (role === 'verify' && o.check) return o.check;
    if (role === 'query' && o.query) return o.query;
    if (role === 'writer' && o.atWriter) {
      const at = o.atWriter;
      return new InlineThread(role, (op) => (at(op), false));
    }
    return new InlineThread(role);
  };
  const session = new SourceSession(
    { ...stamp, root: o.root },
    log,
    (r) => replies.push(r),
    {
      dir: o.indexDir,
      thread,
      ...(o.options ? { options: o.options } : {}),
      ...(o.exports ? { exports: o.exports } : {}),
    },
    (e) => events.push(e),
  );
  const send = async (request: CoreRequest): Promise<CoreResult> => {
    if (request.type === 'forget') void session.forget(request);
    else if (request.type === 'reset') void session.reset(request);
    else session.handle(request as Parameters<SourceSession['handle']>[0]);
    let reply: CoreResult | undefined;
    await until(() => (reply = replies.find((r) => r.reqId === request.reqId)) !== undefined);
    return reply!;
  };
  const openIndex = (dbUuid: string | null, rebuild = false) =>
    send({ type: 'index', reqId: ++reqSeq, stamp, dbUuid, ...(rebuild ? { rebuild } : {}) });
  const query = (q: Parameters<SourceSession['handle']>[0] & { type: 'index-query' }) => send(q);
  const totals = async () => {
    const r = await query({ type: 'index-query', reqId: ++reqSeq, stamp, query: { op: 'totals' } });
    return r.ok ? (r.answer as IndexTotals) : r.code;
  };
  const forget = (sourceKey = stamp.sourceKey) =>
    send({ type: 'forget', reqId: ++reqSeq, sourceKey });
  const reset = () => send({ type: 'reset', reqId: ++reqSeq });
  const dbPath = join(o.indexDir, `${stamp.sourceKey}.sqlite`);
  return { session, replies, events, logs, stamp, send, openIndex, totals, forget, reset, dbPath };
}

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

function exportAt(name: string, messages = 30, seed = 11) {
  const dir = realpathSync(testDir(name));
  const written = writeExport(join(dir, 'export'), { seed, messages });
  return {
    root: join(dir, 'export'),
    run: realpathSync(written.run),
    indexDir: join(dir, 'userdata', 'index'),
    pairs: written.pairs,
  };
}

const family = (indexDir: string, key = KEY) =>
  existsSync(indexDir) ? readdirSync(indexDir).filter((n) => n.startsWith(key)) : [];

/** Builds a source's index to the end of phase 1, closes it, and returns its identity. */
async function built(run: string, indexDir: string, sourceKey = KEY): Promise<string> {
  const c = core({ root: run, indexDir, sourceKey });
  const opened = await c.openIndex(null);
  expect(opened).toMatchObject({ ok: true });
  await c.session.index!.settled();
  const uuid = opened.ok ? opened.index!.dbUuid : '';
  await c.session.close();
  return uuid;
}

describe('an index found damaged on open', () => {
  const cases: Array<[string, (dbPath: string, indexDir: string) => Promise<void>]> = [
    ['truncated', (dbPath) => Promise.resolve(truncateSync(dbPath, 1500))],
    [
      'with a garbage header',
      (dbPath) => {
        const fd = openSync(dbPath, 'r+');
        writeSync(fd, Buffer.alloc(100, 0x5a), 0, 100, 0);
        closeSync(fd);
        return Promise.resolve();
      },
    ],
    [
      'swapped for another source’s index',
      async (dbPath, indexDir) => {
        const other = exportAt('lc-swap-other', 5, 12);
        await built(other.run, indexDir, OTHER);
        copyFileSync(join(indexDir, `${OTHER}.sqlite`), dbPath);
      },
    ],
    [
      'of another schema version',
      (dbPath) => {
        const db = new DatabaseSync(dbPath);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        db.close();
        return Promise.resolve();
      },
    ],
  ];
  const reasons: Record<string, string> = {
    truncated: 'corrupt',
    with: 'corrupt',
    swapped: 'identity',
    of: 'schema',
  };
  for (const [name, damage] of cases) {
    it(`is rebuilt when ${name}`, async () => {
      const { run, root, indexDir, pairs } = exportAt(`lc-open-${name.split(' ')[0]}`);
      const before = digest(root);
      const uuid = await built(run, indexDir);
      await damage(join(indexDir, `${KEY}.sqlite`), indexDir);

      const c = core({ root: run, indexDir, generation: 2 });
      const opened = await c.openIndex(uuid);
      expect(opened).toMatchObject({ ok: true, index: { created: true, replaced: true } });
      expect(opened.ok && opened.index!.dbUuid).not.toBe(uuid);
      expect(opened.ok && opened.progress?.condition).toBe('rebuilding');
      expect(c.logs.find((l) => l.code === 'index.damaged')?.data).toEqual({
        reason: reasons[name.split(' ')[0]!],
      });
      await c.session.index!.settled();
      expect(await c.totals()).toMatchObject({ messages: pairs, pairs });
      expect(c.session.index!.progress.condition).toBe('ok');
      expect(c.events.map((e) => [e.progress.condition, e.damaged])).toEqual([['ok', false]]);
      await c.session.close();
      expect(digest(root)).toBe(before);
    });
  }
});

describe('an index found damaged by the check', () => {
  it('is torn down and deleted, and main is told; a rebuild then fills a new one', async () => {
    const { run, root, indexDir, pairs } = exportAt('lc-page');
    const before = digest(root);
    const uuid = await built(run, indexDir);
    const page = damageTablePage(join(indexDir, `${KEY}.sqlite`), 'messages');
    expect(page).toBeGreaterThan(1);

    const check = new HeldCheck();
    const c = core({ root: run, indexDir, generation: 2, check });
    const opened = await c.openIndex(uuid);
    // The list shows from the index while it is checked.
    expect(opened).toMatchObject({
      ok: true,
      index: { created: false },
      progress: { condition: 'verifying' },
    });
    await until(() => check.running);
    // The real check, in this thread, on the damaged file.
    const { quickCheck } = await import('../../src/core/index/ops');
    const result = quickCheck(c.dbPath, uuid);
    expect(result).toEqual({ ok: false, reason: 'quick_check' });
    check.finish(result);

    await until(() => c.events.some((e) => e.damaged));
    expect(c.events.at(-1)).toMatchObject({
      stamp: c.stamp,
      damaged: true,
      progress: { condition: 'rebuilding' },
    });
    expect(c.logs.filter((l) => l.code === 'index.damaged').map((l) => l.data)).toEqual([
      { reason: 'quick_check' },
    ]);
    expect(c.logs.some((l) => l.code === 'index.deleted')).toBe(true);
    expect(family(indexDir)).toEqual([]);
    expect(c.session.connections.size).toBe(0);
    expect(await c.totals()).toBe('no_index');

    // Main reopens the source under a new generation to rebuild it.
    const again = core({ root: run, indexDir, generation: 3 });
    const rebuilt = await again.openIndex(null, true);
    expect(rebuilt).toMatchObject({
      ok: true,
      index: { created: true, replaced: false },
      progress: { condition: 'rebuilding' },
    });
    await again.session.index!.settled();
    expect(await again.totals()).toMatchObject({ messages: pairs });
    expect(again.session.index!.progress.condition).toBe('ok');
    await again.session.close();
    expect(digest(root)).toBe(before);
  });

  it('is found by SQLite at any time: queries stop at once, and it is deleted', async () => {
    const { run, indexDir } = exportAt('lc-corrupt');
    const query = new CorruptingQuery();
    const c = core({ root: run, indexDir, query });
    await c.openIndex(null);
    await c.session.index!.settled();
    expect(await c.totals()).toMatchObject({ messages: 30 });
    query.corrupt = true;
    expect(await c.totals()).toBe('damaged');
    await until(() => c.events.some((e) => e.damaged));
    expect(c.logs.filter((l) => l.code === 'index.damaged').map((l) => l.data)).toEqual([
      { reason: 'corrupt' },
    ]);
    expect(family(indexDir)).toEqual([]);
    expect(c.session.connections.size).toBe(0);
  });

  it('is deleted while the export is unavailable, and waits for it to rebuild', async () => {
    const { run, indexDir } = exportAt('lc-offline');
    const uuid = await built(run, indexDir);
    damageTablePage(join(indexDir, `${KEY}.sqlite`), 'thread_labels');
    const check = new HeldCheck();
    const c = core({ root: null, indexDir, generation: 2, check });
    expect(await c.openIndex(uuid)).toMatchObject({ ok: true, progress: { phase: 'unavailable' } });
    await until(() => check.running);
    check.finish({ ok: false, reason: 'quick_check' });
    await until(() => c.events.some((e) => e.damaged));
    expect(c.events.at(-1)?.progress.condition).toBe('damaged');
    expect(family(indexDir)).toEqual([]);
    // Nothing is created while the export can't be read.
    expect(await c.openIndex(null)).toMatchObject({ ok: false });
    expect(family(indexDir)).toEqual([]);
  });

  it('is deleted, unavailable, when the file there is not this index', async () => {
    const { run, indexDir } = exportAt('lc-offline-swap');
    const uuid = await built(run, indexDir);
    const c = core({ root: null, indexDir, generation: 2 });
    expect(await c.openIndex('00000000-0000-4000-8000-00000000dead')).toMatchObject({
      ok: false,
      code: 'damaged',
    });
    expect(uuid).not.toBe('00000000-0000-4000-8000-00000000dead');
    expect(c.events.map((e) => [e.progress.condition, e.damaged])).toEqual([['damaged', true]]);
    expect(family(indexDir)).toEqual([]);
  });

  it('with a WAL from another index: no crash, the export unchanged, rebuilt if found', async () => {
    const { run, root, indexDir } = exportAt('lc-foreign-wal');
    const before = digest(root);
    const uuid = await built(run, indexDir);
    // Another index with the same schema, its last writes still in its WAL.
    const other = exportAt('lc-foreign-wal-other', 12, 13);
    const o = core({ root: other.run, indexDir, sourceKey: OTHER });
    await o.openIndex(null);
    await o.session.index!.settled();
    copyFileSync(join(indexDir, `${OTHER}.sqlite-wal`), join(indexDir, `${KEY}.sqlite-wal`));
    await o.session.close();

    const check = new HeldCheck();
    const c = core({ root: run, indexDir, generation: 2, check });
    const opened = await c.openIndex(uuid);
    expect(opened.ok).toBe(true);
    if (opened.ok && !opened.index!.created) {
      await until(() => check.running);
      const { quickCheck } = await import('../../src/core/index/ops');
      check.finish(quickCheck(c.dbPath, uuid));
      await until(
        () => c.session.index === null || c.session.index.progress.condition !== 'verifying',
      );
    }
    const found = c.logs.some((l) => l.code === 'index.damaged');
    if (found) {
      // Either replaced on open, or torn down and deleted for a rebuild.
      expect(
        opened.ok && opened.index!.created ? 'replaced' : c.events.at(-1)?.damaged,
      ).toBeTruthy();
    }
    if (c.session.index) await c.session.close();
    expect(digest(root)).toBe(before);
  });
});

describe('the lifecycle lock', () => {
  it('drops a check completion that queued while a teardown joined its thread', async () => {
    const { run, root, indexDir } = exportAt('lc-join');
    const before = digest(root);
    const uuid = await built(run, indexDir);
    // The check reports damage just as Forget's teardown ends its thread.
    const check = new HeldCheck({ ok: false, reason: 'quick_check' });
    const c = core({ root: run, indexDir, generation: 2, check });
    await c.openIndex(uuid);
    await until(() => check.running);
    expect(await c.forget()).toMatchObject({ ok: true });
    expect(check.stopped).toBe(true);
    await until(() => c.logs.some((l) => l.code === 'index.stale_dropped'));
    expect(c.logs.some((l) => l.code === 'index.damaged')).toBe(false);
    expect(c.events.filter((e) => e.damaged)).toEqual([]);
    expect(family(indexDir)).toEqual([]);
    expect(c.session.connections.size).toBe(0);
    expect(digest(root)).toBe(before);
  });

  it('lets Forget cancel a recovery queued before it', async () => {
    const { run, indexDir } = exportAt('lc-forget-recovery');
    const query = new CorruptingQuery();
    const c = core({ root: run, indexDir, query });
    await c.openIndex(null);
    await c.session.index!.settled();
    // Hold the lock, so the recovery queues behind it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    void c.session.lock.run(() => held);
    query.corrupt = true;
    expect(await c.totals()).toBe('damaged');
    const forgot = c.forget();
    release();
    expect(await forgot).toMatchObject({ ok: true });
    expect(c.logs.some((l) => l.code === 'index.stale_dropped')).toBe(true);
    expect(c.events.filter((e) => e.damaged)).toEqual([]);
    expect(family(indexDir)).toEqual([]);
    // Nothing of it opens again in this core.
    expect(await c.openIndex(null)).toMatchObject({ ok: false, code: 'closed' });
    expect(family(indexDir)).toEqual([]);
  });

  it("drops a late check failure for one source after a switch, and leaves the next one's files alone", async () => {
    const a = exportAt('lc-switch-a', 10, 14);
    const indexDir = a.indexDir;
    const uuidA = await built(a.run, indexDir);
    const check = new HeldCheck({ ok: false, reason: 'quick_check' });
    const coreA = core({ root: a.run, indexDir, generation: 2, check });
    await coreA.openIndex(uuidA);
    await until(() => check.running);
    // The switch tears A down; its check reports damage as it is ended.
    await coreA.session.close();
    await until(() => coreA.logs.some((l) => l.code === 'index.stale_dropped'));

    const b = exportAt('lc-switch-b', 10, 15);
    const coreB = core({ root: b.run, indexDir, generation: 3, sourceKey: OTHER });
    await coreB.openIndex(null);
    await coreB.session.index!.settled();
    expect(await coreB.totals()).toMatchObject({ messages: 10 });
    expect(coreA.events.filter((e) => e.damaged)).toEqual([]);
    expect(family(indexDir, KEY)).toContain(`${KEY}.sqlite`);
    expect(family(indexDir, OTHER)).toContain(`${OTHER}.sqlite`);
    await coreB.session.close();
  });

  it('closes to opens queued before and after a reset, and tears the index down first', async () => {
    const { run, indexDir } = exportAt('lc-reset');
    const c = core({ root: run, indexDir });
    await c.openIndex(null);
    await c.session.index!.settled();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    void c.session.lock.run(() => held);
    const queuedBefore = c.openIndex(null);
    const reset = c.reset();
    const queuedAfter = c.openIndex(null);
    release();
    expect(await queuedBefore).toMatchObject({ ok: false, code: 'closed' });
    expect(await reset).toMatchObject({ ok: true });
    expect(await queuedAfter).toMatchObject({ ok: false, code: 'closed' });
    expect(c.session.index).toBeNull();
    expect(c.session.connections.size).toBe(0);
    expect(descriptorsOn(c.dbPath)).toBe(0);
  });

  it('makes a queued recovery do nothing: the reset tears the index down, and nothing opens after it', async () => {
    const { run, indexDir } = exportAt('lc-reset-recovery');
    const query = new CorruptingQuery();
    const c = core({ root: run, indexDir, query });
    await c.openIndex(null);
    await c.session.index!.settled();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    void c.session.lock.run(() => held);
    query.corrupt = true;
    expect(await c.totals()).toBe('damaged');
    const reset = c.reset();
    const open = c.openIndex(null, true);
    release();
    expect(await reset).toMatchObject({ ok: true });
    expect(await open).toMatchObject({ ok: false, code: 'closed' });
    // The recovery was queued first, but the reset had closed core: it was
    // dropped, so nothing was deleted or reported. The reset tore the index
    // down; deleting the app's data is main's part of it.
    expect(c.events.filter((e) => e.damaged)).toEqual([]);
    expect(c.logs.some((l) => l.code === 'index.damaged' || l.code === 'index.deleted')).toBe(
      false,
    );
    expect(c.logs.some((l) => l.code === 'index.stale_dropped')).toBe(true);
    expect(c.session.index).toBeNull();
    expect(c.session.connections.size).toBe(0);
    expect(family(indexDir)).toContain(`${KEY}.sqlite`);
  });
});

describe('an index folder that overlaps an export', () => {
  it('is never written or deleted when another export holds it', async () => {
    const { run, indexDir } = exportAt('lc-overlap-holds');
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, `${OTHER}.sqlite`), 'x');
    const c = core({ root: run, indexDir, exports: [dirname(indexDir)] });
    expect(await c.openIndex(null)).toMatchObject({ ok: false, code: 'closed' });
    expect(await c.forget(OTHER)).toMatchObject({ ok: false, code: 'busy' });
    expect(c.logs.filter((l) => l.level === 'warn').map((l) => [l.code, l.data])).toEqual([
      ['index.open_refused', { reason: 'overlap' }],
      ['index.delete_refused', { reason: 'overlap' }],
    ]);
    expect(readdirSync(indexDir)).toEqual([`${OTHER}.sqlite`]);
  });

  it('is never written or deleted when the open export lies inside it', async () => {
    const dir = realpathSync(testDir('lc-overlap-inside'));
    const indexDir = join(dir, 'index');
    const written = writeExport(join(indexDir, 'nested'), { seed: 13, messages: 4 });
    const before = digest(join(indexDir, 'nested'));
    const c = core({ root: realpathSync(written.run), indexDir });
    expect(await c.openIndex(null)).toMatchObject({ ok: false, code: 'closed' });
    expect(await c.forget()).toMatchObject({ ok: false, code: 'busy' });
    expect(readdirSync(indexDir)).toEqual(['nested']);
    expect(digest(join(indexDir, 'nested'))).toBe(before);
  });
});

describe('an export that comes to overlap the index folder later', () => {
  /** A known export's folder, reached through a link that the test points elsewhere. */
  function linked(name: string) {
    const { run, indexDir } = exportAt(name);
    mkdirSync(dirname(indexDir), { recursive: true });
    const dir = dirname(dirname(indexDir));
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    const link = join(dir, 'known');
    symlinkSync(elsewhere, link);
    const point = (to: string) => {
      rmSync(link);
      symlinkSync(to, link);
    };
    return { run, indexDir, link, point, away: () => point(elsewhere) };
  }

  it('is looked at again right before an open', async () => {
    const { run, indexDir, link, point, away } = linked('lc-overlap-open');
    const c = core({ root: run, indexDir, exports: [link] });
    // The known export now resolves to the folder that holds the index folder.
    point(dirname(indexDir));
    expect(await c.openIndex(null)).toMatchObject({ ok: false, code: 'closed' });
    expect(family(indexDir)).toEqual([]);
    away();
    expect(await c.openIndex(null)).toMatchObject({ ok: true });
    await c.session.index!.settled();
    expect(c.logs.filter((l) => l.code === 'index.open_refused')).toHaveLength(1);
  });

  it('is looked at again right before a delete', async () => {
    const { run, indexDir, link, point, away } = linked('lc-overlap-delete');
    const c = core({ root: run, indexDir, exports: [link] });
    expect(await c.openIndex(null)).toMatchObject({ ok: true });
    await c.session.index!.settled();
    writeFileSync(join(indexDir, `${OTHER}.sqlite`), 'x');
    point(indexDir);
    expect(await c.forget(OTHER)).toMatchObject({ ok: false, code: 'busy' });
    expect(c.logs.find((l) => l.code === 'index.delete_refused')?.data).toEqual({
      reason: 'overlap',
    });
    expect(family(indexDir, OTHER)).toEqual([`${OTHER}.sqlite`]);
    away();
    expect(await c.forget(OTHER)).toMatchObject({ ok: true });
    expect(family(indexDir, OTHER)).toEqual([]);
  });

  /** Points the link at `to` once, as the writer gets the open, after core's own check. */
  const onceAtOpen = (point: () => void) => {
    let done = false;
    return (op: string) => {
      if (op === 'open' && !done) {
        done = true;
        point();
      }
    };
  };

  it('is looked at again by the writer before it opens an index for writing', async () => {
    const { run, indexDir, link, point, away } = linked('lc-overlap-writer-open');
    const uuid = await built(run, indexDir);
    const files = family(indexDir);
    const bytes = readFileSync(join(indexDir, `${KEY}.sqlite`));
    const c = core({
      root: run,
      indexDir,
      exports: [link],
      atWriter: onceAtOpen(() => point(dirname(indexDir))),
    });
    expect(await c.openIndex(uuid)).toMatchObject({ ok: false, code: 'closed' });
    expect(c.logs.find((l) => l.code === 'index.open_refused')?.data).toEqual({
      reason: 'overlap',
    });
    // Not opened for writing: no sidecar was made and the file is unchanged.
    expect(family(indexDir)).toEqual(files);
    expect(readFileSync(join(indexDir, `${KEY}.sqlite`)).equals(bytes)).toBe(true);
    expect(c.session.connections.size).toBe(0);
    away();
    expect(await c.openIndex(uuid)).toMatchObject({ ok: true, index: { dbUuid: uuid } });
    await c.session.index!.settled();
  });

  it('is looked at again by the writer before it replaces an index', async () => {
    const { run, indexDir, link, point, away } = linked('lc-overlap-writer-replace');
    mkdirSync(indexDir, { recursive: true });
    // Not a database: the writer would delete it and make a new index there.
    writeFileSync(join(indexDir, `${KEY}.sqlite`), 'not a database');
    const c = core({
      root: run,
      indexDir,
      exports: [link],
      atWriter: onceAtOpen(() => point(indexDir)),
    });
    expect(await c.openIndex(null)).toMatchObject({ ok: false, code: 'closed' });
    expect(c.logs.find((l) => l.code === 'index.open_refused')?.data).toEqual({
      reason: 'overlap',
    });
    expect(family(indexDir)).toEqual([`${KEY}.sqlite`]);
    expect(readFileSync(join(indexDir, `${KEY}.sqlite`), 'utf8')).toBe('not a database');
    away();
    expect(await c.openIndex(null)).toMatchObject({ ok: true, index: { created: true } });
    await c.session.index!.settled();
    expect(
      readFileSync(join(indexDir, `${KEY}.sqlite`))
        .subarray(0, 15)
        .toString(),
    ).toBe('SQLite format 3');
  });
});

describe('Forget', () => {
  it('during phase 1 leaves no file of the index, and late work recreates none', async () => {
    const { run, root, indexDir } = exportAt('lc-forget', 400, 16);
    const before = digest(root);
    const c = core({ root: run, indexDir, options: { metaJob: 5 } });
    await c.openIndex(null);
    await until(() => (c.session.index?.progress.loaded ?? 0) > 0);
    expect(c.session.index!.progress.phase).toBe('loading');
    expect(await c.forget()).toMatchObject({ ok: true });
    expect(family(indexDir)).toEqual([]);
    expect(c.session.connections.size).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(family(indexDir)).toEqual([]);
    expect(await c.openIndex(null)).toMatchObject({ ok: false, code: 'closed' });
    expect(family(indexDir)).toEqual([]);
    expect(digest(root)).toBe(before);
  });

  it('deletes another source’s index only while nothing holds it', async () => {
    const a = exportAt('lc-forget-other', 8, 17);
    await built(a.run, a.indexDir, OTHER);
    const c = core({ root: a.run, indexDir: a.indexDir });
    await c.openIndex(null);
    await c.session.index!.settled();
    const otherDb = join(a.indexDir, `${OTHER}.sqlite`);
    const fd = openSync(otherDb, 'r');
    try {
      expect(await c.forget(OTHER)).toMatchObject({ ok: false, code: 'busy' });
      expect(c.logs.find((l) => l.code === 'index.delete_refused')?.data).toEqual({
        reason: 'in_use',
      });
      expect(family(a.indexDir, OTHER)).toContain(`${OTHER}.sqlite`);
    } finally {
      closeSync(fd);
    }
    // Nor while core lists a connection on it.
    const entry = c.session.connections.add({ role: 'query', dbPath: otherDb });
    expect(await c.forget(OTHER)).toMatchObject({ ok: false, code: 'busy' });
    c.session.connections.remove(entry);
    expect(await c.forget(OTHER)).toMatchObject({ ok: true });
    expect(family(a.indexDir, OTHER)).toEqual([]);
    // The open source is untouched.
    expect(await c.totals()).toMatchObject({ messages: 8 });
    await c.session.close();
  });
});

describe('the writer', () => {
  it('rolls back the write in flight when the index is torn down', async () => {
    const { WriterState } = await import('../../src/core/index/ops');
    const { newPair, STAMP } = await import('../index-helpers');
    const dir = realpathSync(testDir('lc-cancel'));
    const cancel = new SharedArrayBuffer(4);
    const w = new WriterState();
    const dbPath = join(dir, 'x.sqlite');
    w.open({ dbPath, stamp: STAMP, expectedUuid: null, capBytes: null, cancel });
    Atomics.store(new Int32Array(cancel), 0, 1);
    expect(() => w.apply(STAMP, [newPair('m1')])).toThrow('CANCELLED');
    // Nothing was registered: the pair is still new to the index.
    expect(w.plan(new Map([['m1', newPair('m1').files.meta!]]), new Map()).changes).toEqual([
      newPair('m1').change,
    ]);
    w.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('closes a candidate whose setup fails after its identity matched', async () => {
    if (process.getuid?.() === 0) return;
    const { WriterState } = await import('../../src/core/index/ops');
    const { STAMP } = await import('../index-helpers');
    const { chmodSync } = await import('node:fs');
    const dir = realpathSync(testDir('lc-candidate'));
    const dbPath = join(dir, 'x.sqlite');
    const first = new WriterState();
    const uuid = first.open({ dbPath, stamp: STAMP, expectedUuid: null, capBytes: null }).uuid;
    first.close();
    expect(readdirSync(dir)).toEqual(['x.sqlite']);
    // The folder turns read-only: the identity still matches, but the WAL
    // can't be opened, so setting the connection up fails.
    chmodSync(dir, 0o500);
    try {
      for (let i = 0; i < 20; i += 1) {
        expect(() =>
          new WriterState().open({ dbPath, stamp: STAMP, expectedUuid: uuid, capBytes: null }),
        ).toThrow();
        expect(descriptorsOn(dbPath)).toBe(0);
      }
    } finally {
      chmodSync(dir, 0o700);
    }
    const again = new WriterState();
    expect(again.open({ dbPath, stamp: STAMP, expectedUuid: uuid, capBytes: null })).toMatchObject({
      uuid,
      created: false,
    });
    again.close();
  });
});
