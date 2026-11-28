// SPDX-License-Identifier: AGPL-3.0-or-later
// A conversation's chips: its folders in sidebar order, never All Mail or
// Starred, and its labels in the order of its IDs, the same for its list row
// and its header.

import { describe, expect, it } from 'vitest';
import type { FolderRow } from '../../src/shared/index-types';
import { folderChips, labelChips } from '../../src/renderer/chips-model';
import { sidebarModel } from '../../src/renderer/folders';

const row = (id: string, kind: FolderRow['kind'], name = '', extra: Partial<FolderRow> = {}) => ({
  id,
  name,
  kind,
  parentId: null,
  color: kind === 'label' ? '#ff0000' : null,
  conversations: 1,
  unread: 0,
  ...extra,
});

const sidebar = sidebarModel({
  folders: [
    ...['0', '8', '7', '10', '6', '4', '3', '5'].map((id) => row(id, 'system')),
    // Snoozed holds nothing, so the sidebar doesn't show it.
    row('16', 'system', '', { conversations: 0 }),
    row('f-work', 'folder', 'Work'),
    row('f-sub', 'folder', 'Projects', { parentId: 'f-work' }),
    row('l-b', 'label', 'Bills'),
    row('l-a', 'label', 'Alpha'),
  ],
  hiddenIds: 0,
});

describe('conversation chips', () => {
  it('folders in sidebar order, system then user folders, never All Mail or Starred', () => {
    const ids = ['f-sub', '5', '10', '7', '0', 'l-a', 'f-work', '16', 'unknown'];
    expect(folderChips(ids, sidebar).map((f) => f.name)).toEqual([
      'Inbox',
      'Sent',
      'Work',
      'Projects',
    ]);
  });

  it('labels in the order of the IDs, folders and unknown IDs left out', () => {
    expect(labelChips(['l-b', '0', 'l-a', 'f-work', 'x'], sidebar).map((l) => l.name)).toEqual([
      'Bills',
      'Alpha',
    ]);
  });

  it('nothing without a sidebar or IDs', () => {
    expect(folderChips(['0'], null)).toEqual([]);
    expect(labelChips(['l-a'], null)).toEqual([]);
    expect(folderChips(undefined, sidebar)).toEqual([]);
    expect(labelChips(undefined, sidebar)).toEqual([]);
  });
});
