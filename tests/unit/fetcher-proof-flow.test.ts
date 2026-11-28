// SPDX-License-Identifier: AGPL-3.0-or-later
// The fetcher's proof launch, with stand-ins for the picker, the bookmark,
// core and the fetcher. Like the sandboxed processes, each stand-in reaches
// only the folders in scope when it was spawned (unless a test says
// otherwise). The proof passes only if core reads the file after every
// restart of the access and the fetcher's open is denied, twice.

import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProofCall, ProofReply } from '../../src/shared/core-protocol';
import {
  FETCHER_STATE_FILE,
  runFetcherProof,
  type FetcherProofResult,
  type ProofFetcher,
} from '../../src/testhooks/proof/fetcher-flow';
import type { ExpectedExport, ProofCore, ProofScope } from '../../src/testhooks/proof/flow';
import { readFile, scanTree } from '../../src/testhooks/proof/fs';
import { testDir } from '../paths';

const ACCOUNT = 'proof@example.com';
const RUN = 'mail_20250101_000000';

function makeExport(root: string): string {
  const run = join(root, ACCOUNT, RUN);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'labels.json'), '{"Version":1,"Payload":[]}');
  for (let i = 0; i < 4; i += 1) {
    writeFileSync(join(run, `m${i}.metadata.json`), `{"ID":"m${i}"}`);
    writeFileSync(join(run, `m${i}.eml`), `Subject: ${i}\r\n\r\nBody ${i}\r\n`);
  }
  return realpathSync(root);
}

const reaches = (reach: string[], path: string) =>
  reach.some((r) => path === r || path.startsWith(r + sep));

function setup(
  options: {
    /** The fetcher reaches whatever is in scope when it reads, not when it was spawned. */
    leaky?: boolean;
    /** The fetcher's open fails with this code instead. */
    fetcherCode?: string;
    /** Starting the access fails from this start on (1 = the first). */
    refuseFrom?: number;
    /** Core loses its reach after this many reads. */
    coreReads?: number;
  } = {},
) {
  const root = testDir('fetcher-proof');
  const one = makeExport(join(root, 'one'));
  const expected: ExpectedExport = {
    path: one,
    digest: scanTree(one).digest!,
    account: { path: join(one, ACCOUNT), digest: scanTree(join(one, ACCOUNT)).digest! },
  };
  const dir = join(root, 'data');
  mkdirSync(dir);
  const inScope = new Set<string>();
  let starts = 0;
  let coreReach: string[] = [];
  let coreReads = 0;
  let corePid: number | undefined;
  const core: ProofCore = {
    get pid() {
      return corePid;
    },
    start() {
      if (corePid === undefined) {
        corePid = 7000;
        coreReach = [...inScope];
      }
      return Promise.resolve();
    },
    stop() {
      corePid = undefined;
      return Promise.resolve();
    },
    async call<A extends ProofCall['action']>(call: Extract<ProofCall, { action: A }>) {
      await this.start();
      const c = call as ProofCall;
      if (c.action !== 'read') throw new Error('unexpected call');
      coreReads += 1;
      const lost = options.coreReads !== undefined && coreReads > options.coreReads;
      const read =
        !lost && reaches(coreReach, c.path)
          ? readFile(c.path)
          : { ok: false, code: 'EPERM', path: c.path, bytes: null, sha256: null };
      return { action: 'read', pid: 7000, read } as Extract<ProofReply, { action: A }>;
    },
  };
  const spawned: number[] = [];
  const makeFetcher = (guard: (spawn: () => Promise<void>) => Promise<void>): ProofFetcher => {
    let pid: number | undefined;
    let reach: string[] = [];
    return {
      get pid() {
        return pid;
      },
      async start() {
        if (pid !== undefined) return;
        await guard(async () => {
          pid = 8000 + spawned.length;
          spawned.push(pid);
          reach = [...inScope];
        });
      },
      read(path) {
        if (options.fetcherCode) return Promise.resolve({ ok: false, code: options.fetcherCode });
        const now = options.leaky ? [...inScope] : reach;
        return Promise.resolve(
          reaches(now, path) ? { ok: true, code: null } : { ok: false, code: 'EPERM' },
        );
      },
      stop() {
        pid = undefined;
        return Promise.resolve();
      },
    };
  };
  const pickedAt: string[] = [];
  let launches = 0;
  const run = (pickPath: string | null = one) => {
    launches += 1;
    return runFetcherProof({
      dir,
      expected,
      launch: { id: `launch${launches}`, mainPid: 100, startedAt: '', sandboxed: false },
      core,
      fetcher: makeFetcher,
      pick: (at) => {
        pickedAt.push(at);
        return Promise.resolve(
          pickPath === null ? null : { path: pickPath, bookmark: `bm:${pickPath}` },
        );
      },
      startScope: (bookmark): ProofScope => {
        starts += 1;
        if (options.refuseFrom !== undefined && starts >= options.refuseFrom) {
          return { started: false, error: 'stale', release() {} };
        }
        const path = bookmark.slice('bm:'.length);
        inScope.add(path);
        return { started: true, error: null, release: () => inScope.delete(path) };
      },
      otherDialogs: () => [],
    });
  };
  const resultFile = (id: string) =>
    JSON.parse(
      readFileSync(join(dir, `fetcher-proof-result-${id}.json`), 'utf8'),
    ) as FetcherProofResult;
  return { root, one, dir, inScope, spawned, pickedAt, run, resultFile };
}

