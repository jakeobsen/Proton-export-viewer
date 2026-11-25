// SPDX-License-Identifier: AGPL-3.0-or-later
// Positive render through the real protocol path, and the exact response headers.

import { BODY_CSP } from '../../src/shared/constants';
import { expect, test, tokenOf } from './app';

test('a body with <style>, a style attribute and a cid image renders', async ({ pev }) => {
  const opened = await pev.open('sample');
  expect(opened.ok).toBe(true);
  const frame = await pev.bodyFrame(opened.url as string);

  const styles = await frame.evaluate(() => {
    const title = document.getElementById('stub-title') as HTMLElement;
    const inline = document.getElementById('stub-inline') as HTMLElement;
    return {
      titleColor: getComputedStyle(title).color,
      titleWeight: getComputedStyle(title).fontWeight,
      inlineColor: getComputedStyle(inline).color,
      inlineSpacing: getComputedStyle(inline).letterSpacing,
    };
  });
  expect(styles).toEqual({
    titleColor: 'rgb(18, 52, 86)',
    titleWeight: '700',
    inlineColor: 'rgb(120, 30, 60)',
    inlineSpacing: '2px',
  });

  await expect
    .poll(() =>
      frame.evaluate(() => {
        const img = document.getElementById('stub-cid') as HTMLImageElement;
        return img.complete ? img.naturalWidth : -1;
      }),
    )
    .toBe(16);
  expect(
    await frame.evaluate(
      () => (document.getElementById('stub-cid') as HTMLImageElement).naturalHeight,
    ),
  ).toBe(16);
});

test('mail-body: and mail-asset: send the exact headers', async ({ pev }) => {
  const opened = await pev.open('sample');
  const url = opened.url as string;
  const token = tokenOf(url);

  const body = await pev.main<{ status: number; headers: Record<string, string> }>(
    'fetchIn',
    1,
    url,
  );
  expect(body.status).toBe(200);
  expect(body.headers).toEqual({
    'content-security-policy': BODY_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-type': 'text/html; charset=utf-8',
  });

  const asset = await pev.main<{ status: number; headers: Record<string, string>; length: number }>(
    'fetchIn',
    1,
    `mail-asset://v/${token}/c1`,
  );
  expect(asset.status).toBe(200);
  expect(asset.headers['content-type']).toBe('image/png');
  expect(asset.headers['cache-control']).toBe('no-store');
  expect(asset.headers['x-content-type-options']).toBe('nosniff');
  expect(asset.length).toBeGreaterThan(0);
});

test('the shell gets the production CSP', async ({ pev }) => {
  const shell = await pev.main<{ status: number; headers: Record<string, string> }>(
    'fetchIn',
    1,
    'app://shell/index.html',
  );
  const expected = await pev.main<string>('shellCsp');
  expect(shell.status).toBe(200);
  expect(shell.headers['content-security-policy']).toBe(expected);
  expect(expected).not.toContain('localhost');
  expect(expected).not.toContain('unsafe-inline');
});
