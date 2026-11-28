// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BODY_STATE } from '../../src/core/index/schema';
import { emlFile } from '../../src/core/index/queries';
import { matchInfo } from '../../src/core/index/search';
import { MAX_MARKS, plainBody } from '../../src/core/reader/plain';
import { asNumber, type Db } from '../../src/core/index/sql';
import { validRanges } from '../../src/core/search/ranges';
import type { IndexMatch } from '../../src/shared/index-types';
import { fresh, ingest, message } from '../index-helpers';

const rowidOf = (db: Db, protonId: string) =>
  asNumber(db.stmt('SELECT rowid FROM messages WHERE proton_id = ?').get(protonId)?.rowid);

/** Gives a message its body and state, as phase 2 would. */
function setBody(
  db: Db,
  protonId: string,
  body: string,
  state: number = BODY_STATE.indexed,
  error: string | null = null,
) {
  db.stmt('UPDATE message_text SET body = ? WHERE rowid = ?').run(body, rowidOf(db, protonId));
  db.stmt('UPDATE pairs SET body_state = ?, error_code = ? WHERE proton_id = ?').run(
    state,
    error,
    protonId,
  );
}

function setAttachments(db: Db, protonId: string, names: string[]) {
  db.stmt('UPDATE message_text SET attachments = ? WHERE rowid = ?').run(
    names.join('\n'),
    rowidOf(db, protonId),
  );
}

/** The marked words of a body match, as the ranges cut them from its text. */
function marked(match: IndexMatch | null): string[] {
  const body = match?.body;
  if (!body) return [];
  expect(validRanges(body.text, body.ranges)).toBe(true);
  return body.ranges.map(([s, e]) => body.text.slice(s, e));
}

function oneMessage(subject = 'Quarterly report', body = 'The invoice is attached.') {
  const { db, writer } = fresh();
  ingest(writer, [message('m1', ['k1'], { subject })], 10);
  setBody(db, 'm1', body);
  return { db, rowid: rowidOf(db, 'm1') };
}

