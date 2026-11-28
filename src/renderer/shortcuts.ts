// SPDX-License-Identifier: AGPL-3.0-or-later
// The keyboard shortcuts: which action a key press is, and where each action
// may act. Typed in the shell's document, or in the body frame and passed on
// by main (FRAME_KEYS only); both go through the same rules.

import type { FrameKeyName } from '../shared/api';
import { keyName } from '../shared/keys';

export type Shortcut =
  /** `j` and `k`: the next or previous row of the list on screen. */
  | 'next'
  | 'previous'
  /** `n` and `p`: the next newer or older card of the open conversation. */
  | 'nextCard'
  | 'previousCard'
  /** `/`: the search box. */
  | 'search'
  /** `o`: opens the focused row or collapsed card. */
  | 'open'
  /** Enter: opens the focused row; on a button or link it stays native. */
  | 'enter'
  /** `u`: the open message again in the other view. */
  | 'toggleView'
  /** `g` then `i`, `g` then `a`. */
  | 'inbox'
  | 'allMail'
  /** `?`: the shortcuts overlay. */
  | 'help'
  /** Escape: one step back. */
  | 'back';

/** How long after `g` its second key counts, in ms. */
export const PREFIX_MS = 1000;

/** The parts of a key press the shortcuts read. */
export interface KeyPress {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  target: EventTarget | null;
}

/** Input types that take no typed text. */
const NOT_TEXT = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** A control that takes typed keys: a text field, a menu or editable content. */
export function editable(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !NOT_TEXT.has(target.type);
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable === true
  );
}

/** The keys that act only without Shift. */
const PLAIN_KEYS: ReadonlyMap<string, Shortcut> = new Map<string, Shortcut>([
  ['j', 'next'],
  ['k', 'previous'],
  ['n', 'nextCard'],
  ['p', 'previousCard'],
  ['o', 'open'],
  ['u', 'toggleView'],
  ['Enter', 'enter'],
  ['Escape', 'back'],
]);

/** Actions that act once per press: a held key's repeats do nothing. */
const ONCE: ReadonlySet<Shortcut> = new Set<Shortcut>([
  'open',
  'enter',
  'toggleView',
  'search',
  'help',
  'back',
]);

/**
 * Reads key presses as shortcuts. It holds one thing between presses: when
 * `g` was pressed, so that `i` or `a` after it, within PREFIX_MS by the
 * monotonic clock, goes to the Inbox or All Mail.
 */
export class ShortcutReader {
  private prefixAt: number | null = null;

  /** The action a key press in the shell is, or null; `now` is `performance.now()`. */
  of(event: KeyPress, now: number): Shortcut | null {
    const prefixed = this.prefixAt !== null && now - this.prefixAt < PREFIX_MS;
    const name = keyName(event.key, event.code);
    // `g` held down: its repeats leave the prefix as it was.
    if (name === 'g' && event.repeat) return null;
    // Any other key ends the prefix.
    this.prefixAt = null;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
    if (editable(event.target)) return null;
    // `/` and `?` need Shift on many layouts (`/` is Shift+7 on German ones).
    if (event.key === '/' || event.key === '?') {
      return event.repeat ? null : event.key === '/' ? 'search' : 'help';
    }
    if (event.shiftKey) return null;
    if (prefixed && !event.repeat && (name === 'i' || name === 'a')) {
      return name === 'i' ? 'inbox' : 'allMail';
    }
    if (name === 'g') {
      this.prefixAt = now;
      return null;
    }
    const action = PLAIN_KEYS.get(name) ?? null;
    if (action === null || (event.repeat && ONCE.has(action))) return null;
    return action;
  }

  /** A key passed on from the body frame ends the prefix too. */
  endPrefix(): void {
    this.prefixAt = null;
  }
}

/** The action of a key main passed on from the body frame. */
export const FRAME_ACTIONS: Readonly<Record<FrameKeyName, Shortcut>> = {
  j: 'next',
  k: 'previous',
  n: 'nextCard',
  p: 'previousCard',
  u: 'toggleView',
  Escape: 'back',
};

/**
 * What shows on top, from the highest: the link dialog or a confirmation
 * (each handles its own Escape), the shortcuts overlay, Settings or the index
 * report, or the mail.
 */
export type Layer = 'modal' | 'overlay' | 'page' | 'mail';

/**
 * Whether an action acts where it was pressed: everything on the mail; only
 * Escape and `?` over Settings, the report or the overlay; nothing while the
 * link dialog or a confirmation shows.
 */
export function actsIn(layer: Layer, action: Shortcut): boolean {
  if (layer === 'mail') return true;
  if (layer === 'modal') return false;
  return action === 'back' || action === 'help';
}

/** What Escape closes, first match wins. */
export type BackStep = 'overlay' | 'settings' | 'report' | 'search';

export function backStep(shown: {
  overlay: boolean;
  settings: boolean;
  report: boolean;
  search: boolean;
}): BackStep | null {
  if (shown.overlay) return 'overlay';
  if (shown.settings) return 'settings';
  if (shown.report) return 'report';
  if (shown.search) return 'search';
  return null;
}
