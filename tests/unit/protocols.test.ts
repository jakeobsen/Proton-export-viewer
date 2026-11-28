// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appHandler, assetHandler, bodyHandler } from '../../src/main/protocols';
import { ViewRegistry } from '../../src/main/views';
import { samplePng } from '../../src/core/png';
import { BODY_CSP, SHELL_CSP } from '../../src/shared/constants';
import type { Logger } from '../../src/shared/log/writer';
import { testDir } from '../paths';
import { dimensionBombPng, gifImage, jpegImage } from '../../tools/gen-export/images.mjs';

const quiet: Logger = { log() {}, error() {}, warn() {}, info() {} };

/** A logger that keeps each event's code and data. */
function recording(): Logger & { events: Array<{ code: string; data: unknown }> } {
  const events: Array<{ code: string; data: unknown }> = [];
  const keep = (code: string, data?: unknown) => events.push({ code, data });
  return {
    events,
    log: (_level, code, data) => keep(code, data),
    error: keep,
    warn: keep,
    info: keep,
  };
}

function fixture() {
  const root = testDir('app-protocol');
  const renderer = join(root, 'renderer');
  mkdirSync(join(renderer, 'assets'), { recursive: true });
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><p>shell</p>');
  writeFileSync(join(renderer, 'assets', 'app.js'), 'export {}');
  mkdirSync(join(root, 'main'), { recursive: true });
  writeFileSync(join(root, 'main', 'index.js'), 'secret');
  writeFileSync(join(root, 'outside.html'), 'secret');
  return appHandler({ rendererDir: renderer, shellCsp: SHELL_CSP, log: quiet });
}

describe('app: handler', () => {
  const handle = fixture();

  it('serves the shell with the production CSP', async () => {
    const res = await handle({ url: 'app://shell/index.html' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(SHELL_CSP);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await handle({ url: 'app://shell/assets/app.js' })).status).toBe(200);
  });

  it.each([
    'app://shell/%2e%2e/main/index.js',
    'app://shell/%2e%2e/outside.html',
    'app://shell/..%2fmain%2findex.js',
    'app://shell/..%2foutside.html',
    'app://shell/%2e%2e%5coutside.html',
    'app://shell/index.html%00.js',
    'app://shell/assets/%2e%2e/%2e%2e/outside.html',
    'app://evil/index.html',
    'app://shell/missing.html',
    'app://shell/assets/',
    'app://shell/%E0%A4%A',
  ])('returns 404 for %s', async (url) => {
    const res = await handle({ url });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret');
  });
});

describe('mail-body: and mail-asset: handlers', () => {
  const views = new ViewRegistry();
  const open = views.accept();
  views.install(open.openId, open.token, 1, 1, {
    html: '<p>body</p>',
    assets: [
      { id: 'c1', contentType: 'image/png', bytes: samplePng() },
      { id: 'c2', contentType: 'image/png', bytes: new TextEncoder().encode('not an image') },
      // Registered with a type the bytes don't have: the bytes decide.
      { id: 'c3', contentType: 'text/html', bytes: gifImage(2, 2, 1) },
      { id: 'c4', contentType: 'image/png', bytes: dimensionBombPng(30000, 30000) },
      // Only c<n> is checked: a remote placeholder id is served as registered.
      { id: 'r1', contentType: 'image/png', bytes: samplePng() },
    ],
  });
  const body = bodyHandler({ views, log: quiet, windowId: 1 });
  const log = recording();
  const asset = assetHandler({ views, log, windowId: 1 });

  it('serves a live body with the exact headers', async () => {
    const res = await body({ url: `mail-body://v/${open.token}` });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers.entries())).toEqual({
      'content-security-policy': BODY_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-type': 'text/html; charset=utf-8',
    });
  });

  it('serves a registered raster asset with no-store and its exact type', async () => {
    const res = await asset({ url: `mail-asset://v/${open.token}/c1` });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['unknown token', `mail-body://v/${'0'.repeat(32)}`],
    ['wrong host', `mail-body://x/${open.token}`],
    ['extra path', `mail-body://v/${open.token}/x`],
  ])('returns 404 for a body with %s', async (_name, url) => {
    expect((await body({ url })).status).toBe(404);
  });

  it('serves an inline image with the type of the format the check found', async () => {
    const res = await asset({ url: `mail-asset://v/${open.token}/c3` });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
  });

  it.each([
    ['unknown asset', `mail-asset://v/${open.token}/c9`, 'unknown_asset'],
    ['no image signature', `mail-asset://v/${open.token}/c2`, 'format'],
    ['a canvas over the limit', `mail-asset://v/${open.token}/c4`, 'canvas'],
    ['unknown token', `mail-asset://v/${'0'.repeat(32)}/c1`, 'unknown_token'],
    ['traversal', `mail-asset://v/${open.token}/..%2fc1`, 'unknown_asset'],
  ])('returns 404 for an asset with %s, and logs why', async (_name, url, reason) => {
    log.events.length = 0;
    expect((await asset({ url })).status).toBe(404);
    expect(log.events).toEqual([
      { code: 'protocol.not_found', data: { scheme: 'mail-asset', reason, windowId: 1 } },
    ]);
  });

  it('returns 404 once the view is revoked', async () => {
    views.revokeAll();
    expect((await body({ url: `mail-body://v/${open.token}` })).status).toBe(404);
    expect((await asset({ url: `mail-asset://v/${open.token}/c1` })).status).toBe(404);
  });
});

