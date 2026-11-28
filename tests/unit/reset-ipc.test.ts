// SPDX-License-Identifier: AGPL-3.0-or-later
// Reset in main: the request names the generation Settings showed, and the
// source manager gets exactly that generation, so a Reset that an earlier
// operation made stale deletes nothing. Each of the manager's answers maps to
// its own reply.

import { describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const fake = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => fake.handlers.set(channel, fn),
    on: () => {},
  },
  shell: { showItemInFolder: () => {}, openExternal: () => Promise.resolve() },
  clipboard: { writeText: () => {} },
  app: {},
  dialog: {},
  protocol: {},
  session: {},
  BrowserWindow: class {},
  MessageChannelMain: class {},
  utilityProcess: {},
}));

const { registerIpc } = await import('../../src/main/ipc');
const { RESET_FAILED, STALE } = await import('../../src/main/sources/manager');
const { IPC } = await import('../../src/shared/api');
type AppContext = import('../../src/main/context').AppContext;
type AppWindow = import('../../src/main/context').AppWindow;

function make(answer: unknown) {
  const frame = { processId: 4, frameToken: 'main-frame', origin: 'app://shell' };
  const appWin = {
    id: 3,
    win: { isDestroyed: () => false, webContents: { send() {} } },
    session: {},
  } as unknown as AppWindow;
  const asked: Array<number | null> = [];
  const ctx = {
    generation: 7,
    windows: new Map([[11, appWin]]),
    log: { error() {}, warn() {}, info() {} },
    sources: {
      reset: async (expected: number | null) => {
        asked.push(expected);
        return answer;
      },
    },
  } as unknown as AppContext;
  fake.handlers.clear();
  registerIpc(ctx);
  const event = { sender: { id: 11, mainFrame: frame }, senderFrame: frame };
  const reset = (generation: number) =>
    (fake.handlers.get(IPC.resetApp) as Handler)(event, { generation });
  return { asked, reset };
}

describe('Reset from Settings', () => {
  it('gives the source manager the generation Settings showed', async () => {
    const t = make(true);
    expect(await t.reset(7)).toEqual({ ok: true, generation: 7 });
    expect(t.asked).toEqual([7]);
  });

  it('answers a stale generation when the manager finds the Reset stale at its turn', async () => {
    const t = make(STALE);
    expect(await t.reset(7)).toEqual({ ok: false, code: 'stale_generation' });
    expect(t.asked).toEqual([7]);
  });

  it('never reaches the manager for a generation that has moved on', async () => {
    const t = make(true);
    expect(await t.reset(6)).toEqual({ ok: false, code: 'stale_generation' });
    expect(t.asked).toEqual([]);
  });

  it('says so when files stay, and when an export overlaps the app’s data', async () => {
    expect(await make(RESET_FAILED).reset(7)).toEqual({ ok: false, code: 'not_deleted' });
    expect(await make(false).reset(7)).toEqual({ ok: false, code: 'refused' });
  });
});