const names = (r: FetcherProofResult) => r.steps.map((s) => s.step);

describe('the fetcher proof', () => {
  it('passes when core reads after each restart and the fetcher is denied, twice', async () => {
    const t = setup();
    const result = await t.run();
    expect(result.failed).toBeNull();
    expect(result.passed).toBe(true);
    expect(t.pickedAt).toEqual([t.one]);
    expect(names(result)).toEqual([
      'scope.start',
      'core.read',
      'scope.release',
      'fetcher.ready',
      'scope.start',
      'core.read',
      'fetcher.read',
      'fetcher.stop',
      'scope.release',
      'fetcher.ready',
      'scope.start',
      'core.read',
      'fetcher.read',
      'fetcher.stop',
    ]);
    const reads = result.steps.filter((s) => s.step === 'fetcher.read');
    expect(reads.map((s) => [s.ok, s.code])).toEqual([
      [false, 'EPERM'],
      [false, 'EPERM'],
    ]);
    expect(
      result.steps
        .filter((s) => s.step === 'core.read')
        .slice(1)
        .every((s) => s.same),
    ).toBe(true);
    // Two fetchers, each its own process, never core's.
    expect(t.spawned).toEqual([8000, 8001]);
    expect(reads.map((s) => s.pid)).toEqual([8000, 8001]);
    // Everything released at the end, and the result holds no path.
    expect([...t.inScope]).toEqual([]);
    const written = readFileSync(join(t.dir, `fetcher-proof-result-launch1.json`), 'utf8');
    expect(written).not.toContain(t.root);
    expect(written).not.toContain(sep + 'one');
    expect(t.resultFile('launch1').passed).toBe(true);
  });

  it('fails when the fetcher can read the export once the access is started again', async () => {
    const t = setup({ leaky: true });
    const result = await t.run();
    expect(result.passed).toBe(false);
    expect(result.failed).toBe('the fetcher read the export');
    expect(names(result).at(-1)).toBe('fetcher.read');
  });

  it('is inconclusive when the fetcher’s open fails for another reason', async () => {
    const t = setup({ fetcherCode: 'ENOENT' });
    const result = await t.run();
    expect(result.passed).toBe(false);
    expect(result.failed).toBe("inconclusive: the fetcher's open failed with ENOENT, not a denial");
  });

  it('fails when the access can’t be started again after the spawn', async () => {
    const t = setup({ refuseFrom: 2 });
    const result = await t.run();
    expect(result.passed).toBe(false);
    expect(result.failed).toBe('the folder access could not be started again');
    expect(result.steps.find((s) => s.step === 'fetcher.read')).toBeUndefined();
  });

  it('fails when core can’t read the export after the restart', async () => {
    const t = setup({ coreReads: 1 });
    const result = await t.run();
    expect(result.passed).toBe(false);
    expect(result.failed).toBe('core could not read the export after the access was started again');
  });

  it('refuses a folder that isn’t the expected export, before anything starts', async () => {
    const t = setup();
    const other = makeExport(join(t.root, 'other'));
    const result = await t.run(other);
    expect(result.passed).toBe(false);
    expect(result.failed).toContain('is not the expected export');
    expect(t.spawned).toEqual([]);
    expect(result.steps).toEqual([]);
  });

  it('lets a cancelled pick be tried again; once it ran, a later launch only records that', async () => {
    const t = setup();
    const cancelled = await t.run(null);
    expect(cancelled.failed).toBe('no folder was picked');
    expect(readdirSync(t.dir)).toEqual(['fetcher-proof-result-launch1.json']);
    expect((await t.run()).passed).toBe(true);
    const later = await t.run();
    expect(later.ranBefore).toBe(true);
    expect(t.pickedAt).toHaveLength(2);
    expect(readdirSync(t.dir).sort()).toEqual(
      [
        FETCHER_STATE_FILE,
        'fetcher-proof-result-launch1.json',
        'fetcher-proof-result-launch2.json',
        'fetcher-proof-result-launch3.json',
      ].sort(),
    );
  });
});
