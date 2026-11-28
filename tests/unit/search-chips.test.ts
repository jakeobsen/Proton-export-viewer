// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hasWord, tidyQuery } from '../../src/shared/query-text';
import { ChipSchema, ChipsSchema, parseRecent } from '../../src/shared/recent-search';
import {
  MAX_CHIPS,
  isEmptySearch,
  isRealDay,
  normalizeSearch,
  searchKey,
  type Chip,
} from '../../src/shared/search-chips';
import type { SidebarModel } from '../../src/renderer/folders';
import {
  chipText,
  dayText,
  folderChoices,
  recentParts,
  withChip,
  withoutChip,
} from '../../src/renderer/search-chips';

describe('canonical search', () => {
  it('writes the keys in a fixed order, pinned byte for byte', () => {
    const chips: Chip[] = [
      { k: 'unread' },
      { k: 'folder', id: 'f1' },
      { k: 'label', id: 'l2' },
      { k: 'after', d: '2024-01-01' },
      { k: 'attachment' },
      { k: 'label', id: 'l1' },
      { k: 'from', v: 'Alice  Moreau ' },
    ];
    expect(searchKey({ text: '  budget\t plan ', chips })).toBe(
      '{"v":1,"text":"budget plan","chips":[{"k":"from","v":"Alice Moreau"},{"k":"attachment"},' +
        '{"k":"after","d":"2024-01-01"},{"k":"label","id":"l1"},{"k":"label","id":"l2"},' +
        '{"k":"folder","id":"f1"},{"k":"unread"}]}',
    );
  });

  it('gives chips in another order, a repeated label or folder ID, and other white space the same key', () => {
    const a = searchKey({
      text: 'x y',
      chips: [
        { k: 'label', id: 'l1' },
        { k: 'folder', id: 'f1' },
      ],
    });
    const b = searchKey({
      text: ' x\n y ',
      chips: [
        { k: 'folder', id: 'f1' },
        { k: 'label', id: 'l1' },
        { k: 'label', id: 'l1' },
        { k: 'folder', id: 'f1' },
      ],
    });
    expect(b).toBe(a);
    expect(searchKey({ text: 'x y', chips: [{ k: 'label', id: 'l2' }] })).not.toBe(a);
  });

  it('cleans control characters out of the text and a From value', () => {
    expect(tidyQuery('a\u0000b  \u0085c')).toBe('a b c');
    expect(normalizeSearch({ text: '', chips: [{ k: 'from', v: ' al\u0007ice ' }] }).chips).toEqual(
      [{ k: 'from', v: 'al ice' }],
    );
  });

  it('parses back exactly what it writes, and nothing that is not in that form', () => {
    const spec = {
      text: 'invoice',
      chips: [{ k: 'from', v: 'alice' }, { k: 'unread' }] as Chip[],
    };
    const q = searchKey(spec);
    expect(parseRecent(q)).toEqual(normalizeSearch(spec));
    // Not canonical: other key order, extra spaces, unsorted chips.
    expect(parseRecent('{"text":"invoice","v":1,"chips":[]}')).toBeNull();
    expect(parseRecent('{"v":1, "text":"invoice","chips":[]}')).toBeNull();
    expect(parseRecent('{"v":1,"text":"","chips":[{"k":"unread"},{"k":"attachment"}]}')).toBeNull();
    // Not a valid search at all.
    for (const bad of [
      '',
      'invoice',
      '{"v":2,"text":"invoice","chips":[]}',
      '{"v":1,"text":"","chips":[]}',
      '{"v":1,"text":"x","chips":[{"k":"from","v":"!!!"}]}',
      '{"v":1,"text":"x","chips":[{"k":"size"}]}',
      '{"v":1,"text":"x","chips":[],"extra":1}',
      42,
      null,
    ]) {
      expect(parseRecent(bad), String(bad)).toBeNull();
    }
  });

  it('knows an empty search', () => {
    expect(isEmptySearch({ text: ' \t', chips: [] })).toBe(true);
    expect(isEmptySearch({ text: '', chips: [{ k: 'unread' }] })).toBe(false);
    expect(isEmptySearch({ text: 'x', chips: [] })).toBe(false);
  });
});

