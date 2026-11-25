// SPDX-License-Identifier: AGPL-3.0-or-later
// View tokens: revoked as soon as the next open is accepted, scoped to their
// window, and bound to the generation.

import { expect, test, tokenOf, type PevApp } from './app';
import type { Page } from '@playwright/test';

async function status(pev: PevApp, windowId: number, url: string): Promise<number> {
  return (await pev.main<{ status: number }>('fetchIn', windowId, url)).status;
}

function assetUrl(bodyUrl: string): string {
  return `mail-asset://v/${tokenOf(bodyUrl)}/c1`;
}

async function startOpen(pev: PevApp, slot: string, page: Page = pev.page): Promise<void> {
  await page.evaluate(
    ([id, key]) => {
      const w = window as unknown as Record<string, unknown> & {
        __pevTest: { open(id: string): Promise<unknown> };
      };
      w[key as string] = w.__pevTest.open(id as string);
    },
    ['sample', slot],
  );
}

type OpenOutcome = { ok: boolean; url?: string; code?: string };

async function finishOpen(pev: PevApp, slot: string, page: Page = pev.page): Promise<OpenOutcome> {
  return page.evaluate(
    (key) =>
      (window as unknown as Record<string, Promise<OpenOutcome>>)[key] as Promise<OpenOutcome>,
    slot,
  );
}

async function held(pev: PevApp): Promise<number> {
  return (await pev.main<{ value: number }>('core', 'held')).value;
}

test('revocation, window scope and generation', async ({ pev }) => {
  // Window A: the live body and its cid both serve first.
  const first = await pev.open('sample');
  const urlA1 = first.url as string;
  expect(await status(pev, 1, urlA1)).toBe(200);
  expect(await status(pev, 1, assetUrl(urlA1))).toBe(200);

  // A second open is accepted and held pending in core: the old view is already gone.
  await pev.main('core', 'hold');
  await startOpen(pev, '__pendingA2');
  await expect.poll(() => held(pev)).toBe(1);
  expect(await status(pev, 1, urlA1)).toBe(404);
  expect(await status(pev, 1, assetUrl(urlA1))).toBe(404);
  expect(await pev.main('authorizedUrl', 1)).toBeNull();
  expect(await held(pev)).toBe(1);
  await pev.main('core', 'release');
  const second = await finishOpen(pev, '__pendingA2');
  expect(second.ok).toBe(true);
  const urlA2 = second.url as string;
  expect(await status(pev, 1, urlA2)).toBe(200);

  // Window B serves its own token, but not A's.
  const b = await pev.openWindow('shell');
  const openedB = await pev.open('sample', b.page);
  const urlB = openedB.url as string;
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

test('a stale openId result does not install a view', async ({ pev }) => {
  await pev.main('core', 'hold');
  await startOpen(pev, '__first');
  await startOpen(pev, '__second');
  await expect.poll(() => held(pev)).toBe(2);
  await pev.main('core', 'release');
  const first = await finishOpen(pev, '__first');
  const second = await finishOpen(pev, '__second');
  expect(first).toEqual({ ok: false, code: 'superseded' });
  expect(second.ok).toBe(true);
  expect(await pev.main('liveViews', 1)).toBe(1);
  expect(await pev.main('authorizedUrl', 1)).toBe(second.url);
  expect(pev.hasLog('open.stale', { reason: 'open_id' })).toBe(true);
});

test('a completion from the previous generation cannot publish a view', async ({ pev }) => {
  await pev.main('core', 'hold');
  await startOpen(pev, '__pending');
  await expect.poll(() => held(pev)).toBe(1);
  await pev.main('bumpGeneration');
  await pev.main('core', 'release');
  const result = await finishOpen(pev, '__pending');
  expect(result).toEqual({ ok: false, code: 'stale_generation' });
  expect(await pev.main('liveViews', 1)).toBe(0);
  expect(await pev.main('authorizedUrl', 1)).toBeNull();
  expect(pev.hasLog('open.stale', { reason: 'generation' })).toBe(true);
});
