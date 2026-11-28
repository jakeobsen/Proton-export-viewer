// SPDX-License-Identifier: AGPL-3.0-or-later
// The shell's keyboard shortcuts: which action a key press is, the `g`
// prefix, where each action acts, and what Escape closes first.

import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FRAME_ACTIONS,
  PREFIX_MS,
  ShortcutReader,
  actsIn,
  backStep,
  editable,
  type KeyPress,
  type Layer,
  type Shortcut,
} from '../../src/renderer/shortcuts';
import { FRAME_KEYS, isFrameKey } from '../../src/shared/api';

const press = (key: string, more: Partial<KeyPress> = {}): KeyPress => ({
  key,
  code: '',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  repeat: false,
  target: null,
  ...more,
});

/** One key press on a fresh reader. */
const one = (key: string, more: Partial<KeyPress> = {}) =>
  new ShortcutReader().of(press(key, more), 0);

const KEYS: ReadonlyArray<[string, Shortcut]> = [
  ['j', 'next'],
  ['k', 'previous'],
  ['n', 'nextCard'],
  ['p', 'previousCard'],
  ['/', 'search'],
  ['o', 'open'],
  ['Enter', 'enter'],
  ['u', 'toggleView'],
  ['?', 'help'],
  ['Escape', 'back'],
];