describe('preview documents and images', () => {
  const views = new ViewRegistry();
  const open = views.accept();
  views.install(open.openId, open.token, 1, 1, { html: '<p>body</p>', assets: [] });
  const body = bodyHandler({ views, log: quiet, windowId: 1 });
  const log = recording();
  const asset = assetHandler({ views, log, windowId: 1 });
  const at = (scheme: string, n: number) => `${scheme}://v/${open.token}/p${n}`;

  it('serves the preview document with the body headers, showing only the image', async () => {
    // Held as PNG, but the bytes are a JPEG: the bytes decide the served type.
    const n = views.setPreview(open.openId, open.token, 0, 'image/png', jpegImage(4, 3))!;
    const doc = await body({ url: at('mail-body', n) });
    expect(doc.status).toBe(200);
    expect(Object.fromEntries(doc.headers.entries())).toEqual({
      'content-security-policy': BODY_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-type': 'text/html; charset=utf-8',
    });
    const html = await doc.text();
    expect(html).toContain(`<img src="${at('mail-asset', n)}" alt="">`);
    expect(html).not.toContain('body</p>');
    expect(html).not.toMatch(/<script|on[a-z]+=/i);
    const image = await asset({ url: at('mail-asset', n) });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect(image.headers.get('cache-control')).toBe('no-store');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves only the preview the view holds now', async () => {
    const old = views.setPreview(open.openId, open.token, 0, 'image/jpeg', jpegImage(4, 3))!;
    const now = views.setPreview(open.openId, open.token, 1, 'image/gif', gifImage(2, 2, 1))!;
    log.events.length = 0;
    expect((await body({ url: at('mail-body', old) })).status).toBe(404);
    expect((await asset({ url: at('mail-asset', old) })).status).toBe(404);
    expect(log.events).toEqual([
      {
        code: 'protocol.not_found',
        data: { scheme: 'mail-asset', reason: 'unknown_asset', windowId: 1 },
      },
    ]);
    expect((await asset({ url: at('mail-asset', now) })).headers.get('content-type')).toBe(
      'image/gif',
    );
  });

  it('checks the image again when serving it', async () => {
    const n = views.setPreview(
      open.openId,
      open.token,
      0,
      'image/png',
      dimensionBombPng(30000, 30000),
    )!;
    log.events.length = 0;
    expect((await asset({ url: at('mail-asset', n) })).status).toBe(404);
    expect(log.events).toEqual([
      { code: 'protocol.not_found', data: { scheme: 'mail-asset', reason: 'canvas', windowId: 1 } },
    ]);
  });

  it('returns 404 for both URLs once the preview is closed, and once the view is revoked', async () => {
    const n = views.setPreview(open.openId, open.token, 0, 'image/jpeg', jpegImage(4, 3))!;
    views.clearPreview(open.openId);
    expect((await body({ url: at('mail-body', n) })).status).toBe(404);
    expect((await asset({ url: at('mail-asset', n) })).status).toBe(404);
    expect((await body({ url: `mail-body://v/${open.token}` })).status).toBe(200);
    const next = views.setPreview(open.openId, open.token, 0, 'image/jpeg', jpegImage(4, 3))!;
    views.revokeAll();
    expect((await body({ url: at('mail-body', next) })).status).toBe(404);
    expect((await asset({ url: at('mail-asset', next) })).status).toBe(404);
  });
});

