// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader state in the shell: a failed open call settles the pane, and closing
// the pane or a new generation closes the link dialog.

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
