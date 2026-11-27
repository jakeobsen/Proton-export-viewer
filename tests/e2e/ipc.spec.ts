// SPDX-License-Identifier: AGPL-3.0-or-later
// IPC: generation-bound requests, and requests from a frame that is not the main frame.

import { expect, test } from './app';
import { SAMPLE, paneSource } from './pane-messages';

test('stale generations are rejected by the real main handler @pane', async ({ pev }) => {
  const ok = await pev.page.evaluate(() => window.pev.ping(1));
  expect(ok).toEqual({ ok: true, generation: 1 });

  await pev.main('bumpGeneration');
  expect(await pev.page.evaluate(() => window.pev.ping(1))).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  expect(await pev.page.evaluate(() => window.pev.open(1, 'html', 1))).toEqual({
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

test('a message open from the shell never starts core @pane', async ({ pev }) => {
  // With no export open, core runs without a source from launch: the reader's
  // test source serves the message.
  await paneSource(pev, SAMPLE);
  expect(await pev.page.evaluate(() => window.pev.open(1, 'html', 1))).toMatchObject({
    ok: true,
    outcome: 'view',
  });
  await pev.main('core', 'exit');
  await expect.poll(() => pev.hasLog('core.exit', { exitCode: 3 })).toBe(true);
  const spawns = () => pev.logs('main').filter((l) => l.code === 'core.spawn').length;
  const before = spawns();

  const unavailable = { ok: false, code: 'core_unavailable' };
  expect(await pev.page.evaluate(() => window.pev.open(1, 'html', 1))).toEqual(unavailable);
  expect(await pev.page.evaluate(() => window.pev.open(1, 'plain', 1))).toEqual(unavailable);
  await pev.page.waitForTimeout(500);
  expect(spawns()).toBe(before);
});

test('renderer logs and error reports for a stale generation are dropped', async ({ pev }) => {
  const rejectedStale = () =>
    pev
      .logs('main')
      .filter((l) => l.code === 'ipc.rejected' && l.data.reason === 'stale_generation').length;
  const rendererCodes = () => pev.logs('renderer').map((l) => l.code);

  // The current generation is accepted on both channels.
  await pev.page.evaluate(() => {
    window.pev.log('info', 'test.log', 1);
    window.pev.reportError({ generation: 1, kind: 'error', errorClass: 'Error', frames: [] });
  });
  await expect.poll(rendererCodes).toEqual(expect.arrayContaining(['test.log', 'renderer.error']));

  await pev.main('bumpGeneration');
  await pev.page.evaluate(() => {
    window.pev.log('warn', 'test.log', 1);
    window.pev.reportError({ generation: 1, kind: 'uncaught', errorClass: 'Error', frames: [] });
  });
  await expect.poll(rejectedStale).toBe(2);
  expect(rendererCodes()).not.toContain('renderer.uncaught');
  expect(pev.logs('renderer').filter((l) => l.code === 'test.log')).toHaveLength(1);

  // The next generation is accepted again.
  await pev.page.evaluate(() => window.pev.log('info', 'test.log', 2));
  await expect.poll(() => pev.logs('renderer').filter((l) => l.code === 'test.log').length).toBe(2);
});

test('state takes no arguments; every channel rejects a missing generation or extra arguments @pane', async ({
  pev,
}) => {
  const invoke = (channel: string, ...args: unknown[]) =>
    pev.page.evaluate(([c, a]) => window.__pevTestIpc.invoke(c, ...a), [channel, args] as const);
  const send = (channel: string, ...args: unknown[]) =>
    pev.page.evaluate(([c, a]) => window.__pevTestIpc.send(c, ...a), [channel, args] as const);
  const invalid = { ok: false, code: 'invalid' };

  expect(await invoke('pev:state')).toEqual({ ok: true, generation: 1 });
  expect(await invoke('pev:state', 1)).toEqual(invalid);
  expect(await invoke('pev:state', { generation: 1 })).toEqual(invalid);
  expect(await invoke('pev:state', undefined)).toEqual(invalid);
  expect(await invoke('pev:ping', {})).toEqual(invalid);
  expect(await invoke('pev:ping', { generation: 1 }, 'extra')).toEqual(invalid);
  expect(await invoke('pev:open', { rowid: 1, mode: 'html' })).toEqual(invalid);

  await send('pev:log', { level: 'info', code: 'test.log' });
  await send('pev:log', { generation: 1, level: 'info', code: 'test.log' }, 'extra');
  await send('pev:report', { kind: 'error', errorClass: 'Error', frames: [] });
  await expect
    .poll(
      () =>
        pev.logs('main').filter((l) => l.code === 'ipc.rejected' && l.data.reason === 'invalid')
          .length,
    )
    .toBe(9);
  expect(pev.logs('renderer')).toEqual([]);
});

test('malformed arguments are rejected @pane', async ({ pev }) => {
  const bad = await pev.page.evaluate(() =>
    (window.pev.open as unknown as (a: unknown, b: unknown, c: unknown) => Promise<unknown>)(
      '../x',
      'html',
      1,
    ),
  );
  expect(bad).toEqual({ ok: false, code: 'invalid' });
  expect(pev.hasLog('ipc.rejected', { reason: 'invalid' })).toBe(true);
});

test('the body frame has no preload API @pane', async ({ pev }) => {
  await paneSource(pev, SAMPLE);
  const { frame } = await pev.showInPane(1, 'html');
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
