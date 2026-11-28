// SPDX-License-Identifier: AGPL-3.0-or-later
// Every window gets its own in-memory session, hardened before anything loads.

import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
import { SHELL_URL } from '../shared/constants';
import { forwardCardKeys } from './card-keys';
import type { AppContext, AppWindow } from './context';
import { hardenSession } from './harden';
import { guardNavigation } from './navigation';
import { ViewRegistry } from './views';

let nextWindowId = 1;

export interface WindowOptions {
  show?: boolean;
  url?: string;
  /** Runs the preload in subframes too. Only test windows use this. */
  subframePreload?: boolean;
  /** Another subframe URL this window may load. Only test windows use this. */
  allowFrameUrl?: string;
  /**
   * Keeps drawing frames for the whole window while it is hidden, as a
   * window with background throttling off does. Only test builds have it.
   */
  framesWhileHidden?: boolean;
}

function devServerUrl(): string | undefined {
  return __PEV_DEV__ ? process.env.ELECTRON_RENDERER_URL : undefined;
}

function devAllow(url: string): boolean {
  if (!__PEV_DEV__) return false;
  return (
    /^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(url) ||
    url.startsWith('devtools:')
  );
}

export function createAppWindow(ctx: AppContext, options: WindowOptions = {}): AppWindow {
  const windowId = nextWindowId;
  nextWindowId += 1;
  const ses = session.fromPartition(`win-${randomUUID()}`, { cache: false });
  const views = new ViewRegistry();
  hardenSession(ses, {
    views,
    windowId,
    rendererDir: ctx.paths.rendererDir,
    shellCsp: ctx.shellCsp,
    log: ctx.log,
    observer: ctx.observerFor?.(windowId),
    devAllow: __PEV_DEV__ ? devAllow : undefined,
  });

  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    // Shown on ready-to-show. Builds with test hooks never show a window.
    show: false,
    paintWhenInitiallyHidden: true,
    title: __PEV_APP_NAME__,
    webPreferences: {
      session: ses,
      preload: ctx.paths.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: options.subframePreload ?? false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: __PEV_TEST_HOOKS__ || __PEV_DEV__,
      ...(__PEV_TEST_HOOKS__
        ? options.framesWhileHidden
          ? { backgroundThrottling: false }
          : {}
        : {}),
    },
  });
  if (!__PEV_TEST_HOOKS__ && (options.show ?? true)) {
    win.once('ready-to-show', () => win.show());
  }
  const contents = win.webContents;
  const contentsId = contents.id;
  const appWin: AppWindow = { id: windowId, win, views, session: ses };
  ctx.windows.set(contentsId, appWin);

  guardNavigation(contents, {
    views,
    windowId,
    log: ctx.log,
    openLink: (url) => ctx.linkDialog.request(contents, appWin, url, ctx.generation),
    allowFrameUrl: options.allowFrameUrl,
  });
  forwardCardKeys(contents, () => views.authorizedUrl());
  contents.on('render-process-gone', (_event, details) => {
    ctx.log.error('renderer.gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      windowId,
    });
  });
  win.on('closed', () => {
    ctx.linkDialog.forget(windowId);
    const revoked = views.revokeAll();
    if (revoked > 0)
      ctx.log.info('view.revoked', { reason: 'window_closed', count: revoked, windowId });
    ctx.windows.delete(contentsId);
  });

  void win.loadURL(options.url ?? devServerUrl() ?? SHELL_URL);
  return appWin;
}
