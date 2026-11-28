// SPDX-License-Identifier: AGPL-3.0-or-later
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_MARKS, plainBody } from '../../src/core/reader/plain';
import { renderMessage } from '../../src/core/reader/render';
import type { StoredBody } from '../../src/shared/reader-protocol';

const BASE = 'mail-asset://v/0123456789abcdef0123456789abcdef';

/** The markup inside the body's <pre>. */
const inner = (html: string) => /<pre>([\s\S]*)<\/pre>/.exec(html)?.[1] ?? '';

/** Ranges of each occurrence of `word` in `text`. */
function rangesOf(text: string, word: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + word.length)) {
    out.push([i, i + word.length]);
  }
  return out;
}

describe('plain bodies with marks', () => {
  it('marks each range and escapes the text inside and outside the marks', () => {
    const text = 'a <b>&</b> invoice & "invoice"';
    const { html } = plainBody(text, BASE, rangesOf(text, 'invoice'));
    expect(inner(html)).toBe(
      'a &lt;b&gt;&amp;&lt;/b&gt; <mark>invoice</mark> &amp; &quot;<mark>invoice</mark>&quot;',
    );
    expect(html).toContain('mark{background:');
  });

  it('escapes markup inside a mark, so a match on "<b>" stays text', () => {
    const text = 'say <b>hi</b> now';
    const { html } = plainBody(text, BASE, [[4, 13]]);
    expect(inner(html)).toBe('say <mark>&lt;b&gt;hi&lt;/b&gt;</mark> now');
  });

  it('nests marks in links: a mark across a link start, a link end, and around a whole link', () => {
    const text = 'see example https://ex.test/invoice?a=1 here';
    const start = text.indexOf('https');
    const end = start + 'https://ex.test/invoice?a=1'.length;
    // Across the start: "example https".
    let { html, links } = plainBody(text, BASE, [[4, start + 5]]);
    expect(links.map((l) => l.url)).toEqual(['https://ex.test/invoice?a=1']);
    expect(inner(html)).toBe(
      `see <mark>example </mark><a href="${BASE}/l1" target="_blank" rel="noopener noreferrer"><mark>https</mark>://ex.test/invoice?a=1</a> here`,
    );
    // Inside the link: "invoice".
    const at = text.indexOf('invoice');
    ({ html } = plainBody(text, BASE, [[at, at + 7]]));
    expect(inner(html)).toContain('://ex.test/<mark>invoice</mark>?a=1</a>');
    // Across the end: "a=1 here".
    ({ html } = plainBody(text, BASE, [[end - 3, text.length]]));
    expect(inner(html)).toContain('?<mark>a=1</mark></a><mark> here</mark>');
    // Around the whole link.
    ({ html, links } = plainBody(text, BASE, [[start - 1, end + 1]]));
    expect(inner(html)).toBe(
      `see example<mark> </mark><a href="${BASE}/l1" target="_blank" rel="noopener noreferrer"><mark>https://ex.test/invoice?a=1</mark></a><mark> </mark>here`,
    );
    expect(links).toEqual([
      { id: 'l1', url: 'https://ex.test/invoice?a=1', text: 'https://ex.test/invoice?a=1' },
    ]);
  });

  it("finds the same links with marks as without, and marks don't change their ids or URLs", () => {
    const text = 'one https://a.test/x two mailto:b@c.test three http://d.test/invoice';
    const plain = plainBody(text, BASE);
    const withMarks = plainBody(
      text,
      BASE,
      rangesOf(text, 'invoice')
        .concat([[0, 3]])
        .sort((a, b) => a[0] - b[0]),
    );
    expect(withMarks.links).toEqual(plain.links);
  });

  it('keeps astral characters whole at mark edges', () => {
    const text = '𝒳yz 😀invoice😀';
    const at = text.indexOf('😀');
    const { html } = plainBody(text, BASE, [
      [0, 4],
      [at, at + 2 + 7],
    ]);
    expect(inner(html)).toBe('<mark>𝒳yz</mark> <mark>😀invoice</mark>😀');
  });

  it('is byte for byte the same as before when there are no ranges', () => {
    const text = 'plain <text> with https://ex.test/a and more';
    const before = plainBody(text, BASE);
    expect(plainBody(text, BASE, [])).toEqual(before);
    expect(before.html).not.toContain('mark');
  });

  it(`draws at most ${MAX_MARKS} marks and leaves the rest unmarked`, () => {
    const text = 'th '.repeat(MAX_MARKS + 5);
    const ranges = rangesOf(text, 'th');
    expect(ranges.length).toBe(MAX_MARKS + 5);
    const { html } = plainBody(text, BASE, ranges);
    expect(inner(html).split('<mark>').length - 1).toBe(MAX_MARKS);
    expect(inner(html).endsWith('th th th th th ')).toBe(true);
  });
});

/** A plain text message whose own text differs from the stored body, to tell them apart. */
const EML = [
  'From: a@example.com',
  'Subject: Note',
  'Content-Type: multipart/alternative; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Text from the file: invoice',
  '--b',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>HTML from the file: invoice</p>',
  '--b--',
  '',
].join('\r\n');

function render(mode: 'html' | 'plain', stored?: StoredBody, onMarksDropped?: (n: number) => void) {
  return renderMessage(Readable.from([Buffer.from(EML)]), {
    mode,
    assetBase: BASE,
    ...(stored ? { stored } : {}),
    ...(onMarksDropped ? { onMarksDropped } : {}),
  });
}

describe('the worker with a stored body', () => {
  const stored: StoredBody = { text: 'Stored text: invoice', ranges: [[13, 20]] };

  it('shows the stored body with its marks in the plain view', async () => {
    const message = await render('plain', stored);
    expect(message.format).toBe('plain');
    expect(message.highlighted).toBe(true);
    expect(inner(message.html)).toBe('Stored text: <mark>invoice</mark>');
    // How much was indexed is the match line's to say, not the cut line's.
    expect(message.cut).toBeNull();
  });

  it('leaves the HTML view unmarked', async () => {
    const message = await render('html', stored);
    expect(message.format).toBe('html');
    expect(message.highlighted).toBe(false);
    expect(message.html).not.toContain('<mark');
  });

  it('shows the file without marks, and says how many it dropped, when the ranges fail the check', async () => {
    const dropped: number[] = [];
    const bad = await render('plain', { text: stored.text, ranges: [[13, 99]] }, (n) =>
      dropped.push(n),
    );
    expect(bad.highlighted).toBe(false);
    expect(inner(bad.html)).toBe('Text from the file: invoice');
    expect(dropped).toEqual([1]);

    // Text whose line ends would change length is never marked either.
    const crlf = await render('plain', { text: 'a\r\ninvoice', ranges: [[3, 10]] }, (n) =>
      dropped.push(n),
    );
    expect(crlf.highlighted).toBe(false);
    expect(dropped).toEqual([1, 1]);
  });

  it('renders as before with no stored body', async () => {
    const message = await render('plain');
    expect(message.highlighted).toBe(false);
    expect(inner(message.html)).toBe('Text from the file: invoice');
  });
});
