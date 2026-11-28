// SPDX-License-Identifier: AGPL-3.0-or-later
// `n`/`p` typed while the body frame has the focus: main passes them on to the
// shell, and only those.

import { EventEmitter } from 'node:events';
import type { Input, WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { cardKeyOf, forwardCardKeys } from '../../src/main/card-keys';
import { IPC } from '../../src/shared/api';

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
}

function fakeContents() {
  const main: FakeFrame = { processId: 1, frameToken: 'main', parent: null };
  const body: FakeFrame = { processId: 2, frameToken: 'body', parent: main };
  const nested: FakeFrame = { processId: 2, frameToken: 'nested', parent: body };
  const sent: unknown[][] = [];
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: main,
    focusedFrame: null as FakeFrame | null,
    send: (...args: unknown[]) => sent.push(args),
  });
  forwardCardKeys(contents as unknown as WebContents);
  const type = (focused: FakeFrame | null, typed: Input) => {
    contents.focusedFrame = focused;
    contents.emit('before-input-event', {}, typed);
  };
  return { main, body, nested, sent, type };
}

describe('card keys', () => {
  it('are n and p pressed down with no Control, Command or Option, outside a composition', () => {
    expect(cardKeyOf(input('n'))).toBe('n');
    expect(cardKeyOf(input('p'))).toBe('p');
    expect(cardKeyOf(input('n', { isAutoRepeat: true }))).toBe('n');
    expect(cardKeyOf(input('n', { type: 'keyUp' }))).toBeNull();
    expect(cardKeyOf(input('n', { control: true }))).toBeNull();
    expect(cardKeyOf(input('p', { meta: true }))).toBeNull();
    expect(cardKeyOf(input('n', { alt: true }))).toBeNull();
    expect(cardKeyOf(input('N', { shift: true }))).toBeNull();
    expect(cardKeyOf(input('n', { isComposing: true }))).toBeNull();
    expect(cardKeyOf(input('j'))).toBeNull();
  });

  it('typed in the body frame go to the shell; typed elsewhere they do not', () => {
    const { main, body, nested, sent, type } = fakeContents();
    type(body, input('n'));
    type(body, input('p'));
    expect(sent).toEqual([
      [IPC.cardKey, 'n'],
      [IPC.cardKey, 'p'],
    ]);
    // The shell's own document handles its keys; a frame inside the body is not the body frame.
    type(main, input('n'));
    type(null, input('n'));
    type(nested, input('n'));
    // Other keys and modified ones are not card keys.
    type(body, input('j'));
    type(body, input('n', { meta: true }));
    type(body, input('n', { type: 'keyUp' }));
    expect(sent).toHaveLength(2);
  });
});
