// SPDX-License-Identifier: AGPL-3.0-or-later
// Handlers for app:, mail-body: and mail-asset:. Each window session gets its
// own handlers, closed over that window's view registry.

import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { APP_HOST, BODY_CSP, VIEW_HOST } from '../shared/constants';
import { checkRaster } from '../core/reader/raster';
import type { Logger } from '../shared/log/writer';
import type { ViewRegistry } from './views';

export interface RequestLike {
  url: string;
  /**
   * Set (to an origin, or null for an opaque one) when a page made the
   * request; absent when the browser started it, as for a download main began.
   */
  initiatorOrigin?: string | null;
}

/** Serves the one-shot assets of a window's saves. */
export interface SaveAssets {
  /** The body of save asset `id` under `token`, once; null if there is none. */
  serve(token: string, id: string, initiated: boolean): Response | null;
}

export type Handler = (request: RequestLike) => Promise<Response>;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const ASSET_ID_RE = /^[a-z0-9][a-z0-9.]{0,31}$/;
const CID_RE = /^c\d{1,4}$/;
const VIEW_PATH_RE = /^\/([0-9a-f]{32})$/;
const ASSET_PATH_RE = /^\/([0-9a-f]{32})\/([^/]+)$/;

/**
 * Test builds only, for a diagnostic run: a request's or download's initiator
 * origin as a number a log field can carry (0 absent, 1 undefined, 2 null,
 * 3 empty, 4 opaque "null", 5 the shell, 6 a mail-body: origin, 7 a
 * mail-asset: origin, 8 another string, 9 another type).
 */
export function initiatorCode(present: boolean, value: unknown): number {
  if (!present) return 0;
  if (value === undefined) return 1;
  if (value === null) return 2;
  if (value === '') return 3;
  if (value === 'null') return 4;
  if (value === 'app://shell') return 5;
  if (typeof value === 'string' && value.startsWith('mail-body:')) return 6;
  if (typeof value === 'string' && value.startsWith('mail-asset:')) return 7;
  return typeof value === 'string' ? 8 : 9;
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export interface AppHandlerOptions {
  rendererDir: string;
  shellCsp: string;
  log: Logger;
  /** Called for every request before any check. */
  onRequest?: ((url: string) => void) | undefined;
  /** Extra routes, only wired up in builds with test hooks. */
  extraRoute?: ((pathname: string) => Promise<Response | null>) | undefined;
}

/** Serves the shell from the renderer output directory with fs. */
export function appHandler(options: AppHandlerOptions): Handler {
  const root = resolve(options.rendererDir);
  const reject = (reason: string): Response => {
    options.log.warn('protocol.not_found', { scheme: 'app', reason });
    return notFound();
  };
  return async (request) => {
    options.onRequest?.(request.url);
    const url = parse(request.url);
    if (!url || url.protocol !== 'app:' || url.host !== APP_HOST) return reject('bad_host');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return reject('bad_path');
    }
    if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) {
      return reject('bad_path');
    }
    if (options.extraRoute) {
      const extra = await options.extraRoute(pathname);
      if (extra) return extra;
    }
    const full = resolve(root, '.' + pathname);
    if (!full.startsWith(root + sep)) return reject('bad_path');
    const type = CONTENT_TYPES[extname(full).toLowerCase()];
    if (!type) return reject('bad_path');
    let bytes: Buffer;
    try {
      bytes = await readFile(full);
    } catch {
      return reject('bad_path');
    }
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = options.shellCsp;
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  };
}

export interface ViewHandlerOptions {
  views: ViewRegistry;
  log: Logger;
  windowId: number;
  /** False only when a test switches the body CSP off for a positive control. */
  bodyCspEnabled?: (() => boolean) | undefined;
  /** Called for every request before the token check. */
  onRequest?: ((url: string) => void) | undefined;
  /** The window's saves, whose assets are kept apart from any view's. */
  saves?: SaveAssets | undefined;
}

/** Serves `mail-body://v/<token>` for live views of this window only. */
export function bodyHandler(options: ViewHandlerOptions): Handler {
  return async (request) => {
    options.onRequest?.(request.url);
    const url = parse(request.url);
    const match = url && url.host === VIEW_HOST ? VIEW_PATH_RE.exec(url.pathname) : null;
    const view = match?.[1] ? options.views.lookup(match[1]) : undefined;
    if (!view) {
      options.log.info('protocol.not_found', {
        scheme: 'mail-body',
        reason: 'unknown_token',
        windowId: options.windowId,
      });
      return notFound();
    }
    const headers: Record<string, string> = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (options.bodyCspEnabled?.() ?? true) headers['Content-Security-Policy'] = BODY_CSP;
    return new Response(view.html, { status: 200, headers });
  };
}

/**
 * Serves `mail-asset://v/<token>/<id>` for assets registered with a live view
 * of this window. An inline image (`c<n>`) passes the raster check again here,
 * and is served with the type of the format it found. A save's asset has a
 * token of its own, outlives the view it was asked from, and is served once.
 */
export function assetHandler(options: ViewHandlerOptions): Handler {
  const reject = (reason: string): Response => {
    options.log.info('protocol.not_found', {
      scheme: 'mail-asset',
      reason,
      windowId: options.windowId,
    });
    return notFound();
  };
  return async (request) => {
    options.onRequest?.(request.url);
    const url = parse(request.url);
    const match = url && url.host === VIEW_HOST ? ASSET_PATH_RE.exec(url.pathname) : null;
    if (!match?.[1] || !match[2]) return reject('bad_path');
    if (options.saves) {
      const initiated = 'initiatorOrigin' in request && request.initiatorOrigin !== undefined;
      const saved = options.saves.serve(match[1], match[2], initiated);
      if (saved) return saved;
    }
    const view = options.views.lookup(match[1]);
    if (!view) {
      if (__PEV_TEST_HOOKS__) {
        options.log.info('test.log', {
          count: initiatorCode('initiatorOrigin' in request, request.initiatorOrigin),
          windowId: options.windowId,
        });
      }
      return reject('unknown_token');
    }
    const id = match[2];
    const asset = ASSET_ID_RE.test(id) ? view.assets.get(id) : undefined;
    if (!asset) return reject('unknown_asset');
    let contentType = asset.contentType;
    if (CID_RE.test(id)) {
      const check = checkRaster(asset.bytes);
      if (!check.ok) return reject(check.reason);
      contentType = check.image.contentType;
    }
    return new Response(new Uint8Array(asset.bytes), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };
}
