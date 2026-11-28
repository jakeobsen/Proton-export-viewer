// SPDX-License-Identifier: AGPL-3.0-or-later
// The source view in main: each channel acts only on the window's live view
// or its fallback, for the current generation; a late answer never replaces
// a newer selection, comes back after Back, or counts in a later showing; a
// block's URL is never used twice in a view's life; one URL at a time is
// authorized; a fallback's view never gets a body URL, and View source works
// on it again after Back; nothing about a header reaches a log.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stamp } from '../../src/shared/sources';
import { findMarkers, MARKER_TEXT } from '../markers';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const fake = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  copied: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => fake.handlers.set(channel, fn),
    on: () => {},
  },
  shell: { showItemInFolder: () => {}, openExternal: () => Promise.resolve() },
  clipboard: { writeText: (text: string) => fake.copied.push(text) },
  app: {},
  dialog: {},
  protocol: {},
  session: {},
  BrowserWindow: class {},
  MessageChannelMain: class {},
  utilityProcess: {},
}));

const { registerIpc } = await import('../../src/main/ipc');
const { CoreUnavailableError } = await import('../../src/main/core-host');
const { ViewRegistry, bodyUrl, sourceUrl } = await import('../../src/main/views');
type AppContext = import('../../src/main/context').AppContext;
type AppWindow = import('../../src/main/context').AppWindow;

const SOURCE = 'pev:source';
const TREE = 'pev:source-tree';
const PART = 'pev:source-part';
const COPY = 'pev:copy-headers';
const BACK = 'pev:source-back';
const OPEN = 'pev:open';
const KEY = '00000000-0000-4000-8000-0000000000a1';
const FILE = { dev: '16777232', ino: '4242' };

const enc = (s: string) => new TextEncoder().encode(s);
const headersOf = (s: string, truncated = false) => ({
  type: 'result',
  reqId: 1,
  ok: true,
  headers: { bytes: enc(s), truncated },
});
const PARTS = [
  {
    path: '1',
    parent: -1,
    contentType: 'multipart/mixed',
    charset: null,
    name: '',
    inline: false,
    size: 3,
    cut: false,
  },
  {
    path: '1.1',
    parent: 0,
    contentType: 'text/plain',
    charset: 'utf-8',
    name: '',
    inline: false,
    size: 1,
    cut: false,
  },
  {
    path: '1.2',
    parent: 0,
    contentType: 'application/pdf',
    charset: null,
    name: 'a.pdf',
    inline: false,
    size: 2,
    cut: false,
  },
];

interface Request {
  type: string;
  what: { kind: string; path?: string };
  file: unknown;
  rowid: number;
  lane: number;
  openId: number;
  order?: number;
}

function make() {
  const logs: Array<{ code: string; data: Record<string, unknown> }> = [];
  const push = (code: string, data: Record<string, unknown> = {}) => logs.push({ code, data });
  const frame = { processId: 4, frameToken: 'main-frame', origin: 'app://shell' };
  const appWin = {
    id: 3,
    win: { isDestroyed: () => false, webContents: { send() {} } },
    views: new ViewRegistry(),
    session: {},
  } as unknown as AppWindow;
  const state: { offline: boolean; answer: (request: Request) => unknown } = {
    offline: false,
    answer: () => headersOf('Subject: hi\r\n'),
  };
  const requests: Request[] = [];
  const ctx = {
    generation: 1,
    windows: new Map([[11, appWin]]),
    log: { error: push, warn: push, info: push },
    core: {
      requestRunning: async (request: Request) => {
        requests.push(request);
        return state.answer(request);
      },
    },
    sources: {
      isOffline: () => state.offline,
      stamp: (): Stamp => ({ sourceKey: KEY, generation: ctx.generation }),
    },
  } as unknown as AppContext;
  fake.handlers.clear();
  registerIpc(ctx);
  const event = { sender: { id: 11, mainFrame: frame }, senderFrame: frame };
  const call = (channel: string, ...args: unknown[]) =>
    (fake.handlers.get(channel) as Handler)(event, ...args) as Promise<Record<string, unknown>>;
  const install = () => {
    const { openId, token } = appWin.views.accept();
    appWin.views.install(openId, token, ctx.generation, ctx.generation, {
      html: '<p>x</p>',
      assets: [],
      message: { rowid: 17, file: FILE, messageId: '', attachments: [] },
    });
    return { openId, token };
  };
  /** An answer core gives only when the test lets it go. */
  const held = () => {
    let release!: (answer: unknown) => void;
    const answer = new Promise((r) => (release = r));
    return { answer, release };
  };
  return { ctx, appWin, state, logs, requests, call, install, held };
}

