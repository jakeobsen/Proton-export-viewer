// SPDX-License-Identifier: AGPL-3.0-or-later
// The search chips as the shell shows and edits them. Names are export data,
// shown as text only.

import { MAX_CHIPS, SINGLE_KINDS, type Chip, type SearchSpec } from '../shared/search-chips';
import { ALL_MAIL, type SidebarEntry, type SidebarModel } from './folders';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The chips with `chip` added. A kind a search holds once (From, After and
 * the toggles) replaces the one there; a label or folder already there isn't
 * added again; nothing is added past MAX_CHIPS.
 */
export function withChip(chips: Chip[], chip: Chip): Chip[] {
  if (SINGLE_KINDS.has(chip.k)) {
    const at = chips.findIndex((c) => c.k === chip.k);
    if (at >= 0) return chips.map((c, i) => (i === at ? chip : c));
  } else if (chips.some((c) => c.k === chip.k && 'id' in c && 'id' in chip && c.id === chip.id)) {
    return chips;
  }
  return chips.length >= MAX_CHIPS ? chips : [...chips, chip];
}

/** The chips without the one at `index`. */
export function withoutChip(chips: Chip[], index: number): Chip[] {
  return chips.filter((_, i) => i !== index);
}

/** A YYYY-MM-DD day as "1 Jan 2024". */
export function dayText(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  return `${day} ${MONTHS[(m ?? 1) - 1] ?? ''} ${y}`;
}

/** A chip's text: "From: alice", "After 1 Jan 2024", a label's or folder's name; null for one the sidebar doesn't have. */
export function chipText(chip: Chip, sidebar: SidebarModel | null): string | null {
  switch (chip.k) {
    case 'from':
      return `From: ${chip.v}`;
    case 'attachment':
      return 'Has attachment';
    case 'after':
      return `After ${dayText(chip.d)}`;
    case 'unread':
      return 'Unread';
    case 'label':
    case 'folder': {
      const entry = sidebar?.byId.get(chip.id);
      const fits =
        chip.k === 'label'
          ? entry?.kind === 'label'
          : entry !== undefined && entry.kind !== 'label';
      return fits ? entry!.name : null;
    }
  }
}

/** The folders a Folder chip offers, in sidebar order: system and user folders, not All Mail. */
export function folderChoices(sidebar: SidebarModel | null): SidebarEntry[] {
  if (!sidebar) return [];
  return [...sidebar.system.filter((e) => e.id !== ALL_MAIL), ...sidebar.folders];
}

/** The labels a Label chip offers, in sidebar order. */
export function labelChoices(sidebar: SidebarModel | null): SidebarEntry[] {
  return sidebar ? sidebar.labels : [];
}

/**
 * A recent search as its menu entry shows it: its text, then its chips'
 * texts. Null if it names a label or folder the sidebar doesn't have.
 */
export function recentParts(spec: SearchSpec, sidebar: SidebarModel | null): string[] | null {
  const parts: string[] = spec.text === '' ? [] : [spec.text];
  for (const chip of spec.chips) {
    const text = chipText(chip, sidebar);
    if (text === null) return null;
    parts.push(text);
  }
  return parts;
}
