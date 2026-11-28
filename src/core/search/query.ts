// SPDX-License-Identifier: AGPL-3.0-or-later
// The search box's query language, parsed into terms. Words, "phrases",
// -negation and operators (from:, to:, cc:, subject:, filename:, label:,
// folder:, has:attachment, is:unread|starred|replied, before:, after:,
// larger:, smaller:). Unknown operators and bad values are plain text. The
// parser is pure: it never builds full-text syntax or SQL, only terms.

import { MAX_QUERY_LENGTH } from '../../shared/index-types';
import { cleanQuery, wordsOf } from '../../shared/query-text';
import { normalizeSearch, type Chip } from '../../shared/search-chips';

export { MAX_QUERY_LENGTH, cleanQuery, wordsOf };
/** The most terms and operators a query keeps; later ones are ignored. */
export const MAX_TERMS = 32;

/** Full-text columns an operator can name. */
export type TextColumn = 'subject' | 'sender' | 'recipients' | 'attachments';

/** Words or a phrase matched in the full-text index. */
export interface TextTerm {
  kind: 'text';
  /** The words as the user typed them; the index's tokenizer splits them. */
  text: string;
  /** True: the last word matches whole. False: it also matches as a prefix. */
  exact: boolean;
  /** Null: any column. */
  column: TextColumn | null;
  negated: boolean;
}

/** from:, to: or cc: with an address: the stored address, exactly or by prefix. */
export interface AddressTerm {
  kind: 'address';
  field: 'from' | 'to' | 'cc';
  value: string;
  negated: boolean;
}

/** label: or folder:, by exact name or path in any case; or, from a chip, by ID. */
export interface LabelTerm {
  kind: 'label';
  scope: 'label' | 'folder';
  /** The name or path typed; empty for a chip's term. */
  name: string;
  /** A chip's folder or label ID: matched as it is, never by name. */
  id?: string;
  negated: boolean;
}

export interface FlagTerm {
  kind: 'flag';
  flag: 'unread' | 'starred' | 'replied' | 'attachment';
  negated: boolean;
}

/** before: (earlier than that local day) or after: (that local day or later). */
export interface DateTerm {
  kind: 'date';
  op: 'before' | 'after';
  /** The start of that day in local time, in seconds since the epoch. */
  time: number;
  negated: boolean;
}

export interface SizeTerm {
  kind: 'size';
  op: 'larger' | 'smaller';
  bytes: number;
  negated: boolean;
}

export type Term = TextTerm | AddressTerm | LabelTerm | FlagTerm | DateTerm | SizeTerm;

export interface ParsedQuery {
  terms: Term[];
  /** Terms past MAX_TERMS that were ignored. */
  ignored: number;
}

const OPERATORS = new Set([
  'from',
  'to',
  'cc',
  'subject',
  'filename',
  'label',
  'folder',
  'has',
  'is',
  'before',
  'after',
  'larger',
  'smaller',
]);

const MARK = /\p{M}/gu;

/**
 * A text term for these words, or null if they hold no word. A bare last word
 * of one character matches whole: a one-character prefix would match every
 * word that starts with it.
 */
function textTerm(
  text: string,
  quoted: boolean,
  column: TextColumn | null,
  negated: boolean,
): TextTerm | null {
  const words = wordsOf(text);
  const last = words.at(-1);
  if (last === undefined) return null;
  const exact = quoted || [...last.replace(MARK, '')].length < 2;
  return { kind: 'text', text, exact, column, negated };
}

/** A YYYY-MM-DD day's local start in seconds, or null if it isn't a real day. */
export function localDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(2000, 0, 1);
  date.setFullYear(y, mo - 1, d);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return Math.floor(date.getTime() / 1000);
}

/** A size in bytes from digits with an optional K or M, or null. */
export function sizeOf(value: string): number | null {
  const m = /^(\d{1,9})([km]?)$/i.exec(value);
  if (!m) return null;
  const unit = m[2]!.toLowerCase();
  return Number(m[1]) * (unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1);
}

/**
 * The term an operator and its value give: null when the value holds no word
 * to match, 'plain' when the value isn't one the operator takes.
 */
