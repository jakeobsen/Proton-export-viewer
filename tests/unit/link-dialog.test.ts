// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  clipboard: { writeText: vi.fn() },
}));
vi.mock('electron', () => electron);

// The scheme check main runs again right before it acts; the dialog itself is
// opened with the real check.
const scheme = vi.hoisted(() => ({ refuse: false }));
vi.mock('../../src/main/links', async (original) => {
  const real = await original<typeof import('../../src/main/links')>();
  return {
    ...real,
    linkScheme: (url: string) => (scheme.refuse ? null : real.linkScheme(url)),
  };
});

const { LinkDialog } = await import('../../src/main/link-dialog');
const { ViewRegistry } = await import('../../src/main/views');
type AppWindow = import('../../src/main/context').AppWindow;
type WebContents = import('electron').WebContents;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setUp(url: string) {
  const views = new ViewRegistry();
  const { openId, token } = views.accept();
  expect(
    views.install(openId, token, 1, 1, {
      html: '',
      assets: [],
      links: [{ id: 'l1', url, text: 'Write to us' }],
    }).ok,
  ).toBe(true);
  const appWin = { id: 1, views } as unknown as AppWindow;
  const sent: unknown[] = [];
  const contents = {
    isDestroyed: () => false,
    send: (_channel: string, prompt: unknown) => sent.push(prompt),
  } as unknown as WebContents;
  const dialog = new LinkDialog(log as never, () => 'e'.repeat(32));
  expect(dialog.request(contents, appWin, `mail-asset://v/${token}/l1`, 1)).toBeNull();
  return { dialog, appWin, sent };
}

describe('LinkDialog for a mailto: link', () => {
  beforeEach(() => {
    scheme.refuse = false;
    vi.clearAllMocks();
  });

  it('opens it in the mail app, with the URL main kept', async () => {
    const url = 'mailto:help@shop.example?cc=billing@shop.example';
    const { dialog, appWin, sent } = setUp(url);
    expect(sent).toMatchObject([{ mail: true, unclear: false, url }]);
    expect(await dialog.act(appWin, 'e'.repeat(32), 'open', 1)).toBeNull();
    expect(electron.shell.openExternal).toHaveBeenCalledWith(url);
  });

  it('checks the scheme again before it opens or copies anything', async () => {
    for (const action of ['open', 'copy'] as const) {
      const { dialog, appWin } = setUp('mailto:help@shop.example');
      scheme.refuse = true;
      expect(await dialog.act(appWin, 'e'.repeat(32), action, 1)).toBe('invalid');
      scheme.refuse = false;
    }
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
    expect(electron.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('never logs a recipient', async () => {
    const url = 'mailto:rcpt-marker@shop.example?cc=cc-marker@other.example&bcc=bcc-marker@x.test';
    const { dialog, appWin } = setUp(url);
    await dialog.act(appWin, 'e'.repeat(32), 'open', 1);
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).toContain('mailto');
    expect(logged).not.toMatch(/marker|shop\.example|other\.example|x\.test/);
  });
});
