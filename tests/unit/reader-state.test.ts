// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader state in the shell: a failed open call settles the pane, the newest
// of racing opens owns it, and closing the pane or a new generation closes the
// link dialog.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkPrompt } from '../../src/shared/api';

const pev = {
  state: vi.fn(),
  open: vi.fn(),
  allowRemote: vi.fn(),
};
(globalThis as unknown as { window: { pev: typeof pev } }).window = { pev };

const reader = await import('../../src/renderer/reader');
const shell = await import('../../src/renderer/shell');

const PROMPT: LinkPrompt = {
  dialogId: 'd'.repeat(32),
  title: 'shop',
  url: 'https://shop.example/',
  host: { start: 8, end: 20 },
  mismatch: false,
  lookalike: false,
  mail: false,
  unclear: false,
};

beforeEach(async () => {
  pev.state.mockResolvedValue({ ok: true, generation: 1 });
  await shell.refreshGeneration();
});

afterEach(() => {
  reader.closeReader();
  vi.clearAllMocks();
});

describe('openInReader', () => {
  it('ends refused, not pending, when the open call fails', async () => {
    pev.open.mockRejectedValueOnce(new Error('handler failed'));
    const result = await reader.openInReader(7);
    expect(result).toEqual({ ok: false, code: 'core_unavailable' });
    expect(reader.getReaderState()).toMatchObject({
      rowid: 7,
      pending: false,
      view: null,
      fallback: false,
      refused: 'core_unavailable',
    });
  });

  it('ends refused when the generation can not be read', async () => {
    reader.closeReader();
    pev.state.mockResolvedValue({ ok: false, code: 'unknown_window' });
    await shell.refreshGeneration();
    pev.state.mockRejectedValueOnce(new Error('no answer'));
    expect(await reader.openInReader(7)).toEqual({ ok: false, code: 'stale_generation' });
    expect(reader.getReaderState()).toMatchObject({ pending: false, refused: 'stale_generation' });
    expect(pev.open).not.toHaveBeenCalled();
  });

  it('lets the newer of two racing opens own the pane, whichever answers first', async () => {
    const view = (openId: number, id: string) => ({
      ok: true,
      openId,
      outcome: 'view',
      url: `mail-body://v/${id.repeat(32)}`,
      format: 'html',
    });
    let answerOld: (value: unknown) => void = () => {};
    pev.open
      .mockReturnValueOnce(new Promise((resolve) => (answerOld = resolve)))
      .mockResolvedValueOnce(view(2, 'b'));
    const older = reader.openInReader(4);
    const newer = reader.openInReader(5);
    await newer;
    // The older open's answer comes last and changes nothing.
    answerOld(view(1, 'a'));
    await older;
    expect(reader.getReaderState()).toMatchObject({
      rowid: 5,
      pending: false,
      view: { openId: 2, url: `mail-body://v/${'b'.repeat(32)}` },
    });
  });

  it("keeps the fallback's refused file for that open only", async () => {
    const fallback = (openId: number, fileRefused: boolean) => ({
      ok: true,
      openId,
      outcome: 'fallback',
      match: null,
      fileRefused,
    });
    pev.open.mockResolvedValueOnce(fallback(1, true));
    await reader.openInReader(4);
    expect(reader.getReaderState()).toMatchObject({ fallback: true, fileRefused: true });

    let answer: (value: unknown) => void = () => {};
    pev.open.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const next = reader.openInReader(4, 'plain');
    expect(reader.getReaderState()).toMatchObject({ pending: true, fileRefused: false });
    answer({ ok: true, openId: 2, outcome: 'view', url: `mail-body://v/${'c'.repeat(32)}` });
    await next;
    expect(reader.getReaderState()).toMatchObject({ fallback: false, fileRefused: false });

    pev.open.mockResolvedValueOnce(fallback(3, false));
    await reader.openInReader(4, 'html-anyway');
    expect(reader.getReaderState()).toMatchObject({ fallback: true, fileRefused: false });
  });
});

describe('the link dialog', () => {
  it('closes with the pane', () => {
    shell.showLink(PROMPT);
    expect(shell.getShellState().link).toEqual(PROMPT);
    reader.closeReader();
    expect(shell.getShellState().link).toBeNull();
  });

  it('closes when a new generation is read, and stays for the same one', async () => {
    shell.showLink(PROMPT);
    await shell.refreshGeneration();
    expect(shell.getShellState().link).toEqual(PROMPT);
    pev.state.mockResolvedValue({ ok: true, generation: 2 });
    await shell.refreshGeneration();
    expect(shell.getShellState()).toMatchObject({ generation: 2, link: null });
  });

  it('closes, with the pane, when the generation moves under an open message', async () => {
    pev.open.mockResolvedValueOnce({
      ok: true,
      openId: 1,
      outcome: 'view',
      url: `mail-body://v/${'a'.repeat(32)}`,
      format: 'html',
    });
    await reader.openInReader(3);
    shell.showLink(PROMPT);
    pev.state.mockResolvedValue({ ok: true, generation: 3 });
    const generation = await shell.refreshGeneration();
    reader.generationChanged(generation);
    expect(reader.getReaderState().rowid).toBeNull();
    expect(shell.getShellState().link).toBeNull();
  });
});

