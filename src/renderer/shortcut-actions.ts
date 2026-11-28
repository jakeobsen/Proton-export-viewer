// SPDX-License-Identifier: AGPL-3.0-or-later
// What each keyboard shortcut does in the shell, and the shortcuts overlay's
// open state. A key typed in the shell and one main passed on from the body
// frame run through the same dispatch, so each key is handled once.

import { useSyncExternalStore } from 'react';
import type { FrameKeyName } from '../shared/api';
import { ALL_MAIL, INBOX } from './folders';
import {
  clearSearch,
  closeReport,
  getMailboxState,
  moveCard,
  search,
  showFolder,
} from './mailbox-state';
import { toggleView } from './reader';
import { getShellState, showMail } from './shell';
import {
  FRAME_ACTIONS,
  ShortcutReader,
  actsIn,
  backStep,
  type KeyPress,
  type Layer,
  type Shortcut,
} from './shortcuts';

let overlayOpen = false;
const overlayListeners = new Set<() => void>();

function setOverlay(open: boolean): void {
  if (overlayOpen === open) return;
  overlayOpen = open;
  for (const listener of overlayListeners) listener();
}

export function closeShortcuts(): void {
  setOverlay(false);
}

/** Whether the shortcuts overlay shows. */
export function useShortcutsOverlay(): boolean {
  return useSyncExternalStore(
    (listener) => {
      overlayListeners.add(listener);
      return () => overlayListeners.delete(listener);
    },
    () => overlayOpen,
  );
}

/** Moves the selection of the list on screen by one row, as its arrow keys do. */
type ListStep = (delta: 1 | -1) => void;
let listStep: ListStep | null = null;

/** The list on screen, the folder's or the results, registers how it moves; returns the undo. */
export function setListStep(step: ListStep): () => void {
  listStep = step;
  return () => {
    if (listStep === step) listStep = null;
  };
}

/** The overlay's dialog; any other modal dialog is the link dialog or a confirmation. */
export const OVERLAY_CLASS = 'shortcuts-dialog';

function layerNow(): Layer {
  const shell = getShellState();
  if (
    shell.link !== null ||
    document.querySelector(`[role="dialog"][aria-modal="true"]:not(.${OVERLAY_CLASS})`) !== null
  ) {
    return 'modal';
  }
  if (overlayOpen) return 'overlay';
  if (shell.screen === 'settings' || getMailboxState().reportOpen) return 'page';
  return 'mail';
}

/** Escape: one step back; false if there was nothing to go back from. */
function back(): boolean {
  const step = backStep({
    overlay: overlayOpen,
    settings: getShellState().screen === 'settings',
    report: getMailboxState().reportOpen,
    search: search.snapshot.active || search.snapshot.text !== '',
  });
  if (step === 'overlay') setOverlay(false);
  else if (step === 'settings') showMail();
  else if (step === 'report') closeReport();
  else if (step === 'search') clearSearch();
  return step !== null;
}

/** Focuses the search box and selects its text. */
function focusSearch(): boolean {
  const box = document.querySelector<HTMLInputElement>('input.search-box');
  if (!box) return false;
  box.focus();
  box.select();
  return true;
}

/**
 * Opens what has the focus: a row of the list or the results selects it
 * (as a click does), and, for `o` only, a collapsed card's header expands
 * it. Enter on a card header, a button or a link stays native.
 */
function openFocused(action: 'open' | 'enter'): boolean {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return false;
  const row = focused.closest<HTMLElement>('.list-scroll [role="option"][data-thread]');
  if (row) {
    row.click();
    return true;
  }
  if (action === 'open' && focused.matches('button.card-h[aria-expanded="false"]')) {
    focused.click();
    return true;
  }
  return false;
}

/** Runs an action; true if it acted, so the key's default is prevented. */
export function runShortcut(action: Shortcut): boolean {
  if (!actsIn(layerNow(), action)) return false;
  switch (action) {
    case 'next':
    case 'previous':
      if (!listStep) return false;
      listStep(action === 'next' ? 1 : -1);
      return true;
    case 'nextCard':
    case 'previousCard':
      moveCard(action === 'nextCard' ? 'n' : 'p');
      return true;
    case 'search':
      return focusSearch();
    case 'open':
    case 'enter':
      return openFocused(action);
    case 'toggleView':
      toggleView();
      return true;
    case 'inbox':
    case 'allMail':
      if (getMailboxState().key === null) return false;
      showFolder(action === 'inbox' ? INBOX : ALL_MAIL);
      return true;
    case 'help':
      setOverlay(!overlayOpen);
      return true;
    case 'back':
      return back();
  }
}

const reader = new ShortcutReader();

/** A key pressed in the shell's document. */
export function shortcutKey(event: KeyPress & { preventDefault(): void }): void {
  const action = reader.of(event, performance.now());
  if (action !== null && runShortcut(action)) event.preventDefault();
}

/** A key main passed on from the body frame. */
export function frameKey(key: FrameKeyName): void {
  reader.endPrefix();
  runShortcut(FRAME_ACTIONS[key]);
}
