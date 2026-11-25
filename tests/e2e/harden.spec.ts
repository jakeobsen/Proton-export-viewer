// SPDX-License-Identifier: AGPL-3.0-or-later
// hardenSession() applies to every window: checked on a second window.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './app';

test('a second window gets the same session policy', async ({ pev }) => {
  const second = await pev.openWindow('shell');
  const page = second.page;

  const permissions = await page.evaluate(async () => {
    const geo = await navigator.permissions.query({ name: 'geolocation' });
    const notify = await Notification.requestPermission();
    const media = await navigator.mediaDevices.getUserMedia({ audio: true }).then(
      () => 'granted',
      (err: Error) => err.name,
    );
    return { geo: geo.state, notify, media };
  });
  expect(permissions.geo).toBe('denied');
  expect(permissions.notify).toBe('denied');
  expect(permissions.media).not.toBe('granted');
  await expect.poll(() => pev.hasLog('perm.denied', { windowId: second.windowId })).toBe(true);

  // Spellchecker off on both sessions.
  expect(await pev.main('spellcheck', 1)).toBe(false);
  expect(await pev.main('spellcheck', second.windowId)).toBe(false);

  // Protocols are scoped: each session serves only its own views.
  const own = await pev.open('sample', page);
  expect((await pev.main<{ status: number }>('fetchIn', second.windowId, own.url)).status).toBe(
    200,
  );
  expect((await pev.main<{ status: number }>('fetchIn', 1, own.url)).status).toBe(404);

  // Downloads are cancelled and logged; nothing is written.
  await pev.main('download', second.windowId, 'app://shell/probe.png');
  await expect
    .poll(() => pev.hasLog('download.cancelled', { windowId: second.windowId }))
    .toBe(true);
  const downloads = join(pev.userData, 'downloads');
  expect(existsSync(downloads) ? readdirSync(downloads) : []).toEqual([]);
});
