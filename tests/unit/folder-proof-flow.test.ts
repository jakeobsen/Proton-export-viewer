// SPDX-License-Identifier: AGPL-3.0-or-later
// The folder-access proof's launches, with stand-ins for the picker, the
// bookmarks and core. Read-only permissions stand in for the sandbox's
// denials of changes; the stand-in core, like the sandboxed one, reaches only
// the folders that were in scope when it was spawned.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProofCall, ProofReply } from '../../src/shared/core-protocol';
import { handleProof } from '../../src/testhooks/proof/core';
import {
  STATE_FILE,
  runProofLaunch,
  type ExpectedExport,
  type ProofCore,
  type ProofScope,
} from '../../src/testhooks/proof/flow';
import { readFile, scanTree, walk } from '../../src/testhooks/proof/fs';
import { testDir } from '../paths';

const asRoot = process.getuid?.() === 0;

/** A launch's result or the state, read as plain JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = Record<string, any>;

/** A small export with `pairs` message pairs. */
function makeExport(root: string, pairs = 4): string {
  const run = join(root, 'proof@example.com', 'mail_20250101_000000');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'labels.json'), '{"Version":1,"Payload":[]}');
  for (let i = 0; i < pairs; i += 1) {
    writeFileSync(join(run, `m${i}.metadata.json`), `{"ID":"m${i}"}`);
    writeFileSync(join(run, `m${i}.eml`), `Subject: ${i}\r\n\r\nBody ${i}\r\n`);
  }
  return realpathSync(root);
}

const lockedFolders: string[] = [];

/** Makes every file and folder in `root` read-only, so every change fails with EACCES. */
function lock(root: string): void {
  for (const entry of walk(root).reverse()) {
    chmodSync(entry.full, entry.type === 'dir' ? 0o555 : 0o444);
  }
  chmodSync(root, 0o555);
  lockedFolders.push(root);
}

afterEach(() => {
  for (const root of lockedFolders.splice(0)) {
    chmodSync(root, 0o755);
    for (const entry of walk(root)) chmodSync(entry.full, entry.type === 'dir' ? 0o755 : 0o644);
  }
});

const denied = (path: string) => ({ ok: false, code: 'EPERM', path, bytes: null, sha256: null });

/** Core in this process. It reaches only what was in scope when it was spawned. */
class StandInCore implements ProofCore {
  pid: number | undefined;
  readonly spawns: number[] = [];
  private reach: string[] = [];

  constructor(private readonly inScope: () => string[]) {}

