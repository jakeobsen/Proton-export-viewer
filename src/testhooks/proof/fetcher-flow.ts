// SPDX-License-Identifier: AGPL-3.0-or-later
// The fetcher's part of the folder-access proof, in the fetcher-proof build:
// one launch, one pick. It shows that the remote-image fetcher, spawned while
// main has released the picked folder's access, can't read that folder, also
// after main has started the access again, while core still can.
//
//   1. Pick the export, check that it is the expected one, start accessing
//      it, and start core. Core reads one message file of it.
//   2. Release the access, spawn the fetcher and wait for its ready message,
//      start the access again (main.ts's FetcherHost, as in the app).
//   3. Core reads the same file again: same bytes.
//   4. The fetcher opens the file: the open must fail with EPERM or EACCES.
//      Any other failure leaves the proof inconclusive.
//   5. Stop the fetcher, and run 2 to 4 once more: the path a second consent
//      takes.
//
// The result holds step names, process ids, error codes and whether core's
// reads matched: never a path. Once a folder was accepted, a later launch
// only records that the proof ran before; a cancelled or wrong pick can be
// tried again. The unsandboxed test build runs the same fetcher read as the
// positive control (an e2e test): there it succeeds.

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markLoaded } from '../marker';
import {
  ProofStop,
  checkExport,
  type ExpectedExport,
  type LaunchInfo,
  type ProofCore,
  type ProofScope,
} from './flow';
import { exportTargets, isDenial } from './fs';

markLoaded();

export const FETCHER_STATE_FILE = 'fetcher-proof-state.json';

/** The fetcher, as the proof uses it. */
export interface ProofFetcher {
  readonly pid: number | undefined;
  /** Spawns the fetcher through the guard the proof gave, and waits for ready. */
  start(): Promise<void>;
  /** Has the fetcher open a file for reading: the error code if it can't. */
  read(path: string): Promise<{ ok: boolean; code: string | null }>;
  stop(): Promise<void>;
}

export interface FetcherProofDeps {
  dir: string;
  expected: ExpectedExport;
  launch: LaunchInfo;
  core: ProofCore;
  /** Makes the fetcher; its spawns run inside `guard`. */
  fetcher(guard: (spawn: () => Promise<void>) => Promise<void>): ProofFetcher;
  pick(at: string): Promise<{ path: string; bookmark: string } | null>;
  startScope(bookmark: string): ProofScope;
  otherDialogs(): string[];
}

/** One step, in the order it happened. Codes and pids only. */
export interface FetcherProofStep {
  step: string;
  pid?: number | null;
  ok?: boolean;
  code?: string | null;
  /** For core's reads after a restart: the same bytes as its first read. */
  same?: boolean;
}

export interface FetcherProofResult {
  launch: LaunchInfo;
  ranBefore: boolean;
  steps: FetcherProofStep[];
  /** Both rounds: core read the file, the fetcher was denied. */
  passed: boolean;
  failed: string | null;
  otherDialogs: string[];
}

function check(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new ProofStop(reason);
}

export const ROUNDS = 2;

/** Runs the fetcher proof, writes its result into `dir`, and resolves when done. */
export async function runFetcherProof(deps: FetcherProofDeps): Promise<FetcherProofResult> {
  const result: FetcherProofResult = {
    launch: deps.launch,
    ranBefore: false,
    steps: [],
    passed: false,
    failed: null,
    otherDialogs: [],
  };
  const statePath = join(deps.dir, FETCHER_STATE_FILE);
  const write = () => {
    result.otherDialogs = deps.otherDialogs();
    writeFileSync(
      join(deps.dir, `fetcher-proof-result-${deps.launch.id}.json`),
      JSON.stringify(result, null, 2),
    );
  };
  if (existsSync(statePath)) {
    result.ranBefore = true;
    write();
    return result;
  }

  const step = (s: FetcherProofStep) => result.steps.push(s);
  let accepted = false;
  let bookmark: string | null = null;
  let scope: ProofScope | null = null;
  const guard = async (spawn: () => Promise<void>) => {
    if (bookmark === null) throw new ProofStop('no folder picked');
    scope?.release();
    scope = null;
    step({ step: 'scope.release' });
    try {
      await spawn();
      step({ step: 'fetcher.ready', pid: fetcher.pid ?? null });
    } finally {
      scope = deps.startScope(bookmark);
      step({ step: 'scope.start', ok: scope.started });
    }
  };
  const fetcher = deps.fetcher(guard);

  try {
    const picked = await deps.pick(deps.expected.path);
    check(picked !== null, 'no folder was picked');
    const folder = checkExport(picked.path, deps.expected, {
      path: '',
      physical: null,
      level: null,
      digest: null,
    });
    accepted = true;
    bookmark = picked.bookmark;
    scope = deps.startScope(bookmark);
    step({ step: 'scope.start', ok: scope.started });
    check(scope.started, 'the folder access could not be started');
    await deps.core.start();
    const marker = exportTargets(folder.path, 'fetcher').read[0];
    check(marker !== undefined, 'the export has no message file');
    const first = await deps.core.call({ action: 'read', path: marker });
    step({ step: 'core.read', pid: first.pid, ok: first.read.ok, code: first.read.code });
    check(first.read.ok, 'core could not read the export');

    for (let round = 1; round <= ROUNDS; round += 1) {
      await fetcher.start();
      const started = scope as ProofScope | null;
      check(started?.started === true, 'the folder access could not be started again');
      const again = await deps.core.call({ action: 'read', path: marker });
      const same = again.read.ok && again.read.sha256 === first.read.sha256;
      step({ step: 'core.read', pid: again.pid, ok: again.read.ok, code: again.read.code, same });
      check(same, 'core could not read the export after the access was started again');
      const read = await fetcher.read(marker);
      step({ step: 'fetcher.read', pid: fetcher.pid ?? null, ok: read.ok, code: read.code });
      check(!read.ok, 'the fetcher read the export');
      check(
        isDenial({ ok: read.ok, code: read.code }),
        `inconclusive: the fetcher's open failed with ${read.code ?? 'no code'}, not a denial`,
      );
      await fetcher.stop();
      step({ step: 'fetcher.stop' });
    }
    result.passed = true;
  } catch (err) {
    result.failed =
      err instanceof ProofStop
        ? err.message
        : err instanceof Error
          ? err.constructor.name
          : 'NonError';
  } finally {
    await fetcher.stop().catch(() => undefined);
    await deps.core.stop().catch(() => undefined);
    const held = scope as ProofScope | null;
    held?.release();
    if (accepted) {
      writeFileSync(statePath, JSON.stringify({ launch: deps.launch.id, passed: result.passed }));
    }
    write();
  }
  return result;
}
