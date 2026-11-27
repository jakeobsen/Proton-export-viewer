// SPDX-License-Identifier: AGPL-3.0-or-later
// Default-deny requests: a page whose CSP allows the requests proves that the
// session's own request filter cancels them, on each window.

import { randomBytes } from 'node:crypto';
import { expect, test } from './app';

const FETCH_PAGE = 'app://shell/__test/fetch.html';

test('the session request filter cancels a host name and an IP literal on each window', async ({
  pev,
}) => {
  const second = await pev.openWindow('shell');
  const windows = [
    { windowId: 1, page: pev.page },
    { windowId: second.windowId, page: second.page },
  ];

  for (const { windowId, page } of windows) {
    const nonce = randomBytes(6).toString('hex');
    const targets = [`https://leak-${nonce}.test/`, 'http://203.0.113.9/'];
    await pev.main('clearRequests');
    await pev.main('loadUrl', windowId, FETCH_PAGE);
    // Playwright learns of the navigation from its own event, which can come
    // after main's load call returns.
    await expect(page).toHaveURL(FETCH_PAGE);

    const results = await page.evaluate(
      (urls) =>
        Promise.all(
          urls.map((url) =>
            fetch(url).then(
              () => 'loaded',
              (err: Error) => `failed:${err.name}`,
            ),
          ),
        ),
      targets,
    );
    expect(results).toEqual(['failed:TypeError', 'failed:TypeError']);

    const seen = await pev.main<{ blocked: string[] }>('requests', windowId);
    for (const target of targets) expect(seen.blocked).toContain(target);
  }

  await expect
    .poll(() => pev.logs('main').filter((l) => l.code === 'net.blocked').length)
    .toBeGreaterThanOrEqual(4);
  expect(pev.hasLog('net.blocked', { windowId: 1, scheme: 'https' })).toBe(true);
  expect(pev.hasLog('net.blocked', { windowId: second.windowId, scheme: 'http' })).toBe(true);
});

test('production switches are applied', async ({ pev }) => {
  const switches = await pev.main<Array<[string, string]>>('switches');
  expect(switches).toEqual([
    ['host-resolver-rules', 'MAP * ~NOTFOUND'],
    ['disable-features', 'Prerender2'],
  ]);
});
