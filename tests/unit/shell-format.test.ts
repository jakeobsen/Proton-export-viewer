// SPDX-License-Identifier: AGPL-3.0-or-later
// The shell's display text for the list, and the sidebar's model.

import { describe, expect, it } from 'vitest';
import type { FolderRow, IndexProgress } from '../../src/shared/index-types';
import { sidebarModel } from '../../src/renderer/folders';
import {
  formatCount,
  fullDate,
  fullTextStatus,
  listDate,
  loadingText,
  participantsText,
} from '../../src/renderer/format';

const at = (y: number, mo: number, d: number, h = 12, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime() / 1000;

describe('list text', () => {
  const now = new Date(2026, 10, 26, 15, 30);

  it('shows the time today, the weekday this week, and the date before', () => {
    expect(listDate(at(2026, 11, 26, 9, 14), now)).toBe('09:14');
    expect(listDate(at(2026, 11, 26, 0, 1), now)).toBe('00:01');
    expect(listDate(at(2026, 11, 24, 21, 40), now)).toBe('Tue');
    expect(listDate(at(2026, 11, 20), now)).toBe('Fri');
    expect(listDate(at(2026, 11, 19), now)).toBe('19 Nov');
    expect(listDate(at(2026, 1, 3), now)).toBe('3 Jan');
    expect(listDate(at(2024, 12, 31), now)).toBe('31 Dec 2024');
    // A date ahead of now is a date.
    expect(listDate(at(2026, 12, 1), now)).toBe('1 Dec');
    expect(fullDate(at(2026, 11, 24, 21, 40))).toBe('Tue 24 Nov 2026, 21:40');
  });

  it('counts with separators, and names senders by name, else by address', () => {
    expect(formatCount(20000)).toBe('20,000');
    expect(loadingText(4100, 20000)).toBe('Loading 4,100 of 20,000…');
    expect(
      participantsText([
        { name: 'Theo Martins', address: 'theo@example.net' },
        { name: '', address: 'billing@example.com' },
        { name: '  ', address: 'x@example.org' },
      ]),
    ).toBe('Theo Martins, billing@example.com, x@example.org');
  });

  it('cleans each sender for display, and uses the address when the name cleans to nothing', () => {
    expect(
      participantsText([
        { name: '\u202eEve\u0007\tMallory', address: 'eve@example.com' },
        { name: '\u200b\u2066\u2069', address: '\u202ebob@example.org' },
        { name: '', address: '\u200b' },
      ]),
    ).toBe('Eve␇ Mallory, bob@example.org');
  });
});

const row = (id: string, kind: FolderRow['kind'], extra: Partial<FolderRow> = {}): FolderRow => ({
  id,
  name: `n${id}`,
  kind,
  parentId: null,
  color: null,
  conversations: 0,
  unread: 0,
  ...extra,
});

describe("Settings' Status", () => {
  const progress = (p: Partial<IndexProgress>): IndexProgress => ({
    phase: 'done',
    loaded: 10,
    total: 10,
    failed: 0,
    timeouts: 0,
    capped: 0,
    condition: 'ok',
    bodyPhase: 'indexing',
    bodiesDone: 0,
    bodiesTotal: 0,
    bodiesFailed: 0,
    ...p,
  });

  it('gives the full text share of this run, rounded down, until it is done', () => {
    expect(fullTextStatus(progress({ bodyPhase: 'waiting', phase: 'loading' }))).toBe(
      'Full text 0%',
    );
    expect(fullTextStatus(progress({ bodiesDone: 1, bodiesTotal: 3 }))).toBe('Full text 33%');
    expect(fullTextStatus(progress({ bodiesDone: 999, bodiesTotal: 1000 }))).toBe('Full text 99%');
    expect(fullTextStatus(progress({ bodyPhase: 'failed', bodiesDone: 5, bodiesTotal: 10 }))).toBe(
      'Full text 50%',
    );
  });

  it('says Complete once the text is indexed, also when this run had nothing to read', () => {
    expect(fullTextStatus(progress({ bodyPhase: 'done', bodiesDone: 10, bodiesTotal: 10 }))).toBe(
      'Complete',
    );
    expect(fullTextStatus(progress({ bodyPhase: 'done' }))).toBe('Complete');
  });
});

describe('the sidebar model', () => {
  it('lists system folders in a fixed order with fixed names, the last three only when used', () => {
    const ids = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '16'];
    const empty = sidebarModel({ folders: ids.map((id) => row(id, 'system')), hiddenIds: 0 });
    expect(empty.system.map((e) => e.name)).toEqual([
      'Inbox',
      'Drafts',
      'Sent',
      'Starred',
      'Archive',
      'Spam',
      'Trash',
      'All Mail',
    ]);
    expect(empty.system.map((e) => e.id)).toEqual(['0', '8', '7', '10', '6', '4', '3', '5']);
    const used = sidebarModel({
      folders: ids.map((id) =>
        row(id, 'system', ['9', '12', '16'].includes(id) ? { conversations: 1 } : {}),
      ),
      hiddenIds: 0,
    });
    expect(used.system.map((e) => e.name)).toEqual([
      'Inbox',
      'Snoozed',
      'Drafts',
      'Outbox',
      'Scheduled',
      'Sent',
      'Starred',
      'Archive',
      'Spam',
      'Trash',
      'All Mail',
    ]);
  });

  it('nests folders and labels under their parents, in file order, and survives a loop', () => {
    const model = sidebarModel({
      folders: [
        row('f1', 'folder'),
        row('f2', 'folder', { parentId: 'f1' }),
        row('f3', 'folder', { parentId: 'f2' }),
        row('f4', 'folder', { parentId: 'gone' }),
        row('l1', 'label', { color: '#123456', unread: 2 }),
        row('l2', 'label', { parentId: 'f1' }),
        row('x1', 'folder', { parentId: 'x2' }),
        row('x2', 'folder', { parentId: 'x1' }),
      ],
      hiddenIds: 0,
    });
    expect(model.folders.map((e) => [e.id, e.depth])).toEqual([
      ['f1', 0],
      ['f2', 1],
      ['f3', 2],
      ['f4', 0],
      ['x1', 0],
      ['x2', 1],
    ]);
    // A label whose parent is a folder is at the top of the labels.
    expect(model.labels.map((e) => [e.id, e.depth, e.color, e.unread])).toEqual([
      ['l1', 0, '#123456', 2],
      ['l2', 0, null, 0],
    ]);
    expect(model.byId.get('f3')?.name).toBe('nf3');
  });

  it('handles a deep chain without recursion', () => {
    const chain = Array.from({ length: 20_000 }, (_, i) =>
      row(`c${i}`, 'folder', i === 0 ? {} : { parentId: `c${i - 1}` }),
    );
    const model = sidebarModel({ folders: chain, hiddenIds: 0 });
    expect(model.folders).toHaveLength(20_000);
    expect(model.folders.at(-1)?.depth).toBe(19_999);
  });
});
