// SPDX-License-Identifier: AGPL-3.0-or-later
// Shortcut keys typed while the body frame has the focus. The shell handles
// the keys typed in its own document. A key typed while the body frame has
// the focus never reaches the shell's document, so main passes a few of them
// on from the window's input: `j`, `k`, `n`, `p`, `u` and Escape, and no
// other key. The body frame holds no editable control: the sanitizer removes
// them all.

import type { Input, WebContents } from 'electron';
import { IPC, isFrameKey, type FrameKeyName } from '../shared/api';
import { keyName } from '../shared/keys';
import { sameFrame } from './navigation';

/** Keys whose repeats, while held down, are not passed on. */
const ONCE: ReadonlySet<FrameKeyName> = new Set<FrameKeyName>(['u', 'Escape']);

/**
 * The shortcut key a key press passes on: one of FRAME_KEYS, pressed down
 * with no modifier at all (Shift included), not composing, and not a repeat
 * of a key that acts once per press.
 */
export function frameKeyOf(input: Input): FrameKeyName | null {
  if (input.type !== 'keyDown') return null;
  if (input.control || input.meta || input.alt || input.shift || input.isComposing) return null;
  const key = keyName(input.key, input.code);
  if (!isFrameKey(key)) return null;
  if (input.isAutoRepeat && ONCE.has(key)) return null;
  return key;
}

/**
 * Sends the shell the shortcut keys typed while the body frame has the
 * focus: the shell's direct child frame that shows the body URL main last
 * authorized for the window (`authorizedUrl`), and no other frame.
 */
export function forwardFrameKeys(contents: WebContents, authorizedUrl: () => string | null): void {
  contents.on('before-input-event', (_event, input) => {
    const key = frameKeyOf(input);
    if (key === null) return;
    const frame = contents.focusedFrame;
    if (!frame || !sameFrame(frame.parent, contents.mainFrame)) return;
    const url = authorizedUrl();
    if (url === null || frame.url !== url) return;
    contents.send(IPC.frameKey, key);
  });
}
