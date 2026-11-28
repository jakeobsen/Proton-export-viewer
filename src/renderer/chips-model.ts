// SPDX-License-Identifier: AGPL-3.0-or-later
// Which chips a conversation shows, from its folder and label IDs and the
// sidebar: its labels in its list row and its header, and its folders in its
// header too. Names are export data and are shown as text only.

import { ALL_MAIL, STARRED, type SidebarEntry, type SidebarModel } from './folders';

/** The conversation's labels the sidebar shows, in the order of its IDs. */
export function labelChips(
  labelIds: readonly string[] | undefined,
  sidebar: SidebarModel | null,
): SidebarEntry[] {
  if (!sidebar) return [];
  return (labelIds ?? [])
    .map((id) => sidebar.byId.get(id))
    .filter((e): e is SidebarEntry => e?.kind === 'label');
}

/**
 * The folders the sidebar shows that hold one of the conversation's messages,
 * system folders then user folders, in sidebar order. All Mail holds every
 * message and Starred is a mark rather than a place, so neither gets a chip.
 */
export function folderChips(
  labelIds: readonly string[] | undefined,
  sidebar: SidebarModel | null,
): SidebarEntry[] {
  if (!sidebar) return [];
  const ids = new Set(labelIds ?? []);
  return [...sidebar.system, ...sidebar.folders].filter(
    (e) => ids.has(e.id) && e.id !== ALL_MAIL && e.id !== STARRED,
  );
}
