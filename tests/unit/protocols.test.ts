// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appHandler, assetHandler, bodyHandler, hasRasterMagic } from '../../src/main/protocols';
import { ViewRegistry } from '../../src/main/views';
import { samplePng } from '../../src/core/png';
import { BODY_CSP, SHELL_CSP } from '../../src/shared/constants';
import type { Logger } from '../../src/shared/log/writer';
import { testDir } from '../paths';

const quiet: Logger = { log() {}, error() {}, warn() {}, info() {} };

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
    ],
  });
  const body = bodyHandler({ views, log: quiet, windowId: 1 });
  const asset = assetHandler({ views, log: quiet, windowId: 1 });

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

  it.each([
    ['unknown asset', `mail-asset://v/${open.token}/c9`],
    ['bad magic bytes', `mail-asset://v/${open.token}/c2`],
    ['unknown token', `mail-asset://v/${'0'.repeat(32)}/c1`],
    ['traversal', `mail-asset://v/${open.token}/..%2fc1`],
  ])('returns 404 for an asset with %s', async (_name, url) => {
    expect((await asset({ url })).status).toBe(404);
  });

  it('returns 404 once the view is revoked', async () => {
    views.revokeAll();
    expect((await body({ url: `mail-body://v/${open.token}` })).status).toBe(404);
    expect((await asset({ url: `mail-asset://v/${open.token}/c1` })).status).toBe(404);
  });
});

describe('hasRasterMagic', () => {
  it('recognizes PNG, JPEG, GIF and WebP signatures only', () => {
    expect(hasRasterMagic(samplePng())).toBe(true);
    expect(hasRasterMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(hasRasterMagic(new TextEncoder().encode('GIF89a....'))).toBe(true);
    expect(hasRasterMagic(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
    expect(
      hasRasterMagic(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBe(false);
  });
});
