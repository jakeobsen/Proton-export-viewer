// SPDX-License-Identifier: AGPL-3.0-or-later
// Positive render through the real protocol path, and the exact response
// headers, in the reader pane's body frame.

import { BODY_CSP } from '../../src/shared/constants';
import { expect, test } from './app';
import { SAMPLE, paneSource } from './pane-messages';

test('a body with <style>, a style attribute and a remote image placeholder renders @pane', async ({
  pev,
}) => {
  await paneSource(pev, SAMPLE);
  const { frame } = await pev.showInPane(1, 'html');

  const styles = await frame.evaluate(() => {
    const title = document.getElementById('title') as HTMLElement;
    const inline = document.getElementById('inline') as HTMLElement;
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

  // The remote image shows as the view's 1 x 1 placeholder, from mail-asset:.
  expect(
    await frame.evaluate(() => document.getElementById('remote')?.getAttribute('src')),
  ).toMatch(/^mail-asset:\/\/v\/[0-9a-f]{32}\/r1$/);
  await expect
    .poll(() =>
      frame.evaluate(() => {
        const img = document.getElementById('remote') as HTMLImageElement;
        return img.complete ? [img.naturalWidth, img.naturalHeight] : null;
      }),
    )
    .toEqual([1, 1]);
});

test('mail-body: and mail-asset: send the exact headers @pane', async ({ pev }) => {
  await paneSource(pev, SAMPLE);
  const { url, token } = await pev.showInPane(1, 'html');

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
    `mail-asset://v/${token}/r1`,
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
