// SPDX-License-Identifier: AGPL-3.0-or-later
// The link dialog: link ids resolve only in the clicking window's live view at
// the current generation, the warnings, the choices and their recorded stubs,
// and choices that come too late.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, Page } from '@playwright/test';
import type { LinkPrompt, MessageOpenResult } from '../../src/shared/api';
import type { OpenMode } from '../../src/shared/reader-protocol';
import { testDir } from '../paths';
import { expect, test, tokenOf, type PevApp } from './app';

type Shown = LinkPrompt & { windowId: number };
interface ExternalCall {
  method: string;
  args: string[];
}

const HTML = [
  'Subject: Links',
  'From: <sender@example.org>',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  '<p><a id="plain" href="https://shop.example/account">Your account</a></p>',
  '<p><a id="mismatch" href="https://evil.test/login">https://bank.example/login</a></p>',
  '<p><a id="lookalike" href="https://аpple.test/verify">Sign in</a></p>',
  '<p><a id="both" href="https://xn--pple-43d.test/">apple.test</a></p>',
  '<p><a id="mailto" href="mailto:help@shop.example">help@shop.example</a></p>',
  '<p><a id="subdomain" href="https://evil.shop.example/">shop.example</a></p>',
  '<p><a id="mailto-idn" href="mailto:help@аpple.test">Write to us</a></p>',
  '<p><a id="invisible" href="https://evil.example/">paypal&#x2060;.com</a></p>',
  '<p><a id="mailto-separator" href="mailto:help@paypal.com%2Fx.evil.test">paypal.com</a></p>',
  '<p><a id="js" href="javascript:alert(1)">js</a> <a id="data" href="data:text/html,x">data</a></p>',
  '',
].join('\r\n');

const PLAIN = [
  'Subject: Plain links',
  'From: <sender@example.org>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Read https://shop.example/a?b=1 now.',
  '',
].join('\r\n');

/** Makes the two messages the reader's source: 1 is HTML, 2 is plain text. */
async function source(pev: PevApp): Promise<void> {
  const root = testDir('links-root');
  writeFileSync(join(root, 'html.eml'), HTML);
  writeFileSync(join(root, 'plain.eml'), PLAIN);
  const result = await pev.main<{ ok: boolean }>('readerSource', root, [
    [1, { file: 'html.eml' }],
    [2, { file: 'plain.eml' }],
  ]);
  expect(result.ok).toBe(true);
}

function openRow(
  pev: PevApp,
  rowid: number,
  mode: OpenMode,
  page: Page = pev.page,
): Promise<MessageOpenResult> {
  return page.evaluate(
    async ([r, m]) => {
      const state = await window.pev.state();
      if (!state.ok) return state;
      return window.pev.open(r as number, m as OpenMode, state.generation);
    },
    [rowid, mode] as const,
  );
}

function viewUrl(result: MessageOpenResult): string {
  if (!result.ok || result.outcome !== 'view')
    throw new Error(`no view: ${JSON.stringify(result)}`);
  return result.url;
}

/** Opens a message in the window's reader pane and waits for its body frame. */
async function show(pev: PevApp, rowid: number, mode: OpenMode, page: Page = pev.page) {
  const { frame, url, token } = await pev.showInPane(rowid, mode, page);
  return { frame, url, token };
}

const linkUrl = (token: string, id: string) => `mail-asset://v/${token}/${id}`;

/** Clicks an element in the body frame. */
async function click(frame: Frame, selector: string): Promise<void> {
  await frame.evaluate((s) => (document.querySelector(s) as HTMLElement).click(), selector);
}

function shown(pev: PevApp): Promise<Shown[]> {
  return pev.main<Shown[]>('linkDialogs');
}

function external(pev: PevApp): Promise<ExternalCall[]> {
  return pev.main<ExternalCall[]>('externalCalls');
}

function deniedCount(pev: PevApp, reason: string): number {
  return pev
    .logs('main')
    .filter((l) => l.code === 'nav.window_open_denied' && l.data.reason === reason).length;
}

/** A choice sent straight to main, as a shell could send it. */
function rawAction(pev: PevApp, args: Record<string, unknown>, page: Page = pev.page) {
  return page.evaluate(async (a) => {
    const ipc = (
      window as unknown as { __pevTestIpc: { invoke(c: string, ...x: unknown[]): unknown } }
    ).__pevTestIpc;
    const state = await window.pev.state();
    const generation = state.ok ? state.generation : -1;
    return ipc.invoke('pev:link-action', { generation, ...a });
  }, args);
}

