// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BrowserWindow, Session } from 'electron';
import { IPC, type IndexUpdate } from '../shared/api';
import type { IndexProgress } from '../shared/index-types';
import type { LogWriter } from '../shared/log/writer';
import type { CoreHost } from './core-host';
import type { PolicyObserver } from './harden';
import type { LinkDialog } from './link-dialog';
import type { SourceManager } from './sources/manager';
import type { ViewRegistry } from './views';

export interface Paths {
  mainDir: string;
  outRoot: string;
  rendererDir: string;
  preloadPath: string;
  corePath: string;
}

export interface AppWindow {
  id: number;
  win: BrowserWindow;
  views: ViewRegistry;
  session: Session;
}

export interface AppContext {
  paths: Paths;
  log: LogWriter;
  rendererLog: LogWriter;
  frameRoots: Array<[string, string]>;
  /** Source generation. Every renderer request carries it; a stale one is rejected. */
  generation: number;
  /** App windows keyed by their webContents id. */
  windows: Map<number, AppWindow>;
  core: CoreHost;
  /** The export sources: picks, runs, scopes and the open one. */
  sources: SourceManager;
  linkDialog: LinkDialog;
  shellCsp: string;
  /** Set only in builds with test hooks: observes one window's session policy. */
  observerFor?: ((windowId: number) => PolicyObserver) | undefined;
  /** Set only in builds with test hooks: the least time between a window's opens. */
  openGapMs?: number | undefined;
}

/** Tells every shell window that the sources changed. */
export function notifySources(ctx: AppContext): void {
  for (const appWin of ctx.windows.values()) {
    if (!appWin.win.isDestroyed()) appWin.win.webContents.send(IPC.sourcesChanged);
  }
}

/** Tells every shell window where the open export's index stands, for the current generation. */
export function notifyIndex(ctx: AppContext, progress: IndexProgress): void {
  const update: IndexUpdate = { generation: ctx.generation, progress };
  for (const appWin of ctx.windows.values()) {
    if (!appWin.win.isDestroyed()) appWin.win.webContents.send(IPC.indexChanged, update);
  }
}

/** Moves to the next generation and revokes every view in every window. */
export function bumpGeneration(ctx: AppContext): number {
  ctx.generation += 1;
  for (const appWin of ctx.windows.values()) {
    const revoked = appWin.views.revokeAll();
    if (revoked > 0) {
      ctx.log.info('view.revoked', { reason: 'generation', count: revoked, windowId: appWin.id });
    }
  }
  return ctx.generation;
}