  start(): Promise<void> {
    if (this.pid === undefined) {
      this.pid = 5000 + this.spawns.length;
      this.spawns.push(this.pid);
      this.reach = this.inScope();
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.pid = undefined;
    return Promise.resolve();
  }

  async call<A extends ProofCall['action']>(
    call: Extract<ProofCall, { action: A }>,
  ): Promise<Extract<ProofReply, { action: A }>> {
    await this.start();
    const pid = this.pid!;
    const reached = (path: string) =>
      this.reach.some((r) => path === r || path.startsWith(r + sep));
    const c = call as ProofCall;
    let reply: ProofReply;
    if (c.action === 'read' && !reached(c.path)) {
      reply = { action: 'read', pid, read: denied(c.path) };
    } else if (c.action === 'scan' && !reached(c.root)) {
      const scan = { ok: false, code: 'EPERM', digest: null, entries: 0, files: 0 };
      reply = { action: 'scan', pid, scan, worker: c.reads.map(denied) };
    } else {
      reply = await new Promise<ProofReply>((resolve) => {
        void handleProof(
          { type: 'proof', reqId: 1, call: c },
          {
            reply: (result) => {
              if (result.ok && result.proof) resolve({ ...result.proof, pid });
            },
            workerRead: (paths) => Promise.resolve(paths.map(readFile)),
          },
        );
      });
    }
    return reply as Extract<ProofReply, { action: A }>;
  }
}

/** Two exports, read-only unless `writable`, and stand-ins for one launch after another. */
function setup(options: { writable?: boolean } = {}) {
  const root = testDir('proof-flow');
  const one = makeExport(join(root, 'one'));
  const two = makeExport(join(root, 'two'));
  const expected: ExpectedExport[] = [one, two].map((path) => ({
    path,
    digest: scanTree(path).digest!,
  }));
  if (!options.writable) {
    lock(one);
    lock(two);
  }
  const dir = join(root, 'data');
  mkdirSync(dir);
  const inScope = new Set<string>();
  const core = new StandInCore(() => [...inScope]);
  const pickedAt: string[] = [];
  let launches = 0;

  /** One launch: `picks` answer the pickers in order; `refuse` refuses every bookmark. */
  const launch = (
    picks: Array<string | null> = [],
    over: { refuse?: boolean; expected?: ExpectedExport[]; core?: ProofCore } = {},
  ) => {
    launches += 1;
    return runProofLaunch({
      dir,
      expected: over.expected ?? expected,
      launch: { id: `launch${launches}`, mainPid: 100 + launches, startedAt: '', sandboxed: false },
      core: over.core ?? core,
      pick: (at) => {
        pickedAt.push(at);
        const path = picks.shift() ?? null;
        return Promise.resolve(path === null ? null : { path, bookmark: `bookmark:${path}` });
      },
      startScope: (bookmark): ProofScope => {
        const path = bookmark.slice('bookmark:'.length);
        if (over.refuse) return { started: false, error: 'stale', release() {} };
        inScope.add(path);
        return { started: true, error: null, release: () => inScope.delete(path) };
      },
      otherDialogs: () => [],
    });
  };
  const state = () => JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as Result;
  return { root, one, two, expected, dir, core, inScope, pickedAt, launch, state };
}

const eventNames = (result: Result) =>
  (result.events as Array<{ event: string }>).map((e) => e.event);

describe('runProofLaunch', () => {
  it.skipIf(asRoot)('runs both launches, checking each step, and nothing more after', async () => {
    const t = setup();
    const acc = { ok: false, code: 'EACCES' };
    const allDenied = { write: acc, create: acc, rename: acc, remove: acc };

    const first = (await t.launch([t.one])) as Result;
    expect(first.stopped).toBeUndefined();
    expect(first.phase).toBe('first launch');
    expect(t.pickedAt).toEqual([t.one]);
    expect(first.picked).toEqual({ path: t.one, physical: t.one, digest: t.expected[0]!.digest });
    expect(first.step1.scan).toMatchObject({ ok: true, digest: t.expected[0]!.digest });
    expect(first.step2).toMatchObject({ main: allDenied, core: allDenied });
    expect(first.step2.after).toBe(t.expected[0]!.digest);
    expect(eventNames(first)).toEqual([
      'first export picked',
      'first export checked',
      'bookmark stored',
      'scope started',
      'core spawned',
      'core stopped',
      'scope released',
    ]);
    expect(t.state().first).toMatchObject({ path: t.one, launch: 'launch1' });

    const second = (await t.launch([t.two])) as Result;
    expect(second.stopped).toBeUndefined();
    expect(second.step3).toMatchObject({
      firstLaunch: 'launch1',
      pickerCallsBefore: 0,
      bookmark: { resolved: true, error: null },
      change: { main: allDenied, core: allDenied },
    });
    expect(second.step4.corePidAfter).not.toBe(second.step4.corePidBefore);
    expect(second.step4.read.scan).toMatchObject({ ok: true, digest: t.expected[1]!.digest });
    expect(second.step4.firstExport.core).toMatchObject({ ok: false, code: 'EPERM' });
    expect(second.step4.change).toMatchObject({ main: allDenied, core: allDenied });
    expect(second.step4.change.targets.core.write.startsWith(t.two + sep)).toBe(true);
    expect(second.pickerCalls).toBe(1);
    expect(eventNames(second)).toEqual([
      'stored bookmark scope started',
      'first export checked',
      'core spawned',
      'second export picked',
      'second export checked',
      'bookmark stored',
      'core stopped',
      'stored bookmark scope released',
      'second scope started',
      'core spawned',
      'core stopped',
      'second scope released',
    ]);

    const third = (await t.launch([t.one])) as Result;
    expect(third.phase).toBe('done before');
    expect(third.pickerCalls).toBe(0);
    expect(t.pickedAt).toHaveLength(2);
    expect(t.inScope.size).toBe(0);
    expect([t.one, t.two].map((p) => scanTree(p).digest)).toEqual(t.expected.map((e) => e.digest));
  });

  it('refuses a folder that is not the expected export, before anything else', async () => {
    const t = setup();
    const other = makeExport(join(t.root, 'other'));
    const result = (await t.launch([other])) as Result;
    expect(result.stopped).toEqual({
      step: 'pick the first export',
      reason: `${other} is not the expected export`,
      failedCheck: true,
    });
    expect(result.picked).toEqual({ path: other, physical: other, digest: null });
    expect(t.core.spawns).toEqual([]);
    expect(t.state()).toEqual({
      failed: { launch: 'launch1', step: 'pick the first export', reason: result.stopped.reason },
    });

    const next = (await t.launch([t.one])) as Result;
    expect(next.phase).toBe('stopped before');
    expect(next.previous).toEqual(t.state().failed);
    expect(t.pickedAt).toHaveLength(1);
    expect(t.core.spawns).toEqual([]);
  });

  it('refuses the expected folder when it no longer matches its manifest', async () => {
    const t = setup();
    const changed = [{ path: t.one, digest: '0'.repeat(64) }, t.expected[1]!];
    const result = (await t.launch([t.one], { expected: changed })) as Result;
    expect(result.stopped.reason).toBe(`${t.one} does not match its manifest digest`);
    expect(result.picked.digest).toBe(t.expected[0]!.digest);
    expect(t.core.spawns).toEqual([]);
    expect(existsSync(join(t.dir, STATE_FILE))).toBe(true);
    expect(t.state().first).toBeUndefined();
  });

  it('stops when no folder is picked', async () => {
    const t = setup();
    const result = (await t.launch([null])) as Result;
    expect(result.stopped).toMatchObject({
      step: 'pick the first export',
      reason: 'no folder or no bookmark was picked',
    });
    expect(t.core.spawns).toEqual([]);
  });

  it('stops when the bookmark cannot be used, before core is spawned', async () => {
    const t = setup();
    const result = (await t.launch([t.one], { refuse: true })) as Result;
    expect(result.stopped).toMatchObject({
      step: 'access the first export',
      reason: 'the bookmark could not be used',
    });
    expect(result.scope).toEqual({ started: false, error: 'stale' });
    expect(t.core.spawns).toEqual([]);
  });

  it('stops at the first change that is not denied: core never tries, no next launch', async () => {
    const t = setup({ writable: true });
    const result = (await t.launch([t.one])) as Result;
    expect(result.stopped).toMatchObject({
      step: 'step 2',
      reason: 'a change from main was not denied',
    });
    expect(result.step2.main).toEqual({
      write: { ok: true, code: null },
      create: null,
      rename: null,
      remove: null,
    });
    expect(result.step2.core).toBeNull();
    expect(eventNames(result).slice(-2)).toEqual(['core stopped', 'scope released']);
    expect(t.core.pid).toBeUndefined();
    expect(t.inScope.size).toBe(0);

    const next = (await t.launch([t.two])) as Result;
    expect(next.phase).toBe('stopped before');
    expect(t.pickedAt).toHaveLength(1);
  });

  it.skipIf(asRoot)(
    'stops when the stored bookmark cannot be used, before core and the picker',
    async () => {
      const t = setup();
      await t.launch([t.one]);
      const spawns = t.core.spawns.length;
      const result = (await t.launch([t.two], { refuse: true })) as Result;
      expect(result.stopped).toMatchObject({
        step: 'step 3',
        reason: 'the stored bookmark could not be used',
      });
      expect(result.step3.bookmark).toEqual({ resolved: false, error: 'stale' });
      expect(t.core.spawns).toHaveLength(spawns);
      expect(result.pickerCalls).toBe(0);
    },
  );

  it.skipIf(asRoot)('refuses the same folder picked twice', async () => {
    const t = setup();
    const same = [t.expected[0]!, t.expected[0]!];
    await t.launch([t.one], { expected: same });
    const result = (await t.launch([t.one], { expected: same })) as Result;
    expect(result.stopped).toMatchObject({
      step: 'pick the second export',
      reason: 'the same folder was picked twice',
    });
    expect(t.state().second).toBeUndefined();
    expect(result.step4).toBeUndefined();
  });

  it.skipIf(asRoot)('needs a denial from the respawned core on the first export', async () => {
    const t = setup();
    await t.launch([t.one]);
    const unscoped = new StandInCore(() => [t.root]);
    const result = (await t.launch([t.two], { core: unscoped })) as Result;
    expect(result.stopped).toMatchObject({
      step: 'step 4',
      reason: "core's read of a known file of the first export was not denied (it succeeded)",
    });
    expect(result.step4.firstExport.core).toMatchObject({ ok: true });
    expect(result.step4.change).toBeUndefined();
    expect(unscoped.pid).toBeUndefined();
    expect(t.inScope.size).toBe(0);
  });
});
