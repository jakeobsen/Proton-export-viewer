// SPDX-License-Identifier: AGPL-3.0-or-later
// `n` and `p` move the conversation's expanded card. The shell handles the
// keys typed in its own document. A key typed while the body frame has the
// focus never reaches the shell's document, so main passes it on from the
// window's input. The body frame holds no editable control: the sanitizer
// removes them all.

import type { Input, WebContents } from 'electron';
import { IPC, type CardKeyName } from '../shared/api';
import { sameFrame } from './navigation';

/** The card key a key press is: `n` or `p`, with no Control, Command or Option, not composing. */
export function cardKeyOf(input: Input): CardKeyName | null {
  if (input.type !== 'keyDown' || input.control || input.meta || input.alt) return null;
  if (input.isComposing) return null;
  return input.key === 'n' || input.key === 'p' ? input.key : null;
}

/**
 * Sends the shell the card keys typed while the body frame has the focus:
 * the shell's direct child frame that shows the body URL main last
 * authorized for the window (`authorizedUrl`), and no other frame.
 */
export function forwardCardKeys(contents: WebContents, authorizedUrl: () => string | null): void {
  contents.on('before-input-event', (_event, input) => {
    const key = cardKeyOf(input);
    if (key === null) return;
    const frame = contents.focusedFrame;
    if (!frame || !sameFrame(frame.parent, contents.mainFrame)) return;
    const url = authorizedUrl();
    if (url === null || frame.url !== url) return;
    contents.send(IPC.cardKey, key);
  });
}
