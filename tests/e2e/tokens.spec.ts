// SPDX-License-Identifier: AGPL-3.0-or-later
// View tokens: revoked as soon as the next open is accepted, scoped to their
// window, and bound to the generation. Messages open in the reader pane, as
// the shell opens them.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { MessageOpenResult } from '../../src/shared/api';
import { testDir } from '../paths';
import { expect, test, tokenOf, type PevApp } from './app';
import { SAMPLE } from './pane-messages';

async function status(pev: PevApp, windowId: number, url: string): Promise<number> {
  return (await pev.main<{ status: number }>('fetchIn', windowId, url)).status;
}

/** The view's remote image placeholder. */
function assetUrl(bodyUrl: string): string {
  return `mail-asset://v/${tokenOf(bodyUrl)}/r1`;
}

/**
 * Two copies of a message with a remote image. The second one's lookup waits
 * at a gate when `gated`, until a test opens it.
 */
async function source(pev: PevApp, gated = false): Promise<void> {
  const root = testDir('tokens-root');
  writeFileSync(join(root, 'sample.eml'), SAMPLE);
  const result = await pev.main<{ ok: boolean }>('readerSource', root, [
    [1, { file: 'sample.eml' }],
    [2, gated ? { file: 'sample.eml', gate: 'second' } : { file: 'sample.eml' }],
  ]);
  expect(result.ok).toBe(true);
}

/** Starts an open in the reader pane and keeps its promise in the page under `slot`. */
async function startOpen(pev: PevApp, rowid: number, slot: string, page: Page = pev.page) {
  await page.evaluate(
    ([r, key]) => {
      const w = window as unknown as Record<string, unknown> & {
        __pevTest: { openInReader(rowid: number): Promise<unknown> };
      };
      w[key as string] = w.__pevTest.openInReader(r as number);
    },
    [rowid, slot] as const,
  );
}

async function finishOpen(
  pev: PevApp,
  slot: string,
  page: Page = pev.page,
): Promise<MessageOpenResult> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, Promise<MessageOpenResult>>)[key]!,
    slot,
  );
}

function viewUrl(result: MessageOpenResult): string {
  if (!result.ok || result.outcome !== 'view')
    throw new Error(`no view: ${JSON.stringify(result)}`);
  return result.url;
}

async function held(pev: PevApp): Promise<number> {
  return (await pev.main<{ value: number }>('core', 'held')).value;
}

test('revocation, window scope and generation @pane', async ({ pev }) => {
  await source(pev);
  // Window A: the live body and its asset both serve first.
  const first = await pev.showInPane(1);
  const urlA1 = first.url;
  expect(await status(pev, 1, urlA1)).toBe(200);
  expect(await status(pev, 1, assetUrl(urlA1))).toBe(200);

  // A second open is accepted and held pending in core: the old view is already gone.
  await pev.main('core', 'hold');
  await startOpen(pev, 2, '__pendingA2');
  await expect.poll(() => held(pev)).toBe(1);
  expect(await status(pev, 1, urlA1)).toBe(404);
  expect(await status(pev, 1, assetUrl(urlA1))).toBe(404);
  expect(await pev.main('authorizedUrl', 1)).toBeNull();
  expect(await held(pev)).toBe(1);
  await pev.main('core', 'release');
  const urlA2 = viewUrl(await finishOpen(pev, '__pendingA2'));
  await pev.paneFrame(urlA2);
  expect(await status(pev, 1, urlA2)).toBe(200);

  // Window B serves its own token, but not A's.
  const b = await pev.openWindow('shell');
  const openedB = await pev.showInPane(1, undefined, b.page);
  const urlB = openedB.url;
  expect(await status(pev, b.windowId, urlB)).toBe(200);
  expect(await status(pev, b.windowId, assetUrl(urlB))).toBe(200);
  expect(await status(pev, b.windowId, urlA2)).toBe(404);
  expect(await status(pev, b.windowId, assetUrl(urlA2))).toBe(404);
  expect(await status(pev, 1, urlB)).toBe(404);
  expect(await status(pev, 1, urlA2)).toBe(200);

  // A generation bump revokes every view.
  await pev.main('bumpGeneration');
  expect(await status(pev, 1, urlA2)).toBe(404);
  expect(await status(pev, 1, assetUrl(urlA2))).toBe(404);
  expect(await status(pev, b.windowId, urlB)).toBe(404);
  expect(await status(pev, b.windowId, assetUrl(urlB))).toBe(404);
});

test('a stale openId result does not install a view @pane', async ({ pev }) => {
  // The newer open's lookup waits at a gate, so the older open's result
  // reaches main first, and main's own check discards it.
  await source(pev, true);
  await pev.main('core', 'hold');
  await startOpen(pev, 1, '__first');
  await startOpen(pev, 2, '__second');
  await expect.poll(() => held(pev)).toBe(2);
  await pev.main('core', 'release');
  expect(await finishOpen(pev, '__first')).toEqual({ ok: false, code: 'superseded' });
  await pev.main('readerGate', 'second');
  const second = viewUrl(await finishOpen(pev, '__second'));
  expect(await pev.main('liveViews', 1)).toBe(1);
  expect(await pev.main('authorizedUrl', 1)).toBe(second);
  expect(pev.hasLog('open.stale', { reason: 'open_id' })).toBe(true);
  await pev.paneFrame(second);
});

test('a completion from the previous generation cannot publish a view @pane', async ({ pev }) => {
  await source(pev);
  await pev.main('core', 'hold');
  await startOpen(pev, 1, '__pending');
  await expect.poll(() => held(pev)).toBe(1);
  await pev.main('bumpGeneration');
  await pev.main('core', 'release');
  const result = await finishOpen(pev, '__pending');
  expect(result).toEqual({ ok: false, code: 'stale_generation' });
  expect(await pev.main('liveViews', 1)).toBe(0);
  expect(await pev.main('authorizedUrl', 1)).toBeNull();
  expect(pev.hasLog('open.stale', { reason: 'generation' })).toBe(true);
  await expect(pev.page.locator('.rp-frame')).toHaveCount(0);
});
