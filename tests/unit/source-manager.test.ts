// SPDX-License-Identifier: AGPL-3.0-or-later
// Opening and switching export sources in main: the order of scope and core
// steps, generations, unavailable sources and Locate. Core is a stand-in that
// computes the real run identity.

import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runIdentity } from '../../src/core/identity';
import type { CoreRequest, CoreResult, CoreSource } from '../../src/shared/core-protocol';
import type { Logger } from '../../src/shared/log/writer';
import type { IndexCondition, IndexProgress } from '../../src/shared/index-types';
import type { ScanSummary, Stamp } from '../../src/shared/sources';
import {
  STALE,
  SourceManager,
  type CoreControl,
  type OrderStep,
} from '../../src/main/sources/manager';
import { ScopeError, type Picked, type Scopes } from '../../src/main/sources/scope';
import { digest } from '../../tools/gen-export/tree.mjs';
import { testDir } from '../paths';

type Call = CoreRequest extends infer R ? (R extends unknown ? Omit<R, 'reqId'> : never) : never;

const SUMMARY: ScanSummary = {
  pairs: 0,
  metadataOnly: 0,
  emlOnly: 0,
  labels: true,
  ignored: 0,
  rejected: {
    symlink: 0,
    directory: 0,
    fifo: 0,
    socket: 0,
    device: 0,
    other_type: 0,
    too_large: 0,
    changed: 0,
    unreadable: 0,
  },
};

const PROGRESS: IndexProgress = {
  phase: 'loading',
  loaded: 0,
  total: 0,
  failed: 0,
  timeouts: 0,
  capped: 0,
  condition: 'ok',
  bodyPhase: 'waiting',
  bodiesDone: 0,
  bodiesTotal: 0,
  bodiesFailed: 0,
};

class FakeCore implements CoreControl {
  running = false;
  next: CoreSource | null = null;
  current: CoreSource | null = null;
  readonly started: Array<CoreSource | null> = [];
  readonly calls: string[] = [];
  holdScans = false;
  readonly heldScans: Array<() => void> = [];
  /** Index reads held until the test answers them. */
  holdQueries = false;
  readonly heldQueries: Array<() => void> = [];
  /** Index opens, with what main asked for. */
  readonly indexCalls: Array<{ stamp: Stamp; dbUuid: string | null; rebuild: boolean }> = [];
  readonly forgets: string[] = [];
  /** Sources whose index core can't delete yet. */
  readonly busy = new Set<string>();
  resets = 0;
  /** Called when core is asked to reset or stopped, to see what was on disk then. */
  onReset: (() => void) | null = null;
  onStop: (() => void) | null = null;
  /** Called once a core has started. */
  onStarted: (() => void) | null = null;
  /** Starts that fail: core exits before it is ready, and says so through `onExit`. */
  failStarts = 0;
  /** Told when core exits on its own, with the source it had, as core-host does. */
  onExit: ((source: CoreSource | null) => void) | null = null;

  setSource(source: CoreSource | null) {
    this.next = source && { ...source };
  }

  start() {
    if (!this.running && this.failStarts > 0) {
      this.failStarts -= 1;
      this.onExit?.(this.next);
      return Promise.reject(new Error('core exited before it was ready'));
    }
    if (!this.running) {
      this.running = true;
      this.current = this.next;
      this.started.push(this.current);
      this.onStarted?.();
    }
    return Promise.resolve();
  }

  stop() {
    if (this.running) this.onStop?.();
    this.running = false;
    this.current = null;
    return Promise.resolve();
  }

  async startWith(source: CoreSource | null) {
    this.setSource(source);
    const stray = this.running && JSON.stringify(this.current) !== JSON.stringify(this.next);
    if (stray) await this.stop();
    await this.start();
    return stray;
  }

  /** Core ends on its own; returns the source it had. */
  crash(): CoreSource | null {
    const had = this.current;
    this.running = false;
    this.current = null;
    return had;
  }

  /** Calls made while no core was up for their stamp. */
  refused = 0;

  requestRunning(call: Call, stamp: Stamp | null): Promise<CoreResult> {
    const src = this.current;
    const same =
      src === null || stamp === null
        ? src === stamp
        : src.sourceKey === stamp.sourceKey && src.generation === stamp.generation;
    if (!this.running || !same) {
      this.refused += 1;
      return Promise.reject(new Error('core unavailable'));
    }
    return this.request(call);
  }

  async request(call: Call): Promise<CoreResult> {
    await this.start();
    const src = this.current;
    this.calls.push(call.type);
    const fail = (code: 'unavailable' | 'invalid'): CoreResult => ({
      type: 'result',
      reqId: 0,
      ok: false,
      code,
    });
    if (call.type === 'forget') {
      this.forgets.push(call.sourceKey);
      return this.busy.has(call.sourceKey)
        ? { type: 'result', reqId: 0, ok: false, code: 'busy' }
        : { type: 'result', reqId: 0, ok: true };
    }
    if (call.type === 'reset') {
      this.resets += 1;
      this.onReset?.();
      return { type: 'result', reqId: 0, ok: true };
    }
    if (!src?.root) return fail('unavailable');
    const stamp = { sourceKey: src.sourceKey, generation: src.generation };
    if (call.type === 'index') {
      const rebuild = call.rebuild === true;
      this.indexCalls.push({ stamp: call.stamp, dbUuid: call.dbUuid, rebuild });
      const created = call.dbUuid === null;
      return {
        type: 'result',
        reqId: 0,
        ok: true,
        stamp,
        index: { dbUuid: call.dbUuid ?? randomUUID(), created, replaced: false },
        progress: { ...PROGRESS, condition: rebuild ? 'rebuilding' : created ? 'ok' : 'verifying' },
      };
    }
    if (call.type === 'identify') {
      const identity = await runIdentity(realpathSync(src.root));
      return { type: 'result', reqId: 0, ok: true, stamp, identity };
    }
    if (call.type === 'scan') {
      const result: CoreResult = { type: 'result', reqId: 0, ok: true, stamp, scan: SUMMARY };
      if (!this.holdScans) return result;
      return new Promise((resolve) => this.heldScans.push(() => resolve(result)));
    }
    if (call.type === 'index-query') {
      const result: CoreResult = {
        type: 'result',
        reqId: 0,
        ok: true,
        stamp,
        answer: call.query.op === 'search' ? ({ queryId: call.query.queryId } as never) : null,
        progress: PROGRESS,
      };
      if (!this.holdQueries) return result;
      return new Promise((resolve) => this.heldQueries.push(() => resolve(result)));
    }
    return fail('invalid');
  }
}

function setup(name: string, at?: string) {
  const userData = at ?? realpathSync(testDir(`${name}-ud`));
  const core = new FakeCore();
  const order: OrderStep[] = [];
  const picks: Array<Picked | null> = [];
  const failing = new Set<string>();
  const live = new Map<number, string | null>();
  let seq = 0;
  let generation = 1;
  let notified = 0;
  const lines: string[] = [];
  const push = (code: string, data?: unknown, meta?: unknown) =>
    lines.push(JSON.stringify({ code, data, meta }));
  const log: Logger = { log: (_l, c, d, m) => push(c, d, m), error: push, warn: push, info: push };
  const hooks: { onScopeStart?: () => void } = {};
  const scopes: Scopes = {
    start(bookmark) {
      hooks.onScopeStart?.();
      if (bookmark === null || failing.has(bookmark)) throw new ScopeError('test');
      seq += 1;
      const id = seq;
      // A scope is only ever started while no other is live.
      expect([...live.values()]).toEqual([]);
      live.set(id, bookmark);
      return { release: () => live.delete(id) };
    },
  };
  const make = () =>
    new SourceManager({
      userData,
      log,
      core,
      generation: () => generation,
      bumpGeneration: () => (generation += 1),
      notify: () => (notified += 1),
      picker: () => Promise.resolve(picks.shift() ?? null),
      scopes,
      record: (step) => order.push(step),
    });
  /** The next launch: the app quit (scope released, core gone) and starts again. */
  const relaunch = async (previous: SourceManager) => {
    previous.close();
    await core.stop();
    return make();
  };
  return {
    hooks,
    userData,
    core,
    order,
    picks,
    failing,
    live,
    lines,
    make,
    relaunch,
    manager: make(),
    generation: () => generation,
    notified: () => notified,
  };
}

