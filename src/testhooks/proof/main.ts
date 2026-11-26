// SPDX-License-Identifier: AGPL-3.0-or-later
// Main-process side of the folder-access proof.
//
// In the folder-proof build (sandboxed, never part of the test runs), each
// launch runs the next phase and writes its result into userData, inside the
// app's container:
//   launch 1: pick the first export, keep its security-scoped bookmark, start
//     accessing it, then spawn core. Core and its worker read the export
//     (step 1), and main and core try changes inside it (step 2). Quit.
//   launch 2: without the picker, start accessing the stored bookmark, then
//     spawn core: steps 1 and 2 again (step 3). Then pick the second export:
//     stop core, release the first folder, access the second and respawn core.
//     Core reads the second export and tries a file of the first (step 4). Quit.
// In the unsandboxed test build, runControl() runs the same operations on
// scratch copies without picker or bookmarks, as the positive control.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AppContext } from '../../main/context';
import type { ProofCall, ProofReply } from '../../shared/core-protocol';
import { markLoaded } from '../marker';
import { changeOps, exportTargets, isDenial, readFile, type ExportTargets } from './fs';

markLoaded();

export type OpenDialog = (
  options: Electron.OpenDialogOptions,
) => Promise<Electron.OpenDialogReturnValue>;

const STATE_FILE = 'folder-proof-state.json';

interface StoredExport {
  path: string;
  bookmark: string;
  launch: string;
}

interface ProofState {
  first?: StoredExport;
  second?: StoredExport;
}

async function coreProof<A extends ProofCall['action']>(
  ctx: AppContext,
  call: Extract<ProofCall, { action: A }>,
): Promise<Extract<ProofReply, { action: A }>> {
  const result = await ctx.core.request({ type: 'proof', call });
  if (!result.ok || result.proof?.action !== call.action) {
    throw new Error(`core answered the ${call.action} call without a proof result`);
  }
  return result.proof as Extract<ProofReply, { action: A }>;
}

/** Core walks and reads the whole export; its worker reads one message pair. */
async function readStep(ctx: AppContext, root: string, targets: ExportTargets) {
  const reply = await coreProof(ctx, { action: 'scan', root, reads: targets.read });
  return { corePid: reply.pid, scan: reply.scan, worker: reply.worker };
}

/** Main and core each try a write, a create, a rename and a delete in the export. */
async function changeStep(ctx: AppContext, targets: ExportTargets) {
  const main = changeOps(targets.main);
  const core = await coreProof(ctx, { action: 'ops', targets: targets.core });
  const denied = (ops: typeof main) => Object.values(ops).every(isDenial);
  return {
    targets: { main: targets.main, core: targets.core },
    main,
    core: core.ops,
    corePid: core.pid,
    mainDenied: denied(main),
    coreDenied: denied(core.ops),
  };
}

interface Scope {
  started: boolean;
  /** Electron's error when it can't use the bookmark, a stale one included. */
  error: string | null;
  stop: () => void;
}

function startScope(bookmark: string): Scope {
  try {
    const stop = app.startAccessingSecurityScopedResource(bookmark) as () => void;
    return { started: true, error: null, stop };
  } catch (err) {
    return { started: false, error: err instanceof Error ? err.message : String(err), stop() {} };
  }
}

async function pick(open: OpenDialog, title: string): Promise<{ path: string; bookmark: string }> {
  app.focus({ steal: true });
  const picked = await open({
    title,
    properties: ['openDirectory'],
    securityScopedBookmarks: true,
  });
  const path = picked.filePaths[0];
  const bookmark = picked.bookmarks?.[0];
  if (picked.canceled || !path || !bookmark) throw new Error('no folder or no bookmark was picked');
  return { path, bookmark };
}

