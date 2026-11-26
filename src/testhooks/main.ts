// SPDX-License-Identifier: AGPL-3.0-or-later
// Main-process test hooks. Compiled only into builds with test hooks; tests reach
// them through globalThis.__pevTest from the main-process evaluation channel.

import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { BrowserWindow, app, dialog } from 'electron';
import { bumpGeneration, type AppContext } from '../main/context';
import type { PolicyObserver } from '../main/harden';
import { PROD_SWITCHES } from '../main/switches';
import { createAppWindow } from '../main/windows';
import type { CoreResult } from '../shared/core-protocol';
import { errorData } from '../shared/log/schema';
import { TESTHOOKS_MARKER, markLoaded } from './marker';
import { TEST_PAGE, testRoute } from './pages';
import { runControl, runFolderProof, type OpenDialog } from './proof/main';
import { runSelfTest } from './selftest';

markLoaded();

interface WindowRequests {
  app: string[];
  body: string[];
  asset: string[];
  blocked: string[];
}

const DIALOG_METHODS = [
  'showOpenDialog',
  'showOpenDialogSync',
  'showSaveDialog',
  'showSaveDialogSync',
  'showMessageBox',
  'showMessageBoxSync',
  'showErrorBox',
  'showCertificateTrustDialog',
] as const;

/** Replaces every native dialog with a recorder, so no dialog can appear during tests. */
function stubDialogs(calls: string[]): void {
  for (const name of DIALOG_METHODS) {
    const stub = () => {
      calls.push(name);
      if (name.endsWith('Sync')) return name === 'showMessageBoxSync' ? 0 : undefined;
      return name === 'showErrorBox'
        ? undefined
        : Promise.resolve({ response: 0, canceled: true, filePaths: [], checkboxChecked: false });
    };
    Object.defineProperty(dialog, name, { value: stub, configurable: true, writable: true });
  }
}

