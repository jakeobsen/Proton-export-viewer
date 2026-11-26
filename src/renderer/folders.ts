// SPDX-License-Identifier: AGPL-3.0-or-later
// The sidebar's model: system folders in a fixed order and with fixed names
// ("All Mail" once), then user folders and labels as nested trees in the
// order labels.json lists them.

import type { FolderKind, FolderRow, Sidebar } from '../shared/index-types';

export interface SidebarEntry {
  id: string;
  name: string;
  kind: FolderKind;
  /** Nesting level, 0 at the top. */
  depth: number;
  color: string | null;
  conversations: number;
  /** Conversations with an unread message here. */
  unread: number;
}

export interface SidebarModel {
  system: SidebarEntry[];
  folders: SidebarEntry[];
  labels: SidebarEntry[];
  /** Every entry shown, by ID. */
  byId: Map<string, SidebarEntry>;
}

export const INBOX = '0';
export const ALL_MAIL = '5';

/** System folders in sidebar order; the last ones show only when they hold messages. */
const SYSTEM: ReadonlyArray<{ id: string; name: string; always: boolean }> = [
  { id: INBOX, name: 'Inbox', always: true },
  { id: '16', name: 'Snoozed', always: false },
  { id: '8', name: 'Drafts', always: true },
  { id: '9', name: 'Outbox', always: false },
  { id: '12', name: 'Scheduled', always: false },
  { id: '7', name: 'Sent', always: true },
  { id: '10', name: 'Starred', always: true },
  { id: '6', name: 'Archive', always: true },
  { id: '4', name: 'Spam', always: true },
  { id: '3', name: 'Trash', always: true },
  { id: ALL_MAIL, name: 'All Mail', always: true },
];

const entryOf = (row: FolderRow, depth: number, name = row.name): SidebarEntry => ({
  id: row.id,
  name,
  kind: row.kind,
  depth,
  color: row.color,
  conversations: row.conversations,
  unread: row.unread,
});

/**
 * Rows of one kind as a tree, depth first. A row whose parent isn't of the
 * same kind is at the top; rows caught in a parent loop are put at the top
 * where the loop is first met.
 */
function tree(rows: readonly FolderRow[]): SidebarEntry[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, FolderRow[]>();
  const roots: FolderRow[] = [];
  for (const row of rows) {
    const parent = row.parentId;
    if (parent === null || parent === row.id || !ids.has(parent)) {
      roots.push(row);
    } else {
      const list = children.get(parent) ?? [];
      list.push(row);
      children.set(parent, list);
    }
  }
  const out: SidebarEntry[] = [];
  const seen = new Set<string>();
  const walk = (start: FolderRow) => {
    const stack: Array<[FolderRow, number]> = [[start, 0]];
    while (stack.length > 0) {
      const [row, depth] = stack.pop()!;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(entryOf(row, depth));
      const kids = children.get(row.id) ?? [];
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push([kids[i]!, depth + 1]);
    }
  };
  for (const root of roots) walk(root);
  for (const row of rows) if (!seen.has(row.id)) walk(row);
  return out;
}

export function sidebarModel(sidebar: Sidebar): SidebarModel {
  const rows = new Map(sidebar.folders.map((r) => [r.id, r]));
  const system: SidebarEntry[] = [];
  for (const { id, name, always } of SYSTEM) {
    const row = rows.get(id);
    if (!row || row.kind !== 'system') continue;
    if (always || row.conversations > 0) system.push(entryOf(row, 0, name));
  }
  const folders = tree(sidebar.folders.filter((r) => r.kind === 'folder'));
  const labels = tree(sidebar.folders.filter((r) => r.kind === 'label'));
  const byId = new Map<string, SidebarEntry>();
  for (const entry of [...system, ...folders, ...labels]) byId.set(entry.id, entry);
  return { system, folders, labels, byId };
}
