// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_LENGTH,
  MAX_TERMS,
  cleanQuery,
  localDay,
  parseQuery,
  sizeOf,
  type Term,
} from '../../src/core/search/query';

const terms = (text: string): Term[] => parseQuery(text).terms;
const text = (t: string, extra: Partial<Term> = {}) => ({
  kind: 'text',
  text: t,
  exact: false,
  column: null,
  negated: false,
  ...extra,
});

describe('the query parser', () => {
  it('reads words, phrases and negation', () => {
    expect(terms('hello "weekly report" -spam')).toEqual([
      text('hello'),
      text('weekly report', { exact: true }),
      text('spam', { negated: true }),
    ]);
    expect(terms('-"out of office"')).toEqual([
      text('out of office', { exact: true, negated: true }),
    ]);
  });

  it('matches a one-character word whole and longer words as prefixes', () => {
    expect(terms("a ab é é o'b")).toEqual([
      text('a', { exact: true }),
      text('ab'),
      text('é', { exact: true }),
      text('é', { exact: true }),
      text("o'b", { exact: true }),
    ]);
    expect(terms("o'brien")).toEqual([text("o'brien")]);
  });

  it('reads every operator', () => {
    expect(terms('from:alice')).toEqual([text('alice', { column: 'sender' })]);
    expect(terms('to:bob cc:"Carol Ng"')).toEqual([
      text('bob', { column: 'recipients' }),
      text('Carol Ng', { column: 'recipients', exact: true }),
    ]);
    expect(terms('from:Alice@Example.com to:bob@ cc:c@d')).toEqual([
      { kind: 'address', field: 'from', value: 'Alice@Example.com', negated: false },
      { kind: 'address', field: 'to', value: 'bob@', negated: false },
      { kind: 'address', field: 'cc', value: 'c@d', negated: false },
    ]);
    expect(terms('subject:invoice filename:"q3 report.pdf"')).toEqual([
      text('invoice', { column: 'subject' }),
      text('q3 report.pdf', { column: 'attachments', exact: true }),
    ]);
    expect(terms('label:Work folder:"Clients/Acme"')).toEqual([
      { kind: 'label', scope: 'label', name: 'Work', negated: false },
      { kind: 'label', scope: 'folder', name: 'Clients/Acme', negated: false },
    ]);
    expect(terms('has:attachment is:unread is:STARRED is:replied')).toEqual([
      { kind: 'flag', flag: 'attachment', negated: false },
      { kind: 'flag', flag: 'unread', negated: false },
      { kind: 'flag', flag: 'starred', negated: false },
      { kind: 'flag', flag: 'replied', negated: false },
    ]);
    expect(terms('after:2024-02-29 before:2024-03-01')).toEqual([
      { kind: 'date', op: 'after', time: localDay('2024-02-29'), negated: false },
      { kind: 'date', op: 'before', time: localDay('2024-03-01'), negated: false },
    ]);
    expect(terms('larger:10K smaller:2m larger:500')).toEqual([
      { kind: 'size', op: 'larger', bytes: 10 * 1024, negated: false },
      { kind: 'size', op: 'smaller', bytes: 2 * 1024 * 1024, negated: false },
      { kind: 'size', op: 'larger', bytes: 500, negated: false },
    ]);
    expect(terms('FROM:alice Subject:x')).toEqual([
      text('alice', { column: 'sender' }),
      text('x', { column: 'subject', exact: true }),
    ]);
  });

  it('negates operators', () => {
    expect(terms('-from:a@b -label:Work -is:unread -subject:hi')).toEqual([
      { kind: 'address', field: 'from', value: 'a@b', negated: true },
      { kind: 'label', scope: 'label', name: 'Work', negated: true },
      { kind: 'flag', flag: 'unread', negated: true },
      text('hi', { column: 'subject', negated: true }),
    ]);
  });

  it('reads unknown operators and bad values as plain text', () => {
    expect(terms('foo:bar is:archived has:link')).toEqual([
      text('foo:bar'),
      text('is:archived'),
      text('has:link'),
    ]);
    expect(terms('before:2024-02-30 after:24-01-01 after:2024-1-1 larger:5G smaller:-1')).toEqual([
      text('before:2024-02-30'),
      text('after:24-01-01'),
      text('after:2024-1-1', { exact: true }),
      text('larger:5G'),
      text('smaller:-1', { exact: true }),
    ]);
    expect(terms('from: subject:')).toEqual([text('from:'), text('subject:')]);
    expect(terms('is:"un read"')).toEqual([text('is:un read')]);
  });

  it('drops terms with no word and keeps full-text syntax as text', () => {
    expect(terms('--- !!! " " * ( ) ^')).toEqual([]);
    expect(terms('NEAR(a b) OR AND NOT a* {subject}:x col:y "a" + "b"')).toEqual([
      text('NEAR(a', { exact: true }),
      text('b)', { exact: true }),
      text('OR'),
      text('AND'),
      text('NOT'),
      text('a*', { exact: true }),
      text('{subject}:x', { exact: true }),
      text('col:y', { exact: true }),
      text('a', { exact: true }),
      text('b', { exact: true }),
    ]);
    expect(terms("'; DROP TABLE messages; --")).toEqual([
      text('DROP'),
      text('TABLE'),
      text('messages;'),
    ]);
  });

  it('runs an unclosed quote to the end', () => {
    expect(terms('subject:"half open')).toEqual([
      text('half open', { column: 'subject', exact: true }),
    ]);
    expect(terms('x "y z')).toEqual([text('x', { exact: true }), text('y z', { exact: true })]);
  });

  it(`keeps at most ${MAX_TERMS} terms and operators`, () => {
    const many = Array.from({ length: 40 }, (_, i) => (i % 2 ? `w${i}` : 'is:unread')).join(' ');
    const parsed = parseQuery(many);
    expect(parsed.terms).toHaveLength(MAX_TERMS);
    expect(parsed.ignored).toBe(8);
  });

  it('reads at most the length limit and never splits a surrogate pair', () => {
    expect(cleanQuery('x'.repeat(5000))).toHaveLength(MAX_QUERY_LENGTH);
    const pair = `${'x'.repeat(MAX_QUERY_LENGTH - 1)}😀`;
    expect(cleanQuery(pair)).toBe('x'.repeat(MAX_QUERY_LENGTH - 1));
  });

  it('turns control characters, unpaired surrogates and mark characters into spaces', () => {
    expect(cleanQuery('a\u0000b\u001fc\u007fd\u0085e\ue000f\ue001g')).toBe('a b c d e f g');
    expect(cleanQuery('x\ud800y\udc00z😀')).toBe('x y z😀');
    expect(terms('caf\u0000e')).toEqual([text('caf'), text('e', { exact: true })]);
  });
});

describe('operator values', () => {
  it('reads a real local day only', () => {
    const day = localDay('2024-03-10');
    expect(day).toBe(new Date(2024, 2, 10).getTime() / 1000);
    expect(localDay('0099-01-01')).toBe(new Date('0099-01-01T00:00:00').getTime() / 1000);
    for (const bad of ['2023-02-29', '2024-13-01', '2024-00-10', '2024-01-32', '2024-1-01', 'x']) {
      expect(localDay(bad), bad).toBeNull();
    }
  });

  it('reads sizes with K or M', () => {
    expect(sizeOf('0')).toBe(0);
    expect(sizeOf('3k')).toBe(3072);
    expect(sizeOf('1M')).toBe(1048576);
    for (const bad of ['', '1.5M', '1KB', '-1', '1e3', '9999999999'])
      expect(sizeOf(bad)).toBeNull();
  });
});