/** A run folder with labels.json and metadata files `ids`. */
function runAt(path: string, ids: string[], labels = '{"Version":1}') {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'labels.json'), labels);
  for (const id of ids) {
    writeFileSync(join(path, `${id}.metadata.json`), `{"ID":"${id}"}`);
    writeFileSync(join(path, `${id}.eml`), `Subject: ${id}\r\n\r\n`);
  }
  return path;
}

/** An export tool folder with one account and two runs; the newer is first. */
function tool(name: string) {
  const root = realpathSync(testDir(name));
  runAt(join(root, 'secret.account@example.com', 'mail_20250630_120000'), ['a', 'b']);
  runAt(join(root, 'secret.account@example.com', 'mail_20250101_100000'), ['c']);
  return root;
}

const steps = (order: OrderStep[]) => order.map((s) => s.step);
const settle = () => new Promise((r) => setTimeout(r, 20));
/** How long a test waits for work the manager does in the background. */
const WAIT = { timeout: 10_000, interval: 5 };

/**
 * Waits until the index of the source opened at `generation` is open: the
 * last of the work an open leaves running (scan, then index).
 */
const indexOpened = (t: ReturnType<typeof setup>, generation: number) =>
  vi.waitFor(() => {
    const opened = t.lines
      .map((l) => JSON.parse(l) as { code: string; data: { generation?: number } })
      .some((e) => e.code === 'index.opened' && e.data.generation === generation);
    expect(opened).toBe(true);
  }, WAIT);

describe('opening a source', () => {
  it('starts the scope, then core with the newest run, and records the run identity', async () => {
    const t = setup('mgr-open');
    const root = tool('mgr-open-tool');
    expect(t.core.started).toEqual([]);
    t.picks.push({ path: root, bookmark: 'bm1' });
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('opened');
    expect(steps(t.order)).toEqual(['scope.start', 'core.spawn']);
    expect(t.order.every((s) => s.generation === 2)).toBe(true);
    const run = join(root, 'secret.account@example.com', 'mail_20250630_120000');
    expect(t.core.started).toEqual([
      { sourceKey: expect.any(String) as string, generation: 2, root: run },
    ]);
    expect(t.core.calls).toContain('identify');
    const view = t.manager.view();
    expect(view.active).toMatchObject({
      account: 'secret.account@example.com',
      runName: 'mail_20250630_120000',
      status: 'online',
    });
    expect(view.active?.runs.map((r) => [r.runName, r.current])).toEqual([
      ['mail_20250630_120000', true],
      ['mail_20250101_100000', false],
    ]);
    const source = t.manager.registry.source(view.active!.sourceKey)!;
    const identity = await runIdentity(run);
    expect(source).toMatchObject({
      rel: join('secret.account@example.com', 'mail_20250630_120000'),
      labelsSha256: identity.labelsSha256,
      namesSha256: identity.namesSha256,
      offline: false,
    });
    expect(t.manager.registry.active).toBe(source.sourceKey);
    expect([...t.live.values()]).toEqual(['bm1']);
    await vi.waitFor(() => expect(t.manager.scanSummary()).toEqual(SUMMARY), WAIT);
  });

  it('opens nothing for a cancelled dialog or a folder without runs', async () => {
    const t = setup('mgr-none');
    expect(await t.manager.restore()).toBeNull();
    expect(t.manager.view()).toEqual({ restoring: false, active: null, recent: [] });
    // With nothing to open, launch starts core without a source.
    expect(t.core.started).toEqual([null]);
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('canceled');
    t.picks.push({ path: realpathSync(testDir('mgr-none-empty')), bookmark: 'bm' });
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('no_export');
    expect(t.order).toEqual([]);
    expect(t.core.started).toEqual([null]);
    expect(t.generation()).toBe(1);
  });
});

