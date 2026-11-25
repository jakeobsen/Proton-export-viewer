// SPDX-License-Identifier: AGPL-3.0-or-later
// Navigation: links go to the link dialog, nothing navigates, and only the
// authorized body URL can be (re)loaded.

import { expect, test, type PevApp } from './app';

async function dialogs(pev: PevApp): Promise<Array<{ windowId: number; url: string }>> {
  return pev.main('linkDialogs');
}

async function bodyRequests(pev: PevApp, url: string): Promise<number> {
  const r = await pev.main<{ body: string[] }>('requests', 1);
  return r.body.filter((u) => u === url).length;
}

test.beforeEach(async ({ pev }) => {
  // Count openExternal calls; the stub dialog must never make one.
  await pev.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __openExternal: number };
    g.__openExternal = 0;
    shell.openExternal = async () => {
      g.__openExternal += 1;
    };
  });
});

test.afterEach(async ({ pev }) => {
  expect(
    await pev.app.evaluate(
      () => (globalThis as unknown as { __openExternal: number }).__openExternal,
    ),
  ).toBe(0);
});

test('a link click in the body opens the link dialog and nothing navigates', async ({ pev }) => {
  const opened = await pev.open('sample');
  const url = opened.url as string;
  const frame = await pev.bodyFrame(url);
  await frame.click('#stub-link');

  await expect.poll(() => dialogs(pev)).toEqual([{ windowId: 1, url: 'https://example.com/' }]);
  await expect(pev.page.locator('.dialog-url')).toHaveText('https://example.com/');
  expect(frame.url()).toBe(url);
  expect(pev.page.url()).toBe('app://shell/index.html');
  expect(pev.app.windows()).toHaveLength(1);
});

test('target=_blank links go to the dialog', async ({ pev }) => {
  const opened = await pev.open('links');
  const frame = await pev.bodyFrame(opened.url as string);
  await frame.click('#link-blank');
  // The link dialog covers the body; cancel it like a user before the next link.
  await expect(pev.page.locator('.dialog-url')).toHaveText('https://example.org/blank');
  await pev.page.click('.dialog-button');
  await expect(pev.page.locator('.dialog')).toHaveCount(0);
  await frame.click('#link-mailto');
  await expect(pev.page.locator('.dialog-url')).toHaveText('mailto:someone@example.org');
  await expect
    .poll(() => dialogs(pev))
    .toEqual([
      { windowId: 1, url: 'https://example.org/blank' },
      { windowId: 1, url: 'mailto:someone@example.org' },
    ]);
  expect(frame.url()).toBe(opened.url);
  expect(pev.app.windows()).toHaveLength(1);
});

for (const id of ['#link-self', '#link-plain']) {
  test(`a ${id.slice(6)} https link in the body is denied`, async ({ pev }) => {
    const opened = await pev.open('links');
    const frame = await pev.bodyFrame(opened.url as string);
    await pev.main('clearRequests');
    await frame.click(id);
    // The shell CSP (frame-src mail-body:) stops the frame navigation before any request.
    await expect
      .poll(() =>
        pev.consoleMessages.some(
          (m) => m.text.includes('frame-src mail-body:') && m.text.includes('https://example.org/'),
        ),
      )
      .toBe(true);
    expect(pev.page.frames().some((f) => f.url().startsWith('https:'))).toBe(false);
    const seen = await pev.main<{ blocked: string[] }>('requests', 1);
    expect(seen.blocked).toEqual([]);
    expect(await dialogs(pev)).toEqual([]);
    expect(pev.page.url()).toBe('app://shell/index.html');
  });
}

test('window.open from the shell goes to the dialog', async ({ pev }) => {
  await pev.shell('windowOpen', ['https://example.org/popup']);
  await expect
    .poll(() => dialogs(pev))
    .toEqual([{ windowId: 1, url: 'https://example.org/popup' }]);
  expect(pev.app.windows()).toHaveLength(1);
});

test('the body frame cannot load an old or guessed token', async ({ pev }) => {
  const first = await pev.open('sample');
  const second = await pev.open('sample');
  const current = second.url as string;
  const frame = await pev.bodyFrame(current);

  let denied = 0;
  for (const target of [first.url as string, `mail-body://v/${'f'.repeat(32)}`]) {
    const before = await bodyRequests(pev, target);
    await pev.shell('setFrameSrc', [target]);
    denied += 1;
    await expect
      .poll(
        () =>
          pev.logs('main').filter((l) => l.code === 'nav.denied' && l.data.scheme === 'mail-body')
            .length,
      )
      .toBe(denied);
    expect(await bodyRequests(pev, target)).toBe(before);
    expect(frame.url()).toBe(current);
  }
});

test('meta refresh in a body is denied', async ({ pev }) => {
  await pev.main('clearRequests');
  const refresh = await pev.open('refresh');
  const frame = await pev.bodyFrame(refresh.url as string);
  // The iframe sandbox (no allow-scripts) refuses the refresh before it navigates.
  await expect
    .poll(() =>
      pev.consoleMessages.some(
        (m) => m.text.includes("<meta http-equiv='refresh'") && m.text.includes('sandboxed'),
      ),
    )
    .toBe(true);
  await pev.page.waitForTimeout(1500);
  expect(frame.url()).toBe(refresh.url);
  expect(await frame.locator('#refresh-title').textContent()).toBe('Refresh body');
  const seen = await pev.main<{ blocked: string[] }>('requests', 1);
  expect(seen.blocked).toEqual([]);
});

test('main-frame navigation is denied', async ({ pev }) => {
  for (const target of ['https://example.org/', 'app://shell/index.html?other']) {
    await pev.shell('navigateMain', [target]).catch(() => undefined);
  }
  await expect
    .poll(
      () =>
        pev.logs('main').filter((l) => l.code === 'nav.denied' && l.data.reason === 'main_frame')
          .length,
    )
    .toBeGreaterThanOrEqual(2);
  expect(pev.page.url()).toBe('app://shell/index.html');
});

test('the authorized reload of the current token works', async ({ pev }) => {
  const opened = await pev.open('sample');
  const url = opened.url as string;
  await pev.bodyFrame(url);
  expect(await bodyRequests(pev, url)).toBe(1);
  await pev.shell('setFrameSrc', [url]);
  await expect.poll(() => bodyRequests(pev, url)).toBe(2);
  const frame = await pev.bodyFrame(url);
  expect(await frame.locator('#stub-title').textContent()).toBe('Sample message');
});
