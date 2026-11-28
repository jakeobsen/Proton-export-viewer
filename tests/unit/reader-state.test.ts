// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader state in the shell: a failed open call settles the pane, the newest
// of racing opens owns it, and closing the pane or a new generation closes the
// link dialog.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkPrompt } from '../../src/shared/api';

const pev = {
  state: vi.fn(),
  open: vi.fn(),
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
