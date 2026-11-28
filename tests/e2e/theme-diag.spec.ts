// SPDX-License-Identifier: AGPL-3.0-or-later
// Records how the Theme setting reaches the shell and a message's frame:
// after a live change, after the pages' preferences are applied again, and
// on a launch with Dark already stored. It always fails, with what it saw.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { testDir } from '../paths';
import { expect, launch, test, type PevApp } from './app';

interface Reader {
  pending: boolean;
  view: { url: string; format: 'html' | 'plain' } | null;
}

const reader = (pev: PevApp) => pev.shell<Reader>('reader');
const pressButton = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).dispatchEvent('click');
const settingsMain = (page: Page) => page.locator('main.settings');

async function chooseTheme(page: Page, theme: 'System' | 'Light' | 'Dark'): Promise<void> {
  await pressButton(page, 'Settings');
  await expect(settingsMain(page)).toBeVisible();
  await page.getByRole('tab', { name: 'Appearance' }).dispatchEvent('click');
  await page.getByRole('radio', { name: theme }).dispatchEvent('click');
  await expect(page.getByRole('radio', { name: theme })).toBeChecked();
  await pressButton(page, 'Back to mail');
  await expect(settingsMain(page)).toHaveCount(0);
}

const SCHEMES = [
  'Subject: Colours',
  'From: <sender@example.org>',
  'To: <owner@example.com>',
  'Date: Wed, 25 Nov 2026 08:02:11 +0100',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<style>@media (prefers-color-scheme: dark) { p { color: rgb(1, 2, 3); } }',
  '@media (prefers-color-scheme: light) { p { color: rgb(4, 5, 6); } }</style>',
  '<p>Colours in HTML.</p>',
  '',
].join('\r\n');

async function openSchemes(pev: PevApp, name: string): Promise<void> {
  const root = testDir(name);
  writeFileSync(join(root, 'schemes.eml'), SCHEMES);
  expect(
    (await pev.main<{ ok: boolean }>('readerSource', root, [[1, { file: 'schemes.eml' }]])).ok,
  ).toBe(true);
  await pev.shell('openInReader', [1]);
  await expect
    .poll(async () => {
      const r = await reader(pev);
      const src = await pev.page.locator('.rp-frame').getAttribute('src');
      return !r.pending && r.view?.format === 'html' && src === r.view.url;
    })
    .toBe(true);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function state(pev: PevApp, label: string): Promise<Record<string, unknown>> {
  await pause(1500);
  const main = await pev.main<Record<string, unknown>>('themeState');
  const shellDark = await pev.page.evaluate(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  let frameColor: string | null = null;
  let frameDark: boolean | null = null;
  const r = await reader(pev);
  if (r.view) {
    const frame = await pev.bodyFrame(r.view.url);
    frameColor = await frame.locator('p').evaluate((p) => getComputedStyle(p).color);
    frameDark = await frame
      .locator('p')
      .evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
  }
  return { label, ...main, shellDark, frameDark, frameColor };
}

test('theme: what the shell and the frame see', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const first = await launch('theme-diag', { appColorScheme: true });
  try {
    await openSchemes(first, 'theme-diag-a');
    seen.push(await state(first, 'start'));
    await chooseTheme(first.page, 'Dark');
    seen.push(await state(first, 'dark live'));
    await first.main('refreshWebPrefs');
    seen.push(await state(first, 'dark after refresh'));
    await chooseTheme(first.page, 'Light');
    seen.push(await state(first, 'light live'));
    await first.main('refreshWebPrefs');
    seen.push(await state(first, 'light after refresh'));
    await chooseTheme(first.page, 'Dark');
    seen.push(await state(first, 'dark live again'));
  } finally {
    await first.close();
  }
  const second = await launch('theme-diag', { userData: first.userData, appColorScheme: true });
  try {
    seen.push(await state(second, 'relaunch, dark stored'));
    await openSchemes(second, 'theme-diag-b');
    seen.push(await state(second, 'relaunch, frame opened'));
  } finally {
    await second.close();
  }
  expect(JSON.stringify(seen, null, 1)).toBe('(a record, not a check)');
});