let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><body></body>');
  for (const name of [
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
  ] as const) {
    vi.stubGlobal(name, dom.window[name]);
  }
});
afterAll(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

function element(html: string, contentEditable = false): HTMLElement {
  const holder = dom.window.document.createElement('div');
  holder.innerHTML = html;
  const el = holder.firstElementChild as HTMLElement;
  // jsdom doesn't compute isContentEditable; Chromium does.
  if (contentEditable) Object.defineProperty(el, 'isContentEditable', { value: true });
  return el;
}

describe('ShortcutReader', () => {
  it('reads each shortcut key, and no other', () => {
    for (const [key, action] of KEYS) expect(one(key)).toBe(action);
    for (const key of ['x', 'a', 'i', 'g', 'Tab', ' ', 'ArrowDown', 'Backspace', '1', 'Shift']) {
      expect(one(key)).toBeNull();
    }
  });

  it('ignores every key with Control, Command or Option, or while composing', () => {
    for (const [key] of KEYS) {
      expect(one(key, { ctrlKey: true })).toBeNull();
      expect(one(key, { metaKey: true })).toBeNull();
      expect(one(key, { altKey: true })).toBeNull();
      expect(one(key, { isComposing: true })).toBeNull();
    }
  });

  it('ignores every key while a text field, a menu or editable text has the focus', () => {
    const typing = [
      element('<input>'),
      element('<input type="search">'),
      element('<input type="email">'),
      element('<textarea></textarea>'),
      element('<select><option>a</option></select>'),
      element('<div></div>', true),
    ];
    for (const target of typing) {
      expect(editable(target)).toBe(true);
      for (const [key] of KEYS) expect(one(key, { target })).toBeNull();
    }
    // Controls that take no typed text don't hold the keys.
    for (const target of [
      element('<button></button>'),
      element('<input type="checkbox">'),
      element('<input type="radio">'),
      element('<div tabindex="0"></div>'),
    ]) {
      expect(editable(target)).toBe(false);
      expect(one('j', { target })).toBe('next');
    }
  });

  it('takes / and ? with or without Shift; letters, Enter and Escape only without', () => {
    // `/` is Shift+7 on German, Danish, Nordic and Swiss layouts.
    expect(one('/', { code: 'Digit7', shiftKey: true })).toBe('search');
    expect(one('?', { code: 'Slash', shiftKey: true })).toBe('help');
    expect(one('?', { code: 'Minus', shiftKey: true })).toBe('help');
    for (const key of ['J', 'K', 'N', 'P', 'O', 'U', 'Enter', 'Escape']) {
      expect(one(key, { shiftKey: true })).toBeNull();
    }
  });

  it('reads a non-Latin letter by its physical key, and a letter whatever Caps Lock says', () => {
    expect(one('о', { code: 'KeyJ' })).toBe('next');
    expect(one('л', { code: 'KeyK' })).toBe('previous');
    expect(one('щ', { code: 'KeyO' })).toBe('open');
    expect(one('θ', { code: 'KeyU' })).toBe('toggleView');
    expect(one('ö', { code: 'Semicolon' })).toBeNull();
    expect(one('j', { code: 'KeyC' })).toBe('next');
    expect(one('J', { code: 'KeyJ' })).toBe('next');
  });

  it('ignores the repeats of a held u, o, Enter, /, ? and Escape, but not of j, k, n and p', () => {
    for (const key of ['u', 'o', 'Enter', '/', '?', 'Escape']) {
      expect(one(key, { repeat: true })).toBeNull();
    }
    expect(one('?', { repeat: true, shiftKey: true })).toBeNull();
    for (const [key, action] of KEYS.slice(0, 4)) {
      expect(one(key, { repeat: true })).toBe(action);
    }
  });

  describe('g then i or a', () => {
    it('goes to the Inbox or All Mail within the second after g', () => {
      const reader = new ShortcutReader();
      expect(reader.of(press('g'), 100)).toBeNull();
      expect(reader.of(press('i'), 100 + PREFIX_MS - 1)).toBe('inbox');
      expect(reader.of(press('g'), 5000)).toBeNull();
      expect(reader.of(press('a'), 5000)).toBe('allMail');
      // Through the physical key on a non-Latin layout.
      expect(reader.of(press('п', { code: 'KeyG' }), 9000)).toBeNull();
      expect(reader.of(press('ф', { code: 'KeyA' }), 9001)).toBe('allMail');
    });

    it('does nothing a second or more after g', () => {
      const reader = new ShortcutReader();
      reader.of(press('g'), 0);
      expect(reader.of(press('i'), PREFIX_MS)).toBeNull();
      reader.of(press('g'), 0);
      expect(reader.of(press('a'), PREFIX_MS + 100)).toBeNull();
    });

    it('ends at any other key, which acts as usual', () => {
      const reader = new ShortcutReader();
      reader.of(press('g'), 0);
      expect(reader.of(press('j'), 10)).toBe('next');
      expect(reader.of(press('i'), 20)).toBeNull();
      reader.of(press('g'), 100);
      expect(reader.of(press('x'), 110)).toBeNull();
      expect(reader.of(press('a'), 120)).toBeNull();
      // A modified or Shifted second key ends it too.
      reader.of(press('g'), 200);
      expect(reader.of(press('i', { ctrlKey: true }), 210)).toBeNull();
      expect(reader.of(press('i'), 220)).toBeNull();
      reader.of(press('g'), 300);
      expect(reader.of(press('I', { shiftKey: true }), 310)).toBeNull();
      expect(reader.of(press('i'), 320)).toBeNull();
      // So does a key passed on from the body frame.
      reader.of(press('g'), 400);
      reader.endPrefix();
      expect(reader.of(press('i'), 410)).toBeNull();
    });

    it('starts only from a plain g outside a text field, and a held g keeps it as it was', () => {
      const reader = new ShortcutReader();
      reader.of(press('G', { shiftKey: true }), 0);
      expect(reader.of(press('i'), 10)).toBeNull();
      reader.of(press('g', { target: element('<input>') }), 20);
      expect(reader.of(press('i'), 30)).toBeNull();
      reader.of(press('g', { metaKey: true }), 40);
      expect(reader.of(press('a'), 50)).toBeNull();
      // Held: the repeats neither end nor restart the second.
      reader.of(press('g'), 100);
      expect(reader.of(press('g', { repeat: true }), 600)).toBeNull();
      expect(reader.of(press('g', { repeat: true }), 1050)).toBeNull();
      expect(reader.of(press('i'), 1099)).toBe('inbox');
      reader.of(press('g'), 2000);
      reader.of(press('g', { repeat: true }), 2900);
      expect(reader.of(press('i'), 3000)).toBeNull();
      // A held i after g goes once.
      reader.of(press('g'), 4000);
      expect(reader.of(press('i', { repeat: true }), 4010)).toBeNull();
    });
  });
});

describe('actsIn', () => {
  const all = [...KEYS.map(([, action]) => action), 'inbox', 'allMail'] as Shortcut[];

  it('lets every shortcut act on the mail', () => {
    for (const action of all) expect(actsIn('mail', action)).toBe(true);
  });

  it('lets only Escape and ? act over Settings, the report and the overlay', () => {
    for (const layer of ['page', 'overlay'] as Layer[]) {
      for (const action of all) {
        expect(actsIn(layer, action)).toBe(action === 'back' || action === 'help');
      }
    }
  });

  it('lets nothing act while the link dialog or a confirmation shows', () => {
    for (const action of all) expect(actsIn('modal', action)).toBe(false);
  });
});

describe('backStep', () => {
  const none = { overlay: false, settings: false, report: false, search: false };

  it('closes the overlay, then Settings, then the report, then clears the search', () => {
    const all = { overlay: true, settings: true, report: true, search: true };
    expect(backStep(all)).toBe('overlay');
    expect(backStep({ ...all, overlay: false })).toBe('settings');
    expect(backStep({ ...all, overlay: false, settings: false })).toBe('report');
    expect(backStep({ ...none, search: true })).toBe('search');
    expect(backStep(none)).toBeNull();
  });
});

describe('keys from the body frame', () => {
  it('are the six names, each with its action, and nothing else', () => {
    expect(Object.keys(FRAME_ACTIONS).sort()).toEqual([...FRAME_KEYS].sort());
    expect(FRAME_ACTIONS).toEqual({
      j: 'next',
      k: 'previous',
      n: 'nextCard',
      p: 'previousCard',
      u: 'toggleView',
      Escape: 'back',
    });
    for (const key of FRAME_KEYS) expect(isFrameKey(key)).toBe(true);
    for (const key of ['/', 'o', 'g', 'i', 'a', '?', 'Enter', 'J', 'escape', '', 'constructor']) {
      expect(isFrameKey(key)).toBe(false);
    }
    for (const value of [null, undefined, 1, ['j'], { key: 'j' }]) {
      expect(isFrameKey(value)).toBe(false);
    }
  });
});