export function operatorTerm(
  op: string,
  value: string,
  quoted: boolean,
  negated: boolean,
): Term | null | 'plain' {
  if (value.trim() === '') return 'plain';
  switch (op) {
    case 'from':
    case 'to':
    case 'cc':
      if (value.includes('@')) return { kind: 'address', field: op, value: value.trim(), negated };
      return textTerm(value, quoted, op === 'from' ? 'sender' : 'recipients', negated);
    case 'subject':
      return textTerm(value, quoted, 'subject', negated);
    case 'filename':
      return textTerm(value, quoted, 'attachments', negated);
    case 'label':
    case 'folder':
      return { kind: 'label', scope: op, name: value.trim(), negated };
    case 'has':
      return value.toLowerCase() === 'attachment'
        ? { kind: 'flag', flag: 'attachment', negated }
        : 'plain';
    case 'is': {
      const flag = value.toLowerCase();
      return flag === 'unread' || flag === 'starred' || flag === 'replied'
        ? { kind: 'flag', flag, negated }
        : 'plain';
    }
    case 'before':
    case 'after': {
      const time = localDay(value);
      return time === null ? 'plain' : { kind: 'date', op, time, negated };
    }
    case 'larger':
    case 'smaller': {
      const bytes = sizeOf(value);
      return bytes === null ? 'plain' : { kind: 'size', op, bytes, negated };
    }
  }
  return 'plain';
}

const SPACE = /\s/u;

/** Parses query text into at most MAX_TERMS terms. */
export function parseQuery(raw: string): ParsedQuery {
  const text = cleanQuery(raw);
  const terms: Term[] = [];
  let ignored = 0;
  const add = (term: Term | null) => {
    if (term === null) return;
    if (terms.length < MAX_TERMS) terms.push(term);
    else ignored += 1;
  };
  let i = 0;
  const n = text.length;
  /** Reads a quoted value starting at the quote; an unclosed one runs to the end. */
  const readQuoted = (): string => {
    const close = text.indexOf('"', i + 1);
    const end = close === -1 ? n : close;
    const value = text.slice(i + 1, end);
    i = close === -1 ? n : close + 1;
    return value;
  };
  while (i < n) {
    if (SPACE.test(text[i]!)) {
      i += 1;
      continue;
    }
    let negated = false;
    if (text[i] === '-' && i + 1 < n && !SPACE.test(text[i + 1]!)) {
      negated = true;
      i += 1;
    }
    if (text[i] === '"') {
      add(textTerm(readQuoted(), true, null, negated));
      continue;
    }
    // A bare run: up to the next space or quote.
    const start = i;
    while (i < n && text[i] !== '"' && !SPACE.test(text[i]!)) i += 1;
    const run = text.slice(start, i);
    const op = /^([A-Za-z]+):/.exec(run);
    if (op && OPERATORS.has(op[1]!.toLowerCase())) {
      let value = run.slice(op[0].length);
      let quoted = false;
      if (value === '' && text[i] === '"') {
        value = readQuoted();
        quoted = true;
      }
      const term = operatorTerm(op[1]!.toLowerCase(), value, quoted, negated);
      if (term !== 'plain') {
        add(term);
        continue;
      }
      add(textTerm(quoted ? `${op[0]}${value}` : run, false, null, negated));
      continue;
    }
    add(textTerm(run, false, null, negated));
  }
  return { terms, ignored };
}

/**
 * The term a chip makes, with the parser's own constructors: From is what
 * `from:<value>` gives (an address with "@", otherwise sender words, matched
 * whole when the value has a space, as `from:"…"` is), After is `after:<day>`,
 * the toggles are `has:attachment` and `is:unread`, and Label and Folder match
 * their ID. Null for a value that makes no term.
 */
export function chipTerm(chip: Chip): Term | null {
  const made = (term: Term | null | 'plain') => (term === 'plain' ? null : term);
  switch (chip.k) {
    case 'from':
      return made(operatorTerm('from', chip.v, SPACE.test(chip.v.trim()), false));
    case 'attachment':
      return made(operatorTerm('has', 'attachment', false, false));
    case 'after':
      return made(operatorTerm('after', chip.d, false, false));
    case 'label':
    case 'folder':
      return { kind: 'label', scope: chip.k, name: '', id: chip.id, negated: false };
    case 'unread':
      return made(operatorTerm('is', 'unread', false, false));
  }
}

/** A search's terms: its text's, then one per chip. Chips don't count against MAX_TERMS. */
export function searchTerms(spec: { text: string; chips?: Chip[] }): ParsedQuery {
  const parsed = parseQuery(spec.text);
  const chips = normalizeSearch({ text: '', chips: spec.chips ?? [] }).chips;
  const terms = chips.map(chipTerm).filter((term): term is Term => term !== null);
  return { terms: [...parsed.terms, ...terms], ignored: parsed.ignored };
}
