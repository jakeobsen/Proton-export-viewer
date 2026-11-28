// SPDX-License-Identifier: AGPL-3.0-or-later
// Show in folder and Copy Message-ID in main: each acts only on the window's
// live view, for the current generation, with a strict argument list, and
// logs a fixed code and the window id, never a path or an ID.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeEvent } from '../../src/shared/log/schema';
import type { Stamp } from '../../src/shared/sources';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const fake = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  revealed: [] as string[],
  copied: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => fake.handlers.set(channel, fn),
    on: () => {},
  },
  shell: {
    showItemInFolder: (path: string) => fake.revealed.push(path),
    openExternal: () => Promise.resolve(),
  },
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
const { ViewRegistry } = await import('../../src/main/views');
const { bumpGeneration } = await import('../../src/main/context');
type AppContext = import('../../src/main/context').AppContext;
type AppWindow = import('../../src/main/context').AppWindow;

const SHOW = 'pev:show-in-folder';
const COPY = 'pev:copy-message-id';
const KEY = '00000000-0000-4000-8000-0000000000a1';
const PATH = '/exports/acct/mail_20250101_000000/m-0001.eml';
const MESSAGE_ID = '<marker-7f3a@example.test>';
const FILE = { dev: '16777232', ino: '4242' };

interface Logged {
  level: string;
  code: string;
  data: Record<string, unknown>;
}

type LocateAnswer =
  | { type: 'result'; reqId: number; ok: true; path?: string }
  | { type: 'result'; reqId: number; ok: false; code: string };