/** Waits for the dialog and checks that nothing navigated or opened a window. */
async function dialogShown(pev: PevApp, frame: Frame, url: string, windows = 1) {
  await expect(pev.page.locator('.link-dialog')).toHaveCount(1);
  expect(frame.url()).toBe(url);
  expect(pev.page.url()).toBe('app://shell/index.html');
  expect(pev.app.windows()).toHaveLength(windows);
}

test('each warning shows only when it applies, with the host marked @pane', async ({ pev }) => {
  await source(pev);
  const { frame, url } = await show(pev, 1, 'html');
  const dialog = pev.page.locator('.link-dialog');
  const cases: Array<[string, Record<string, unknown>, string | null]> = [
    [
      '#plain',
      {
        title: 'Your account',
        url: 'https://shop.example/account',
        mismatch: false,
        lookalike: false,
      },
      'shop.example',
    ],
    [
      '#mismatch',
      {
        title: 'https://bank.example/login',
        url: 'https://evil.test/login',
        mismatch: true,
        lookalike: false,
      },
      'evil.test',
    ],
    [
      '#lookalike',
      {
        title: 'Sign in',
        url: 'https://xn--pple-43d.test/verify',
        mismatch: false,
        lookalike: true,
      },
      'xn--pple-43d.test',
    ],
    [
      '#both',
      { title: 'apple.test', url: 'https://xn--pple-43d.test/', mismatch: true, lookalike: true },
      'xn--pple-43d.test',
    ],
    [
      '#mailto',
      {
        title: 'help@shop.example',
        url: 'mailto:help@shop.example',
        mismatch: false,
        lookalike: false,
      },
      'shop.example',
    ],
    [
      '#subdomain',
      {
        title: 'shop.example',
        url: 'https://evil.shop.example/',
        mismatch: true,
        lookalike: false,
      },
      'evil.shop.example',
    ],
    [
      '#mailto-idn',
      {
        title: 'Write to us',
        url: 'mailto:help@xn--pple-43d.test',
        mismatch: false,
        lookalike: true,
      },
      'xn--pple-43d.test',
    ],
    [
      '#invisible',
      { title: 'paypal.com', url: 'https://evil.example/', mismatch: true, lookalike: false },
      'evil.example',
    ],
    [
      '#mailto-separator',
      {
        title: 'paypal.com',
        url: 'mailto:help@paypal.com%2Fx.evil.test',
        mismatch: true,
        lookalike: false,
      },
      null,
    ],
  ];
  for (const [index, [id, want, host]] of cases.entries()) {
    await click(frame, id);
    await dialogShown(pev, frame, url);
    await expect(dialog.locator('h3')).toHaveText('Open link?');
    await expect(dialog.locator('.link-label')).toHaveText(['Title', 'URL']);
    await expect(dialog.locator('.link-title')).toHaveText(want.title as string);
    await expect(dialog.locator('.link-url')).toHaveText(want.url as string);
    await expect(dialog.locator('.link-host')).toHaveText(host === null ? [] : [host]);
    await expect(dialog.locator('.link-mismatch')).toHaveText(
      want.mismatch ? ["Title doesn't match URL"] : [],
    );
    await expect(dialog.locator('.link-lookalike')).toHaveText(
      want.lookalike ? ['URL uses look-alike characters'] : [],
    );
    await expect(dialog.locator('.link-foot button')).toHaveText([
      'Cancel',
      'Copy link',
      'Open in browser',
    ]);
    expect((await shown(pev))[index]).toMatchObject({ windowId: 1, ...want });
    await pev.page.click('.link-cancel');
    await expect(dialog).toHaveCount(0);
  }

  // javascript: and data: links lost their href in the sanitizer: a click on
  // one does nothing, and the next real link still opens the dialog.
  expect(
    await frame.evaluate(() =>
      ['js', 'data'].map((id) => document.getElementById(id)?.getAttribute('href') ?? null),
    ),
  ).toEqual([null, null]);
  await click(frame, '#js');
  await click(frame, '#data');
  await click(frame, '#plain');
  await dialogShown(pev, frame, url);
  expect((await shown(pev)).map((s) => s.url)).toEqual([
    ...cases.map(([, want]) => want.url),
    'https://shop.example/account',
  ]);
  await pev.page.click('.link-cancel');
  expect(await external(pev)).toEqual([]);
});

