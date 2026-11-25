// SPDX-License-Identifier: AGPL-3.0-or-later
// IPC: generation-bound requests, and requests from a frame that is not the main frame.

import { expect, test } from './app';

test('stale generations are rejected by the real main handler', async ({ pev }) => {
  const ok = await pev.page.evaluate(() => window.pev.ping(1));
  expect(ok).toEqual({ ok: true, generation: 1 });

  await pev.main('bumpGeneration');
  expect(await pev.page.evaluate(() => window.pev.ping(1))).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  expect(await pev.page.evaluate(() => window.pev.openStub('sample', 1))).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  expect(await pev.page.evaluate(() => window.pev.ping(2))).toEqual({ ok: true, generation: 2 });

  await expect
    .poll(
      () =>
        pev
          .logs('main')
          .filter((l) => l.code === 'ipc.rejected' && l.data.reason === 'stale_generation').length,
    )
    .toBe(2);
});

test('malformed arguments are rejected', async ({ pev }) => {
  const bad = await pev.page.evaluate(() =>
    (window.pev.openStub as unknown as (a: unknown, b: unknown) => Promise<unknown>)('../x', 1),
  );
  expect(bad).toEqual({ ok: false, code: 'invalid' });
  expect(pev.hasLog('ipc.rejected', { reason: 'invalid' })).toBe(true);
});

test('the body frame has no preload API', async ({ pev }) => {
  const opened = await pev.open('sample');
  const frame = await pev.bodyFrame(opened.url as string);
  expect(await frame.evaluate(() => typeof (window as unknown as { pev?: unknown }).pev)).toBe(
    'undefined',
  );
});

test('a request from a subframe reaches the main guard and is rejected', async ({ pev }) => {
  const { page } = await pev.openWindow('subframe');
  const subUrl = 'app://shell/__test/subframe.html';
  await expect.poll(() => page.frames().some((f) => f.url() === subUrl)).toBe(true);
  const sub = page.frames().find((f) => f.url() === subUrl);
  if (!sub) throw new Error('subframe missing');
  await sub.waitForLoadState('load');

  // In this test-only window the preload runs in subframes, so the request is really sent.
  expect(await sub.evaluate(() => typeof (window as unknown as { pev?: unknown }).pev)).toBe(
    'object',
  );
  const rejected = await sub.evaluate(() => window.pev.ping(1));
  expect(rejected).toEqual({ ok: false, code: 'not_main_frame' });

  // The same call from that window's main frame passes the same guard.
  const accepted = await page.evaluate(() => window.pev.ping(1));
  expect(accepted).toEqual({ ok: true, generation: 1 });

  await expect.poll(() => pev.hasLog('ipc.rejected', { reason: 'not_main_frame' })).toBe(true);
});
