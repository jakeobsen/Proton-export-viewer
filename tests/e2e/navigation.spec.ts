// SPDX-License-Identifier: AGPL-3.0-or-later
// Navigation: link ids go to the link dialog, nothing navigates, and only the
// authorized body URL can be (re)loaded. Bodies open in the reader pane; those
// the sanitizer would clean go through the reader's unsanitized path.

import type { Frame } from '@playwright/test';
import { expect, test, type PevApp } from './app';
import { LINKS, RAW_LINKS, REFRESH, SAMPLE, paneSource, unsanitized } from './pane-messages';

interface Shown {
  windowId: number;
  url: string;
}

async function dialogs(pev: PevApp): Promise<Array<{ windowId: number; url: string }>> {
  const shown = await pev.main<Shown[]>('linkDialogs');
  return shown.map(({ windowId, url }) => ({ windowId, url }));
}

/** Polls `check` every 100 ms for up to `ms`; returns its last result. */
async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return check();
}

/**
 * Clicks a link in the body frame until the link dialog has recorded `count`
 * links. A click into the body frame of a window that was never shown can be
 * lost while the frame is not yet ready for input, so it is tried again, up to
 * five times, two seconds apart. Callers still check the exact list of
 * dialogs, so a late click that opened a second one fails the test.
 */
