// SPDX-License-Identifier: AGPL-3.0-or-later
// Main-process test hooks. Compiled only into builds with test hooks; tests reach
// them through globalThis.__pevTest from the main-process evaluation channel.

import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, clipboard, dialog, shell } from 'electron';
import { bumpGeneration, type AppContext } from '../main/context';
import type { PolicyObserver } from '../main/harden';
import { PROD_SWITCHES } from '../main/switches';
import { ScopeError, type Picked } from '../main/sources/scope';
import type { OrderStep } from '../main/sources/manager';
import { createAppWindow } from '../main/windows';
import type { CoreResult } from '../shared/core-protocol';
import type { IndexQuery } from '../shared/index-types';
import { errorData } from '../shared/log/schema';
import { TESTHOOKS_MARKER, markLoaded } from './marker';
import { TEST_PAGE, testRoute } from './pages';
import { READER_SOURCE_ACTION, type SourceEntry } from './reader-source';
import { READER_UNSANITIZED_ACTION } from './unsanitized';
import { runControl, runFolderProof, type OpenDialog } from './proof/main';
import { killRenderer } from './renderer-kill';
import { runSelfTest } from './selftest';
import { WindowEventRecorder } from './window-events';

markLoaded();

interface WindowRequests {
  app: string[];
  body: string[];
  asset: string[];
  blocked: string[];
  /**
   * Console messages of the window's frames, as main gets them. Some
   * reports, such as a CSP refusal of a nested frame, reach only main.
   */
  console: Array<{ frame: string; text: string }>;
  /**
   * URLs the window's session was asked to preconnect to. A resource hint
   * leaves no other trace: it never reaches the request filter.
   */
  sessionPreconnects: string[];
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

const SHELL_METHODS = ['openExternal', 'openPath', 'showItemInFolder', 'trashItem'] as const;
const CLIPBOARD_METHODS = ['write', 'writeText', 'clear'] as const;

/** One call to a stubbed shell or clipboard method, with its string arguments. */
export interface ExternalCall {
  method: string;
  args: string[];
}

/**
 * Replaces the shell's open and show methods and every clipboard write with
 * recorders, so tests never open another app or touch the clipboard.
 */
function stubExternal(calls: ExternalCall[]): void {
  const record = (method: string, args: unknown[]) =>
    calls.push({ method, args: args.filter((a): a is string => typeof a === 'string') });
  for (const name of SHELL_METHODS) {
    const stub = (...args: unknown[]) => {
      record(`shell.${name}`, args);
      return name === 'showItemInFolder'
        ? undefined
        : Promise.resolve(name === 'openPath' ? '' : undefined);
    };
    Object.defineProperty(shell, name, { value: stub, configurable: true, writable: true });
  }
  for (const name of CLIPBOARD_METHODS) {
    const stub = (...args: unknown[]) => {
      record(`clipboard.${name}`, args);
      return Promise.resolve();
    };
    Object.defineProperty(clipboard, name, { value: stub, configurable: true, writable: true });
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
  const externalCalls: ExternalCall[] = [];
  stubExternal(externalCalls);
  const windowEvents = new WindowEventRecorder();
  app.on('browser-window-created', (_event, win) => windowEvents.attach(win));

  // The folder picker answers from a queue the test fills, and folder scopes
  // are recorded instead of started: test builds run without the App Sandbox.
  // Every scope and core step of the source manager is recorded in order.
  const picks: Array<Picked | null> = [];
  let pickerCalls = 0;
  // A bookmark named on the command line fails from the start, so a test can
  // make the reopen at launch find it stale.
  const failingBookmarks = new Set<string>(
    process.argv
      .filter((a) => a.startsWith('--pev-fail-bookmark='))
      .map((a) => a.slice('--pev-fail-bookmark='.length)),
  );
  const liveScopes = new Map<number, string | null>();
  let scopeSeq = 0;
  const order: OrderStep[] = [];
  const heldResults: Array<() => void> = [];
  ctx.sources.setAccess({
    picker: () => {
      pickerCalls += 1;
      return Promise.resolve(picks.shift() ?? null);
    },
    scopes: {
      start(bookmark) {
        if (bookmark === null || failingBookmarks.has(bookmark)) throw new ScopeError('test');
        scopeSeq += 1;
        const id = scopeSeq;
        liveScopes.set(id, bookmark);
        return {
          release() {
            liveScopes.delete(id);
          },
        };
      },
    },
    record: (step) => order.push(step),
  });

  const requests = new Map<number, WindowRequests>();
  let bodyCsp = true;

  const recordsFor = (windowId: number): WindowRequests => {
    let rec = requests.get(windowId);
    if (!rec) {
      rec = { app: [], body: [], asset: [], blocked: [], console: [], sessionPreconnects: [] };
      requests.set(windowId, rec);
    }
    return rec;
  };

  // Every frame's console messages and every preconnect request, per window.
  // Windows are created after this; each has a session of its own.
  const sessionsSeen = new WeakSet<Electron.Session>();
  app.on('web-contents-created', (_event, contents) => {
    if (!sessionsSeen.has(contents.session)) {
      sessionsSeen.add(contents.session);
      contents.session.on('preconnect', (_e, url) => {
        const appWin = ctx.windows.get(contents.id);
        if (appWin) recordsFor(appWin.id).sessionPreconnects.push(url);
      });
    }
    contents.on('console-message', (details) => {
      const appWin = ctx.windows.get(contents.id);
      if (!appWin) return;
      let frame = '';
      try {
        frame = details.frame?.url ?? '';
      } catch {
        // The frame is already gone.
      }
      recordsFor(appWin.id).console.push({ frame, text: details.message });
    });
  });

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
    externalCalls: () => externalCalls.map((c) => ({ method: c.method, args: [...c.args] })),
    externalStubbed: () =>
      SHELL_METHODS.every((name) => String(shell[name]).includes('record(')) &&
      CLIPBOARD_METHODS.every((name) => String(clipboard[name]).includes('record(')),
    windowEvents: () => windowEvents.events(),
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
        rec.console.length = 0;
        rec.sessionPreconnects.length = 0;
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
    crashRenderer: (windowId: number): boolean => {
      const contents = byId(windowId).win.webContents;
      // On Linux, forcefullyCrashRenderer() asks the renderer to crash itself
      // instead of ending it from main, so end the process directly there,
      // but only by a PID that names one process.
      if (process.platform !== 'linux') {
        contents.forcefullyCrashRenderer();
        return true;
      }
      const killed = killRenderer(contents.getOSProcessId(), (pid, signal) =>
        process.kill(pid, signal),
      );
      if (!killed) ctx.log.warn('test.crash_refused', { windowId, reason: 'invalid' });
      return killed;
    },
    core,
    corePid: () => ctx.core.pid,
    /** Sets the reader's message source: rowids mapped to files under `root`, or test inputs. */
    readerSource: (root: string, entries: Array<[number, SourceEntry]>) =>
      ctx.core.request({
        type: 'test',
        action: READER_SOURCE_ACTION,
        payload: { root, entries },
      }),
    readerLimits: (limits: { heapMb?: number; timeoutMs?: number }) =>
      ctx.core.request({ type: 'test', action: 'reader-limits', payload: limits }),
    /** Serves later HTML bodies without the sanitizer and the CSS filter, or with them again. */
    readerUnsanitized: (on: boolean) =>
      ctx.core.request({ type: 'test', action: READER_UNSANITIZED_ACTION, payload: on }),
    /** Opens a gate of the reader's test source; lookups waiting there go on. */
    readerGate: (name: string) =>
      ctx.core.request({ type: 'test', action: 'reader-gate', payload: name }),
    /** How many lookups of the reader's test source wait at a gate. */
    readerGateWaiting: (name: string) =>
      ctx.core.request({ type: 'test', action: 'reader-gate-waiting', payload: name }),
    /** The links main keeps for a live view, by id. */
    viewLinks: (windowId: number, token: string) => [
      ...(byId(windowId).views.lookup(token)?.links ?? []),
    ],
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
    /** The next folder picks; null stands for a cancelled dialog. */
    queuePick: (path: string | null, bookmark: string | null = 'test-bookmark') => {
      picks.push(path === null ? null : { path, bookmark });
    },
    pickerCalls: () => pickerCalls,
    failBookmark: (bookmark: string) => failingBookmarks.add(bookmark),
    clearFailingBookmarks: () => failingBookmarks.clear(),
    sourceOrder: () => order.map((step) => ({ ...step })),
    clearSourceOrder: () => {
      order.length = 0;
    },
    liveScopes: () => [...liveScopes.values()],
    sourcesView: () => ctx.sources.view(),
    sourceStamp: () => ctx.sources.stamp(),
    scanSummary: () => ctx.sources.scanSummary(),
    registryFile: () => ctx.sources.registry.file,
    /** Holds core's scan results in main, before main checks them. */
    holdSourceResults: () => {
      ctx.sources.setAccess({ hold: (next) => heldResults.push(next) });
    },
    releaseSourceResults: () => {
      ctx.sources.setAccess({ hold: null });
      const waiting = heldResults.splice(0);
      for (const next of waiting) next();
      return waiting.length;
    },
    heldSourceResults: () => heldResults.length,
    /** A read from the open source's index, as the shell will make it. */
    indexQuery: (query: IndexQuery) => ctx.sources.queryIndex(query),
    indexDir: () => join(app.getPath('userData'), 'index'),
    /** Resets the app's data, as Settings will. */
    resetApp: () => ctx.sources.reset(),
  };
  (globalThis as { __pevTest?: typeof api }).__pevTest = api;

  if (__PEV_FOLDER_PROOF__) {
    await runFolderProof(ctx, realOpenDialog, () => [...dialogCalls]);
    return true;
  }
  const bench = await import('./bench/main');
  if (bench.benchRequested(process.argv)) {
    void bench.runBench(ctx, process.argv);
    return true;
  }

  const selfTest = process.argv.includes('--pev-selftest');
  if (selfTest) {
    await runSelfTest(ctx, process.argv, windowEvents);
    return true;
  }
  return false;
}