describe('match info for the reader', () => {
  it('marks the body and lists the other columns that match, with the body only when it matched', () => {
    const { db, rowid } = oneMessage(
      'Invoice for March',
      'Please pay the invoice. Invoices are due.',
    );
    const match = matchInfo(db, rowid, 'invoice');
    expect(match).toMatchObject({ state: 1, reason: null, columns: ['subject'], changed: false });
    expect(marked(match)).toEqual(['invoice', 'Invoices']);
    expect(match!.bodyMatches).toBe(2);
    expect(match!.dropped).toBe(0);

    const subjectOnly = matchInfo(db, rowid, 'march');
    expect(subjectOnly).toMatchObject({ columns: ['subject'], bodyMatches: 0, body: null });
  });

  it('marks exact words, prefixes and phrases, and leaves negated words unmarked', () => {
    const { db, rowid } = oneMessage('Plans', 'red apple and green apples, not a pear');
    expect(marked(matchInfo(db, rowid, '"apple"'))).toEqual(['apple']);
    expect(marked(matchInfo(db, rowid, 'appl'))).toEqual(['apple', 'apples']);
    expect(marked(matchInfo(db, rowid, '"green apples"'))).toEqual(['green apples']);
    expect(marked(matchInfo(db, rowid, 'apple -banana'))).toEqual(['apple', 'apples']);
    // The negated word doesn't stop the match here, and isn't marked either.
    expect(marked(matchInfo(db, rowid, 'red -banana'))).toEqual(['red']);
  });

  it('marks only the column a filter names: subject: in the subject, filename: as attachments', () => {
    const { db, writer } = fresh();
    ingest(writer, [message('m1', ['k1'], { subject: 'Budget' })], 10);
    setBody(db, 'm1', 'The budget is final.');
    setAttachments(db, 'm1', ['budget-2024.pdf']);
    const rowid = rowidOf(db, 'm1');
    const bySubject = matchInfo(db, rowid, 'subject:budget');
    expect(bySubject).toMatchObject({ columns: ['subject'], bodyMatches: 0, body: null });
    const byName = matchInfo(db, rowid, 'filename:budget');
    expect(byName).toMatchObject({ columns: ['attachments'], bodyMatches: 0 });
    const plain = matchInfo(db, rowid, 'budget');
    expect(plain!.columns).toEqual(['subject', 'attachments']);
    expect(marked(plain)).toEqual(['budget']);
  });

  it('is null for a search with nothing to mark: filters only, or only negated words', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        message('m1', ['k1'], {
          subject: 'Hello',
          sender: { name: 'Alice Moreau', address: 'alice@example.com' },
        }),
      ],
      10,
    );
    setBody(db, 'm1', 'alice wrote this');
    const rowid = rowidOf(db, 'm1');
    expect(matchInfo(db, rowid, 'from:alice@example.com')).toBeNull();
    expect(matchInfo(db, rowid, '-zebra')).toBeNull();
    expect(matchInfo(db, rowid, 'has:attachment')).toBeNull();
    expect(matchInfo(db, rowid, 'is:unread -zebra')).toBeNull();
    // A name after from: is a word in the sender: it marks the sender, and not the body.
    expect(matchInfo(db, rowid, 'from:alice')).toMatchObject({
      columns: ['sender'],
      bodyMatches: 0,
      body: null,
    });
  });

  it("doesn't mark the words that only narrow an address match", () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        message('m1', ['k1'], {
          subject: 'Lunch',
          sender: { name: 'Alice', address: 'alice@example.com' },
        }),
      ],
      10,
    );
    setBody(db, 'm1', 'alice suggests lunch at noon');
    const match = matchInfo(db, rowidOf(db, 'm1'), 'from:alice@example.com lunch');
    expect(match!.columns).toEqual(['subject']);
    expect(marked(match)).toEqual(['lunch']);
  });

  it("is null for a message that doesn't match the whole search, while its neighbours do", () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        message('a', ['k1'], { subject: 'Re: plan', time: 1 }),
        message('b', ['k2', 'k1'], { subject: 'Re: plan', time: 2 }),
        message('c', ['k3', 'k1'], { subject: 'Re: plan', time: 3 }),
      ],
      10,
    );
    setBody(db, 'a', 'invoice attached');
    setBody(db, 'b', 'nothing to see');
    setBody(db, 'c', 'second invoice');
    expect(matchInfo(db, rowidOf(db, 'a'), 'invoice')).not.toBeNull();
    // Bound as a plain number, the rowid can be ignored next to the match: b would match then.
    expect(matchInfo(db, rowidOf(db, 'b'), 'invoice')).toBeNull();
    expect(matchInfo(db, rowidOf(db, 'c'), 'invoice')).not.toBeNull();
    // The marks come from this message's own row, not the first one that matches.
    expect(matchInfo(db, rowidOf(db, 'c'), 'invoice')!.body!.text).toBe('second invoice');
    expect(matchInfo(db, rowidOf(db, 'a'), 'invoice')!.body!.text).toBe('invoice attached');
    // Every term must match this message, not only one of them.
    expect(matchInfo(db, rowidOf(db, 'a'), 'invoice second')).toBeNull();
    expect(matchInfo(db, rowidOf(db, 'c'), 'invoice second')).not.toBeNull();
    // A filter the message fails makes it no match either.
    expect(matchInfo(db, rowidOf(db, 'a'), 'invoice is:unread')).toBeNull();
  });

  it('gives each state, with the reason for state 3, and a body only at states 1 and 2', () => {
    const { db, writer } = fresh();
    ingest(writer, [message('m1', ['k1'], { subject: 'Invoice' })], 10);
    const rowid = rowidOf(db, 'm1');
    const at = (state: number, error: string | null = null, body = 'invoice body') => {
      setBody(db, 'm1', body, state, error);
      return matchInfo(db, rowid, 'invoice')!;
    };
    expect(at(BODY_STATE.pending, null, '')).toMatchObject({ state: 0, reason: null, body: null });
    expect(at(BODY_STATE.indexed)).toMatchObject({ state: 1, reason: null, bodyMatches: 1 });
    expect(at(BODY_STATE.truncated)).toMatchObject({ state: 2, reason: null, bodyMatches: 1 });
    expect(at(BODY_STATE.failed, 'BODY_TIMEOUT', '')).toMatchObject({
      state: 3,
      reason: 'timeout',
      columns: ['subject'],
      body: null,
    });
    for (const code of ['BODY_FAILED', 'BODY_TOO_LARGE', 'FILE_EACCES']) {
      expect(at(BODY_STATE.failed, code, '')).toMatchObject({ state: 3, reason: 'unreadable' });
    }
    expect(at(BODY_STATE.emlMissing, null, '')).toMatchObject({
      state: 4,
      reason: null,
      body: null,
    });
    // A body left in the index at a state that has none isn't marked.
    expect(at(BODY_STATE.failed, 'BODY_FAILED', 'invoice body')).toMatchObject({
      bodyMatches: 0,
      body: null,
    });
  });

  it('comes in the same answer as the message file, from one snapshot', () => {
    const { db, rowid } = oneMessage('Invoice', 'invoice body');
    const file = emlFile(db, rowid);
    expect(file?.bodyState).toBe(BODY_STATE.indexed);
    expect(matchInfo(db, rowid, 'invoice')?.state).toBe(file?.bodyState);
  });

  it('keeps ranges right on astral characters, combining marks, RTL, CJK and folded diacritics', () => {
    const cases: Array<[string, string, string[]]> = [
      ['🙂 smile 😀 smile', 'smile', ['smile', 'smile']],
      ['emoji 👍🏽 then 𝒳yz and 𝒳yz', '𝒳yz', ['𝒳yz', '𝒳yz']],
      ['café au lait', 'cafe', ['café']],
      ['Crème Brûlée', 'creme brulee', ['Crème', 'Brûlée']],
      ['ÅNGSTRÖM unit', 'angstrom', ['ÅNGSTRÖM']],
      ['שלום עולם hello', 'עולם', ['עולם']],
      ['مرحبا بالعالم', 'مرحبا', ['مرحبا']],
      ['東京タワー 大阪', '東京タワー', ['東京タワー']],
    ];
    for (const [body, query, words] of cases) {
      const { db, rowid } = oneMessage('Note', body);
      const match = matchInfo(db, rowid, query);
      expect(marked(match), `${query} in ${body}`).toEqual(words);
    }
  });

  it(`counts every body match past the ${MAX_MARKS} marks drawn`, () => {
    const { db, rowid } = oneMessage('Note', 'th '.repeat(MAX_MARKS + 5));
    const match = matchInfo(db, rowid, 'th')!;
    expect(match.bodyMatches).toBe(MAX_MARKS + 5);
    expect(match.body!.ranges).toHaveLength(MAX_MARKS + 5);
    const { html } = plainBody(match.body!.text, 'mail-asset://v/x', match.body!.ranges);
    expect(html.split('<mark>').length - 1).toBe(MAX_MARKS);
  });

  it('drops marks that fail the check but still counts the column as matched', () => {
    // Mark characters written past the stripping, as an older index could hold them.
    const { db, rowid } = oneMessage('Invoice', 'an invoice \ue000 with a stray mark');
    db.stmt('UPDATE message_text SET subject = ? WHERE rowid = ?').run(
      'Invoice \ue001 here',
      rowid,
    );
    const match = matchInfo(db, rowid, 'invoice');
    expect(match).toMatchObject({ columns: ['subject'], bodyMatches: 0, body: null, dropped: 2 });
  });
});
