// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader's match line for a message opened from search: how many matches
// its body has, with the way to see them marked, or the other places it
// matched and why its body can't show them. Text only, from counts and column
// names; never the search text.

import type { RejectCode } from '../shared/api';
import type { MatchColumn, OpenMode, ReaderMatch } from '../shared/reader-protocol';
import { formatCount } from './format';

/** What the match line shows: nothing, a line of text, or the body's matches with their action. */
export type MatchLine =
  { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'matches'; text: string };

/** What the open showed, as far as the match line cares. */
export interface MatchLineInput {
  match: ReaderMatch | null;
  /** Main refused the open with this code. */
  refused: RejectCode | null;
  /** The reader couldn't render the message. */
  fallback: boolean;
  /** The mode the open asked for. */
  mode: OpenMode;
  /** On the fallback: the message file itself couldn't be opened. */
  fileRefused: boolean;
  /** The body shown: its format, and whether it is the stored text with marks. */
  view: { format: 'plain' | 'html'; highlighted: boolean } | null;
}

const NONE: MatchLine = { kind: 'none' };

/** Where the index is with a message's text, as `ReaderMatch.state` gives it. */
const STATE = { pending: 0, indexed: 1, truncated: 2, failed: 3, emlMissing: 4 } as const;

export function matchesText(n: number): string {
  return `${formatCount(n)} ${n === 1 ? 'match' : 'matches'}`;
}

function matchesIn(columns: readonly MatchColumn[]): string {
  return `Matches in: ${columns.join(', ')}`;
}

/** The match line for the reader's latest open. */
export function matchLine({
  match,
  refused,
  fallback,
  mode,
  fileRefused,
  view,
}: MatchLineInput): MatchLine {
  if (match === null) return NONE;
  const { columns } = match;
  const where = columns.length > 0 ? matchesIn(columns) : null;
  if (refused !== null) {
    // Only a missing file says how the message matched; it never counts body matches.
    if (refused !== 'eml_missing' || where === null) return NONE;
    return { kind: 'text', text: `${where} · Message file missing` };
  }
  if (match.state === STATE.pending) return { kind: 'text', text: 'Body not indexed yet' };
  if (match.state === STATE.failed) {
    if (where === null) return NONE;
    const reason = match.reason === 'timeout' ? 'Timed out' : "Couldn't read text";
    return { kind: 'text', text: `${where} · ${reason}` };
  }
  if (match.state !== STATE.indexed && match.state !== STATE.truncated) return NONE;
  if (match.bodyMatches > 0 && !match.changed) {
    // The marks are in the body itself.
    if (view?.highlighted) return NONE;
    // HTML, or the fallback: the plain view shows them. A plain view that came
    // back without marks had them dropped, so it isn't offered again. Nor is it
    // on a fallback that a plain open would meet again: the plain open itself
    // failed, or the file couldn't be opened at all.
    const plainOpens = fallback ? mode !== 'plain' && !fileRefused : view?.format === 'html';
    if (plainOpens) return { kind: 'matches', text: matchesText(match.bodyMatches) };
  }
  return where === null ? NONE : { kind: 'text', text: where };
}

/** The line about how much of a highlighted body is indexed: only part of it, at state 2. */
export function indexedPartText(match: ReaderMatch | null, highlighted: boolean): string | null {
  return highlighted && match?.state === STATE.truncated ? 'First 1 MB indexed' : null;
}