describe('switching', () => {
  it('between sibling runs keeps the scope, restarts core and moves the generation', async () => {
    const t = setup('mgr-sibling');
    const root = tool('mgr-sibling-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const first = t.manager.stamp()!;
    t.order.length = 0;
    const older = t.manager.view().active!.runs[1]!;
    expect(await t.manager.switchRun(older.runId, t.generation())).toBe('opened');
    expect(steps(t.order)).toEqual(['core.stop', 'scope.keep', 'core.spawn']);
    const second = t.manager.stamp()!;
    expect(second.generation).toBe(first.generation + 1);
    expect(second.sourceKey).not.toBe(first.sourceKey);
    expect(t.core.started.at(-1)).toEqual({
      ...second,
      root: join(root, 'secret.account@example.com', 'mail_20250101_100000'),
    });
    // The pick's scope stayed active the whole time.
    expect([...t.live.values()]).toEqual(['bm1']);
    // Back to the first run: the same source, without a new identity check.
    t.core.calls.length = 0;
    const newer = t.manager.view().active!.runs[0]!;
    expect(await t.manager.switchRun(newer.runId, t.generation())).toBe('opened');
    expect(t.manager.stamp()).toEqual({
      sourceKey: first.sourceKey,
      generation: second.generation + 1,
    });
    expect(t.core.calls).not.toContain('identify');
  });

  it('between separate picks releases the old scope before it starts the new one', async () => {
    const t = setup('mgr-picks');
    const one = tool('mgr-picks-1');
    // The second pick is a run folder by itself.
    const two = runAt(join(realpathSync(testDir('mgr-picks-2')), 'mail_20250701_090000'), ['x']);
    t.picks.push({ path: one, bookmark: 'bm1' }, { path: two, bookmark: 'bm2' });
    await t.manager.chooseFolder(null, t.generation());
    const first = t.manager.stamp()!;
    const firstPick = t.order[0]!.pickId;
    t.order.length = 0;
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('opened');
    expect(steps(t.order)).toEqual(['core.stop', 'scope.release', 'scope.start', 'core.spawn']);
    expect(t.order[1]!.pickId).toBe(firstPick);
    expect(t.order[2]!.pickId).not.toBe(firstPick);
    expect(t.manager.stamp()!.generation).toBe(first.generation + 1);
    expect([...t.live.values()]).toEqual(['bm2']);
    expect(t.manager.view().active).toMatchObject({
      account: null,
      runName: 'mail_20250701_090000',
    });
    expect(t.manager.view().recent.length).toBe(2);
  });

  it('never starts core for an index read made during a switch', async () => {
    const t = setup('mgr-read-switch');
    const one = tool('mgr-read-switch-1');
    const two = runAt(join(realpathSync(testDir('mgr-read-switch-2')), 'mail_20250701_090000'), [
      'x',
    ]);
    t.picks.push({ path: one, bookmark: 'bm1' }, { path: two, bookmark: 'bm2' });
    await t.manager.chooseFolder(null, t.generation());
    const started = t.core.started.length;
    // The shell reads the list after core stopped and before the new one starts.
    let read: Promise<unknown> | null = null;
    t.hooks.onScopeStart = () => {
      read = t.manager.queryIndex({ op: 'sidebar' });
    };
    t.order.length = 0;
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('opened');
    expect(await read).toBeNull();
    expect(t.core.refused).toBe(1);
    // Only the switch started a core, with the new source; none was stopped as a stray.
    expect(t.core.started.length).toBe(started + 1);
    expect(t.core.started.at(-1)).toEqual({ ...t.manager.stamp()!, root: two });
    expect(steps(t.order)).toEqual(['core.stop', 'scope.release', 'scope.start', 'core.spawn']);
  });

  it('replaces a core that a request started with the old source during a switch', async () => {
    const t = setup('mgr-stray');
    const one = tool('mgr-stray-1');
    const two = runAt(join(realpathSync(testDir('mgr-stray-2')), 'mail_20250701_090000'), ['x']);
    t.picks.push({ path: one, bookmark: 'bm1' }, { path: two, bookmark: 'bm2' });
    await t.manager.chooseFolder(null, t.generation());
    const first = t.manager.stamp()!;
    // A request arrives after core stopped and before the new one starts.
    t.hooks.onScopeStart = () => void t.core.request({ type: 'ping' });
    t.order.length = 0;
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('opened');
    expect(t.core.started.at(-2)).toMatchObject({ sourceKey: first.sourceKey });
    expect(steps(t.order)).toEqual([
      'core.stop',
      'scope.release',
      'scope.start',
      'core.stop',
      'core.spawn',
    ]);
    expect(t.core.started.at(-1)).toEqual({ ...t.manager.stamp()!, root: two });
    expect(t.core.calls).toContain('identify');
    await vi.waitFor(() => expect(t.manager.scanSummary()).toEqual(SUMMARY), WAIT);
  });

  it('drops a scan result that arrives in main after a switch', async () => {
    const t = setup('mgr-late');
    const root = tool('mgr-late-tool');
    t.core.holdScans = true;
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await vi.waitFor(() => expect(t.core.heldScans.length).toBe(1), WAIT);
    const older = t.manager.view().active!.runs[1]!;
    await t.manager.switchRun(older.runId, t.generation());
    // The second run's scan is held too.
    await vi.waitFor(() => expect(t.core.heldScans.length).toBe(2), WAIT);
    // The first run's scan, from the core that was stopped, comes back late.
    t.core.heldScans.shift()!();
    await vi.waitFor(
      () => expect(t.lines.some((l) => l.includes('"source.stale_result"'))).toBe(true),
      WAIT,
    );
    expect(t.manager.scanSummary()).toBeNull();
    // The current run's own scan is accepted.
    t.core.heldScans.shift()!();
    await vi.waitFor(() => expect(t.manager.scanSummary()).toEqual(SUMMARY), WAIT);
  });
});

describe('index reads', () => {
  const search = { op: 'search', queryId: 7, text: 'x', sort: 'date', after: null } as const;

  it('gives a search the answer core made for the open run', async () => {
    const t = setup('mgr-search');
    t.picks.push({ path: tool('mgr-search-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    expect((await t.manager.queryIndex(search))?.answer).toEqual({ queryId: 7 });
  });

  it('drops a search answered after a switch', async () => {
    const t = setup('mgr-search-late');
    t.picks.push({ path: tool('mgr-search-late-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await settle();
    t.core.holdQueries = true;
    const late = t.manager.queryIndex(search);
    await settle();
    expect(t.core.heldQueries.length).toBe(1);
    const older = t.manager.view().active!.runs[1]!;
    await t.manager.switchRun(older.runId, t.generation());
    // The first run's answer, from the core that was stopped, comes back late.
    t.core.heldQueries.shift()!();
    expect(await late).toBeNull();
    t.core.holdQueries = false;
    expect((await t.manager.queryIndex(search))?.answer).toEqual({ queryId: 7 });
  });
});

describe('an unavailable source', () => {
  it('opens offline when its bookmark fails, and core starts without a root', async () => {
    const t = setup('mgr-stale');
    const root = tool('mgr-stale-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;

    // The next launch: the bookmark no longer resolves.
    const later = await t.relaunch(t.manager);
    t.failing.add('bm1');
    t.order.length = 0;
    expect(await later.restore()).toBe('offline');
    expect(steps(t.order)).toEqual(['scope.failed', 'core.spawn']);
    expect(t.core.started.at(-1)).toEqual({
      sourceKey: key,
      generation: t.generation(),
      root: null,
    });
    expect(later.view().active).toMatchObject({ sourceKey: key, status: 'offline' });
    expect(later.registry.source(key)?.offline).toBe(true);
    expect([...t.live.values()]).toEqual([]);
  });

  it('opens offline when its folder is gone, and releases the scope', async () => {
    const t = setup('mgr-gone');
    const root = tool('mgr-gone-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;
    renameSync(join(root, 'secret.account@example.com'), join(root, 'moved'));
    t.order.length = 0;
    expect(await t.manager.openRecent(key, t.generation())).toBe('offline');
    expect(steps(t.order)).toEqual(['core.stop', 'scope.keep', 'scope.release', 'core.spawn']);
    expect(t.core.started.at(-1)?.root).toBeNull();
    expect([...t.live.values()]).toEqual([]);
  });

  it('is checked again when it comes back, and only then', async () => {
    const t = setup('mgr-back');
    const root = tool('mgr-back-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;

    // A plain reopen computes no identity.
    t.core.calls.length = 0;
    let app = await t.relaunch(t.manager);
    const restoring = app.restore();
    expect(app.view()).toMatchObject({ restoring: true, active: null });
    expect(await restoring).toBe('opened');
    expect(app.view()).toMatchObject({ restoring: false, active: { sourceKey: key } });
    expect(t.core.calls).not.toContain('identify');

    renameSync(join(root, 'secret.account@example.com'), join(root, 'away'));
    expect(await app.openRecent(key, t.generation())).toBe('offline');
    renameSync(join(root, 'away'), join(root, 'secret.account@example.com'));
    t.core.calls.length = 0;
    app = await t.relaunch(app);
    expect(await app.restore()).toBe('opened');
    expect(t.core.calls).toContain('identify');
    expect(app.stamp()?.sourceKey).toBe(key);
  });

  it('is offline at launch when a link was put on the way to it', async () => {
    const t = setup('mgr-linked');
    const root = tool('mgr-linked-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;
    // Between launches the account folder becomes a link to a copy elsewhere.
    const elsewhere = realpathSync(testDir('mgr-linked-elsewhere'));
    const account = join(root, 'secret.account@example.com');
    cpSync(account, join(elsewhere, 'copy'), { recursive: true });
    rmSync(account, { recursive: true });
    symlinkSync(join(elsewhere, 'copy'), account);

    const later = await t.relaunch(t.manager);
    t.order.length = 0;
    t.core.calls.length = 0;
    expect(await later.restore()).toBe('offline');
    expect(steps(t.order)).toEqual(['scope.start', 'scope.release', 'core.spawn']);
    expect(t.core.started.at(-1)).toEqual({
      sourceKey: key,
      generation: t.generation(),
      root: null,
    });
    // Without the run, only its index is asked for, to browse it.
    expect(t.core.calls).toEqual(['index']);
    expect([...t.live.values()]).toEqual([]);
  });

  it('stays offline at launch when another run took its place', async () => {
    const t = setup('mgr-replaced');
    const root = tool('mgr-replaced-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;
    const run = join(root, 'secret.account@example.com', 'mail_20250630_120000');
    renameSync(run, `${run}-old`);
    expect(await t.manager.openRecent(key, t.generation())).toBe('offline');
    runAt(run, ['other']);
    const later = await t.relaunch(t.manager);
    expect(await later.restore()).toBe('offline');
    expect(later.view().active?.sourceKey).toBe(key);
    expect(later.view().recent.length).toBe(1);
  });
});

describe('queued actions', () => {
  it('refuse to run when an earlier one moved the generation first', async () => {
    const t = setup('mgr-queue');
    const root = tool('mgr-queue-tool');
    const other = runAt(join(realpathSync(testDir('mgr-queue-other')), 'mail_20250701_090000'), [
      'x',
    ]);
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const generation = t.generation();
    const older = t.manager.view().active!.runs[1]!;
    t.picks.push({ path: other, bookmark: 'bm2' }, { path: other, bookmark: 'bm3' });
    t.order.length = 0;

    // Three actions made for the same generation, at once.
    const [chosen, switched, located] = await Promise.all([
      t.manager.chooseFolder(null, generation),
      t.manager.switchRun(older.runId, generation),
      t.manager.locate(null, generation),
    ]);
    expect([chosen, switched, located]).toEqual(['opened', STALE, STALE]);
    expect(t.generation()).toBe(generation + 1);
    expect(t.order.filter((s) => s.step === 'core.spawn')).toHaveLength(1);
    // Only the first one used the picker.
    expect(t.picks).toEqual([{ path: other, bookmark: 'bm3' }]);
    expect(t.manager.view().active).toMatchObject({ runName: 'mail_20250701_090000' });
  });
});

describe('Locate', () => {
  it('takes the same run back as the same source, at its new place', async () => {
    const t = setup('mgr-locate');
    const root = tool('mgr-locate-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;
    const account = join(root, 'secret.account@example.com');
    const moved = realpathSync(testDir('mgr-locate-moved'));
    cpSync(account, join(moved, 'secret.account@example.com'), { recursive: true });
    rmSync(account, { recursive: true });
    expect(await t.manager.openRecent(key, t.generation())).toBe('offline');

    t.picks.push({ path: moved, bookmark: 'bm2' });
    expect(await t.manager.locate(null, t.generation())).toBe('opened');
    expect(t.manager.stamp()!.sourceKey).toBe(key);
    const source = t.manager.registry.source(key)!;
    expect(t.manager.registry.pick(source.pickId)).toMatchObject({ path: moved, bookmark: 'bm2' });
    expect(source.offline).toBe(false);
    expect(t.manager.view().recent.length).toBe(1);
  });

  it('opens a different run with the same names as a new source, and leaves the old one as it is', async () => {
    const t = setup('mgr-collide');
    const first = realpathSync(testDir('mgr-collide-1'));
    runAt(join(first, 'secret.account@example.com', 'mail_20250630_120000'), ['a', 'b']);
    t.picks.push({ path: first, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;
    const index = join(t.userData, 'index');
    mkdirSync(index, { recursive: true });
    writeFileSync(join(index, `${key}.sqlite`), 'the first index');

    rmSync(first, { recursive: true });
    expect(await t.manager.openRecent(key, t.generation())).toBe('offline');
    const before = { ...t.manager.registry.source(key)! };
    const second = realpathSync(testDir('mgr-collide-2'));
    runAt(join(second, 'secret.account@example.com', 'mail_20250630_120000'), ['a', 'c']);
    t.picks.push({ path: second, bookmark: 'bm2' });
    expect(await t.manager.locate(null, t.generation())).toBe('new_source');

    const now = t.manager.stamp()!.sourceKey;
    expect(now).not.toBe(key);
    expect(t.manager.registry.source(key)).toEqual(before);
    expect(
      t.manager
        .view()
        .recent.map((r) => r.sourceKey)
        .sort(),
    ).toEqual([key, now].sort());
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(index, `${key}.sqlite`), 'utf8')).toBe('the first index');
  });

  it('takes a run picked by its own folder back from its account folder, as the same source', async () => {
    const t = setup('mgr-levels');
    const root = tool('mgr-levels-tool');
    const run = join(root, 'secret.account@example.com', 'mail_20250630_120000');
    // Picked by the run folder itself: no account folder in the pick.
    t.picks.push({ path: run, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;
    expect(t.manager.registry.source(key)?.accountName).toBeNull();

    const moved = realpathSync(testDir('mgr-levels-moved'));
    renameSync(join(root, 'secret.account@example.com'), join(moved, 'secret.account@example.com'));
    expect(await t.manager.openRecent(key, t.generation())).toBe('offline');
    t.picks.push({ path: moved, bookmark: 'bm2' });
    expect(await t.manager.locate(null, t.generation())).toBe('opened');
    expect(t.manager.stamp()!.sourceKey).toBe(key);
    expect(t.manager.registry.source(key)?.accountName).toBe('secret.account@example.com');
    expect(t.manager.view().recent).toHaveLength(1);
  });

  it('is only for the open source, and a cancelled dialog changes nothing', async () => {
    const t = setup('mgr-locate-none');
    expect(await t.manager.locate(null, t.generation())).toBeNull();
    const root = tool('mgr-locate-none-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const stamp = t.manager.stamp();
    expect(await t.manager.locate(null, t.generation())).toBe('canceled');
    expect(t.manager.stamp()).toEqual(stamp);
  });
});

describe('the logs', () => {
  it('never carry a path or an account name', async () => {
    const t = setup('mgr-logs');
    const root = tool('mgr-logs-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;
    await t.manager.switchRun(t.manager.view().active!.runs[1]!.runId, t.generation());
    rmSync(root, { recursive: true });
    await t.manager.openRecent(key, t.generation());
    t.picks.push({ path: realpathSync(testDir('mgr-logs-empty')), bookmark: 'bm2' });
    await t.manager.locate(null, t.generation());
    t.manager.close();
    await settle();
    expect(t.lines.length).toBeGreaterThan(0);
    const all = t.lines.join('\n');
    for (const secret of ['secret.account', root, 'mail_2025', 'bm1']) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('core exiting on its own', () => {
  const restarts = (t: ReturnType<typeof setup>) =>
    t.lines.filter((l) => l.includes('"core.restart"')).length;
  /** Core ends on its own; waits until the restart has opened the index again. */
  const crashAndRestart = async (t: ReturnType<typeof setup>) => {
    const next = t.manager.stamp()!.generation + 1;
    t.manager.coreExited(t.core.crash());
    await indexOpened(t, next);
  };

  it('opens the source again under a new generation, with a new core and its index', async () => {
    const t = setup('mgr-restart');
    t.picks.push({ path: tool('mgr-restart-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const stamp = t.manager.stamp()!;
    const dbUuid = t.manager.registry.source(stamp.sourceKey)!.dbUuid;
    const started = t.core.started.length;
    t.order.length = 0;

    await crashAndRestart(t);
    const now = t.manager.stamp()!;
    expect(now).toEqual({ sourceKey: stamp.sourceKey, generation: stamp.generation + 1 });
    // The core was gone already, so nothing was stopped.
    expect(steps(t.order)).toEqual(['scope.keep', 'core.spawn']);
    expect(t.core.started.length).toBe(started + 1);
    expect(t.core.started.at(-1)).toMatchObject(now);
    // The same index is opened again, with its checks.
    expect(t.core.indexCalls.at(-1)).toEqual({ stamp: now, dbUuid, rebuild: false });
    expect(restarts(t)).toBe(1);
    expect(t.manager.view().active).toMatchObject({ status: 'online', closed: false });
  });

  it('restarts it at most 3 times a minute; then the export stays closed until it is opened again', async () => {
    const t = setup('mgr-restart-limit');
    t.picks.push({ path: tool('mgr-restart-limit-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    for (let i = 0; i < 3; i += 1) {
      await crashAndRestart(t);
    }
    expect(restarts(t)).toBe(3);
    const started = t.core.started.length;
    const generation = t.generation();
    const notified = t.notified();

    t.manager.coreExited(t.core.crash());
    await vi.waitFor(
      () => expect(t.lines.filter((l) => l.includes('"core.restart_gave_up"'))).toHaveLength(1),
      WAIT,
    );
    expect(restarts(t)).toBe(3);
    expect(t.core.started.length).toBe(started);
    // The open views go: a new generation, with no core.
    expect(t.generation()).toBe(generation + 1);
    expect(t.core.running).toBe(false);
    expect(t.manager.view().active?.closed).toBe(true);
    expect(t.notified()).toBeGreaterThan(notified);

    // Opening it again clears the state and the count.
    const key = t.manager.stamp()!.sourceKey;
    expect(await t.manager.openRecent(key, t.generation())).toBe('opened');
    expect(t.manager.view().active?.closed).toBe(false);
    await indexOpened(t, t.manager.stamp()!.generation);
    await crashAndRestart(t);
    expect(restarts(t)).toBe(4);
    expect(t.manager.view().active?.closed).toBe(false);
  });

  it('restarts again when the new core exits before it is ready, up to the limit, and leaves nothing unhandled', async () => {
    const t = setup('mgr-restart-unready');
    t.picks.push({ path: tool('mgr-restart-unready-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const key = t.manager.stamp()!.sourceKey;
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', note);
    try {
      t.core.onExit = (source) => t.manager.coreExited(source);
      // Every new core ends before it is ready.
      t.core.failStarts = 10;
      t.manager.coreExited(t.core.crash());
      await vi.waitFor(
        () => expect(t.lines.filter((l) => l.includes('"core.restart_gave_up"'))).toHaveLength(1),
        WAIT,
      );
      expect(restarts(t)).toBe(3);
      expect(t.lines.filter((l) => l.includes('"core.restart_failed"'))).toHaveLength(3);
      expect(t.manager.view().active?.closed).toBe(true);
      expect(t.core.running).toBe(false);
      // Nothing more is queued, and nothing was left unhandled.
      await settle();
      expect(restarts(t)).toBe(3);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', note);
    }

    // Reopen works once core starts again.
    t.core.failStarts = 0;
    expect(await t.manager.openRecent(key, t.generation())).toBe('opened');
    await indexOpened(t, t.manager.stamp()!.generation);
    expect(t.manager.view().active?.closed).toBe(false);
    expect(t.core.running).toBe(true);
  });

  it('recovers when the new core exits before it is ready once, and then starts', async () => {
    const t = setup('mgr-restart-unready-once');
    t.picks.push({ path: tool('mgr-restart-unready-once-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const generation = t.manager.stamp()!.generation;
    t.core.onExit = (source) => t.manager.coreExited(source);
    t.core.failStarts = 1;
    t.manager.coreExited(t.core.crash());
    // The first restart failed; its exit brought the second, which works.
    await indexOpened(t, generation + 2);
    expect(restarts(t)).toBe(2);
    expect(t.core.running).toBe(true);
    expect(t.manager.view().active).toMatchObject({ status: 'online', closed: false });
  });

  it('restarts again when the new core exits right after it is ready, before its export settled', async () => {
    const t = setup('mgr-restart-ready-exit');
    t.picks.push({ path: tool('mgr-restart-ready-exit-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const generation = t.manager.stamp()!.generation;
    const started = t.core.started.length;
    // The first new core is ready, then exits at once, while the restart
    // that started it is still settling the export.
    t.core.onStarted = () => {
      t.core.onStarted = null;
      t.manager.coreExited(t.core.crash());
    };
    t.manager.coreExited(t.core.crash());
    await indexOpened(t, generation + 2);
    expect(restarts(t)).toBe(2);
    expect(t.core.started.length).toBe(started + 2);
    expect(t.core.running).toBe(true);
    expect(t.manager.view().active).toMatchObject({ status: 'online', closed: false });
  });

  it('is not restarted once quit began, also when the exit was queued before', async () => {
    const t = setup('mgr-restart-quit');
    t.picks.push({ path: tool('mgr-restart-quit-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const stamp = t.manager.stamp()!;
    // An open holds the queue: its dialog is up.
    let pick: ((p: Picked | null) => void) | undefined;
    t.manager.setAccess({ picker: () => new Promise((r) => (pick = r)) });
    const inProgress = t.manager.chooseFolder(null, t.generation());
    await vi.waitFor(() => expect(pick).toBeDefined(), WAIT);
    const started = t.core.started.length;
    // Core exits; its restart waits in the queue. Then quit begins.
    t.manager.coreExited(t.core.crash());
    t.manager.close();
    pick!(null);
    await inProgress;
    // An exit reported after quit began.
    t.manager.coreExited(stamp);
    await settle();
    expect(restarts(t)).toBe(0);
    expect(t.core.started.length).toBe(started);
    expect(t.core.running).toBe(false);
  });

  it('is not restarted for an earlier generation, or once a switch, Forget or Reset began', async () => {
    const t = setup('mgr-restart-moved');
    const one = tool('mgr-restart-moved-1');
    const two = runAt(join(realpathSync(testDir('mgr-restart-moved-2')), 'mail_20250701_090000'), [
      'x',
    ]);
    t.picks.push({ path: one, bookmark: 'bm1' }, { path: two, bookmark: 'bm2' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const stamp = t.manager.stamp()!;
    t.manager.coreExited({ ...stamp, generation: stamp.generation - 1 });
    // An exit reported while a switch is under way, for the source it leaves.
    t.hooks.onScopeStart = () => t.manager.coreExited(stamp);
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('opened');
    t.hooks.onScopeStart = undefined;
    await indexOpened(t, t.manager.stamp()!.generation);
    const after = t.manager.stamp()!;
    expect(after.sourceKey).not.toBe(stamp.sourceKey);

    // Forget of the open export, then an exit of its core.
    const forgetting = t.manager.forget(after.sourceKey, t.generation());
    t.manager.coreExited(after);
    await forgetting;
    await t.manager.reset();
    t.manager.coreExited(after);
    await settle();
    expect(restarts(t)).toBe(0);
  });

  it('is not restarted once a switch queued before it has run', async () => {
    const t = setup('mgr-restart-queued');
    const one = tool('mgr-restart-queued-1');
    const two = runAt(join(realpathSync(testDir('mgr-restart-queued-2')), 'mail_20250701_090000'), [
      'x',
    ]);
    t.picks.push({ path: one, bookmark: 'bm1' }, { path: two, bookmark: 'bm2' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const stamp = t.manager.stamp()!;
    // The switch is queued first; the exit of the old core arrives while it waits.
    const switching = t.manager.chooseFolder(null, t.generation());
    t.manager.coreExited(stamp);
    expect(await switching).toBe('opened');
    await indexOpened(t, t.manager.stamp()!.generation);
    const after = t.manager.stamp()!;
    expect(after.sourceKey).not.toBe(stamp.sourceKey);
    expect(restarts(t)).toBe(0);
  });

  it('starts the count afresh when the same run is opened from another place', async () => {
    const t = setup('mgr-restart-other');
    const root = tool('mgr-restart-other-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    for (let i = 0; i < 3; i += 1) {
      await crashAndRestart(t);
    }
    const copy = realpathSync(testDir('mgr-restart-other-copy'));
    cpSync(join(root, 'secret.account@example.com'), join(copy, 'secret.account@example.com'), {
      recursive: true,
    });
    t.picks.push({ path: copy, bookmark: 'bm2' });
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('opened');
    await indexOpened(t, t.manager.stamp()!.generation);
    await crashAndRestart(t);
    expect(restarts(t)).toBe(4);
    expect(t.manager.view().active?.closed).toBe(false);
  });

  it('is not started again by the scan or the index open when it ended right after its restart', async () => {
    const t = setup('mgr-restart-early');
    t.picks.push({ path: tool('mgr-restart-early-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const started = t.core.started.length;
    t.core.calls.length = 0;
    t.core.onStarted = () => {
      t.core.onStarted = null;
      t.core.crash();
    };
    t.manager.coreExited(t.core.crash());
    // The restart started core, and the scan after it was refused.
    await vi.waitFor(() => {
      expect(restarts(t)).toBe(1);
      expect(t.core.refused).toBeGreaterThan(0);
    }, WAIT);
    // Nothing that came after it starts core again.
    await settle();
    expect(restarts(t)).toBe(1);
    expect(t.core.started.length).toBe(started + 1);
    expect(t.core.calls).toEqual([]);
    expect(t.core.refused).toBeGreaterThan(0);
  });

  it('counts only the restarts of the last minute', async () => {
    const t = setup('mgr-restart-window');
    t.picks.push({ path: tool('mgr-restart-window-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    let now = 1_000_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      for (let i = 0; i < 3; i += 1) await crashAndRestart(t);
      now += 60_001;
      await crashAndRestart(t);
      expect(restarts(t)).toBe(4);
      expect(t.manager.view().active?.closed).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });
});

/** What core reports when it tore down and deleted a damaged index. */
function damaged(stamp: Stamp, condition: IndexCondition = 'rebuilding') {
  return {
    type: 'event' as const,
    event: 'index' as const,
    stamp,
    progress: { ...PROGRESS, condition },
    damaged: true,
  };
}

describe('a damaged index', () => {
  it('is rebuilt under a new generation while its source is still known', async () => {
    const t = setup('mgr-rebuild');
    t.picks.push({ path: tool('mgr-rebuild-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const stamp = t.manager.stamp()!;
    const first = t.manager.registry.source(stamp.sourceKey)!.dbUuid;
    expect(first).toEqual(expect.any(String));
    expect(t.core.indexCalls).toEqual([{ stamp, dbUuid: null, rebuild: false }]);

    t.order.length = 0;
    t.manager.handleCoreEvent(damaged(stamp));
    expect(t.manager.view().active?.index).toBe('rebuilding');
    await indexOpened(t, stamp.generation + 1);
    // The generation moved; core was started again for the same run, and its
    // index is made afresh, as a rebuild.
    const now = t.manager.stamp()!;
    expect(now).toEqual({ sourceKey: stamp.sourceKey, generation: stamp.generation + 1 });
    expect(steps(t.order)).toEqual(['core.stop', 'scope.keep', 'core.spawn']);
    expect(t.core.indexCalls.at(-1)).toEqual({ stamp: now, dbUuid: null, rebuild: true });
    const second = t.manager.registry.source(stamp.sourceKey)!.dbUuid;
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    expect(t.manager.view().active?.index).toBe('rebuilding');
    expect(t.lines.some((l) => l.includes('"index.rebuild"'))).toBe(true);
  });

  it('is rebuilt while the shell keeps reading, and only the rebuild starts core', async () => {
    const t = setup('mgr-rebuild-reads');
    t.picks.push({ path: tool('mgr-rebuild-reads-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const stamp = t.manager.stamp()!;
    await indexOpened(t, stamp.generation);
    const first = t.manager.registry.source(stamp.sourceKey)!.dbUuid;
    const started = t.core.started.length;

    // Reads come in all through the rebuild, also while core is stopped.
    const reads: Array<Promise<unknown>> = [];
    const read = () => {
      reads.push(t.manager.queryIndex({ op: 'sidebar' }));
    };
    t.core.onStop = read;
    const timer = setInterval(read, 0);
    t.order.length = 0;
    try {
      t.manager.handleCoreEvent(damaged(stamp));
      read();
      // Until the rebuild has opened the new index.
      await indexOpened(t, stamp.generation + 1);
    } finally {
      clearInterval(timer);
    }
    await Promise.all(reads);

    const now = t.manager.stamp()!;
    expect(now).toEqual({ sourceKey: stamp.sourceKey, generation: stamp.generation + 1 });
    expect(t.core.refused).toBeGreaterThan(0);
    // No read started a core: the rebuild started one, with the new generation.
    expect(steps(t.order)).toEqual(['core.stop', 'scope.keep', 'core.spawn']);
    expect(t.core.started.length).toBe(started + 1);
    expect(t.core.started.at(-1)).toMatchObject(now);
    // The index is made afresh.
    expect(t.core.indexCalls.at(-1)).toEqual({ stamp: now, dbUuid: null, rebuild: true });
    expect(t.manager.registry.source(stamp.sourceKey)!.dbUuid).not.toBe(first);
  });

  it('drops a report made for an earlier generation', async () => {
    const t = setup('mgr-rebuild-stale');
    const root = tool('mgr-rebuild-stale-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const old = t.manager.stamp()!;
    const older = t.manager.view().active!.runs[1]!;
    await t.manager.switchRun(older.runId, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const calls = t.core.indexCalls.length;
    const view = t.manager.view();
    t.manager.handleCoreEvent(damaged(old));
    await settle();
    expect(t.core.indexCalls).toHaveLength(calls);
    expect(t.manager.view()).toEqual(view);
    expect(t.manager.registry.source(old.sourceKey)?.dbUuid).toEqual(expect.any(String));
    expect(t.lines.some((l) => l.includes('"source.stale_result"'))).toBe(true);
  });

  it('waits for an unavailable export to come back, then rebuilds', async () => {
    const t = setup('mgr-rebuild-offline');
    const root = tool('mgr-rebuild-offline-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const key = t.manager.stamp()!.sourceKey;
    renameSync(join(root, 'secret.account@example.com'), join(root, 'away'));
    const asks = () => t.core.calls.filter((c) => c === 'index').length;
    const asked = asks();
    expect(await t.manager.openRecent(key, t.generation())).toBe('offline');
    // It is browsed from its index: core is asked to open it, and can't.
    await vi.waitFor(() => expect(asks()).toBe(asked + 1), WAIT);
    const stamp = t.manager.stamp()!;
    const started = t.core.started.length;
    t.manager.handleCoreEvent(damaged(stamp, 'damaged'));
    await settle();
    expect(t.core.started).toHaveLength(started);
    expect(t.manager.view().active).toMatchObject({ status: 'offline', index: 'damaged' });
    expect(t.manager.registry.source(key)?.dbUuid).toBeNull();
    // Still waiting when it is opened again while it's gone.
    expect(await t.manager.openRecent(key, t.generation())).toBe('offline');
    expect(t.manager.view().active?.index).toBe('damaged');

    renameSync(join(root, 'away'), join(root, 'secret.account@example.com'));
    t.picks.push({ path: root, bookmark: 'bm2' });
    expect(await t.manager.locate(null, t.generation())).toBe('opened');
    await indexOpened(t, t.manager.stamp()!.generation);
    expect(t.core.indexCalls.at(-1)).toEqual({
      stamp: t.manager.stamp(),
      dbUuid: null,
      rebuild: true,
    });
    expect(t.manager.view().active?.index).toBe('rebuilding');
  });

  it('is not rebuilt for a source forgotten first', async () => {
    const t = setup('mgr-rebuild-forget');
    t.picks.push({ path: tool('mgr-rebuild-forget-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const stamp = t.manager.stamp()!;
    const calls = t.core.indexCalls.length;
    const forgetting = t.manager.forget(stamp.sourceKey, t.generation());
    t.manager.handleCoreEvent(damaged(stamp));
    expect(await forgetting).toBe('forgotten');
    await settle();
    expect(t.core.indexCalls).toHaveLength(calls);
    expect(t.manager.registry.sources()).toEqual([]);
    expect(t.core.running).toBe(false);
  });
});

describe('Forget', () => {
  it('of an export that is not open has core delete its index, and nothing else moves', async () => {
    const t = setup('mgr-forget');
    const root = tool('mgr-forget-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const first = t.manager.stamp()!.sourceKey;
    await t.manager.switchRun(t.manager.view().active!.runs[1]!.runId, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const open = t.manager.stamp()!;
    expect(t.manager.view().recent).toHaveLength(2);

    t.order.length = 0;
    expect(await t.manager.forget(first, t.generation())).toBe('forgotten');
    expect(t.core.forgets).toEqual([first]);
    expect(t.order).toEqual([]);
    expect(t.manager.stamp()).toEqual(open);
    expect(t.manager.view().recent.map((r) => r.sourceKey)).toEqual([open.sourceKey]);
    expect(t.manager.registry.source(first)).toBeUndefined();
    expect(await t.manager.forget(first, t.generation())).toBeNull();
  });

  it('of the open export tears it down first and releases its folder', async () => {
    const t = setup('mgr-forget-open');
    t.picks.push({ path: tool('mgr-forget-open-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const stamp = t.manager.stamp()!;
    t.order.length = 0;
    expect(await t.manager.forget(stamp.sourceKey, t.generation())).toBe('forgotten');
    expect(t.generation()).toBe(stamp.generation + 1);
    expect(t.core.forgets).toEqual([stamp.sourceKey]);
    expect(steps(t.order)).toEqual(['core.stop', 'scope.release']);
    expect([...t.live.values()]).toEqual([]);
    expect(t.manager.view()).toEqual({ restoring: false, active: null, recent: [] });
    const saved = JSON.parse(readFileSync(join(t.userData, 'sources.json'), 'utf8')) as {
      sources: unknown[];
      picks: unknown[];
      active: unknown;
    };
    expect(saved).toMatchObject({ sources: [], picks: [], active: null });
  });

  it('keeps the export when core can not delete its index yet', async () => {
    const t = setup('mgr-forget-busy');
    t.picks.push({ path: tool('mgr-forget-busy-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    const key = t.manager.stamp()!.sourceKey;
    t.core.busy.add(key);
    expect(await t.manager.forget(key, t.generation())).toBe('busy');
    // Asked again of a core started afresh, which holds nothing of it.
    expect(t.core.forgets).toEqual([key, key]);
    expect(t.manager.registry.source(key)).toBeDefined();
    expect(t.manager.view().active).toBeNull();
    expect(t.lines.some((l) => l.includes('"source.forget_refused"'))).toBe(true);
  });
});

describe('Rebuild by hand', () => {
  const opened = async (name: string) => {
    const t = setup(name);
    t.picks.push({ path: tool(`${name}-tool`), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    return t;
  };
  const codes = (t: ReturnType<typeof setup>) =>
    t.lines.map((l) => JSON.parse(l) as { code: string; data: unknown; meta: unknown });

  it('deletes the open index in core, then opens the source again with a fresh one', async () => {
    const t = await opened('mgr-rebuild');
    const before = t.manager.stamp()!;
    const oldUuid = t.manager.registry.source(before.sourceKey)!.dbUuid;
    expect(oldUuid).toEqual(expect.any(String));
    t.order.length = 0;
    const calls = t.core.indexCalls.length;

    expect(await t.manager.rebuildIndex(before.sourceKey, t.generation())).toBe('opened');
    const after = t.manager.stamp()!;
    expect(after.sourceKey).toBe(before.sourceKey);
    expect(after.generation).toBeGreaterThan(before.generation + 1);
    expect(t.core.forgets).toEqual([before.sourceKey]);
    // The folder stays granted; core starts afresh, since the old one retired the key.
    expect(steps(t.order)).toEqual(['core.stop', 'scope.keep', 'core.spawn']);
    expect([...t.live.values()]).toEqual(['bm1']);
    await indexOpened(t, after.generation);
    // A fresh index, not a recovery: no "damaged" state.
    expect(t.core.indexCalls.slice(calls)).toEqual([
      { stamp: after, dbUuid: null, rebuild: false },
    ]);
    const newUuid = t.manager.registry.source(before.sourceKey)!.dbUuid;
    expect(newUuid).toEqual(expect.any(String));
    expect(newUuid).not.toBe(oldUuid);
    expect(t.manager.view().active!.index).toBe('ok');
    expect(codes(t)).toContainEqual({
      code: 'index.rebuild',
      data: { generation: before.generation + 1, reason: 'manual' },
      meta: { src: before.sourceKey },
    });
  });

  it('changes nothing for a stale generation, another export, an unknown one or an offline one', async () => {
    const t = await opened('mgr-rebuild-refused');
    const first = t.manager.stamp()!;
    expect(await t.manager.rebuildIndex(first.sourceKey, t.generation() - 1)).toBe(STALE);
    expect(await t.manager.rebuildIndex(randomUUID(), t.generation())).toBeNull();
    await t.manager.switchRun(t.manager.view().active!.runs[1]!.runId, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const generation = t.generation();
    expect(await t.manager.rebuildIndex(first.sourceKey, generation)).toBeNull();
    expect(t.generation()).toBe(generation);
    expect(t.core.forgets).toEqual([]);

    // The open run goes away: it can't be read to build an index.
    const open = t.manager.stamp()!;
    const run = join(t.manager.exportRoots().at(-1)!);
    renameSync(run, `${run}-gone`);
    await t.manager.openRecent(open.sourceKey, t.generation());
    expect(t.manager.view().active!.status).toBe('offline');
    expect(await t.manager.rebuildIndex(open.sourceKey, t.generation())).toBe('offline');
    expect(t.core.forgets).toEqual([]);
    expect(t.manager.registry.source(open.sourceKey)!.dbUuid).toEqual(expect.any(String));
  });

  it('opens the source again with its index when core can not delete it, and says busy', async () => {
    const t = await opened('mgr-rebuild-busy');
    const stamp = t.manager.stamp()!;
    const uuid = t.manager.registry.source(stamp.sourceKey)!.dbUuid;
    t.core.busy.add(stamp.sourceKey);
    const calls = t.core.indexCalls.length;
    expect(await t.manager.rebuildIndex(stamp.sourceKey, t.generation())).toBe('busy');
    // Asked again of a core started afresh, which holds nothing of it.
    expect(t.core.forgets).toEqual([stamp.sourceKey, stamp.sourceKey]);
    expect(t.manager.registry.source(stamp.sourceKey)!.dbUuid).toBe(uuid);
    await indexOpened(t, t.manager.stamp()!.generation);
    expect(t.core.indexCalls.slice(calls)).toEqual([
      { stamp: t.manager.stamp(), dbUuid: uuid, rebuild: false },
    ]);
    expect(codes(t)).toContainEqual({
      code: 'index.rebuild_refused',
      data: { reason: 'in_use' },
      meta: { src: stamp.sourceKey },
    });
  });

  it('is refused behind a Forget queued before it, so no index is made for the forgotten export', async () => {
    const t = await opened('mgr-rebuild-forget');
    const stamp = t.manager.stamp()!;
    const generation = t.generation();
    const calls = t.core.indexCalls.length;
    const forgetting = t.manager.forget(stamp.sourceKey, generation);
    const rebuilding = t.manager.rebuildIndex(stamp.sourceKey, generation);
    expect(await forgetting).toBe('forgotten');
    expect(await rebuilding).toBe(STALE);
    await settle();
    expect(t.core.indexCalls).toHaveLength(calls);
    expect(t.manager.registry.source(stamp.sourceKey)).toBeUndefined();
  });

  it('makes a switch queued behind it stale, and the rebuilt export stays open', async () => {
    const t = await opened('mgr-rebuild-then-switch');
    const stamp = t.manager.stamp()!;
    const generation = t.generation();
    const other = t.manager.view().active!.runs[1]!.runId;
    const rebuilding = t.manager.rebuildIndex(stamp.sourceKey, generation);
    const switching = t.manager.switchRun(other, generation);
    expect(await rebuilding).toBe('opened');
    expect(await switching).toBe(STALE);
    expect(t.manager.stamp()!.sourceKey).toBe(stamp.sourceKey);
    expect(t.manager.view().recent).toHaveLength(1);
  });

  it('is stale behind a switch queued before it, and the export switched to is untouched', async () => {
    const t = await opened('mgr-switch-then-rebuild');
    const first = t.manager.stamp()!;
    const generation = t.generation();
    const switching = t.manager.switchRun(t.manager.view().active!.runs[1]!.runId, generation);
    const rebuilding = t.manager.rebuildIndex(first.sourceKey, generation);
    expect(await switching).toBe('opened');
    expect(await rebuilding).toBe(STALE);
    await indexOpened(t, t.manager.stamp()!.generation);
    const second = t.manager.stamp()!;
    const calls = t.core.indexCalls.length;
    await settle();
    expect(t.core.forgets).toEqual([]);
    expect(t.manager.stamp()).toEqual(second);
    expect(t.core.indexCalls).toHaveLength(calls);
    // The first export keeps its index identity: nothing was deleted.
    expect(t.manager.registry.source(first.sourceKey)!.dbUuid).toEqual(expect.any(String));
  });

  it('is refused while a Reset runs', async () => {
    const t = await opened('mgr-rebuild-reset');
    const stamp = t.manager.stamp()!;
    const generation = t.generation();
    const resetting = t.manager.reset();
    expect(await t.manager.rebuildIndex(stamp.sourceKey, generation)).toBe(STALE);
    expect(await resetting).toBe(true);
    expect(t.core.forgets).toEqual([]);
  });

  it('leaves nothing once a Reset queued behind it has run', async () => {
    const t = await opened('mgr-rebuild-then-reset');
    const stamp = t.manager.stamp()!;
    const rebuilding = t.manager.rebuildIndex(stamp.sourceKey, t.generation());
    const resetting = t.manager.reset();
    // The Reset closed the app to opens first, so the rebuild doesn't reopen.
    expect(await rebuilding).toBe('closed');
    expect(await resetting).toBe(true);
    // The rebuild never reached core: it was refused at its turn.
    expect(t.core.forgets).toEqual([]);
    const calls = t.core.indexCalls.length;
    await settle();
    expect(t.core.indexCalls).toHaveLength(calls);
    expect(t.manager.view()).toEqual({ restoring: false, active: null, recent: [] });
    expect(existsSync(join(t.userData, 'sources.json'))).toBe(false);
  });
});

describe('an export overlapping the app’s data folder', () => {
  it('is refused when it lies inside it, and nothing changes', async () => {
    const t = setup('mgr-inside');
    const root = join(t.userData, 'index', 'tool');
    runAt(join(root, 'secret.account@example.com', 'mail_20250630_120000'), ['a', 'b']);
    const before = digest(root);
    t.picks.push({ path: root, bookmark: 'bm1' });
    const generation = t.generation();
    expect(await t.manager.chooseFolder(null, generation)).toBe('app_data');
    expect(t.generation()).toBe(generation);
    expect(t.core.started).toEqual([]);
    expect(t.order).toEqual([]);
    expect(t.manager.view()).toEqual({ restoring: false, active: null, recent: [] });
    expect(t.lines.map((l) => JSON.parse(l) as { code: string; data: unknown })).toContainEqual({
      code: 'source.refused',
      data: { reason: 'app_data' },
    });
    expect(JSON.stringify(t.lines)).not.toContain('secret');
    expect(digest(root)).toBe(before);
  });

  it('is refused when it holds it', async () => {
    const root = realpathSync(testDir('mgr-holds-tool'));
    const run = join(root, 'secret.account@example.com', 'mail_20250630_120000');
    runAt(run, ['a']);
    const userData = join(run, 'app-data');
    mkdirSync(userData);
    const t = setup('mgr-holds', userData);
    t.picks.push({ path: root, bookmark: 'bm1' });
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('app_data');
    expect(t.core.started).toEqual([]);
  });

  it('makes Reset delete nothing while the app knows it', async () => {
    const t = setup('mgr-reset-overlap');
    const pickPath = join(t.userData, 'logs', 'moved');
    runAt(join(pickPath, 'acct', 'mail_20250630_120000'), ['a']);
    const before = digest(pickPath);
    const key = '00000000-0000-4000-8000-0000000000e5';
    const pickId = '00000000-0000-4000-8000-0000000000f6';
    mkdirSync(join(t.userData, 'index'));
    writeFileSync(join(t.userData, 'index', `${key}.sqlite`), 'x');
    // A registry from before exports like this were refused.
    writeFileSync(
      join(t.userData, 'sources.json'),
      JSON.stringify({
        version: 1,
        picks: [{ pickId, path: pickPath, bookmark: null }],
        sources: [
          {
            sourceKey: key,
            pickId,
            rel: 'acct/mail_20250630_120000',
            runName: 'mail_20250630_120000',
            accountName: 'acct',
            labelsSha256: null,
            namesSha256: '0'.repeat(64),
            openedAt: 1,
            offline: false,
          },
        ],
        active: null,
      }),
    );
    const manager = t.make();
    expect(manager.view().recent).toHaveLength(1);
    expect(manager.exportRoots()).toEqual([join(pickPath, 'acct', 'mail_20250630_120000')]);
    await manager.reset();
    expect(t.lines.map((l) => JSON.parse(l) as { code: string; data: unknown })).toContainEqual({
      code: 'app.reset_refused',
      data: { reason: 'overlap' },
    });
    expect(existsSync(join(t.userData, 'sources.json'))).toBe(true);
    expect(existsSync(join(t.userData, 'index', `${key}.sqlite`))).toBe(true);
    expect(digest(pickPath)).toBe(before);
    // The app goes on as before: opens are admitted again, and this one is
    // still refused for where it is.
    expect(await manager.openRecent(key, t.generation())).toBe('app_data');
  });
});

describe('Reset', () => {
  it('refuses opens queued before and during it, deletes the data once core is down, then admits opens again', async () => {
    const t = setup('mgr-reset');
    const root = tool('mgr-reset-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const key = t.manager.stamp()!.sourceKey;
    mkdirSync(join(t.userData, 'index'), { recursive: true });
    writeFileSync(join(t.userData, 'index', `${key}.sqlite`), 'x');
    mkdirSync(join(t.userData, 'logs'), { recursive: true });
    writeFileSync(join(t.userData, 'logs', 'main.jsonl'), '');
    const seen: string[] = [];
    const look = (when: string) => () =>
      seen.push(`${when}:${existsSync(join(t.userData, 'sources.json'))}`);
    t.core.onReset = look('reset');
    t.core.onStop = look('stop');

    // An open is under way (its dialog is up) and another is queued behind it.
    let pick: ((p: Picked | null) => void) | undefined;
    t.manager.setAccess({ picker: () => new Promise((r) => (pick = r)) });
    const inProgress = t.manager.chooseFolder(null, t.generation());
    // Its dialog is up.
    await vi.waitFor(() => expect(pick).toBeDefined(), WAIT);
    const queuedBefore = t.manager.openRecent(key, t.generation());
    const reset = t.manager.reset();
    const queuedAfter = t.manager.chooseFolder(null, t.generation());
    pick!({ path: root, bookmark: 'bm2' });
    expect(await inProgress).toBe('closed');
    expect(await queuedBefore).toBe('closed');
    expect(await reset).toBe(true);
    // Made for the generation before the reset: refused when its turn comes.
    expect(await queuedAfter).toBe(STALE);

    // Core was told to tear down and stopped while the data was still there.
    expect(seen).toEqual(['reset:true', 'stop:true']);
    expect(t.core.resets).toBe(1);
    expect(readdirSync(t.userData).filter((n) => n !== 'session')).toEqual([]);
    expect(t.manager.view()).toEqual({ restoring: false, active: null, recent: [] });
    expect([...t.live.values()]).toEqual([]);
    await settle();
    expect(existsSync(join(t.userData, 'sources.json'))).toBe(false);
    expect(existsSync(join(t.userData, 'index'))).toBe(false);
    // Core is up again with no source, as at a launch with nothing to reopen.
    expect(t.core.running).toBe(true);
    expect(t.core.current).toBeNull();

    // Then the app starts afresh: the old source is unknown, and a new open works.
    expect(await t.manager.openRecent(key, t.generation())).toBeNull();
    t.manager.setAccess({ picker: () => Promise.resolve({ path: root, bookmark: 'bm3' }) });
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('opened');
    expect(t.manager.stamp()!.sourceKey).not.toBe(key);
  });

  it('stays closed when the app quits while it runs: no opens are admitted and core stays down', async () => {
    const t = setup('mgr-reset-quit');
    t.picks.push({ path: tool('mgr-reset-quit-tool'), bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const starts = t.core.started.length;
    // The app quits while core tears the source down for the Reset.
    t.core.onReset = () => t.manager.close();
    expect(await t.manager.reset()).toBe(true);
    await settle();
    expect(t.core.running).toBe(false);
    expect(t.core.started).toHaveLength(starts);
    t.picks.push({ path: tool('mgr-reset-quit-tool-2'), bookmark: 'bm2' });
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('closed');
    expect(t.core.started).toHaveLength(starts);
  });

  it('starts the logs again and restores the default settings once the data is gone', async () => {
    const t = setup('mgr-reset-after');
    const seen: string[] = [];
    const manager = new SourceManager({
      userData: t.userData,
      log: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
      core: t.core,
      generation: () => 1,
      bumpGeneration: () => 2,
      notify: () => seen.push('notify'),
      stopLogs: () => seen.push(`stop:${existsSync(join(t.userData, 'settings.json'))}`),
      afterReset: () => seen.push(`after:${existsSync(join(t.userData, 'settings.json'))}`),
      picker: () => Promise.resolve(null),
      scopes: { start: () => ({ release: () => {} }) },
    });
    writeFileSync(join(t.userData, 'settings.json'), '{}');
    expect(await manager.reset()).toBe(true);
    expect(seen).toEqual(['stop:true', 'after:false', 'notify']);
  });

  it('refuses a recovery queued before it and an open of another source', async () => {
    const t = setup('mgr-reset-recovery');
    const root = tool('mgr-reset-recovery-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const first = t.manager.stamp()!;
    await t.manager.switchRun(t.manager.view().active!.runs[1]!.runId, t.generation());
    await indexOpened(t, t.manager.stamp()!.generation);
    const stamp = t.manager.stamp()!;
    const calls = t.core.indexCalls.length;
    t.manager.handleCoreEvent(damaged(stamp));
    const other = t.manager.openRecent(first.sourceKey, t.generation());
    await t.manager.reset();
    expect(await other).toBe('closed');
    await settle();
    expect(t.core.indexCalls).toHaveLength(calls);
    // Core runs again, with no source.
    expect(t.core.current).toBeNull();
    expect(existsSync(join(t.userData, 'sources.json'))).toBe(false);
    expect(existsSync(join(t.userData, 'index'))).toBe(false);
  });
});