describe('mail-asset: handler for saves', () => {
  const views = new ViewRegistry();
  const token = 'a'.repeat(32);
  const asked: Array<{ token: string; id: string; method: string; header: string | null }> = [];
  const asset = assetHandler({
    views,
    log: quiet,
    windowId: 1,
    saves: {
      serve: (t, id, request) => {
        asked.push({ token: t, id, ...request });
        return request.header === 'n0nce' ? new Response('saved', { status: 200 }) : null;
      },
    },
  });

  it('hands a save its request’s method and proof header, matched without regard to case', async () => {
    asked.length = 0;
    const url = `mail-asset://v/${token}/a0`;
    const res = await asset(new Request(url, { headers: { 'x-pev-save': 'n0nce' } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('saved');
    const head = await asset(new Request(url, { method: 'HEAD', headers: { 'X-Pev-Save': 'x' } }));
    expect(head.status).toBe(404);
    expect((await asset(new Request(url))).status).toBe(404);
    expect(asked).toEqual([
      { token, id: 'a0', method: 'GET', header: 'n0nce' },
      { token, id: 'a0', method: 'HEAD', header: 'x' },
      { token, id: 'a0', method: 'GET', header: null },
    ]);
  });
});

describe('mail-body: source documents', () => {
  it('serves only the current source document of a view, with the body headers', async () => {
    const views = new ViewRegistry();
    const open = views.accept();
    views.install(open.openId, open.token, 1, 1, {
      html: '<p>body</p>',
      assets: [],
      message: {
        rowid: 17,
        file: null,
        version: null,
        messageId: '',
        subject: '',
        attachments: [],
      },
    });
    const body = bodyHandler({ views, log: quiet, windowId: 1 });
    const view = views.beginSource(open.openId)!;
    // None before the first block shows.
    expect((await body({ url: `mail-body://v/${open.token}/source/0` })).status).toBe(404);
    expect((await body({ url: `mail-body://v/${open.token}/source/1` })).status).toBe(404);
    const session = view.source!.session;
    views.showSource(view, session, views.select(view)!, '<pre>one</pre>', 'one');
    const first = await body({ url: `mail-body://v/${open.token}/source/1` });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('<pre>one</pre>');
    expect(Object.fromEntries(first.headers.entries())).toEqual({
      'content-security-policy': BODY_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-type': 'text/html; charset=utf-8',
    });
    views.showSource(view, session, views.select(view)!, '<pre>two</pre>', 'two');
    expect((await body({ url: `mail-body://v/${open.token}/source/1` })).status).toBe(404);
    expect(await (await body({ url: `mail-body://v/${open.token}/source/2` })).text()).toBe(
      '<pre>two</pre>',
    );
    // The body itself is still the view's.
    expect((await body({ url: `mail-body://v/${open.token}` })).status).toBe(200);
    // After Back, no source document is served.
    views.leaveSource(view);
    expect((await body({ url: `mail-body://v/${open.token}/source/2` })).status).toBe(404);
  });

  it("serves a source-only view's document, and never a body for it", async () => {
    const views = new ViewRegistry();
    const open = views.accept();
    views.markFallback(open.openId, 1, 17);
    const body = bodyHandler({ views, log: quiet, windowId: 1 });
    const view = views.beginSource(open.openId)!;
    expect(view.sourceOnly).toBe(true);
    views.showSource(view, view.source!.session, views.select(view)!, '<pre>h</pre>', 'h');
    expect((await body({ url: `mail-body://v/${open.token}/source/1` })).status).toBe(200);
    expect((await body({ url: `mail-body://v/${open.token}` })).status).toBe(404);
  });
});