describe('chip checks', () => {
  const ok = (chip: unknown) => ChipSchema.safeParse(chip).success;

  it('take each kind in its own form', () => {
    expect(ok({ k: 'from', v: 'alice' })).toBe(true);
    expect(ok({ k: 'from', v: 'a@b.c' })).toBe(true);
    expect(ok({ k: 'attachment' })).toBe(true);
    expect(ok({ k: 'after', d: '2024-02-29' })).toBe(true);
    expect(ok({ k: 'label', id: 'abc==' })).toBe(true);
    expect(ok({ k: 'folder', id: '0' })).toBe(true);
    expect(ok({ k: 'unread' })).toBe(true);
  });

  it('refuse every bad form', () => {
    for (const bad of [
      { k: 'from', v: '!!!' },
      { k: 'from', v: '' },
      { k: 'from', v: 'x'.repeat(256) },
      { k: 'from', v: 'alice', extra: 1 },
      { k: 'from' },
      { k: 'attachment', v: 'x' },
      { k: 'after', d: '2023-02-29' },
      { k: 'after', d: '2024-1-01' },
      { k: 'after', d: '2024-01-01T00:00' },
      { k: 'label', id: '' },
      { k: 'label', id: 'x'.repeat(129) },
      { k: 'label', id: 'a\u0000b' },
      { k: 'folder', id: 'a\nb' },
      { k: 'folder', id: 7 },
      { k: 'starred' },
      'unread',
    ]) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuse more than MAX_CHIPS, and a second From, After or toggle', () => {
    const labels = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ k: 'label', id: `l${i}` }));
    expect(ChipsSchema.safeParse(labels(MAX_CHIPS)).success).toBe(true);
    expect(ChipsSchema.safeParse(labels(MAX_CHIPS + 1)).success).toBe(false);
    for (const twice of [
      [
        { k: 'from', v: 'a' },
        { k: 'from', v: 'b' },
      ],
      [
        { k: 'after', d: '2024-01-01' },
        { k: 'after', d: '2024-01-02' },
      ],
      [{ k: 'unread' }, { k: 'unread' }],
      [{ k: 'attachment' }, { k: 'attachment' }],
    ]) {
      expect(ChipsSchema.safeParse(twice).success).toBe(false);
    }
    expect(
      ChipsSchema.safeParse([
        { k: 'label', id: 'l1' },
        { k: 'label', id: 'l2' },
      ]).success,
    ).toBe(true);
  });

  it('know a real day and a word', () => {
    expect(isRealDay('2024-02-29')).toBe(true);
    expect(isRealDay('2023-02-29')).toBe(false);
    expect(isRealDay('2024-13-01')).toBe(false);
    expect(isRealDay('0099-01-01')).toBe(true);
    expect(hasWord('!!!')).toBe(false);
    expect(hasWord('́')).toBe(false);
    expect(hasWord('é')).toBe(true);
  });
});

describe('chips in the shell', () => {
  const entry = (id: string, name: string, kind: 'system' | 'folder' | 'label') => ({
    id,
    name,
    kind,
    parentId: null,
    depth: 0,
    color: kind === 'label' ? '#ff0000' : null,
    conversations: 1,
    unread: 0,
  });
  const system = [entry('0', 'Inbox', 'system'), entry('5', 'All Mail', 'system')];
  const folders = [entry('f1', 'x y', 'folder')];
  const labels = [entry('l1', 'a "b": -c', 'label')];
  const sidebar = {
    system,
    folders,
    labels,
    byId: new Map([...system, ...folders, ...labels].map((e) => [e.id, e])),
  } as unknown as SidebarModel;

  it('replaces a kind held once, and adds a label or folder only once', () => {
    let chips: Chip[] = [];
    chips = withChip(chips, { k: 'from', v: 'alice' });
    chips = withChip(chips, { k: 'from', v: 'bob' });
    expect(chips).toEqual([{ k: 'from', v: 'bob' }]);
    chips = withChip(chips, { k: 'label', id: 'l1' });
    chips = withChip(chips, { k: 'label', id: 'l1' });
    chips = withChip(chips, { k: 'folder', id: 'l1' });
    expect(chips).toEqual([
      { k: 'from', v: 'bob' },
      { k: 'label', id: 'l1' },
      { k: 'folder', id: 'l1' },
    ]);
    expect(withoutChip(chips, 1)).toEqual([
      { k: 'from', v: 'bob' },
      { k: 'folder', id: 'l1' },
    ]);
    let many: Chip[] = [];
    for (let i = 0; i < MAX_CHIPS + 2; i += 1) many = withChip(many, { k: 'label', id: `l${i}` });
    expect(many).toHaveLength(MAX_CHIPS);
  });

  it('shows each chip as text, and names only what the sidebar has in that scope', () => {
    expect(chipText({ k: 'from', v: 'alice' }, sidebar)).toBe('From: alice');
    expect(chipText({ k: 'attachment' }, sidebar)).toBe('Has attachment');
    expect(chipText({ k: 'after', d: '2024-01-01' }, sidebar)).toBe('After 1 Jan 2024');
    expect(chipText({ k: 'unread' }, sidebar)).toBe('Unread');
    expect(chipText({ k: 'label', id: 'l1' }, sidebar)).toBe('a "b": -c');
    expect(chipText({ k: 'folder', id: 'f1' }, sidebar)).toBe('x y');
    expect(chipText({ k: 'folder', id: '0' }, sidebar)).toBe('Inbox');
    expect(chipText({ k: 'label', id: 'f1' }, sidebar)).toBeNull();
    expect(chipText({ k: 'folder', id: 'l1' }, sidebar)).toBeNull();
    expect(chipText({ k: 'label', id: 'gone' }, sidebar)).toBeNull();
    expect(dayText('2024-12-31')).toBe('31 Dec 2024');
  });

  it('offers the folders in sidebar order without All Mail', () => {
    expect(folderChoices(sidebar).map((e) => e.id)).toEqual(['0', 'f1']);
    expect(folderChoices(null)).toEqual([]);
  });

  it('leaves out a recent search whose label or folder the sidebar no longer has', () => {
    expect(
      recentParts({ text: 'invoice', chips: [{ k: 'label', id: 'l1' }, { k: 'unread' }] }, sidebar),
    ).toEqual(['invoice', 'a "b": -c', 'Unread']);
    expect(recentParts({ text: '', chips: [{ k: 'folder', id: 'gone' }] }, sidebar)).toBeNull();
  });
});
