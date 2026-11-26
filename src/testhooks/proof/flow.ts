// SPDX-License-Identifier: AGPL-3.0-or-later
// The launches of the folder-access proof, step by step. main.ts runs them in
// the folder-proof build with the real picker, bookmarks and core; the unit
// tests run them with stand-ins.
//
//   launch 1: pick the first export and check that it is the expected one.
//     Store its security-scoped bookmark, start accessing it, then spawn
//     core. Core and its worker read the export (step 1), and main and core
//     try changes inside it (step 2).
//   launch 2: without the picker, start accessing the stored bookmark and
//     check the folder again, then spawn core: steps 1 and 2 again (step 3).
//     Pick the second export and check it. Stop core, release the first
//     folder, access the second and respawn core. Core reads the second
//     export and tries a known file of the first, and main and core try
//     changes inside the second (step 4).
//   later launches: record that the proof ran before, and nothing else.
//
// Each check runs before the next action. The first one that fails ends the
// launch: the result says where and why, core is stopped, every folder is
// released, and the state is marked failed, so later launches do nothing.
// Before anything is changed, main checks that a folder is the expected
// export: the same physical path, and the digest its manifest gives. The
// single account folder inside an export may be picked instead (the folder
// dialog hands over a highlighted subfolder); it is checked the same way,
// against the path and digest the build recorded for it.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProofCall,
  ProofExpect,
  ProofFileRead,
  ProofOps,
  ProofReply,
  ProofScan,
  ProofTargets,
} from '../../shared/core-protocol';
import { markLoaded } from '../marker';
import {
  allAsExpected,
  changeOps,
  exportTargets,
  isDenial,
  readFile,
  scanTree,
  type ExportTargets,
} from './fs';

markLoaded();

export const STATE_FILE = 'folder-proof-state.json';

/** A folder the proof accepts: its physical path and the digest of its tree. */
export interface ExpectedFolder {
  path: string;
  digest: string;
}

/**
 * An export the proof accepts: its folder and manifest digest, and the single
 * account folder directly inside it, which may be picked instead.
 */
export interface ExpectedExport extends ExpectedFolder {
  account?: ExpectedFolder | null;
}

/** Access to a folder through its security-scoped bookmark. */
export interface ProofScope {
  started: boolean;
  /** Why the bookmark could not be used, a stale one included. */
  error: string | null;
  release(): void;
}

/** Core, as the proof uses it. */
export interface ProofCore {
  readonly pid: number | undefined;
  start(): Promise<void>;
  /** Resolves once core has exited. */
  stop(): Promise<void>;
  call<A extends ProofCall['action']>(
    call: Extract<ProofCall, { action: A }>,
  ): Promise<Extract<ProofReply, { action: A }>>;
}

export interface LaunchInfo {
  id: string;
  mainPid: number;
  startedAt: string;
  sandboxed: boolean;
}

export interface ProofDeps {
  /** Where the state and the result files go. */
  dir: string;
  /** The first and the second export, in the order they are picked. */
  expected: readonly ExpectedExport[];
  launch: LaunchInfo;
  core: ProofCore;
  /** Shows the folder picker at `at`; null when no folder or no bookmark came back. */
  pick(at: string): Promise<{ path: string; bookmark: string } | null>;
  startScope(bookmark: string): ProofScope;
  /** The other dialogs the app tried to show. */
  otherDialogs(): string[];
}

interface StoredExport {
  path: string;
  bookmark: string;
  launch: string;
}

interface ProofState {
  first?: StoredExport;
  second?: StoredExport;
  /** Set when a launch stopped at a failed check; later launches do nothing. */
  failed?: { launch: string; step: string; reason: string };
}

/** A failed check. It ends the launch. */
export class ProofStop extends Error {}

function check(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new ProofStop(reason);
}

function noProblem(problem: string | null): void {
  if (problem !== null) throw new ProofStop(problem);
}

function physicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Main's check of a folder before anything in it is changed. */
export interface ExportCheck {
  path: string;
  physical: string | null;
  /** Which of the export's folders was picked, once the path matched one. */
  level: 'export' | 'account' | null;
  digest: string | null;
}

/**
 * Checks from main that `path` is the expected export or its account folder:
 * first its physical path, and only if that matches, its digest (every entry
 * listed and read). The record is filled in before a mismatch throws, so it
 * shows what was found. Returns the folder that matched.
 */
export function checkExport(
  path: string,
  expected: ExpectedExport,
  record: ExportCheck,
): ExpectedFolder {
  record.path = path;
  record.physical = physicalPath(path);
  const account = expected.account ?? null;
  const match =
    record.physical === expected.path
      ? expected
      : account !== null && record.physical === account.path
        ? account
        : null;
  check(match !== null, `${path} is not the expected export`);
  record.level = match === expected ? 'export' : 'account';
  const scan = scanTree(path);
  record.digest = scan.digest;
  check(scan.ok, `main could not read ${path} (${scan.code})`);
  check(scan.digest === match.digest, `${path} does not match its manifest digest`);
  return { path: match.path, digest: match.digest };
}

function emptyCheck(): ExportCheck {
  return { path: '', physical: null, level: null, digest: null };
}

export interface ExportRead {
  corePid: number;
  scan: ProofScan;
  worker: ProofFileRead[] | null;
  /** Main's own reads of the files the worker read. */
  main: ProofFileRead[];
}

/** Core walks and reads the whole export, its worker reads one message pair, main reads it too. */
export async function readExport(
  core: ProofCore,
  root: string,
  targets: ExportTargets,
): Promise<ExportRead> {
  const reply = await core.call({ action: 'scan', root, reads: targets.read });
  return {
    corePid: reply.pid,
    scan: reply.scan,
    worker: reply.worker,
    main: targets.read.map(readFile),
  };
}

/** Why a read step failed, or null: core must read the manifest's digest, the worker what main reads. */
export function readProblem(read: ExportRead, digest: string): string | null {
  if (!read.scan.ok) return `core could not read the export (${read.scan.code})`;
  if (read.scan.digest !== digest) return 'core read a digest that differs from the manifest';
  if (!read.worker || read.worker.length !== read.main.length) {
    return 'the worker did not read the message pair';
  }
  for (const [i, worker] of read.worker.entries()) {
    const main = read.main[i];
    if (!worker.ok) return `the worker could not read ${worker.path} (${worker.code})`;
    if (!main?.ok || worker.sha256 !== main.sha256) {
      return `the worker read ${worker.path} differently from main`;
    }
  }
  return null;
}

export interface ExportChange {
  expect: ProofExpect;
  targets: { main: ProofTargets; core: ProofTargets };
  main: ProofOps;
  /** Null when main's checks already ended the step, so core never tried. */
  core: ProofOps | null;
  corePid: number | null;
}

/**
 * Main tries the four changes on its pair. Only if every outcome was what
 * `expect` asks for does core try them on its own pair.
 */
export async function changeExport(
  core: ProofCore,
  targets: ExportTargets,
  expect: ProofExpect,
): Promise<ExportChange> {
  const change: ExportChange = {
    expect,
    targets: { main: targets.main, core: targets.core },
    main: changeOps(targets.main, expect),
    core: null,
    corePid: null,
  };
  if (allAsExpected(change.main, expect)) {
    const reply = await core.call({ action: 'ops', targets: targets.core, expect });
    change.core = reply.ops;
    change.corePid = reply.pid;
  }
  return change;
}

/** Why a change step failed, or null. */
export function changeProblem(change: ExportChange): string | null {
  if (!allAsExpected(change.main, change.expect)) {
    return `a change from main was not ${change.expect}`;
  }
  if (!change.core || !allAsExpected(change.core, change.expect)) {
    return `a change from core was not ${change.expect}`;
  }
  return null;
}