beforeEach(() => {
  fake.copied.length = 0;
});

describe('opening the source view', () => {
  it("shows the message's raw headers under the view's token, as the only URL the frame may load", async () => {
    const t = make();
    const { openId, token } = t.install();
    expect(t.appWin.views.authorizedUrl()).toBe(bodyUrl(token));
    const result = await t.call(SOURCE, { openId, generation: 1 });
    expect(result).toEqual({ ok: true, url: sourceUrl(token, 1), truncated: false });
    expect(t.requests).toEqual([
      expect.objectContaining({
        type: 'source',
        openId,
        rowid: 17,
        file: FILE,
        lane: 3,
        what: { kind: 'headers' },
      }),
    ]);
    expect(t.appWin.views.authorizedUrl()).toBe(sourceUrl(token, 1));
    expect(t.appWin.views.sourceDoc(token, 1)).toContain('<span class="hn">Subject:</span> hi');
    expect(t.logs.map((l) => l.code)).toEqual(['reader.source']);
  });

  it('refuses a stale generation, an older open, an offline export, and says when core is down', async () => {
    const t = make();
    const { openId } = t.install();
    expect(await t.call(SOURCE, { openId, generation: 2 })).toEqual({
      ok: false,
      code: 'stale_generation',
    });
    expect(await t.call(SOURCE, { openId: openId + 1, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    expect(await t.call(SOURCE, { openId, generation: 1, extra: 1 })).toEqual({
      ok: false,
      code: 'invalid',
    });
    t.state.offline = true;
    expect(await t.call(SOURCE, { openId, generation: 1 })).toEqual({
      ok: false,
      code: 'offline',
    });
    t.state.offline = false;
    t.state.answer = () => {
      throw new CoreUnavailableError();
    };
    expect(await t.call(SOURCE, { openId, generation: 1 })).toEqual({
      ok: false,
      code: 'core_unavailable',
    });
  });

  it('refuses a stale generation on the tree, a part and Copy headers, and asks core nothing', async () => {
    const t = make();
    const { openId } = t.install();
    await t.call(SOURCE, { openId, generation: 1 });
    const asked = t.requests.length;
    for (const [channel, args] of [
      [TREE, { openId, generation: 2 }],
      [PART, { openId, path: null, generation: 2 }],
      [COPY, { openId, generation: 2 }],
    ] as const) {
      expect(await t.call(channel, args)).toEqual({ ok: false, code: 'stale_generation' });
    }
    expect(t.requests).toHaveLength(asked);
    expect(fake.copied).toEqual([]);
  });

  it('refuses an answer that came after a newer open', async () => {
    const t = make();
    const { openId } = t.install();
    const h = t.held();
    t.state.answer = () => h.answer;
    const pending = t.call(SOURCE, { openId, generation: 1 });
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    const newer = t.install();
    h.release(headersOf('Subject: late\r\n'));
    expect(await pending).toEqual({ ok: false, code: 'superseded' });
    expect(t.appWin.views.authorizedUrl()).toBe(bodyUrl(newer.token));
  });

  it('refuses a block larger than the cap', async () => {
    const t = make();
    const { openId } = t.install();
    t.state.answer = () => headersOf('x'.repeat(256 * 1024 + 1), true);
    expect(await t.call(SOURCE, { openId, generation: 1 })).toEqual({ ok: false, code: 'invalid' });
  });
});

describe('the tree and the parts', () => {
  it('gives the tree, then shows a part named by a path from it, and no other', async () => {
    const t = make();
    const { openId, token } = t.install();
    await t.call(SOURCE, { openId, generation: 1 });
    // Before the tree, no part can be named.
    expect(await t.call(PART, { openId, path: '1.2', generation: 1 })).toEqual({
      ok: false,
      code: 'invalid',
    });
    t.state.answer = () => ({ type: 'result', reqId: 1, ok: true, parts: PARTS });
    const tree = await t.call(TREE, { openId, generation: 1 });
    expect(tree).toMatchObject({ ok: true });
    expect((tree.parts as Array<{ path: string; type: string }>).map((p) => p.type)).toEqual([
      'multipart/mixed',
      'text/plain',
      'application/pdf',
    ]);
    t.state.answer = () => headersOf('Content-Type: application/pdf\r\n');
    expect(await t.call(PART, { openId, path: '1.2', generation: 1 })).toEqual({
      ok: true,
      url: sourceUrl(token, 2),
      truncated: false,
    });
    expect(t.requests.at(-1)).toMatchObject({ what: { kind: 'part', path: '1.2' }, order: 2 });
    expect(await t.call(PART, { openId, path: '1.9', generation: 1 })).toEqual({
      ok: false,
      code: 'invalid',
    });
    expect(await t.call(PART, { openId, path: '../1', generation: 1 })).toEqual({
      ok: false,
      code: 'invalid',
    });
    // The message's own block is read again without a parse.
    t.state.answer = () => headersOf('Subject: hi\r\n');
    await t.call(PART, { openId, path: '1', generation: 1 });
    expect(t.requests.at(-1)).toMatchObject({ what: { kind: 'headers' } });
  });

  it('gives no tree when the structure could not be read, or core answered something unchecked', async () => {
    const t = make();
    const { openId } = t.install();
    await t.call(SOURCE, { openId, generation: 1 });
    t.state.answer = () => ({
      type: 'result',
      reqId: 1,
      ok: false,
      code: 'reader_failed',
      reason: 'timeout',
    });
    expect(await t.call(TREE, { openId, generation: 1 })).toEqual({ ok: true, parts: null });
    t.state.answer = () => ({
      type: 'result',
      reqId: 1,
      ok: true,
      parts: [{ ...PARTS[0], path: '1/../2' }],
    });
    expect(await t.call(TREE, { openId, generation: 1 })).toEqual({ ok: true, parts: null });
    t.state.answer = () => ({
      type: 'result',
      reqId: 1,
      ok: true,
      parts: [PARTS[0], { ...PARTS[1], parent: 5 }],
    });
    expect(await t.call(TREE, { openId, generation: 1 })).toEqual({ ok: true, parts: null });
  });

  it('drops the answer to an older selection, so it never replaces a newer one', async () => {
    const t = make();
    const { openId, token } = t.install();
    await t.call(SOURCE, { openId, generation: 1 });
    t.state.answer = () => ({ type: 'result', reqId: 1, ok: true, parts: PARTS });
    await t.call(TREE, { openId, generation: 1 });
    const h = t.held();
    t.state.answer = (r) =>
      r.what.path === '1.1' ? h.answer : headersOf('Content-Type: application/pdf\r\n');
    const first = t.call(PART, { openId, path: '1.1', generation: 1 });
    await vi.waitFor(() => expect(t.requests.at(-1)?.what.path).toBe('1.1'));
    const second = await t.call(PART, { openId, path: '1.2', generation: 1 });
    expect(second).toMatchObject({ ok: true, url: sourceUrl(token, 2) });
    h.release(headersOf('Content-Type: text/plain\r\n'));
    expect(await first).toEqual({ ok: false, code: 'superseded' });
    expect(t.appWin.views.authorizedUrl()).toBe(sourceUrl(token, 2));
    expect(t.appWin.views.sourceDoc(token, 2)).toContain('application/pdf');
  });
});

describe('Copy headers and Back to message', () => {
  it('copies only the block shown, and only while the source view shows', async () => {
    const t = make();
    const { openId } = t.install();
    expect(await t.call(COPY, { openId, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    t.state.answer = () => headersOf(`Subject: ${MARKER_TEXT}\u202e\r\n`);
    await t.call(SOURCE, { openId, generation: 1 });
    expect(await t.call(COPY, { openId, generation: 1 })).toEqual({ ok: true });
    expect(fake.copied).toEqual([`Subject: ${MARKER_TEXT}<U+202E>\n`]);
    await t.call(BACK, { openId, generation: 1 });
    expect(await t.call(COPY, { openId, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    expect(fake.copied).toHaveLength(1);
    // The two refusals are logged as such; the copy only by its code.
    expect(t.logs.map((l) => l.code)).toEqual([
      'ipc.rejected',
      'reader.source',
      'reader.copy_headers',
      'ipc.rejected',
    ]);
    expect(findMarkers(JSON.stringify(t.logs))).toEqual([]);
  });

  it('gives the body URL back, and an answer that comes after Back changes nothing', async () => {
    const t = make();
    const { openId, token } = t.install();
    await t.call(SOURCE, { openId, generation: 1 });
    t.state.answer = () => ({ type: 'result', reqId: 1, ok: true, parts: PARTS });
    await t.call(TREE, { openId, generation: 1 });
    const h = t.held();
    t.state.answer = () => h.answer;
    const late = t.call(PART, { openId, path: '1.2', generation: 1 });
    await vi.waitFor(() => expect(t.requests.at(-1)?.what.path).toBe('1.2'));
    expect(await t.call(BACK, { openId, generation: 1 })).toEqual({
      ok: true,
      url: bodyUrl(token),
    });
    h.release(headersOf('Content-Type: application/pdf\r\n'));
    expect(await late).toEqual({ ok: false, code: 'superseded' });
    expect(t.appWin.views.authorizedUrl()).toBe(bodyUrl(token));
    expect(t.appWin.views.sourceDoc(token, 1)).toBeNull();
    // The old source URL serves nothing any more.
    expect(t.appWin.views.sourceDoc(token, 2)).toBeNull();
  });

  it('numbers blocks on for the life of the view, so View source after Back never reuses a URL', async () => {
    const t = make();
    const { openId, token } = t.install();
    expect(await t.call(SOURCE, { openId, generation: 1 })).toMatchObject({
      url: sourceUrl(token, 1),
    });
    await t.call(BACK, { openId, generation: 1 });
    expect(await t.call(SOURCE, { openId, generation: 1 })).toMatchObject({
      url: sourceUrl(token, 2),
    });
    expect(t.appWin.views.sourceDoc(token, 1)).toBeNull();
    expect(t.appWin.views.sourceDoc(token, 2)).toContain('Subject:');
    expect(t.appWin.views.authorizedUrl()).toBe(sourceUrl(token, 2));
  });
});

describe('a read that crosses Back and View source again', () => {
  it('never shows a block it read for the earlier showing', async () => {
    const t = make();
    const { openId, token } = t.install();
    const h = t.held();
    t.state.answer = () => h.answer;
    const old = t.call(SOURCE, { openId, generation: 1 });
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    await t.call(BACK, { openId, generation: 1 });
    // The new showing's own read: same view, its selection counted from 1 again.
    const h2 = t.held();
    t.state.answer = () => h2.answer;
    const now = t.call(SOURCE, { openId, generation: 1 });
    await vi.waitFor(() => expect(t.requests).toHaveLength(2));
    h.release(headersOf('Subject: old\r\n'));
    expect(await old).toEqual({ ok: false, code: 'superseded' });
    expect(t.appWin.views.authorizedUrl()).toBe(bodyUrl(token));
    expect(t.appWin.views.sourceDoc(token, 1)).toBeNull();
    h2.release(headersOf('Subject: new\r\n'));
    expect(await now).toEqual({ ok: true, url: sourceUrl(token, 1), truncated: false });
    expect(t.appWin.views.sourceDoc(token, 1)).toContain('new');
    expect(t.appWin.views.sourceDoc(token, 1)).not.toContain('old');
  });

  it('never shows a part, nor sets the paths, from a read for the earlier showing', async () => {
    const t = make();
    const { openId, token } = t.install();
    await t.call(SOURCE, { openId, generation: 1 });
    t.state.answer = () => ({ type: 'result', reqId: 1, ok: true, parts: PARTS });
    await t.call(TREE, { openId, generation: 1 });
    // A part read and a tree read for the first showing, both held over Back.
    const part = t.held();
    const tree = t.held();
    t.state.answer = (r) => (r.what.kind === 'part' ? part.answer : tree.answer);
    const latePart = t.call(PART, { openId, path: '1.2', generation: 1 });
    const lateTree = t.call(TREE, { openId, generation: 1 });
    await vi.waitFor(() => expect(t.requests).toHaveLength(4));
    await t.call(BACK, { openId, generation: 1 });
    t.state.answer = () => headersOf('Subject: hi\r\n');
    expect(await t.call(SOURCE, { openId, generation: 1 })).toMatchObject({
      url: sourceUrl(token, 2),
    });
    part.release(headersOf('Content-Type: application/pdf\r\n'));
    expect(await latePart).toEqual({ ok: false, code: 'superseded' });
    // A tree with another part in it: the new showing gets none of its paths.
    tree.release({
      type: 'result',
      reqId: 1,
      ok: true,
      parts: [...PARTS, { ...PARTS[2], path: '1.3', name: 'b.pdf' }],
    });
    expect(await lateTree).toEqual({ ok: false, code: 'superseded' });
    expect(t.appWin.views.authorizedUrl()).toBe(sourceUrl(token, 2));
    expect(await t.call(PART, { openId, path: '1.3', generation: 1 })).toEqual({
      ok: false,
      code: 'invalid',
    });
    expect(await t.call(PART, { openId, path: '1.2', generation: 1 })).toEqual({
      ok: false,
      code: 'invalid',
    });
  });
});

describe('the fallback', () => {
  it("shows a failed open's headers in a view of its own that never gets a body URL", async () => {
    const t = make();
    const { openId, token } = t.appWin.views.accept();
    t.appWin.views.markFallback(openId, 1, 17);
    const result = await t.call(SOURCE, { openId, generation: 1 });
    expect(result).toEqual({ ok: true, url: sourceUrl(token, 1), truncated: false });
    expect(t.requests[0]).toMatchObject({ rowid: 17, file: null, what: { kind: 'headers' } });
    expect(t.appWin.views.authorizedUrl()).toBe(sourceUrl(token, 1));
    expect(t.appWin.views.lookup(token)?.sourceOnly).toBe(true);
    expect(await t.call(BACK, { openId, generation: 1 })).toEqual({ ok: true, url: null });
    expect(t.appWin.views.authorizedUrl()).toBeNull();
    expect(t.appWin.views.lookup(token)).toBeUndefined();
    // View source again on the same open: a fresh view under a new token, so
    // the URL the first one had never serves again.
    const again = await t.call(SOURCE, { openId, generation: 1 });
    expect(again).toMatchObject({ ok: true, truncated: false });
    const url = again.url as string;
    expect(url).not.toBe(sourceUrl(token, 1));
    const fresh = /\/([0-9a-f]{32})\/source\/1$/.exec(url)![1]!;
    expect(t.appWin.views.authorizedUrl()).toBe(url);
    expect(t.appWin.views.lookup(fresh)?.sourceOnly).toBe(true);
    expect(t.appWin.views.lookup(token)).toBeUndefined();
    expect(t.appWin.views.sourceDoc(token, 1)).toBeNull();
    expect(t.requests[1]).toMatchObject({ rowid: 17, file: null, what: { kind: 'headers' } });
    // A new open ends it.
    t.appWin.views.accept();
    expect(await t.call(SOURCE, { openId, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
  });

  it('is kept by an open that ends with the fallback, for View source', async () => {
    const t = make();
    t.state.answer = (r) =>
      r.type === 'read'
        ? { type: 'result', reqId: 1, ok: false, code: 'reader_failed', reason: 'limit' }
        : headersOf('Subject: big\r\n');
    const opened = await t.call(OPEN, { rowid: 17, mode: 'html', generation: 1 });
    expect(opened).toMatchObject({ ok: true, outcome: 'fallback' });
    const openId = opened.openId as number;
    const result = await t.call(SOURCE, { openId, generation: 1 });
    expect(result).toMatchObject({ ok: true, truncated: false });
    expect(t.requests.at(-1)).toMatchObject({ type: 'source', rowid: 17, file: null });
    expect(t.appWin.views.authorizedUrl()).toBe(result.url);
  });

  it('is only for the latest open', async () => {
    const t = make();
    const first = t.appWin.views.accept();
    t.appWin.views.markFallback(first.openId, 1, 17);
    t.appWin.views.accept();
    expect(await t.call(SOURCE, { openId: first.openId, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
  });
});
