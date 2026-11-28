// SPDX-License-Identifier: AGPL-3.0-or-later
// The name of a pressed key, as the keyboard shortcuts read it.

/**
 * A letter is the letter typed, in lower case (Caps Lock doesn't change it).
 * On a layout whose letters aren't Latin (Cyrillic, Greek), it is the Latin
 * letter of the physical key: `KeyJ` gives `j`. Any other key keeps its name
 * (`/`, `?`, `Enter`, `Escape`).
 */
export function keyName(key: string, code: string): string {
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  if (/^\p{L}$/u.test(key)) {
    const match = /^Key([A-Z])$/.exec(code);
    if (match) return match[1]!.toLowerCase();
  }
  return key;
}
