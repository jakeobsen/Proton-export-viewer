// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BrowserWindow, Session } from 'electron';
import type { LogWriter } from '../shared/log/writer';
import type { CoreHost } from './core-host';
import type { PolicyObserver } from './harden';
import type { LinkDialog } from './link-dialog';
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
  linkDialog: LinkDialog;
  shellCsp: string;
  /** Set only in builds with test hooks: observes one window's session policy. */
  observerFor?: ((windowId: number) => PolicyObserver) | undefined;
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
