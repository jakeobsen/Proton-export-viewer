// SPDX-License-Identifier: AGPL-3.0-or-later
// Every test-hook module references this string. Release packages must not contain it.

export const TESTHOOKS_MARKER = 'pev-testhooks-present';

export function markLoaded(): void {
  (globalThis as { __pevTestMarker?: string }).__pevTestMarker = TESTHOOKS_MARKER;
}
