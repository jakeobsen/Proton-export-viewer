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
import { describe, expect, it } from 'vitest';
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
};

class FakeCore implements CoreControl {
  running = false;
  next: CoreSource | null = null;
  current: CoreSource | null = null;
  readonly started: Array<CoreSource | null> = [];
  readonly calls: string[] = [];
  holdScans = false;
  readonly heldScans: Array<() => void> = [];
  /** Index opens, with what main asked for. */
  readonly indexCalls: Array<{ stamp: Stamp; dbUuid: string | null; rebuild: boolean }> = [];
  readonly forgets: string[] = [];
  /** Sources whose index core can't delete yet. */
  readonly busy = new Set<string>();
  resets = 0;
  /** Called when core is asked to reset or stopped, to see what was on disk then. */
  onReset: (() => void) | null = null;
  onStop: (() => void) | null = null;

  setSource(source: CoreSource | null) {
    this.next = source && { ...source };
  }

  start() {
    if (!this.running) {
      this.running = true;
      this.current = this.next;
      this.started.push(this.current);
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
    await settle();
    expect(t.manager.scanSummary()).toEqual(SUMMARY);
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
    await settle();
    expect(t.manager.scanSummary()).toEqual(SUMMARY);
  });

  it('drops a scan result that arrives in main after a switch', async () => {
    const t = setup('mgr-late');
    const root = tool('mgr-late-tool');
    t.core.holdScans = true;
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await settle();
    expect(t.core.heldScans.length).toBe(1);
    const older = t.manager.view().active!.runs[1]!;
    await t.manager.switchRun(older.runId, t.generation());
    await settle();
    // The first run's scan, from the core that was stopped, comes back late.
    t.core.heldScans.shift()!();
    await settle();
    expect(t.manager.scanSummary()).toBeNull();
    expect(t.lines.some((l) => l.includes('"source.stale_result"'))).toBe(true);
    // The current run's own scan is accepted.
    t.core.heldScans.shift()!();
    await settle();
    expect(t.manager.scanSummary()).toEqual(SUMMARY);
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
    await settle();
    const stamp = t.manager.stamp()!;
    const first = t.manager.registry.source(stamp.sourceKey)!.dbUuid;
    expect(first).toEqual(expect.any(String));
    expect(t.core.indexCalls).toEqual([{ stamp, dbUuid: null, rebuild: false }]);

    t.order.length = 0;
    t.manager.handleCoreEvent(damaged(stamp));
    expect(t.manager.view().active?.index).toBe('rebuilding');
    await settle();
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
    await settle();
    const stamp = t.manager.stamp()!;
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
      await settle();
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
    await settle();
    const old = t.manager.stamp()!;
    const older = t.manager.view().active!.runs[1]!;
    await t.manager.switchRun(older.runId, t.generation());
    await settle();
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
    await settle();
    const key = t.manager.stamp()!.sourceKey;
    renameSync(join(root, 'secret.account@example.com'), join(root, 'away'));
    expect(await t.manager.openRecent(key, t.generation())).toBe('offline');
    await settle();
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
    await settle();
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
    await settle();
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
    await settle();
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
    await settle();
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
    // And it stays closed.
    expect(await manager.openRecent(key, t.generation())).toBe('closed');
  });
});

describe('Reset', () => {
  it('closes to opens queued before and after it, and deletes the data once core is down', async () => {
    const t = setup('mgr-reset');
    const root = tool('mgr-reset-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await settle();
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
    let pick!: (p: Picked | null) => void;
    t.manager.setAccess({ picker: () => new Promise((r) => (pick = r)) });
    const inProgress = t.manager.chooseFolder(null, t.generation());
    await settle();
    const queuedBefore = t.manager.openRecent(key, t.generation());
    const reset = t.manager.reset();
    const queuedAfter = t.manager.chooseFolder(null, t.generation());
    pick({ path: root, bookmark: 'bm2' });
    expect(await inProgress).toBe('closed');
    expect(await queuedBefore).toBe('closed');
    await reset;
    // Made for the generation before the reset: refused when its turn comes.
    expect(await queuedAfter).toBe(STALE);
    expect(await t.manager.chooseFolder(null, t.generation())).toBe('closed');
    expect(await t.manager.openRecent(key, t.generation())).toBe('closed');

    // Core was told to tear down and stopped while the data was still there.
    expect(seen).toEqual(['reset:true', 'stop:true']);
    expect(t.core.resets).toBe(1);
    expect(readdirSync(t.userData).filter((n) => n !== 'session')).toEqual([]);
    expect(t.manager.view()).toEqual({ restoring: false, active: null, recent: [] });
    expect([...t.live.values()]).toEqual([]);
    await settle();
    expect(existsSync(join(t.userData, 'sources.json'))).toBe(false);
    expect(existsSync(join(t.userData, 'index'))).toBe(false);
  });

  it('refuses a recovery queued before it and an open of another source', async () => {
    const t = setup('mgr-reset-recovery');
    const root = tool('mgr-reset-recovery-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null, t.generation());
    await settle();
    const first = t.manager.stamp()!;
    await t.manager.switchRun(t.manager.view().active!.runs[1]!.runId, t.generation());
    await settle();
    const stamp = t.manager.stamp()!;
    const calls = t.core.indexCalls.length;
    t.manager.handleCoreEvent(damaged(stamp));
    const other = t.manager.openRecent(first.sourceKey, t.generation());
    await t.manager.reset();
    expect(await other).toBe('closed');
    await settle();
    expect(t.core.indexCalls).toHaveLength(calls);
    expect(t.core.running).toBe(false);
    expect(existsSync(join(t.userData, 'sources.json'))).toBe(false);
    expect(existsSync(join(t.userData, 'index'))).toBe(false);
  });
});