async function clickToDialog(
  pev: PevApp,
  frame: Frame,
  selector: string,
  count: number,
): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await frame.click(selector);
    const end = Date.now() + 2_000;
    while (Date.now() < end) {
      if ((await dialogs(pev)).length >= count) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function bodyRequests(pev: PevApp, url: string): Promise<number> {
  const r = await pev.main<{ body: string[] }>('requests', 1);
  return r.body.filter((u) => u === url).length;
}

// Nothing here may open another app or write to the clipboard.
test.afterEach(async ({ pev }) => {
  expect(await pev.main('externalCalls')).toEqual([]);
});

test('a link click in the body opens the link dialog and nothing navigates @pane', async ({
  pev,
}) => {
  await paneSource(pev, SAMPLE);
  const { url, frame } = await pev.showInPane(1, 'html');
  await clickToDialog(pev, frame, '#link', 1);
  expect(await dialogs(pev)).toEqual([{ windowId: 1, url: 'https://example.com/' }]);
  await expect(pev.page.locator('.link-url')).toHaveText('https://example.com/');
  await expect(pev.page.locator('.link-title')).toHaveText('example.com');
  expect(frame.url()).toBe(url);
  expect(pev.page.url()).toBe('app://shell/index.html');
  expect(pev.app.windows()).toHaveLength(1);
});

test('target=_blank link ids go to the dialog @pane', async ({ pev }) => {
  await paneSource(pev, LINKS);
  const opened = await pev.showInPane(1, 'html');
  const frame = opened.frame;
  await clickToDialog(pev, frame, '#link-blank', 1);
  expect(await dialogs(pev)).toEqual([{ windowId: 1, url: 'https://example.org/blank' }]);
  // The link dialog covers the body; cancel it like a user before the next link.
  await expect(pev.page.locator('.link-url')).toHaveText('https://example.org/blank');
  await pev.page.click('.link-cancel');
  await expect(pev.page.locator('.link-dialog')).toHaveCount(0);
  await clickToDialog(pev, frame, '#link-mailto', 2);
  await expect(pev.page.locator('.link-url')).toHaveText('mailto:someone@example.org');
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
  test(`a ${id.slice(6)} https link in the body is denied @pane`, async ({ pev }) => {
    await paneSource(pev, RAW_LINKS);
    await unsanitized(pev);
    const { frame } = await pev.showInPane(1, 'html');
    await pev.main('clearRequests');
    // The shell CSP (frame-src mail-body:) stops the frame navigation before any request.
    const stoppedByCsp = () =>
      pev.consoleMessages.some(
        (m) => m.text.includes('frame-src mail-body:') && m.text.includes('https://example.org/'),
      );
    // Nothing may leave, navigate or open the dialog, after any click.
    const nothingHappened = async () => {
      expect(pev.page.frames().some((f) => f.url().startsWith('https:'))).toBe(false);
      const seen = await pev.main<{ blocked: string[] }>('requests', 1);
      expect(seen.blocked).toEqual([]);
      expect(await dialogs(pev)).toEqual([]);
      expect(pev.page.url()).toBe('app://shell/index.html');
    };
    // A click into the body frame of a window that was never shown can be lost
    // while the frame is not yet ready for input, so click again until the CSP
    // stops one. Every attempt is checked in full; a failed check is not retried.
    let stopped = false;
    for (let attempt = 1; attempt <= 5 && !stopped; attempt += 1) {
      await frame.click(id);
      stopped = await waitFor(stoppedByCsp, 2_000);
      await nothingHappened();
    }
    if (!stopped) {
      console.log('console:', JSON.stringify(pev.consoleMessages.slice(-10)));
      console.log('main log:', JSON.stringify(pev.logs('main').slice(-10)));
    }
    expect(stopped).toBe(true);
    await nothingHappened();
  });
}

test('a raw URL, or a javascript: or data: link opens no dialog @pane', async ({ pev }) => {
  await paneSource(pev, RAW_LINKS);
  await unsanitized(pev);
  const { url, frame } = await pev.showInPane(1, 'html');
  const denied = (reason: string, scheme: string) =>
    pev.hasLog('nav.window_open_denied', { reason, scheme });
  for (const id of ['#link-js', '#link-data', '#link-raw']) {
    await frame.evaluate((s) => (document.querySelector(s) as HTMLElement).click(), id);
  }
  await expect.poll(() => denied('not_link', 'data')).toBe(true);
  await expect.poll(() => denied('not_link', 'https')).toBe(true);
  expect(await dialogs(pev)).toEqual([]);
  await expect(pev.page.locator('.link-dialog')).toHaveCount(0);
  expect(frame.url()).toBe(url);
  expect(pev.page.url()).toBe('app://shell/index.html');
  expect(pev.app.windows()).toHaveLength(1);
});

// The sanitizer only maps http, https and mailto URLs to link ids, so this body
// exists only as a stub of the test hooks.
test('a link id without a link scheme opens no dialog (stub frame)', async ({ pev }) => {
  const opened = await pev.open('links');
  const url = opened.url as string;
  const frame = await pev.bodyFrame(url);
  await frame.evaluate(() => (document.querySelector('#link-poisoned') as HTMLElement).click());
  await expect
    .poll(() => pev.hasLog('nav.window_open_denied', { reason: 'scheme', scheme: 'mail-asset' }))
    .toBe(true);
  expect(await dialogs(pev)).toEqual([]);
  await expect(pev.page.locator('.link-dialog')).toHaveCount(0);
  expect(frame.url()).toBe(url);
  expect(pev.page.url()).toBe('app://shell/index.html');
  expect(pev.app.windows()).toHaveLength(1);
});

test('window.open from the shell opens the dialog only for a link id of the live view @pane', async ({
  pev,
}) => {
  await paneSource(pev, LINKS);
  const opened = await pev.showInPane(1, 'html');
  await pev.shell('windowOpen', ['https://example.org/popup']);
  await expect.poll(() => pev.hasLog('nav.window_open_denied', { reason: 'not_link' })).toBe(true);
  await pev.shell('windowOpen', [`${opened.url.replace('mail-body:', 'mail-asset:')}/l1`]);
  await expect
    .poll(() => dialogs(pev))
    .toEqual([{ windowId: 1, url: 'https://example.org/blank' }]);
  expect(pev.app.windows()).toHaveLength(1);
});

test('the body frame cannot load an old or guessed token @pane', async ({ pev }) => {
  await paneSource(pev, SAMPLE);
  const first = await pev.showInPane(1, 'html');
  const second = await pev.showInPane(1, 'html');
  const current = second.url;
  const frame = second.frame;

  let denied = 0;
  for (const target of [first.url, `mail-body://v/${'f'.repeat(32)}`]) {
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

test('meta refresh in a body is denied @pane', async ({ pev }) => {
  await paneSource(pev, REFRESH);
  await unsanitized(pev);
  await pev.main('clearRequests');
  const refresh = await pev.showInPane(1, 'html');
  const frame = refresh.frame;
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

test('the authorized reload of the current token works @pane', async ({ pev }) => {
  await paneSource(pev, SAMPLE);
  const { url } = await pev.showInPane(1, 'html');
  expect(await bodyRequests(pev, url)).toBe(1);
  await pev.shell('setFrameSrc', [url]);
  await expect.poll(() => bodyRequests(pev, url)).toBe(2);
  const frame = await pev.paneFrame(url);
  expect(await frame.locator('#heading').textContent()).toBe('Sample message');
});