describe('remote images', () => {
  const VIEW = {
    ok: true,
    openId: 5,
    outcome: 'view',
    url: `mail-body://v/${'c'.repeat(32)}`,
    format: 'html',
    hasHtml: true,
    remote: 2,
    remoteLoadable: true,
    htmlTooLarge: false,
    cut: null,
    headers: { subject: '', from: '', to: '', cc: '', date: null },
  };

  async function shown(view: object = VIEW) {
    pev.open.mockResolvedValueOnce(view);
    await reader.openInReader(7);
    const state = reader.getReaderState();
    if (!state.view) throw new Error('no view');
    return state;
  }

  const key = () => {
    const state = reader.getReaderState();
    return state.view ? reader.frameKey(state.view, state.remote) : null;
  };

  it('mounts a new frame only for a new view, or a consent granted with a reload', async () => {
    await shown();
    const first = key();
    reader.remoteStatus({ generation: 1, openId: 5, insecure: 1, refused: 0 });
    expect(key()).toBe(first);
    pev.allowRemote.mockResolvedValueOnce({ ok: true, reload: false });
    await reader.loadRemoteImages();
    expect(key()).toBe(first);
    reader.closeReader();
    await shown();
    pev.allowRemote.mockResolvedValueOnce({ ok: true, reload: true });
    await reader.loadRemoteImages();
    const reloaded = key();
    expect(reloaded).not.toBe(first);
    expect(reader.getReaderState().remote).toMatchObject({ allowed: true, reloads: 1 });
    // Asking again once allowed sends nothing.
    expect(await reader.loadRemoteImages()).toBeNull();
    expect(pev.allowRemote).toHaveBeenCalledTimes(2);
    expect(key()).toBe(reloaded);
    await shown({ ...VIEW, openId: 6, url: `mail-body://v/${'d'.repeat(32)}` });
    expect(key()).not.toBe(reloaded);
    expect(reader.getReaderState().remote).toMatchObject({ allowed: false, reloads: 0 });
  });

  it('sends one request while one is out, with the open id and generation', async () => {
    await shown();
    let answer: (value: unknown) => void = () => {};
    pev.allowRemote.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const first = reader.loadRemoteImages();
    expect(reader.getReaderState().remote.asking).toBe(true);
    expect(await reader.loadRemoteImages()).toBeNull();
    expect(pev.allowRemote).toHaveBeenCalledTimes(1);
    expect(pev.allowRemote).toHaveBeenCalledWith(5, 1);
    answer({ ok: true, reload: true });
    await first;
    expect(reader.getReaderState().remote).toMatchObject({ asking: false, allowed: true });
  });

  it("says it couldn't load them only when the loader couldn't start; the button stays", async () => {
    await shown();
    pev.allowRemote.mockResolvedValueOnce({ ok: false, code: 'unavailable' });
    await reader.loadRemoteImages();
    expect(reader.getReaderState().remote).toMatchObject({
      asking: false,
      allowed: false,
      failed: true,
    });
    pev.allowRemote.mockRejectedValueOnce(new Error('handler failed'));
    await reader.loadRemoteImages();
    expect(reader.getReaderState().remote.failed).toBe(true);
    pev.allowRemote.mockResolvedValueOnce({ ok: false, code: 'not_live' });
    await reader.loadRemoteImages();
    expect(reader.getReaderState().remote).toMatchObject({ allowed: false, failed: false });
  });

  it("drops another open's counts, and keeps the shown view's", async () => {
    await shown();
    reader.remoteStatus({ generation: 1, openId: 4, insecure: 3, refused: 3 });
    reader.remoteStatus({ generation: 2, openId: 5, insecure: 3, refused: 3 });
    expect(reader.getReaderState().remote).toMatchObject({ insecure: 0, refused: 0 });
    reader.remoteStatus({ generation: 1, openId: 5, insecure: 1, refused: 2 });
    expect(reader.getReaderState().remote).toMatchObject({ insecure: 1, refused: 2 });
  });

  it('asks nothing for a view whose images can not load', async () => {
    await shown({ ...VIEW, remoteLoadable: false });
    expect(await reader.loadRemoteImages()).toBeNull();
    expect(pev.allowRemote).not.toHaveBeenCalled();
  });

  it('ignores an answer that comes after a newer open', async () => {
    await shown();
    let answer: (value: unknown) => void = () => {};
    pev.allowRemote.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const asked = reader.loadRemoteImages();
    await shown({ ...VIEW, openId: 6, url: `mail-body://v/${'d'.repeat(32)}` });
    answer({ ok: true, reload: true });
    await asked;
    expect(reader.getReaderState().remote).toMatchObject({
      allowed: false,
      reloads: 0,
      asking: false,
    });
  });
});
