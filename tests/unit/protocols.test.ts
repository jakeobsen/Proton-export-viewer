// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appHandler, assetHandler, bodyHandler } from '../../src/main/protocols';
import { ViewRegistry } from '../../src/main/views';
import { samplePng } from '../../src/core/png';
import { BODY_CSP, SHELL_CSP } from '../../src/shared/constants';
import type { Logger } from '../../src/shared/log/writer';
import { testDir } from '../paths';
import { dimensionBombPng, gifImage } from '../../tools/gen-export/images.mjs';

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

describe('mail-asset: remote images', () => {
  const placeholder = samplePng();
  function setUp(served: unknown) {
    const views = new ViewRegistry();
    const open = views.accept();
    views.install(open.openId, open.token, 1, 1, {
      html: '<p>body</p>',
      assets: [
        { id: 'r1', contentType: 'image/png', bytes: placeholder },
        { id: 'c1', contentType: 'image/png', bytes: samplePng() },
      ],
      remoteRefs: ['https://a.test/1.png'],
    });
    const log = recording();
    const remote = { serve: vi.fn(() => Promise.resolve(served)) };
    const asset = assetHandler({ views, log, windowId: 1, remote: remote as never });
    return { asset, remote, log, url: (id: string) => `mail-asset://v/${open.token}/${id}` };
  }

  it('serves the registered placeholder while the view has no consent', async () => {
    const t = setUp({ kind: 'placeholder' });
    const res = await t.asset({ url: t.url('r1') });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(placeholder);
    expect(t.remote.serve).toHaveBeenCalledTimes(1);
  });

  it('serves a fetched image with the type main found, no-store and nosniff', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const t = setUp({ kind: 'image', bytes, contentType: 'image/webp' });
    const res = await t.asset({ url: t.url('r1') });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers.entries())).toEqual({
      'content-type': 'image/webp',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('gives 404 to an image whose view was revoked while it waited', async () => {
    const t = setUp({ kind: 'revoked' });
    expect((await t.asset({ url: t.url('r1') })).status).toBe(404);
    expect(t.log.events).toEqual([
      {
        code: 'protocol.not_found',
        data: { scheme: 'mail-asset', reason: 'unknown_token', windowId: 1 },
      },
    ]);
  });

  it('asks only for registered remote ids', async () => {
    const t = setUp({ kind: 'image', bytes: new Uint8Array([1]), contentType: 'image/png' });
    expect((await t.asset({ url: t.url('c1') })).status).toBe(200);
    expect((await t.asset({ url: t.url('r2') })).status).toBe(404);
    expect(t.remote.serve).not.toHaveBeenCalled();
  });
});

describe('mail-body: source documents', () => {
  it('serves only the current source document of a view, with the body headers', async () => {
    const views = new ViewRegistry();
    const open = views.accept();
    views.install(open.openId, open.token, 1, 1, {
      html: '<p>body</p>',
      assets: [],
      message: { rowid: 17, file: null, messageId: '', attachments: [] },
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
