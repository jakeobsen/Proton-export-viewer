// SPDX-License-Identifier: AGPL-3.0-or-later
// Keys typed while the body frame has the focus: main passes `j`, `k`, `n`,
// `p`, `u` and Escape on to the shell, and no other key.

import { EventEmitter } from 'node:events';
import type { Input, WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { frameKeyOf, forwardFrameKeys } from '../../src/main/frame-keys';
import { FRAME_KEYS, IPC } from '../../src/shared/api';

const input = (key: string, more: Partial<Input> = {}) =>
  ({
    type: 'keyDown',
    key,
    code: '',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...more,
  }) as Input;

interface FakeFrame {
  processId: number;
  frameToken: string;
  parent: FakeFrame | null;
  url: string;
}

const BODY = 'mail-body://v/0123456789abcdef0123456789abcdef';

function fakeContents() {
  const main: FakeFrame = {
    processId: 1,
    frameToken: 'main',
    parent: null,
    url: 'app://shell/index.html',
  };
  const body: FakeFrame = { processId: 2, frameToken: 'body', parent: main, url: BODY };
  const nested: FakeFrame = { processId: 2, frameToken: 'nested', parent: body, url: BODY };
  const sibling: FakeFrame = {
    processId: 3,
    frameToken: 'sibling',
    parent: main,
    url: 'about:blank',
  };
  const sent: unknown[][] = [];
  let authorized: string | null = BODY;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: main,
    focusedFrame: null as FakeFrame | null,
    send: (...args: unknown[]) => sent.push(args),
  });
  forwardFrameKeys(contents as unknown as WebContents, () => authorized);
  const type = (focused: FakeFrame | null, typed: Input) => {
    contents.focusedFrame = focused;
    contents.emit('before-input-event', {}, typed);
  };
  const authorize = (url: string | null) => {
    authorized = url;
  };
  return { main, body, nested, sibling, sent, type, authorize };
}

describe('frame keys', () => {
  it('are the six keys pressed down with no modifier, outside a composition', () => {
    for (const key of FRAME_KEYS) expect(frameKeyOf(input(key))).toBe(key);
    expect(frameKeyOf(input('n', { type: 'keyUp' }))).toBeNull();
    for (const key of FRAME_KEYS) {
      expect(frameKeyOf(input(key, { control: true }))).toBeNull();
      expect(frameKeyOf(input(key, { meta: true }))).toBeNull();
      expect(frameKeyOf(input(key, { alt: true }))).toBeNull();
      expect(frameKeyOf(input(key, { shift: true }))).toBeNull();
      expect(frameKeyOf(input(key, { isComposing: true }))).toBeNull();
    }
    expect(frameKeyOf(input('J', { shift: true }))).toBeNull();
  });

  it('are no other key: not /, o, g, a, i, ?, Enter or Tab', () => {
    for (const key of ['/', 'o', 'g', 'a', 'i', '?', 'Enter', 'Tab', 'x', ' ', 'ArrowDown']) {
      expect(frameKeyOf(input(key))).toBeNull();
    }
    // `?` and `/` with the Shift they need on many layouts.
    expect(frameKeyOf(input('?', { shift: true }))).toBeNull();
    expect(frameKeyOf(input('/', { shift: true, code: 'Digit7' }))).toBeNull();
  });

  it('pass on held j, k, n and p, but not a held u or Escape', () => {
    for (const key of ['j', 'k', 'n', 'p']) {
      expect(frameKeyOf(input(key, { isAutoRepeat: true }))).toBe(key);
    }
    expect(frameKeyOf(input('u', { isAutoRepeat: true }))).toBeNull();
    expect(frameKeyOf(input('Escape', { isAutoRepeat: true }))).toBeNull();
  });

  it('read a non-Latin letter by its physical key, and a letter whatever Caps Lock says', () => {
    // Russian and Greek layouts.
    expect(frameKeyOf(input('о', { code: 'KeyJ' }))).toBe('j');
    expect(frameKeyOf(input('л', { code: 'KeyK' }))).toBe('k');
    expect(frameKeyOf(input('ν', { code: 'KeyN' }))).toBe('n');
    expect(frameKeyOf(input('г', { code: 'KeyU' }))).toBe('u');
    // A non-Latin letter on a key that is no shortcut, and one with no letter key.
    expect(frameKeyOf(input('ф', { code: 'KeyA' }))).toBeNull();
    expect(frameKeyOf(input('ö', { code: 'Semicolon' }))).toBeNull();
    // A Latin letter is the letter typed, not the key it is on (Dvorak's j is on KeyC).
    expect(frameKeyOf(input('j', { code: 'KeyC' }))).toBe('j');
    expect(frameKeyOf(input('c', { code: 'KeyJ' }))).toBeNull();
    // Caps Lock: an upper-case letter with no Shift.
    expect(frameKeyOf(input('J', { code: 'KeyJ' }))).toBe('j');
  });

  it('typed in the body frame go to the shell; typed elsewhere they do not', () => {
    const { main, body, nested, sibling, sent, type } = fakeContents();
    for (const key of FRAME_KEYS) type(body, input(key));
    expect(sent).toEqual(FRAME_KEYS.map((key) => [IPC.frameKey, key]));
    // The shell's own document handles its keys; a frame inside the body is not the body frame.
    type(main, input('n'));
    type(null, input('n'));
    type(nested, input('n'));
    // Another child frame of the shell is not the body frame either.
    type(sibling, input('n'));
    // Other keys and modified ones are not passed on.
    type(body, input('g'));
    type(body, input('/'));
    type(body, input('n', { meta: true }));
    type(body, input('j', { shift: true }));
    type(body, input('n', { type: 'keyUp' }));
    expect(sent).toHaveLength(FRAME_KEYS.length);
  });

  it('go to the shell only from the frame that shows the authorized body URL', () => {
    const { body, sent, type, authorize } = fakeContents();
    authorize(null);
    type(body, input('n'));
    authorize('mail-body://v/ffffffffffffffffffffffffffffffff');
    type(body, input('n'));
    expect(sent).toEqual([]);
    authorize(BODY);
    type(body, input('p'));
    expect(sent).toEqual([[IPC.frameKey, 'p']]);
  });
});