test('Open in browser and Copy link go to the recorded stubs; the other choices do nothing @pane', async ({
  pev,
}) => {
  await source(pev);
  const { frame, url } = await show(pev, 1, 'html');
  const dialog = pev.page.locator('.link-dialog');

  await click(frame, '#plain');
  await dialogShown(pev, frame, url);
  const first = (await shown(pev))[0]!;
  await pev.page.click('.link-open');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => external(pev))
    .toEqual([{ method: 'shell.openExternal', args: ['https://shop.example/account'] }]);

  await click(frame, '#mailto');
  await dialogShown(pev, frame, url);
  await pev.page.click('.link-copy');
  await expect
    .poll(() => external(pev))
    .toEqual([
      { method: 'shell.openExternal', args: ['https://shop.example/account'] },
      { method: 'clipboard.writeText', args: ['mailto:help@shop.example'] },
    ]);

  // Cancel, Escape and the close button send nothing anywhere.
  await click(frame, '#mismatch');
  await dialogShown(pev, frame, url);
  await pev.page.click('.link-cancel');
  await click(frame, '#lookalike');
  await dialogShown(pev, frame, url);
  await pev.page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await click(frame, '#both');
  await dialogShown(pev, frame, url);
  await pev.page.click('.link-close');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      () =>
        pev.logs('main').filter((l) => l.code === 'nav.link_action' && l.data.action === 'cancel')
          .length,
    )
    .toBe(3);
  expect(pev.hasLog('nav.link_action', { action: 'open', scheme: 'https' })).toBe(true);
  expect(pev.hasLog('nav.link_action', { action: 'copy', scheme: 'mailto' })).toBe(true);

  // Each dialog takes one choice.
  expect(await rawAction(pev, { dialogId: first.dialogId, action: 'open' })).toEqual({
    ok: false,
    code: 'unknown_dialog',
  });
  expect(await external(pev)).toHaveLength(2);
});

test('the shell sends only a dialog id and a choice, for its own dialog @pane', async ({ pev }) => {
  await source(pev);
  const { frame, url } = await show(pev, 1, 'html');
  await click(frame, '#plain');
  await dialogShown(pev, frame, url);
  const { dialogId } = (await shown(pev))[0]!;

  for (const args of [
    { dialogId, action: 'open', url: 'https://evil.test/' },
    { dialogId, action: 'navigate' },
    { dialogId: 'not-an-id', action: 'open' },
    { action: 'open' },
  ]) {
    expect(await rawAction(pev, args), JSON.stringify(args)).toEqual({
      ok: false,
      code: 'invalid',
    });
  }
  expect(await rawAction(pev, { dialogId, action: 'open', generation: 99 })).toEqual({
    ok: false,
    code: 'stale_generation',
  });

  // Another window can't answer this window's dialog.
  const second = await pev.openWindow('shell');
  expect(await rawAction(pev, { dialogId, action: 'open' }, second.page)).toEqual({
    ok: false,
    code: 'unknown_dialog',
  });

  // The dialog is still this window's, and opens the URL main kept.
  await pev.page.click('.link-open');
  await expect
    .poll(() => external(pev))
    .toEqual([{ method: 'shell.openExternal', args: ['https://shop.example/account'] }]);
  expect(pev.app.windows()).toHaveLength(2);
});

