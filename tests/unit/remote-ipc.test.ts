// SPDX-License-Identifier: AGPL-3.0-or-later
// The shell's side of remote images, through main's real IPC handlers: an
// open tells the shell how many remote images there are and whether they can
// load, never a URL; consent is refused for a wrong sender, bad arguments, a
// stale generation or an open whose view isn't live, without starting the
// fetcher; counts reach the window that asked.

import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: (channel: string, run: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, run),
      on: () => undefined,
    },
  };
});
vi.mock('electron', () => ({ ipcMain: electron.ipcMain }));

const { registerIpc } = await import('../../src/main/ipc');
const { RemoteImages } = await import('../../src/main/remote-images');
const { ViewRegistry } = await import('../../src/main/views');
const { IPC } = await import('../../src/shared/api');
const { APP_ORIGIN } = await import('../../src/shared/constants');
type AppContext = import('../../src/main/context').AppContext;
type AppWindow = import('../../src/main/context').AppWindow;
type RenderedMessage = import('../../src/shared/reader-protocol').RenderedMessage;
type ImageResult = import('../../src/main/fetcher-host').ImageResult;

const REFS = ['https://a.test/one.png', 'http://b.test/two.png'];
const PNG: ImageResult = {
  ok: true,
  bytes: new Uint8Array([1]),
  format: 'png',
  contentType: 'image/png',
  insecure: false,
};

function message(remoteRefs: string[] = REFS): RenderedMessage {
  return {
    headers: { subject: 's', from: 'a@b.test', to: '', cc: '', date: null },
    html: '<p>x</p>',
    links: [],
    format: 'html',
    remote: 2,
    remoteRefs,
    cids: 0,
    images: [],
    imagesRefused: 0,
    hasHtml: true,
    htmlTooLarge: false,
    cut: null,
    attachments: [],
    details: { messageId: '', references: [], moreReferences: 0, format: '' },
    highlighted: false,
  };
}

function setUp() {
  const events: Array<{ code: string; data: unknown }> = [];
  const keep = (code: string, data?: unknown) => events.push({ code, data });
  const log = {
    log: (_l: string, code: string, data?: unknown) => keep(code, data),
    info: keep,
    warn: keep,
    error: keep,
  };
  const fetcher = {
    running: false,
    ensure: vi.fn(() => {
      fetcher.running = true;
      return Promise.resolve();
    }),
    fetch: vi.fn(() => Promise.resolve(PNG)),
    abort: vi.fn(),
    stop: vi.fn(() => Promise.resolve()),
  };
  const windows = new Map<number, AppWindow>();
  const remote = new RemoteImages({
    fetcher,
    log,
    liveViews: () => [...windows.values()].flatMap((w) => w.views.liveViews()),
  });
  const views = new ViewRegistry(undefined, (view) => remote.revoked(view));
  const sent: Array<[string, unknown]> = [];
  const appWin = {
    id: 3,
    views,
    win: {
      isDestroyed: () => false,
      webContents: { send: (channel: string, update: unknown) => sent.push([channel, update]) },
    },
  } as unknown as AppWindow;
  windows.set(7, appWin);
  const read = vi.fn(() => Promise.resolve({ ok: true, read: message() }));
  const ctx = {
    generation: 1,
    windows,
    log,
    rendererLog: log,
    remote,
    fetcher,
    openGapMs: 0,
    core: { requestRunning: read },
    sources: { isOffline: () => false, stamp: () => 0 },
  } as unknown as AppContext;
  registerIpc(ctx);
  const mainFrame = { processId: 1, frameToken: 'main', origin: APP_ORIGIN };
  const call = (channel: string, args: unknown[], frame: object = mainFrame, id = 7) =>
    electron.handlers.get(channel)!({ sender: { id, mainFrame }, senderFrame: frame }, ...args);
  const open = async () =>
    (await call(IPC.open, [{ rowid: 1, mode: 'html', generation: ctx.generation }])) as {
      ok: true;
      openId: number;
      remote: number;
      remoteLoadable: boolean;
    };
  return { ctx, events, fetcher, views, sent, read, call, open, mainFrame };
}

