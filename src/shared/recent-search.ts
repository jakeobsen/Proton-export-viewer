// SPDX-License-Identifier: AGPL-3.0-or-later
// Checks for search chips and for stored recent searches. Main checks the
// chips a window sends with these; core checks each stored row with them
// before it lists or keeps it. A row is stored as `searchKey`'s canonical
// JSON, so a row is valid only if it parses, passes the schema and is
// already in that exact form.

import { z } from 'zod';
import { MAX_QUERY_LENGTH } from './index-types';
import { cleanQuery, hasWord } from './query-text';
import {
  MAX_CHIPS,
  MAX_CHIP_ID_LENGTH,
  MAX_FROM_LENGTH,
  SINGLE_KINDS,
  isEmptySearch,
  isRealDay,
  searchKey,
  type Chip,
  type SearchSpec,
} from './search-chips';

const ChipId = z
  .string()
  .min(1)
  .max(MAX_CHIP_ID_LENGTH)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/);

/** One chip: a From value must hold a word once cleaned, an After day must exist. */
export const ChipSchema = z.discriminatedUnion('k', [
  z
    .object({
      k: z.literal('from'),
      v: z
        .string()
        .max(MAX_FROM_LENGTH)
        .refine((v) => hasWord(cleanQuery(v))),
    })
    .strict(),
  z.object({ k: z.literal('attachment') }).strict(),
  z
    .object({
      k: z.literal('after'),
      d: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine(isRealDay),
    })
    .strict(),
  z.object({ k: z.literal('label'), id: ChipId }).strict(),
  z.object({ k: z.literal('folder'), id: ChipId }).strict(),
  z.object({ k: z.literal('unread') }).strict(),
]);

/** A search's chips: at most MAX_CHIPS, and at most one From, After and of each toggle. */
export const ChipsSchema = z
  .array(ChipSchema)
  .max(MAX_CHIPS)
  .refine((chips) => {
    const kinds = chips.map((c) => c.k).filter((k) => SINGLE_KINDS.has(k));
    return new Set(kinds).size === kinds.length;
  });

const RecentRowSchema = z
  .object({ v: z.literal(1), text: z.string().max(MAX_QUERY_LENGTH), chips: ChipsSchema })
  .strict();

/**
 * The search a stored row holds, or null if the row isn't valid: not JSON,
 * not this schema, not in canonical form, or an empty search.
 */
export function parseRecent(q: unknown): SearchSpec | null {
  if (typeof q !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(q);
  } catch {
    return null;
  }
  const parsed = RecentRowSchema.safeParse(value);
  if (!parsed.success) return null;
  const spec: SearchSpec = { text: parsed.data.text, chips: parsed.data.chips as Chip[] };
  if (isEmptySearch(spec) || searchKey(spec) !== q) return null;
  return spec;
}

/** A job on a source's recent searches, from main, run by core in the order main sent them. */
export type RecentJob = { op: 'record'; q: string; at: number } | { op: 'list' } | { op: 'wipe' };

/** A stored recent search: its canonical JSON and when main received it, in ms. */
export interface RecentRow {
  q: string;
  at: number;
}

/** What a recent job did; `invalid` counts the rows that failed the check. */
export type RecentAnswer =
  | { op: 'record'; invalid: number }
  | { op: 'list'; rows: RecentRow[]; invalid: number }
  | { op: 'wipe'; deleted: number };
