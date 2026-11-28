// SPDX-License-Identifier: AGPL-3.0-or-later
// Search chips: filters added beside the typed text. A chip travels as data,
// never as query text, so a name with quotes, colons or a leading minus can't
// add or change an operator. A search is its text plus its chips; its
// canonical form, written by `searchKey`, is how two searches compare and how
// a recent search is stored.

import { tidyQuery } from './query-text';

export type Chip =
  | { k: 'from'; v: string }
  | { k: 'attachment' }
  | { k: 'after'; d: string }
  | { k: 'label'; id: string }
  | { k: 'folder'; id: string }
  | { k: 'unread' };

export type ChipKind = Chip['k'];

/** A search: the typed text and the chips beside it. */
export interface SearchSpec {
  text: string;
  chips: Chip[];
}

/** The most chips a search holds. */
export const MAX_CHIPS = 8;
/** The longest From value, in UTF-16 units. */
export const MAX_FROM_LENGTH = 255;
/** The longest folder or label ID a chip carries, in UTF-16 units. */
export const MAX_CHIP_ID_LENGTH = 128;
/** Kinds a search holds at most one of; adding another replaces it. */
export const SINGLE_KINDS: ReadonlySet<ChipKind> = new Set([
  'from',
  'attachment',
  'after',
  'unread',
]);

/** The order chips sort in, by kind. */
const KIND_ORDER: readonly ChipKind[] = [
  'from',
  'attachment',
  'after',
  'label',
  'folder',
  'unread',
];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True if `d` is a YYYY-MM-DD day that exists in the calendar. */
export function isRealDay(d: string): boolean {
  const m = DAY.exec(d);
  if (!m) return false;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(y, mo - 1, day);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === day;
}

/** The value a chip sorts and compares by; empty for a toggle. */
function chipValue(chip: Chip): string {
  switch (chip.k) {
    case 'from':
      return chip.v;
    case 'after':
      return chip.d;
    case 'label':
    case 'folder':
      return chip.id;
    default:
      return '';
  }
}

function compareChips(a: Chip, b: Chip): number {
  const byKind = KIND_ORDER.indexOf(a.k) - KIND_ORDER.indexOf(b.k);
  if (byKind !== 0) return byKind;
  const [va, vb] = [chipValue(a), chipValue(b)];
  return va < vb ? -1 : va > vb ? 1 : 0;
}

/**
 * The search in its canonical form: the text cleaned, white space runs made
 * one space and trimmed; a From value the same way; a chip that repeats
 * another (the same label or folder ID, the same toggle) dropped; the chips
 * sorted by kind, then value.
 */
export function normalizeSearch(spec: SearchSpec): SearchSpec {
  const seen = new Set<string>();
  const chips: Chip[] = [];
  for (const chip of spec.chips) {
    const tidy: Chip = chip.k === 'from' ? { k: 'from', v: tidyQuery(chip.v) } : chip;
    const key = `${tidy.k}\u0000${chipValue(tidy)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push(tidy);
  }
  chips.sort(compareChips);
  return { text: tidyQuery(spec.text), chips };
}

/** One chip as JSON with its keys in a fixed order. */
function chipJson(chip: Chip): string {
  const s = JSON.stringify;
  switch (chip.k) {
    case 'from':
      return `{"k":"from","v":${s(chip.v)}}`;
    case 'after':
      return `{"k":"after","d":${s(chip.d)}}`;
    case 'label':
      return `{"k":"label","id":${s(chip.id)}}`;
    case 'folder':
      return `{"k":"folder","id":${s(chip.id)}}`;
    case 'attachment':
      return '{"k":"attachment"}';
    case 'unread':
      return '{"k":"unread"}';
  }
}

/**
 * The canonical JSON of a search, `{"v":1,"text":…,"chips":[…]}`, with its
 * keys in a fixed order: two searches that mean the same give the same string.
 */
export function searchKey(spec: SearchSpec): string {
  const { text, chips } = normalizeSearch(spec);
  return `{"v":1,"text":${JSON.stringify(text)},"chips":[${chips.map(chipJson).join(',')}]}`;
}

/** True if the search has no text and no chips. */
export function isEmptySearch(spec: SearchSpec): boolean {
  return spec.chips.length === 0 && tidyQuery(spec.text) === '';
}