/** The seccomp mode of a Linux process ('2' when a filter is active), or null. */
function seccompMode(pid: number): string | null {
  try {
    return /^Seccomp:\s*(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function install(ctx: AppContext): Promise<boolean> {
  // Only the folder-proof build uses the real folder picker; it is kept
  // before the stubs replace it.
  const realOpenDialog = dialog.showOpenDialog.bind(dialog) as OpenDialog;
  const dialogCalls: string[] = [];
  stubDialogs(dialogCalls);
  const windowEvents: string[] = [];
  app.on('browser-window-created', (_event, win) => {
    win.on('show', () => windowEvents.push('show'));
    win.on('focus', () => windowEvents.push('focus'));
  });

  const requests = new Map<number, WindowRequests>();
  let bodyCsp = true;

  const recordsFor = (windowId: number): WindowRequests => {
    let rec = requests.get(windowId);
    if (!rec) {
      rec = { app: [], body: [], asset: [], blocked: [] };
      requests.set(windowId, rec);
    }
    return rec;
  };

  ctx.observerFor = (windowId: number): PolicyObserver => {
    const rec = recordsFor(windowId);
    return {
      onAppRequest: (url) => rec.app.push(url),
      onBodyRequest: (url) => rec.body.push(url),
      onAssetRequest: (url) => rec.asset.push(url),
      onBlocked: (url) => rec.blocked.push(url),
      bodyCspEnabled: () => bodyCsp,
      extraAppRoute: testRoute,
    };
  };

  const byId = (windowId: number) => {
    for (const appWin of ctx.windows.values()) if (appWin.id === windowId) return appWin;
    throw new Error('no such window');
  };

  const loaded = async (windowId: number) => {
    const contents = byId(windowId).win.webContents;
    if (contents.isLoading()) await once(contents, 'did-finish-load');
  };

  const core = (action: string, markers?: string): Promise<CoreResult> =>
    ctx.core.request(
      markers === undefined ? { type: 'test', action } : { type: 'test', action, markers },
    );

  const api = {
    marker: TESTHOOKS_MARKER,
    dialogCalls: () => [...dialogCalls],
    dialogsStubbed: () =>
      DIALOG_METHODS.every((name) => String(dialog[name]).includes('calls.push')),
    windowEvents: () => [...windowEvents],
    windowState: () =>
      BrowserWindow.getAllWindows().map((w) => ({
        visible: w.isVisible(),
        focused: w.isFocused(),
      })),
    pages: TEST_PAGE,
    logsDir: () => ctx.log.fileAt(0).replace(/\/[^/]+$/, ''),
    shellCsp: () => ctx.shellCsp,
    switches: () =>
      PROD_SWITCHES.map(([name]) => [name, app.commandLine.getSwitchValue(name)] as const),
    windows: () => [...ctx.windows.values()].map((w) => w.id),
    generation: () => ctx.generation,
    bumpGeneration: () => bumpGeneration(ctx),
    setBodyCsp: (on: boolean) => {
      bodyCsp = on;
    },
    requests: (windowId: number) => recordsFor(windowId),
    clearRequests: () => {
      // Each session's observer keeps its record object, so empty it in place.
      for (const rec of requests.values()) {
        rec.app.length = 0;
        rec.body.length = 0;
        rec.asset.length = 0;
        rec.blocked.length = 0;
      }
    },
    linkDialogs: () => [...ctx.linkDialog.shown],
    liveViews: (windowId: number) => byId(windowId).views.liveCount,
    authorizedUrl: (windowId: number) => byId(windowId).views.authorizedUrl(),
    spellcheck: (windowId: number) => byId(windowId).session.isSpellCheckerEnabled(),
    /**
     * The OS-level sandbox evidence for every renderer process, and for the
     * main process as the unsandboxed control: the process metric on macOS and
     * Windows, the seccomp mode on Linux.
     */
    rendererSandbox: () => {
      const evidence = (m: Electron.ProcessMetric) => ({
        pid: m.pid,
        sandboxed: m.sandboxed ?? null,
        seccomp: process.platform === 'linux' ? seccompMode(m.pid) : null,
      });
      const metrics = app.getAppMetrics();
      const main = metrics.find((m) => m.pid === process.pid);
      return {
        platform: process.platform,
        windowPids: [...ctx.windows.values()].map((w) => w.win.webContents.getOSProcessId()),
        main: main ? evidence(main) : null,
        renderers: metrics.filter((m) => m.type === 'Tab').map(evidence),
      };
    },
    openWindow: async (kind: 'shell' | 'subframe' | 'script-control' | 'fetch') => {
      const appWin =
        kind === 'shell'
          ? createAppWindow(ctx)
          : kind === 'subframe'
            ? createAppWindow(ctx, {
                url: TEST_PAGE.subframeHost,
                subframePreload: true,
                allowFrameUrl: TEST_PAGE.subframe,
              })
            : createAppWindow(ctx, {
                url: kind === 'fetch' ? TEST_PAGE.fetch : TEST_PAGE.scriptControl,
              });
      await loaded(appWin.id);
      return appWin.id;
    },
    loadUrl: async (windowId: number, url: string) => {
      await byId(windowId).win.webContents.loadURL(url);
    },
    fetchIn: async (windowId: number, url: string) => {
      const response = await byId(windowId).session.fetch(url);
      const body = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        length: body.length,
      };
    },
    download: (windowId: number, url: string) => byId(windowId).win.webContents.downloadURL(url),
    crashRenderer: (windowId: number) => {
      const contents = byId(windowId).win.webContents;
      // On Linux, forcefullyCrashRenderer() asks the renderer to crash itself
      // instead of ending it from main, so end the process directly there.
      if (process.platform === 'linux') process.kill(contents.getOSProcessId(), 'SIGKILL');
      else contents.forcefullyCrashRenderer();
    },
    core,
    corePid: () => ctx.core.pid,
    mainLog: (markers: string) =>
      ctx.log.info('test.log', {
        subject: markers,
        path: markers,
        reason: markers,
        errorClass: markers,
      }),
    mainError: (markers: string) =>
      ctx.log.error('test.error', errorData(new Error(markers), ctx.frameRoots)),
    mainThrow: (markers: string) => {
      setTimeout(() => {
        throw new Error(markers);
      }, 0);
    },
    mainReject: (markers: string) => {
      void Promise.reject(new Error(markers));
    },
    folderProofControl: (first: string, second: string) => runControl(ctx, first, second),
  };
  (globalThis as { __pevTest?: typeof api }).__pevTest = api;

  if (__PEV_FOLDER_PROOF__) {
    await runFolderProof(ctx, realOpenDialog, () => [...dialogCalls]);
    return true;
  }
  const selfTest = process.argv.includes('--pev-selftest');
  if (selfTest) {
    await runSelfTest(ctx, process.argv);
    return true;
  }
  return false;
}
