// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  indexedPartText,
  matchLine,
  matchesText,
  type MatchLineInput,
} from '../../src/renderer/match-line';
import type { ReaderMatch } from '../../src/shared/reader-protocol';

const match = (patch: Partial<ReaderMatch> = {}): ReaderMatch => ({
  state: 1,
  reason: null,
  columns: [],
  bodyMatches: 0,
  changed: false,
  ...patch,
});

const html = { format: 'html', highlighted: false } as const;
const plain = { format: 'plain', highlighted: false } as const;
const marked = { format: 'plain', highlighted: true } as const;

const line = (input: Partial<MatchLineInput>) =>
  matchLine({ match: null, refused: null, fallback: false, view: html, ...input });

describe('the match line', () => {
  it('counts body matches in the HTML view and offers the plain view', () => {
    expect(line({ match: match({ bodyMatches: 3, columns: ['subject'] }) })).toEqual({
      kind: 'matches',
      text: '3 matches',
    });
    expect(line({ match: match({ state: 2, bodyMatches: 1 }) })).toEqual({
      kind: 'matches',
      text: '1 match',
    });
    expect(matchesText(12345)).toBe('12,345 matches');
  });

  it('is gone in the plain view whose body shows the marks', () => {
    expect(line({ match: match({ bodyMatches: 3, columns: ['subject'] }), view: marked })).toEqual({
      kind: 'none',
    });
  });

  it('never offers highlights a plain view came back without: the worker dropped them', () => {
    expect(line({ match: match({ bodyMatches: 3 }), view: plain })).toEqual({ kind: 'none' });
    expect(line({ match: match({ bodyMatches: 3, columns: ['sender'] }), view: plain })).toEqual({
      kind: 'text',
      text: 'Matches in: sender',
    });
  });

  it('lists the other columns when the body has no match', () => {
    expect(line({ match: match({ columns: ['subject', 'sender'] }) })).toEqual({
      kind: 'text',
      text: 'Matches in: subject, sender',
    });
    expect(line({ match: match({ state: 2, columns: ['attachments'] }), view: plain })).toEqual({
      kind: 'text',
      text: 'Matches in: attachments',
    });
  });

  it('gives the reason at state 3', () => {
    expect(line({ match: match({ state: 3, reason: 'timeout', columns: ['subject'] }) })).toEqual({
      kind: 'text',
      text: 'Matches in: subject · Timed out',
    });
    expect(
      line({ match: match({ state: 3, reason: 'unreadable', columns: ['recipients'] }) }),
    ).toEqual({ kind: 'text', text: "Matches in: recipients · Couldn't read text" });
  });

  it('says the body is not indexed yet at state 0', () => {
    expect(line({ match: match({ state: 0, columns: ['subject'] }) })).toEqual({
      kind: 'text',
      text: 'Body not indexed yet',
    });
  });

  it('on a missing file, lists the columns and says it is missing, never counting matches', () => {
    const missing = { refused: 'eml_missing' as const, view: null };
    expect(line({ ...missing, match: match({ state: 4, columns: ['subject'] }) })).toEqual({
      kind: 'text',
      text: 'Matches in: subject · Message file missing',
    });
    expect(
      line({ ...missing, match: match({ state: 1, bodyMatches: 4, columns: ['subject'] }) }),
    ).toEqual({
      kind: 'text',
      text: 'Matches in: subject · Message file missing',
    });
    // A body-only match: the pane's own "Message file missing" stands alone.
    expect(line({ ...missing, match: match({ state: 1, bodyMatches: 4 }) })).toEqual({
      kind: 'none',
    });
    // No other refusal carries a line.
    expect(
      line({ refused: 'not_found', view: null, match: match({ columns: ['subject'] }) }),
    ).toEqual({
      kind: 'none',
    });
  });

  it('on the fallback, offers the plain view for body matches', () => {
    expect(line({ fallback: true, view: null, match: match({ bodyMatches: 2 }) })).toEqual({
      kind: 'matches',
      text: '2 matches',
    });
  });

  it('lists only the other columns once the file changed since it was indexed', () => {
    expect(line({ match: match({ changed: true, columns: ['subject'] }) })).toEqual({
      kind: 'text',
      text: 'Matches in: subject',
    });
    expect(line({ match: match({ changed: true }) })).toEqual({ kind: 'none' });
  });

  it('is never an empty "Matches in": no columns and no body match is no line', () => {
    expect(line({ match: match() })).toEqual({ kind: 'none' });
    expect(line({ match: match({ state: 3, reason: 'timeout' }) })).toEqual({ kind: 'none' });
  });

  it('is gone with no match: filters only, a message that did not match, or no search', () => {
    expect(line({ match: null })).toEqual({ kind: 'none' });
    expect(line({ match: null, refused: 'eml_missing', view: null })).toEqual({ kind: 'none' });
  });
});

describe('the indexed part line', () => {
  it('says "First 1 MB indexed" for a highlighted body at state 2 only', () => {
    expect(indexedPartText(match({ state: 2 }), true)).toBe('First 1 MB indexed');
    expect(indexedPartText(match({ state: 2 }), false)).toBeNull();
    expect(indexedPartText(match({ state: 1 }), true)).toBeNull();
    expect(indexedPartText(null, true)).toBeNull();
  });
});