describe('the open result', () => {
  it('gives the shell the count and that the images can load, and no URL', async () => {
    const t = setUp();
    const result = await t.open();
    expect(result).toMatchObject({ ok: true, remote: 2, remoteLoadable: true });
    expect(JSON.stringify(result)).not.toMatch(/https?:|one\.png|two\.png/);
    expect(t.views.liveViews()[0]?.remote.refs).toEqual(REFS);
  });

  it('marks a view whose remote list fails the check as not loadable, logs it, and refuses consent', async () => {
    const t = setUp();
    t.read.mockResolvedValueOnce({
      ok: true,
      read: message(['https://a.test/1.png', 'ftp://x.test/2']),
    });
    const result = await t.open();
    expect(result).toMatchObject({ ok: true, remote: 2, remoteLoadable: false });
    expect(t.events).toContainEqual({
      code: 'remote.refs_invalid',
      data: { openId: result.openId, windowId: 3 },
    });
    expect(await t.call(IPC.allowRemote, [{ openId: result.openId, generation: 1 }])).toEqual({
      ok: false,
      code: 'invalid',
    });
    expect(t.fetcher.ensure).not.toHaveBeenCalled();
  });
});

describe('pev:allow-remote', () => {
  it('allows the live view with one reload, and a second request gets no reload', async () => {
    const t = setUp();
    const { openId } = await t.open();
    expect(await t.call(IPC.allowRemote, [{ openId, generation: 1 }])).toEqual({
      ok: true,
      reload: true,
    });
    expect(await t.call(IPC.allowRemote, [{ openId, generation: 1 }])).toEqual({
      ok: true,
      reload: false,
    });
    expect(t.fetcher.ensure).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a subframe', { processId: 1, frameToken: 'sub', origin: APP_ORIGIN }, 7, 'not_main_frame'],
    [
      'another origin',
      { processId: 1, frameToken: 'main', origin: 'mail-body://v' },
      7,
      'bad_origin',
    ],
    ['an unknown window', undefined, 8, 'unknown_window'],
  ])('refuses %s without starting the fetcher', async (_name, frame, id, code) => {
    const t = setUp();
    const { openId } = await t.open();
    const answer = await t.call(
      IPC.allowRemote,
      [{ openId, generation: 1 }],
      frame ?? t.mainFrame,
      id,
    );
    expect(answer).toEqual({ ok: false, code });
    expect(t.fetcher.ensure).not.toHaveBeenCalled();
  });

  it.each([
    ['no arguments', []],
    ['an extra argument', [{ openId: 1, generation: 1 }, 1]],
    ['an extra field', [{ openId: 1, generation: 1, url: 'https://a.test/' }]],
    ['a string open id', [{ openId: '1', generation: 1 }]],
    ['open id 0', [{ openId: 0, generation: 1 }]],
    ['no generation', [{ openId: 1 }]],
  ])('refuses %s as invalid without starting the fetcher', async (_name, args) => {
    const t = setUp();
    await t.open();
    expect(await t.call(IPC.allowRemote, args)).toEqual({ ok: false, code: 'invalid' });
    expect(t.fetcher.ensure).not.toHaveBeenCalled();
  });

  it('refuses a stale generation, and logs it', async () => {
    const t = setUp();
    const { openId } = await t.open();
    expect(await t.call(IPC.allowRemote, [{ openId, generation: 2 }])).toEqual({
      ok: false,
      code: 'stale_generation',
    });
    expect(t.events).toContainEqual({
      code: 'remote.refused',
      data: { reason: 'stale', windowId: 3 },
    });
    expect(t.fetcher.ensure).not.toHaveBeenCalled();
  });

  it('refuses an open whose view is no longer live, and logs it', async () => {
    const t = setUp();
    const first = await t.open();
    await t.open();
    expect(await t.call(IPC.allowRemote, [{ openId: first.openId, generation: 1 }])).toEqual({
      ok: false,
      code: 'not_live',
    });
    expect(t.events).toContainEqual({
      code: 'remote.refused',
      data: { reason: 'not_live', windowId: 3 },
    });
    expect(t.fetcher.ensure).not.toHaveBeenCalled();
  });

  it('sends that window the counts of its view, with the generation and open id only', async () => {
    const t = setUp();
    const { openId } = await t.open();
    await t.call(IPC.allowRemote, [{ openId, generation: 1 }]);
    const view = t.views.liveViews()[0]!;
    await t.ctx.remote.serve(t.views, view, 'r1');
    expect(t.sent).toEqual([
      [IPC.remoteStatus, { generation: 1, openId, insecure: 0, refused: 0 }],
    ]);
  });
});
