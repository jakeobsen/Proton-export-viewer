// SPDX-License-Identifier: AGPL-3.0-or-later
// Opening and switching export sources in main: the order of scope and core
// steps, generations, unavailable sources and Locate. Core is a stand-in that
// computes the real run identity.

import { cpSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runIdentity } from '../../src/core/identity';
import type { CoreRequest, CoreResult, CoreSource } from '../../src/shared/core-protocol';
import type { Logger } from '../../src/shared/log/writer';
import type { ScanSummary } from '../../src/shared/sources';
import { SourceManager, type CoreControl, type OrderStep } from '../../src/main/sources/manager';
import { ScopeError, type Picked, type Scopes } from '../../src/main/sources/scope';
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

class FakeCore implements CoreControl {
  running = false;
  next: CoreSource | null = null;
  current: CoreSource | null = null;
  readonly started: Array<CoreSource | null> = [];
  readonly calls: string[] = [];
  holdScans = false;
  readonly heldScans: Array<() => void> = [];

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
    this.running = false;
    this.current = null;
    return Promise.resolve();
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
    if (!src?.root) return fail('unavailable');
    const stamp = { sourceKey: src.sourceKey, generation: src.generation };
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

function setup(name: string) {
  const userData = realpathSync(testDir(`${name}-ud`));
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
  const scopes: Scopes = {
    start(bookmark) {
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
    expect(await t.manager.chooseFolder(null)).toBe('opened');
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
    expect(await t.manager.chooseFolder(null)).toBe('canceled');
    t.picks.push({ path: realpathSync(testDir('mgr-none-empty')), bookmark: 'bm' });
    expect(await t.manager.chooseFolder(null)).toBe('no_export');
    expect(t.order).toEqual([]);
    expect(t.core.started).toEqual([]);
    expect(t.generation()).toBe(1);
  });
});

describe('switching', () => {
  it('between sibling runs keeps the scope, restarts core and moves the generation', async () => {
    const t = setup('mgr-sibling');
    const root = tool('mgr-sibling-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null);
    const first = t.manager.stamp()!;
    t.order.length = 0;
    const older = t.manager.view().active!.runs[1]!;
    expect(await t.manager.switchRun(older.runId)).toBe('opened');
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
    expect(await t.manager.switchRun(newer.runId)).toBe('opened');
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
    await t.manager.chooseFolder(null);
    const first = t.manager.stamp()!;
    const firstPick = t.order[0]!.pickId;
    t.order.length = 0;
    expect(await t.manager.chooseFolder(null)).toBe('opened');
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

  it('drops a scan result that arrives in main after a switch', async () => {
    const t = setup('mgr-late');
    const root = tool('mgr-late-tool');
    t.core.holdScans = true;
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null);
    await settle();
    expect(t.core.heldScans.length).toBe(1);
    const older = t.manager.view().active!.runs[1]!;
    await t.manager.switchRun(older.runId);
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
    await t.manager.chooseFolder(null);
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
    await t.manager.chooseFolder(null);
    const key = t.manager.stamp()!.sourceKey;
    renameSync(join(root, 'secret.account@example.com'), join(root, 'moved'));
    t.order.length = 0;
    expect(await t.manager.openRecent(key)).toBe('offline');
    expect(steps(t.order)).toEqual(['core.stop', 'scope.keep', 'scope.release', 'core.spawn']);
    expect(t.core.started.at(-1)?.root).toBeNull();
    expect([...t.live.values()]).toEqual([]);
  });

  it('is checked again when it comes back, and only then', async () => {
    const t = setup('mgr-back');
    const root = tool('mgr-back-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null);
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
    expect(await app.openRecent(key)).toBe('offline');
    renameSync(join(root, 'away'), join(root, 'secret.account@example.com'));
    t.core.calls.length = 0;
    app = await t.relaunch(app);
    expect(await app.restore()).toBe('opened');
    expect(t.core.calls).toContain('identify');
    expect(app.stamp()?.sourceKey).toBe(key);
  });

  it('stays offline at launch when another run took its place', async () => {
    const t = setup('mgr-replaced');
    const root = tool('mgr-replaced-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null);
    const key = t.manager.stamp()!.sourceKey;
    const run = join(root, 'secret.account@example.com', 'mail_20250630_120000');
    renameSync(run, `${run}-old`);
    expect(await t.manager.openRecent(key)).toBe('offline');
    runAt(run, ['other']);
    const later = await t.relaunch(t.manager);
    expect(await later.restore()).toBe('offline');
    expect(later.view().active?.sourceKey).toBe(key);
    expect(later.view().recent.length).toBe(1);
  });
});

describe('Locate', () => {
  it('takes the same run back as the same source, at its new place', async () => {
    const t = setup('mgr-locate');
    const root = tool('mgr-locate-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null);
    const key = t.manager.stamp()!.sourceKey;
    const account = join(root, 'secret.account@example.com');
    const moved = realpathSync(testDir('mgr-locate-moved'));
    cpSync(account, join(moved, 'secret.account@example.com'), { recursive: true });
    rmSync(account, { recursive: true });
    expect(await t.manager.openRecent(key)).toBe('offline');

    t.picks.push({ path: moved, bookmark: 'bm2' });
    expect(await t.manager.locate(null)).toBe('opened');
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
    await t.manager.chooseFolder(null);
    const key = t.manager.stamp()!.sourceKey;
    const index = join(t.userData, 'index');
    mkdirSync(index, { recursive: true });
    writeFileSync(join(index, `${key}.sqlite`), 'the first index');

    rmSync(first, { recursive: true });
    expect(await t.manager.openRecent(key)).toBe('offline');
    const before = { ...t.manager.registry.source(key)! };
    const second = realpathSync(testDir('mgr-collide-2'));
    runAt(join(second, 'secret.account@example.com', 'mail_20250630_120000'), ['a', 'c']);
    t.picks.push({ path: second, bookmark: 'bm2' });
    expect(await t.manager.locate(null)).toBe('new_source');

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

  it('is only for the open source, and a cancelled dialog changes nothing', async () => {
    const t = setup('mgr-locate-none');
    expect(await t.manager.locate(null)).toBeNull();
    const root = tool('mgr-locate-none-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null);
    const stamp = t.manager.stamp();
    expect(await t.manager.locate(null)).toBe('canceled');
    expect(t.manager.stamp()).toEqual(stamp);
  });
});

describe('the logs', () => {
  it('never carry a path or an account name', async () => {
    const t = setup('mgr-logs');
    const root = tool('mgr-logs-tool');
    t.picks.push({ path: root, bookmark: 'bm1' });
    await t.manager.chooseFolder(null);
    const key = t.manager.stamp()!.sourceKey;
    await t.manager.switchRun(t.manager.view().active!.runs[1]!.runId);
    rmSync(root, { recursive: true });
    await t.manager.openRecent(key);
    t.picks.push({ path: realpathSync(testDir('mgr-logs-empty')), bookmark: 'bm2' });
    await t.manager.locate(null);
    t.manager.close();
    await settle();
    expect(t.lines.length).toBeGreaterThan(0);
    const all = t.lines.join('\n');
    for (const secret of ['secret.account', root, 'mail_2025', 'bm1']) {
      expect(all).not.toContain(secret);
    }
  });
});