function make() {
  const logs: Logged[] = [];
  const push =
    (level: string) =>
    (code: string, data: Record<string, unknown> = {}) =>
      logs.push({ level, code, data });
  const frame = { processId: 4, frameToken: 'main-frame', origin: 'app://shell' };
  let destroyed = false;
  const appWin = {
    id: 3,
    win: { isDestroyed: () => destroyed, webContents: { send() {} } },
    views: new ViewRegistry(),
    session: {},
  } as unknown as AppWindow;
  const state = {
    offline: false,
    /** What core answers a locate; a function to run something while core works. */
    answer: (): Promise<LocateAnswer> | LocateAnswer => ({
      type: 'result',
      reqId: 1,
      ok: true,
      path: PATH,
    }),
  };
  const requests: Array<{ request: unknown; stamp: Stamp | null }> = [];
  const ctx = {
    generation: 1,
    windows: new Map([[11, appWin]]),
    log: { error: push('error'), warn: push('warn'), info: push('info') },
    core: {
      requestRunning: async (request: unknown, stamp: Stamp | null) => {
        requests.push({ request, stamp });
        return state.answer();
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
    (fake.handlers.get(channel) as Handler)(event, ...args);

  /** Installs a reader view for the current generation and returns its open id. */
  const install = (message: Partial<{ messageId: string; file: typeof FILE | null }> = {}) => {
    const { openId, token } = appWin.views.accept();
    const outcome = appWin.views.install(openId, token, ctx.generation, ctx.generation, {
      html: '<p>x</p>',
      assets: [],
      message: {
        rowid: 17,
        file: message.file === undefined ? FILE : message.file,
        messageId: message.messageId ?? MESSAGE_ID,
        attachments: [],
      },
    });
    expect(outcome.ok).toBe(true);
    return openId;
  };

  return {
    ctx,
    appWin,
    state,
    logs,
    requests,
    call,
    install,
    event,
    destroy: () => (destroyed = true),
  };
}

beforeEach(() => {
  fake.revealed.length = 0;
  fake.copied.length = 0;
});

/** Every entry is one the log schema keeps whole, and none carries the path or the ID. */
function expectRedacted(logs: Logged[]) {
  for (const entry of logs) {
    const event = sanitizeEvent({
      level: entry.level as 'info',
      proc: 'main',
      code: entry.code,
      data: entry.data,
    });
    expect(event, entry.code).not.toBeNull();
    expect(event!.data.dropped, `${entry.code} ${JSON.stringify(entry.data)}`).toBeUndefined();
    const text = JSON.stringify(entry);
    for (const secret of [PATH, 'm-0001', MESSAGE_ID, 'marker-7f3a', FILE.ino]) {
      expect(text).not.toContain(secret);
    }
  }
}

const rejected = (t: ReturnType<typeof make>) =>
  t.logs.filter((l) => l.code === 'ipc.rejected').map((l) => l.data.reason);

describe('Show in folder', () => {
  it("reveals the file core located for the live view's message", async () => {
    const t = make();
    const openId = t.install();
    expect(await t.call(SHOW, { openId, generation: 1 })).toEqual({ ok: true });
    expect(fake.revealed).toEqual([PATH]);
    // Core is asked for the view's message by its rowid and the identity it was read from.
    expect(t.requests).toEqual([
      {
        request: { type: 'locate', generation: 1, rowid: 17, file: FILE },
        stamp: { sourceKey: KEY, generation: 1 },
      },
    ]);
    expect(t.logs).toEqual([
      { level: 'info', code: 'reader.show_in_folder', data: { windowId: 3 } },
    ]);
    expectRedacted(t.logs);
  });

  it('refuses a stale generation, an older open and a test body, and asks core nothing', async () => {
    const t = make();
    const first = t.install();
    const second = t.install();
    expect(await t.call(SHOW, { openId: second, generation: 0 })).toEqual({
      ok: false,
      code: 'stale_generation',
    });
    // The newer open revoked the first view.
    expect(await t.call(SHOW, { openId: first, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    // An open still waiting for its view names nothing yet.
    const { openId: pending } = t.appWin.views.accept();
    expect(await t.call(SHOW, { openId: pending, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    // A test hook's fixed body has no message behind it.
    const { openId: stub, token } = t.appWin.views.accept();
    t.appWin.views.install(stub, token, 1, 1, { html: '<p>stub</p>', assets: [] });
    expect(await t.call(SHOW, { openId: stub, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    // After a switch, the old view is gone, whatever generation is named.
    const live = t.install();
    bumpGeneration(t.ctx);
    expect(await t.call(SHOW, { openId: live, generation: 2 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    expect(t.requests).toEqual([]);
    expect(fake.revealed).toEqual([]);
    expectRedacted(t.logs);
  });

  it('takes exactly one object of openId and generation', async () => {
    const t = make();
    const openId = t.install();
    const bad: unknown[][] = [
      [],
      [{ openId }],
      [{ generation: 1 }],
      [{ openId, generation: 1, path: PATH }],
      [{ openId, generation: 1, rowid: 17 }],
      [{ openId, generation: 1 }, { extra: true }],
      [{ openId: String(openId), generation: 1 }],
      [{ openId: 0, generation: 1 }],
      [{ openId: 1.5, generation: 1 }],
      [{ openId, generation: -1 }],
      [{ openId, generation: 2 ** 31 + 1 }],
      [null],
      ['open'],
    ];
    for (const args of bad) {
      expect(await t.call(SHOW, ...args), JSON.stringify(args)).toEqual({
        ok: false,
        code: 'invalid',
      });
    }
    expect(t.requests).toEqual([]);
    expect(fake.revealed).toEqual([]);
  });

  it('refuses while the export is offline, and for a view with no file identity', async () => {
    const t = make();
    const openId = t.install();
    t.state.offline = true;
    expect(await t.call(SHOW, { openId, generation: 1 })).toEqual({ ok: false, code: 'offline' });
    t.state.offline = false;
    const noFile = t.install({ file: null });
    expect(await t.call(SHOW, { openId: noFile, generation: 1 })).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(t.requests).toEqual([]);
    expect(fake.revealed).toEqual([]);
  });

  it("passes on core's refusals and reveals nothing for them", async () => {
    const cases: Array<[string, string]> = [
      ['changed', 'changed'],
      ['eml_missing', 'eml_missing'],
      ['not_found', 'not_found'],
      ['superseded', 'superseded'],
      ['unavailable', 'offline'],
      ['no_source', 'invalid'],
    ];
    for (const [code, expected] of cases) {
      const t = make();
      const openId = t.install();
      t.state.answer = () => ({ type: 'result', reqId: 1, ok: false, code });
      expect(await t.call(SHOW, { openId, generation: 1 }), code).toEqual({
        ok: false,
        code: expected,
      });
      expect(rejected(t)).toEqual([expected]);
      expectRedacted(t.logs);
    }
    const t = make();
    const openId = t.install();
    t.state.answer = () => {
      throw new CoreUnavailableError();
    };
    expect(await t.call(SHOW, { openId, generation: 1 })).toEqual({
      ok: false,
      code: 'core_unavailable',
    });
    // An answer without a path reveals nothing either.
    t.state.answer = () => ({ type: 'result', reqId: 1, ok: true });
    expect(await t.call(SHOW, { openId, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    expect(fake.revealed).toEqual([]);
  });

  it('reveals nothing when the view goes while core locates the file', async () => {
    const moves: Array<[string, (t: ReturnType<typeof make>) => void]> = [
      ['a switch', (t) => void bumpGeneration(t.ctx)],
      ['a newer open', (t) => void t.appWin.views.accept()],
      ['a newer view', (t) => void t.install()],
      ['the window closing', (t) => t.destroy()],
    ];
    for (const [name, move] of moves) {
      const t = make();
      const openId = t.install();
      t.state.answer = () => {
        move(t);
        return { type: 'result', reqId: 1, ok: true, path: PATH };
      };
      expect(await t.call(SHOW, { openId, generation: 1 }), name).toEqual({
        ok: false,
        code: 'superseded',
      });
      expect(t.requests, name).toHaveLength(1);
      expect(fake.revealed, name).toEqual([]);
      expect(
        t.logs.map((l) => l.code),
        name,
      ).not.toContain('reader.show_in_folder');
    }
  });

  it('refuses a sender that is not the main frame of an app window', async () => {
    const t = make();
    const openId = t.install();
    const handler = fake.handlers.get(SHOW) as Handler;
    const sub = { processId: 4, frameToken: 'sub-frame', origin: 'app://shell' };
    const other = { processId: 4, frameToken: 'main-frame', origin: 'app://body' };
    expect(
      await handler(
        { sender: { id: 11, mainFrame: t.event.senderFrame }, senderFrame: sub },
        { openId, generation: 1 },
      ),
    ).toEqual({ ok: false, code: 'not_main_frame' });
    expect(
      await handler(
        { sender: { id: 11, mainFrame: other }, senderFrame: other },
        { openId, generation: 1 },
      ),
    ).toEqual({ ok: false, code: 'bad_origin' });
    expect(
      await handler(
        { sender: { id: 12, mainFrame: t.event.senderFrame }, senderFrame: t.event.senderFrame },
        { openId, generation: 1 },
      ),
    ).toEqual({ ok: false, code: 'unknown_window' });
    expect(t.requests).toEqual([]);
    expect(fake.revealed).toEqual([]);
  });
});

describe('Copy Message-ID', () => {
  it("copies the live view's Message-ID and logs only the window", async () => {
    const t = make();
    const openId = t.install();
    expect(await t.call(COPY, { openId, generation: 1 })).toEqual({ ok: true });
    expect(fake.copied).toEqual([MESSAGE_ID]);
    expect(t.logs).toEqual([
      { level: 'info', code: 'reader.copy_message_id', data: { windowId: 3 } },
    ]);
    // It needs nothing from the export, so it works offline too, and never asks core.
    t.state.offline = true;
    expect(await t.call(COPY, { openId, generation: 1 })).toEqual({ ok: true });
    expect(fake.copied).toEqual([MESSAGE_ID, MESSAGE_ID]);
    expect(t.requests).toEqual([]);
    expectRedacted(t.logs);
  });

  it('copies nothing for a message without one, a stale or older view, or bad arguments', async () => {
    const t = make();
    const none = t.install({ messageId: '' });
    expect(await t.call(COPY, { openId: none, generation: 1 })).toEqual({
      ok: false,
      code: 'not_found',
    });
    const live = t.install();
    expect(await t.call(COPY, { openId: none, generation: 1 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    expect(await t.call(COPY, { openId: live, generation: 0 })).toEqual({
      ok: false,
      code: 'stale_generation',
    });
    for (const args of [
      [],
      [{ openId: live, generation: 1, messageId: MESSAGE_ID }],
      [{ openId: live, generation: 1 }, 1],
      [{ openId: live }],
    ]) {
      expect(await t.call(COPY, ...args), JSON.stringify(args)).toEqual({
        ok: false,
        code: 'invalid',
      });
    }
    bumpGeneration(t.ctx);
    expect(await t.call(COPY, { openId: live, generation: 2 })).toEqual({
      ok: false,
      code: 'superseded',
    });
    expect(fake.copied).toEqual([]);
    expect(rejected(t)).toEqual([
      'not_found',
      'superseded',
      'stale_generation',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'superseded',
    ]);
    expectRedacted(t.logs);
  });
});
