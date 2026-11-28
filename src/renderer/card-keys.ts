// SPDX-License-Identifier: AGPL-3.0-or-later
// `n` and `p` typed in the shell's document: from the list, the cards or
// anywhere else, except while an editable control has the focus.

import type { CardKeyName } from '../shared/api';

/** A control that takes typed letters: a text field, a menu or editable content. */
function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** The card key a key press in the shell is: `n` or `p` with no Control, Command or Option. */
export function typedCardKey(event: KeyboardEvent): CardKeyName | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
  if (event.key !== 'n' && event.key !== 'p') return null;
  return editable(event.target) ? null : event.key;
}