/** Runs the next launch of the proof (see the top of this file) and returns its result. */
export async function runProofLaunch(deps: ProofDeps): Promise<Record<string, unknown>> {
  const { core, launch } = deps;
  const statePath = join(deps.dir, STATE_FILE);
  const state = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, 'utf8')) as ProofState)
    : {};
  const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
  // What happened, in order, so the result shows the sequence the proof relies on.
  const events: Array<{ at: string; event: string; corePid?: number | undefined }> = [];
  const event = (name: string) =>
    events.push({ at: new Date().toISOString(), event: name, corePid: core.pid });
  const result: Record<string, unknown> = { launch, events };
  let step = 'start';
  let pickerCalls = 0;

  const held: Array<{ name: string; scope: ProofScope }> = [];
  const access = (bookmark: string, name: string) => {
    const scope = deps.startScope(bookmark);
    event(scope.started ? `${name} started` : `${name} refused`);
    if (scope.started) held.push({ name, scope });
    return scope;
  };
  const release = (scope: ProofScope) => {
    const index = held.findIndex((h) => h.scope === scope);
    if (index < 0) return;
    const [h] = held.splice(index, 1);
    h?.scope.release();
    event(`${h?.name} released`);
  };
  const spawnCore = async () => {
    await core.start();
    event('core spawned');
  };
  const stopCore = async () => {
    await core.stop();
    event('core stopped');
  };
  const pick = async (expected: ExpectedExport) => {
    pickerCalls += 1;
    const picked = await deps.pick(expected.path);
    check(picked !== null, 'no folder or no bookmark was picked');
    return picked;
  };
  /**
   * Changes from main and core, then main checks that the export is
   * unchanged. The record goes into `into[key]` first, so a stop keeps it.
   */
  const changeStep = async (
    into: Record<string, unknown>,
    key: string,
    root: string,
    targets: ExportTargets,
    expected: ExpectedFolder,
  ) => {
    const change = {
      ...(await changeExport(core, targets, 'denied')),
      after: null as string | null,
    };
    into[key] = change;
    noProblem(changeProblem(change));
    change.after = scanTree(root).digest;
    check(change.after === expected.digest, `${root} changed during the change checks`);
  };

  try {
    if (state.failed) {
      result.phase = 'stopped before';
      result.previous = state.failed;
    } else if (state.second) {
      result.phase = 'done before';
    } else {
      const [firstExpected, secondExpected] = deps.expected;
      check(
        deps.expected.length === 2 && !!firstExpected && !!secondExpected,
        'the build does not name the two expected exports',
      );

      if (!state.first) {
        result.phase = 'first launch';
        step = 'pick the first export';
        const first = await pick(firstExpected);
        event('first export picked');
        const picked = emptyCheck();
        result.picked = picked;
        const firstFolder = checkExport(first.path, firstExpected, picked);
        event('first export checked');
        state.first = { ...first, launch: launch.id };
        saveState();
        event('bookmark stored');

        step = 'access the first export';
        const scope = access(first.bookmark, 'scope');
        result.scope = { started: scope.started, error: scope.error };
        check(scope.started, 'the bookmark could not be used');
        await spawnCore();
        const targets = exportTargets(first.path, launch.id);

        step = 'step 1';
        const read = await readExport(core, first.path, targets);
        result.step1 = read;
        noProblem(readProblem(read, firstFolder.digest));

        step = 'step 2';
        await changeStep(result, 'step2', first.path, targets, firstFolder);
        await stopCore();
        release(scope);
      } else {
        result.phase = 'second launch';
        step = 'step 3';
        const stored = state.first;
        const step3: Record<string, unknown> = {
          firstLaunch: stored.launch,
          pickerCallsBefore: pickerCalls,
        };
        result.step3 = step3;
        const scope = access(stored.bookmark, 'stored bookmark scope');
        step3.bookmark = { resolved: scope.started, error: scope.error };
        check(scope.started, 'the stored bookmark could not be used');
        const verified = emptyCheck();
        step3.checked = verified;
        const firstFolder = checkExport(stored.path, firstExpected, verified);
        event('first export checked');
        await spawnCore();
        const targets = exportTargets(stored.path, launch.id);
        const read = await readExport(core, stored.path, targets);
        step3.read = read;
        noProblem(readProblem(read, firstFolder.digest));
        await changeStep(step3, 'change', stored.path, targets, firstFolder);

        step = 'pick the second export';
        const second = await pick(secondExpected);
        event('second export picked');
        const picked = emptyCheck();
        result.picked = picked;
        const secondFolder = checkExport(second.path, secondExpected, picked);
        check(picked.physical !== verified.physical, 'the same folder was picked twice');
        event('second export checked');
        state.second = { ...second, launch: launch.id };
        saveState();
        event('bookmark stored');

        step = 'step 4';
        const step4: Record<string, unknown> = { corePidBefore: core.pid };
        result.step4 = step4;
        await stopCore();
        release(scope);
        const secondScope = access(second.bookmark, 'second scope');
        step4.scope = { started: secondScope.started, error: secondScope.error };
        check(secondScope.started, 'the second bookmark could not be used');
        await spawnCore();
        step4.corePidAfter = core.pid;
        check(core.pid !== undefined && core.pid !== step4.corePidBefore, 'core was not respawned');
        const secondTargets = exportTargets(second.path, launch.id);
        const secondRead = await readExport(core, second.path, secondTargets);
        step4.read = secondRead;
        noProblem(readProblem(secondRead, secondFolder.digest));
        // A file of the first export that step 3 read in this launch: it exists.
        const known = targets.read[1];
        const coreRead = (await core.call({ action: 'read', path: known })).read;
        step4.firstExport = { file: known, core: coreRead, main: readFile(known) };
        check(
          isDenial(coreRead),
          `core's read of a known file of the first export was not denied (${coreRead.code ?? 'it succeeded'})`,
        );
        await changeStep(step4, 'change', second.path, secondTargets, secondFolder);
        await stopCore();
        release(secondScope);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result.stopped = { step, reason, failedCheck: err instanceof ProofStop };
    state.failed = { launch: launch.id, step, reason };
    try {
      saveState();
    } catch (saveErr) {
      result.stateNotSaved = saveErr instanceof Error ? saveErr.message : String(saveErr);
    }
  } finally {
    if (core.pid !== undefined) await stopCore();
    while (held.length > 0) release(held[held.length - 1]!.scope);
  }
  result.pickerCalls = pickerCalls;
  result.otherDialogs = deps.otherDialogs();
  writeFileSync(join(deps.dir, `folder-proof-${launch.id}.json`), JSON.stringify(result, null, 2));
  return result;
}

/**
 * The positive control, for the unsandboxed test build: the same reads and
 * changes on two scratch copies, without picker or bookmarks, where every
 * change is expected to succeed. Core is restarted between the two copies,
 * then reads the second copy and a file of the first, and main and core
 * change the second copy too.
 */
export async function runControl(core: ProofCore, first: string, second: string) {
  const tag = randomBytes(8).toString('hex');
  const targets = exportTargets(first, tag);
  const secondTargets = exportTargets(second, tag);
  const read = await readExport(core, first, targets);
  const change = await changeExport(core, targets, 'allowed');
  const corePidBefore = core.pid;
  await core.stop();
  await core.start();
  const corePidAfter = core.pid;
  const secondRead = await readExport(core, second, secondTargets);
  const known = targets.read[1];
  const firstExport = {
    file: known,
    core: (await core.call({ action: 'read', path: known })).read,
    main: readFile(known),
  };
  const secondChange = await changeExport(core, secondTargets, 'allowed');
  return {
    read,
    change,
    corePidBefore,
    corePidAfter,
    secondRead,
    firstExport,
    secondChange,
  };
}