test('plain-text links go through the same ids @pane', async ({ pev }) => {
  await source(pev);
  const { frame, url, token } = await show(pev, 2, 'plain');
  expect(
    await frame.evaluate(() =>
      [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    ),
  ).toEqual([linkUrl(token, 'l1')]);
  await click(frame, 'a');
  await dialogShown(pev, frame, url);
  await expect(pev.page.locator('.link-title')).toHaveText('https://shop.example/a?b=1');
  await expect(pev.page.locator('.link-url')).toHaveText('https://shop.example/a?b=1');
  await expect(pev.page.locator('.link-mismatch, .link-lookalike')).toHaveCount(0);
  await pev.page.click('.link-copy');
  await expect
    .poll(() => external(pev))
    .toEqual([{ method: 'clipboard.writeText', args: ['https://shop.example/a?b=1'] }]);
});

test('an unknown, revoked, other-window or stale-generation id opens no dialog @pane', async ({
  pev,
}) => {
  await source(pev);
  const first = await show(pev, 1, 'html');

  // Unknown in the live view.
  await pev.shell('windowOpen', [linkUrl(first.token, 'l99')]);
  await expect.poll(() => deniedCount(pev, 'unknown_link')).toBe(1);

  // Another window's live view: refused here, a dialog there.
  const second = await pev.openWindow('shell');
  const other = await show(pev, 1, 'html', second.page);
  await pev.shell('windowOpen', [linkUrl(other.token, 'l1')]);
  await expect.poll(() => deniedCount(pev, 'unknown_token')).toBe(1);
  await pev.shell('windowOpen', [linkUrl(other.token, 'l1')], second.page);
  await expect
    .poll(async () => (await shown(pev)).map((s) => [s.windowId, s.url]))
    .toEqual([[second.windowId, 'https://shop.example/account']]);
  await expect(second.page.locator('.link-dialog')).toHaveCount(1);
  await second.page.click('.link-cancel');

  // Revoked by the next open.
  const next = await show(pev, 1, 'html');
  await pev.shell('windowOpen', [linkUrl(first.token, 'l1')]);
  await expect.poll(() => deniedCount(pev, 'unknown_token')).toBe(2);

  // Revoked by a generation bump.
  await pev.main('bumpGeneration');
  await pev.shell('windowOpen', [linkUrl(next.token, 'l1')]);
  await expect.poll(() => deniedCount(pev, 'unknown_token')).toBe(3);

  expect(await shown(pev)).toHaveLength(1);
  await expect(pev.page.locator('.link-dialog')).toHaveCount(0);
  expect(pev.app.windows()).toHaveLength(2);
  expect(await external(pev)).toEqual([]);
});

test('a choice after a revoke or a generation bump does nothing @pane', async ({ pev }) => {
  await source(pev);
  const dialog = pev.page.locator('.link-dialog');
  const rejected = (reason: string) =>
    pev.logs('main').filter((l) => l.code === 'ipc.rejected' && l.data.reason === reason).length;

  // The next open revokes the view the link came from.
  let view = await show(pev, 1, 'html');
  await click(view.frame, '#plain');
  await dialogShown(pev, view.frame, view.url);
  viewUrl(await openRow(pev, 1, 'html'));
  await pev.page.click('.link-open');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => rejected('superseded')).toBe(1);

  // A generation bump: the shell's choice is stale, and so is the dialog.
  view = await show(pev, 1, 'html');
  await click(view.frame, '#mailto');
  await dialogShown(pev, view.frame, view.url);
  const { dialogId } = (await shown(pev)).at(-1)!;
  await pev.main('bumpGeneration');
  await pev.page.click('.link-copy');
  await expect.poll(() => rejected('stale_generation')).toBeGreaterThanOrEqual(1);
  expect(await rawAction(pev, { dialogId, action: 'copy' })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  expect(await rawAction(pev, { dialogId, action: 'copy' })).toEqual({
    ok: false,
    code: 'unknown_dialog',
  });

  expect(await external(pev)).toEqual([]);
  expect(pev.hasLog('nav.link_action', { action: 'open' })).toBe(false);
  expect(pev.hasLog('nav.link_action', { action: 'copy' })).toBe(false);
});

// The sanitizer never puts a link id in an image or CSS reference, nor a link
// id with a target other than a new window, so the next two bodies exist only
// as stubs of the test hooks, in their own frame.
test('an image or CSS reference to a link id loads nothing', async ({ pev }) => {
  await pev.main('clearRequests');
  const opened = await pev.open('link-refs');
  const url = opened.url as string;
  const token = tokenOf(url);
  const frame = await pev.bodyFrame(url);
  await expect
    .poll(async () => {
      const asset = (await pev.main<{ asset: string[] }>('requests', 1)).asset;
      return [linkUrl(token, 'l1'), linkUrl(token, 'l2')].every((u) => asset.includes(u));
    })
    .toBe(true);
  expect(
    await frame.evaluate(() => {
      const img = document.getElementById('img-ref') as HTMLImageElement;
      return { complete: img.complete, width: img.naturalWidth };
    }),
  ).toEqual({ complete: true, width: 0 });
  for (const id of ['l1', 'l2']) {
    const response = await pev.main<{ status: number; headers: Record<string, string> }>(
      'fetchIn',
      1,
      linkUrl(token, id),
    );
    expect(response.status).toBe(404);
    expect(response.headers.location).toBeUndefined();
  }
  expect(pev.hasLog('protocol.not_found', { scheme: 'mail-asset', reason: 'unknown_asset' })).toBe(
    true,
  );
  expect(await shown(pev)).toEqual([]);
  expect((await pev.main<{ blocked: string[] }>('requests', 1)).blocked).toEqual([]);
});

test('a link id loading in the body frame itself is stopped and opens no dialog', async ({
  pev,
}) => {
  const opened = await pev.open('links');
  const url = opened.url as string;
  const frame = await pev.bodyFrame(url);
  await pev.main('clearRequests');
  // The shell CSP (frame-src mail-body:) stops the frame navigation before any request.
  await click(frame, '#link-id-self');
  await expect
    .poll(() =>
      pev.consoleMessages.some(
        (m) => m.text.includes('frame-src mail-body:') && m.text.includes('mail-asset://v'),
      ),
    )
    .toBe(true);
  expect(await shown(pev)).toEqual([]);
  await expect(pev.page.locator('.link-dialog')).toHaveCount(0);
  const seen = await pev.main<{ asset: string[]; blocked: string[] }>('requests', 1);
  expect(seen.asset).toEqual([]);
  expect(seen.blocked).toEqual([]);
  expect(pev.page.url()).toBe('app://shell/index.html');
  expect(pev.app.windows()).toHaveLength(1);
});
