// SPDX-License-Identifier: AGPL-3.0-or-later
// Navigation policy: nothing navigates, except the body frame loading the one
// mail-body URL main last authorized for this window, as many times as its
// view allows: once, and once more after consent to its remote images.
// Popups never open; a link id of this window's live body view opens the
// link dialog instead.

import type { WebContents, WebFrameMain } from 'electron';
import type { Logger } from '../shared/log/writer';
import { schemeLabel } from './harden';
import type { LinkRefusal } from './links';
import type { ViewRegistry } from './views';

export interface NavigationOptions {
  views: ViewRegistry;
  windowId: number;
  log: Logger;
  /** Opens the link dialog for a link id of this window, or returns why it didn't. */
  openLink: (url: string) => LinkRefusal | null;
  /** Another subframe URL this window may load. Only test windows set it. */
  allowFrameUrl?: string | undefined;
}

export function sameFrame(a: WebFrameMain | null | undefined, b: WebFrameMain | null | undefined) {
  return !!a && !!b && a.processId === b.processId && a.frameToken === b.frameToken;
}

export function guardNavigation(contents: WebContents, options: NavigationOptions): void {
  const { log, windowId, views } = options;

  contents.on('will-navigate', (event) => {
    event.preventDefault();
    log.warn('nav.denied', { reason: 'main_frame', scheme: schemeLabel(event.url), windowId });
  });

  contents.on('will-frame-navigate', (event) => {
    const frame = event.frame;
    const isBodyFrame =
      !event.isMainFrame && !!frame && sameFrame(frame.parent, contents.mainFrame);
    const load = isBodyFrame ? views.spendLoad(event.url) : 'not_authorized';
    if (load === 'load') return;
    if (__PEV_TEST_HOOKS__ && !event.isMainFrame && event.url === options.allowFrameUrl) return;
    event.preventDefault();
    log.warn('nav.denied', {
      reason: event.isMainFrame
        ? 'main_frame'
        : load === 'spent'
          ? 'reload_spent'
          : 'not_authorized',
      scheme: schemeLabel(event.url),
      windowId,
    });
  });

  contents.on('will-redirect', (event) => {
    event.preventDefault();
    log.warn('nav.redirect_denied', { scheme: schemeLabel(event.url), windowId });
  });

  contents.setWindowOpenHandler(({ url }) => {
    const refused = options.openLink(url);
    if (refused !== null) {
      log.warn('nav.window_open_denied', { reason: refused, scheme: schemeLabel(url), windowId });
    }
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log.warn('nav.webview_denied', { windowId });
  });

  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    log.info('device.denied', { device: 'bluetooth', windowId });
    callback('');
  });
}
