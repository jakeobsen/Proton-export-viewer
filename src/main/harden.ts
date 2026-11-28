// SPDX-License-Identifier: AGPL-3.0-or-later
// One policy for every window session: scoped protocol handlers, default-deny
// requests, denied permissions and devices, no spellchecker, and no downloads
// but the saves main starts itself.

import type { Session } from 'electron';
import { ALLOWED_REQUEST_SCHEMES, devShellCsp } from '../shared/constants';
import { PERMISSIONS, SCHEMES } from '../shared/log/codes';
import type { Logger } from '../shared/log/writer';
import { appHandler, assetHandler, bodyHandler, initiatorCode } from './protocols';
import type { DownloadLike, WindowSaves } from './saves/manager';
import type { ViewRegistry } from './views';

/** Hooks a build with test hooks uses to observe the policy. Release builds leave them unset. */
export interface PolicyObserver {
  onAppRequest?: (url: string) => void;
  onBodyRequest?: (url: string) => void;
  onAssetRequest?: (url: string) => void;
  onBlocked?: (url: string) => void;
  bodyCspEnabled?: () => boolean;
  extraAppRoute?: (pathname: string) => Promise<Response | null>;
}

export interface HardenOptions {
  views: ViewRegistry;
  windowId: number;
  rendererDir: string;
  shellCsp: string;
  log: Logger;
  observer?: PolicyObserver | undefined;
  /** Extra origins allowed while running under the dev server. */
  devAllow?: ((url: string) => boolean) | undefined;
  /** The window's saves: the only downloads let through. */
  saves?: WindowSaves | undefined;
}

export function schemeLabel(url: string): (typeof SCHEMES)[number] {
  const colon = url.indexOf(':');
  const scheme = colon > 0 ? url.slice(0, colon).toLowerCase() : '';
  return (SCHEMES as readonly string[]).includes(scheme)
    ? (scheme as (typeof SCHEMES)[number])
    : 'other';
}

export function isAllowedRequest(url: string): boolean {
  const colon = url.indexOf(':');
  if (colon <= 0) return false;
  return ALLOWED_REQUEST_SCHEMES.includes(url.slice(0, colon + 1).toLowerCase());
}

function permissionLabel(permission: string): string {
  return (PERMISSIONS as readonly string[]).includes(permission) ? permission : 'other';
}

export function hardenSession(ses: Session, options: HardenOptions): void {
  const { log, windowId, observer } = options;

  ses.protocol.handle(
    'app',
    appHandler({
      rendererDir: options.rendererDir,
      shellCsp: options.shellCsp,
      log,
      onRequest: observer?.onAppRequest,
      extraRoute: observer?.extraAppRoute,
    }),
  );
  ses.protocol.handle(
    'mail-body',
    bodyHandler({
      views: options.views,
      log,
      windowId,
      bodyCspEnabled: observer?.bodyCspEnabled,
      onRequest: observer?.onBodyRequest,
    }),
  );
  ses.protocol.handle(
    'mail-asset',
    assetHandler({
      views: options.views,
      log,
      windowId,
      onRequest: observer?.onAssetRequest,
      saves: options.saves,
    }),
  );

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedRequest(details.url) || options.devAllow?.(details.url)) {
      callback({});
      return;
    }
    observer?.onBlocked?.(details.url);
    log.warn('net.blocked', { scheme: schemeLabel(details.url), windowId });
    callback({ cancel: true });
  });

  if (__PEV_DEV__) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      if (details.resourceType === 'mainFrame' && options.devAllow?.(details.url)) {
        headers['Content-Security-Policy'] = [devShellCsp()];
      }
      callback({ responseHeaders: headers });
    });
  }

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    log.info('perm.denied', { permission: permissionLabel(permission), windowId });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    log.info('device.denied', { device: 'display-media', windowId });
    callback(null);
  });
  ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    log.info('device.denied', { device: 'hid', windowId });
    callback();
  });
  ses.on('select-serial-port', (event, _ports, _webContents, callback) => {
    event.preventDefault();
    log.info('device.denied', { device: 'serial', windowId });
    callback('');
  });
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    log.info('device.denied', { device: 'usb', windowId });
    callback();
  });

  ses.setSpellCheckerEnabled(false);

  // Only a save main started goes ahead; any other download is cancelled, and
  // its URL is never logged.
  ses.on('will-download', (event, item, _webContents, frame) => {
    if (__PEV_TEST_HOOKS__) {
      let origin = 10;
      let chain = 0;
      try {
        origin = initiatorCode(true, item.getInitiatorOrigin());
        chain = item.getURLChain().length;
      } catch {
        // Left at 10 and 0.
      }
      log.info('test.log', {
        exitCode: origin,
        openId: frame === undefined ? 0 : frame === null ? 1 : 2,
        rowid: chain,
        windowId,
      });
    }
    if (options.saves?.willDownload(item as DownloadLike, frame ?? null)) return;
    event.preventDefault();
    log.info('download.cancelled', { windowId });
  });
}
