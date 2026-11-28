// SPDX-License-Identifier: AGPL-3.0-or-later
// Main-process side of the folder-access proof (the steps are in flow.ts).
//
// In the folder-proof build (sandboxed, never part of the test runs), each
// launch runs the next step of the proof with the system folder picker,
// security-scoped bookmarks and the real core, writes its result into
// userData, inside the app's container, and quits. The build names the two
// exports it accepts. In the unsandboxed test build, runControl() runs the
// same operations on scratch copies without picker or bookmarks, as the
// positive control.

import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { app } from 'electron';
import type { AppContext } from '../../main/context';
import { FetcherHost } from '../../main/fetcher-host';
import { markLoaded } from '../marker';
import { runFetcherProof } from './fetcher-flow';
import {
  runControl as runControlWith,
  runProofLaunch,
  type ExpectedExport,
  type ProofCore,
  type ProofScope,
} from './flow';

markLoaded();

export type OpenDialog = (
  options: Electron.OpenDialogOptions,
) => Promise<Electron.OpenDialogReturnValue>;

function proofCore(ctx: AppContext): ProofCore {
  return {
    get pid() {
      return ctx.core.pid;
    },
    start: () => ctx.core.start(),
    stop: () => ctx.core.stop(),
    async call(call) {
      const result = await ctx.core.request({ type: 'proof', call });
      if (!result.ok || result.proof?.action !== call.action) {
        throw new Error(`core answered the ${call.action} call without a proof result`);
      }
      return result.proof as never;
    },
  };
}

function startScope(bookmark: string): ProofScope {
  try {
    const stop = app.startAccessingSecurityScopedResource(bookmark) as () => void;
    let released = false;
    return {
      started: true,
      error: null,
      release() {
        if (released) return;
        released = true;
        stop();
      },
    };
  } catch (err) {
    return {
      started: false,
      error: err instanceof Error ? err.message : String(err),
      release() {},
    };
  }
}

/** Runs the next launch of the proof (or, in the fetcher-proof build, the fetcher's), then quits. */
export async function runFolderProof(
  ctx: AppContext,
  open: OpenDialog,
  dialogCalls: () => string[],
): Promise<void> {
  const expected = JSON.parse(__PEV_FOLDER_PROOF_EXPORTS__) as ExpectedExport[];
  const launch = {
    id: randomBytes(8).toString('hex'),
    mainPid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    sandboxed: process.mas === true,
  };
  async function pick(at: string) {
    app.focus({ steal: true });
    const picked = await open({
      message: `Choose ${basename(at)}`,
      defaultPath: at,
      properties: ['openDirectory'],
      securityScopedBookmarks: true,
    });
    const path = picked.filePaths[0];
    const bookmark = picked.bookmarks?.[0];
    return picked.canceled || !path || !bookmark ? null : { path, bookmark };
  }
  try {
    if (__PEV_FOLDER_PROOF_STEP__ === 'fetcher') {
      await runFetcherProof({
        dir: app.getPath('userData'),
        expected: expected[0]!,
        launch,
        core: proofCore(ctx),
        // The app's own fetcher host and process; only the guard is the proof's.
        fetcher(guard) {
          const host = new FetcherHost({
            fetcherPath: ctx.paths.fetcherPath,
            log: ctx.log,
            relay: ctx.log.forProc('fetcher'),
            spawnGuard: guard,
          });
          return {
            get pid() {
              return host.pid;
            },
            start: () => host.ensure(),
            read: (path) => host.testCall('read', path),
            stop: () => host.stop(),
          };
        },
        pick,
        startScope,
        otherDialogs: dialogCalls,
      });
    } else {
      await runProofLaunch({
        dir: app.getPath('userData'),
        expected,
        launch,
        core: proofCore(ctx),
        pick,
        startScope,
        otherDialogs: dialogCalls,
      });
    }
    ctx.log.info('test.folder_proof');
  } finally {
    app.exit(0);
  }
}

/** The positive control (see flow.ts), for the unsandboxed test build. */
export function runControl(ctx: AppContext, first: string, second: string) {
  return runControlWith(proofCore(ctx), first, second);
}