/** Runs the next phase of the proof; see the top of this file. */
export async function runFolderProof(
  ctx: AppContext,
  open: OpenDialog,
  dialogCalls: () => string[],
): Promise<void> {
  const dir = app.getPath('userData');
  const statePath = join(dir, STATE_FILE);
  let pickerCalls = 0;
  const counted: OpenDialog = (options) => {
    pickerCalls += 1;
    return open(options);
  };
  const launch = {
    id: randomBytes(8).toString('hex'),
    mainPid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    sandboxed: process.mas === true,
  };
  const state = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, 'utf8')) as ProofState)
    : {};
  const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
  // What happened, in order, so the result shows the sequence the proof relies on.
  const events: Array<{ at: string; event: string; corePid?: number | undefined }> = [];
  const event = (name: string) =>
    events.push({ at: new Date().toISOString(), event: name, corePid: ctx.core.pid });
  const spawnCore = async () => {
    await ctx.core.start();
    event('core spawned');
  };
  const stopCore = async () => {
    await ctx.core.stop();
    event('core stopped');
  };
  const result: Record<string, unknown> = { launch, events };

  try {
    if (!state.first) {
      result.phase = 'first launch';
      const first = await pick(counted, 'Choose the first export');
      event('first export picked');
      state.first = { ...first, launch: launch.id };
      saveState();
      event('bookmark stored');
      const scope = startScope(first.bookmark);
      event(scope.started ? 'scope started' : 'scope refused');
      result.scope = { started: scope.started, error: scope.error };
      await spawnCore();
      const targets = exportTargets(first.path, launch.id);
      result.step1 = await readStep(ctx, first.path, targets);
      result.step2 = await changeStep(ctx, targets);
      await stopCore();
      scope.stop();
      event('scope released');
    } else if (!state.second) {
      result.phase = 'second launch';
      const pickerCallsBefore = pickerCalls;
      const scope = startScope(state.first.bookmark);
      event(scope.started ? 'stored bookmark resolved, scope started' : 'stored bookmark refused');
      await spawnCore();
      const targets = exportTargets(state.first.path, launch.id);
      result.step3 = {
        firstLaunch: state.first.launch,
        pickerCallsBefore,
        bookmark: { resolved: scope.started, error: scope.error },
        read: await readStep(ctx, state.first.path, targets),
        change: await changeStep(ctx, targets),
      };

      const second = await pick(counted, 'Choose the second export');
      event('second export picked');
      state.second = { ...second, launch: launch.id };
      saveState();
      event('bookmark stored');
      const corePidBefore = ctx.core.pid;
      await stopCore();
      scope.stop();
      event('first scope released');
      const secondScope = startScope(second.bookmark);
      event(secondScope.started ? 'second scope started' : 'second scope refused');
      await spawnCore();
      const secondTargets = exportTargets(second.path, launch.id);
      const known = targets.read[1];
      result.step4 = {
        corePidBefore,
        corePidAfter: ctx.core.pid,
        scope: { started: secondScope.started, error: secondScope.error },
        read: await readStep(ctx, second.path, secondTargets),
        firstExport: {
          file: known,
          core: (await coreProof(ctx, { action: 'read', path: known })).read,
          main: readFile(known),
        },
      };
      await stopCore();
      secondScope.stop();
      event('scope released');
    } else {
      result.phase = 'done before';
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.pickerCalls = pickerCalls;
  result.otherDialogs = dialogCalls();
  writeFileSync(join(dir, `folder-proof-${launch.id}.json`), JSON.stringify(result, null, 2));
  ctx.log.info('test.folder_proof');
  app.exit(0);
}

/**
 * The positive control, for the unsandboxed test build: the same reads and
 * changes on two scratch exports, then a core restart, and core reads the
 * second export and a file of the first. Everything is expected to succeed.
 */
export async function runControl(ctx: AppContext, first: string, second: string) {
  const tag = randomBytes(8).toString('hex');
  const targets = exportTargets(first, tag);
  const secondTargets = exportTargets(second, tag);
  const read = await readStep(ctx, first, targets);
  const change = await changeStep(ctx, targets);
  const corePidBefore = ctx.core.pid;
  await ctx.core.stop();
  const secondRead = await readStep(ctx, second, secondTargets);
  const known = targets.read[1];
  return {
    read,
    change,
    corePidBefore,
    corePidAfter: ctx.core.pid,
    secondRead,
    firstExport: {
      file: known,
      core: (await coreProof(ctx, { action: 'read', path: known })).read,
      main: readFile(known),
    },
  };
}
