// SPDX-License-Identifier: AGPL-3.0-or-later
// `n` and `p` move the expanded card only while the mail shows: not while
// Settings shows over it, and not while the link dialog is open.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkPrompt } from '../../src/shared/api';

(globalThis as unknown as { window: { pev: Record<string, unknown> } }).window = { pev: {} };

const shell = await import('../../src/renderer/shell');
const mailbox = await import('../../src/renderer/mailbox-state');

const PROMPT = {
  dialogId: 'd1',
  title: 'example',
  url: 'https://example.com/',
  host: { start: 8, end: 19 },
} as LinkPrompt;

afterEach(() => {
  shell.showMail();
  shell.clearLink();
  vi.restoreAllMocks();
});

describe('card keys and the screen', () => {
  it('move the card while the mail shows', () => {
    const move = vi.spyOn(mailbox.cards, 'move').mockReturnValue(true);
    mailbox.moveCard('n');
    mailbox.moveCard('p');
    expect(move.mock.calls).toEqual([[1], [-1]]);
  });

  it('move nothing while Settings shows, and move again after Back to mail', () => {
    const move = vi.spyOn(mailbox.cards, 'move').mockReturnValue(true);
    shell.showSettings();
    mailbox.moveCard('n');
    mailbox.moveCard('p');
    expect(move).not.toHaveBeenCalled();
    shell.showMail();
    mailbox.moveCard('p');
    expect(move.mock.calls).toEqual([[-1]]);
  });

  it('move nothing while the link dialog is open', () => {
    const move = vi.spyOn(mailbox.cards, 'move').mockReturnValue(true);
    shell.showLink(PROMPT);
    mailbox.moveCard('n');
    expect(move).not.toHaveBeenCalled();
    shell.clearLink();
    mailbox.moveCard('n');
    expect(move.mock.calls).toEqual([[1]]);
  });
});
