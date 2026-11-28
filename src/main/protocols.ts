// SPDX-License-Identifier: AGPL-3.0-or-later
// Handlers for app:, mail-body: and mail-asset:. Each window session gets its
// own handlers, closed over that window's view registry.

import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { APP_HOST, BODY_CSP, VIEW_HOST } from '../shared/constants';
import { checkRaster } from '../core/reader/raster';
import type { Logger } from '../shared/log/writer';
import { SAVE_PROOF_HEADER, type SaveRequestProof } from './saves/manager';
import { previewAssetUrl, type View, type ViewRegistry } from './views';

export interface RequestLike {
  url: string;
  method?: string;
  headers?: { get(name: string): string | null };
}

/** Serves the one-shot assets of a window's saves. */
export interface SaveAssets {
  /** The body of save asset `id` under `token`, once, to main's own request; null otherwise. */
  serve(token: string, id: string, request: SaveRequestProof): Response | null;
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
const PREVIEW_RE = /^p(\d{1,9})$/;
// A view's body, its source document number n, or its preview's document.
const VIEW_PATH_RE = /^\/([0-9a-f]{32})(?:\/source\/([1-9]\d{0,8})|\/(p\d{1,9}))?$/;
const ASSET_PATH_RE = /^\/([0-9a-f]{32})\/([^/]+)$/;

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

/** The preview `id` (`p<n>`) names, if `view` holds it now. */
function previewOf(view: View, id: string) {
  const match = PREVIEW_RE.exec(id);
  return match && view.preview && String(view.preview.n) === match[1] ? view.preview : null;
}

/**
 * The fixed document a preview frame shows: the preview's image alone,
 * scaled to fit. It holds no mail data, only the image's URL.
 */
export function previewDocument(token: string, n: number): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;height:100%;overflow:hidden}' +
    'body{display:flex;align-items:center;justify-content:center}' +
    'img{max-width:100%;max-height:100%;object-fit:contain}' +
    `</style></head><body><img src="${previewAssetUrl(token, n)}" alt=""></body></html>`
  );
}

/**
 * Serves `mail-body://v/<token>` for live views of this window only,
 * `mail-body://v/<token>/source/<n>` while that is the view's current source
 * document, and `mail-body://v/<token>/p<n>`, the document of the preview
 * that view holds now. A source-only view has no body.
 */
export function bodyHandler(options: ViewHandlerOptions): Handler {
  return async (request) => {
    options.onRequest?.(request.url);
    const url = parse(request.url);
    const match = url && url.host === VIEW_HOST ? VIEW_PATH_RE.exec(url.pathname) : null;
    const view = match?.[1] ? options.views.lookup(match[1]) : undefined;
    const n = match?.[2];
    const previewId = match?.[3];
    const preview = view && previewId !== undefined ? previewOf(view, previewId) : null;
    const html = !view
      ? null
      : n !== undefined
        ? options.views.sourceDoc(view.token, Number(n))
        : previewId !== undefined
          ? preview && previewDocument(view.token, preview.n)
          : view.sourceOnly
            ? null
            : view.html;
    if (html === null) {
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
    return new Response(html, { status: 200, headers });
  };
}

/**
 * Serves `mail-asset://v/<token>/<id>` for assets registered with a live view
 * of this window. An inline image (`c<n>`) and the view's preview (`p<n>`)
 * pass the raster check again here, and are served with the type of the
 * format it found. A save's asset has a token of its own, outlives the view
 * it was asked from, and is served once.
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
      const saved = options.saves.serve(match[1], match[2], {
        method: request.method ?? '',
        header: request.headers?.get(SAVE_PROOF_HEADER) ?? null,
      });
      if (saved) return saved;
    }
    const view = options.views.lookup(match[1]);
    if (!view) return reject('unknown_token');
    const id = match[2];
    if (PREVIEW_RE.test(id)) {
      const preview = previewOf(view, id);
      if (!preview) return reject('unknown_asset');
      const check = checkRaster(preview.bytes);
      if (!check.ok) return reject(check.reason);
      return new Response(new Uint8Array(preview.bytes), {
        status: 200,
        headers: {
          'Content-Type': check.image.contentType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
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
