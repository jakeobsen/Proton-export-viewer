// SPDX-License-Identifier: AGPL-3.0-or-later
// The HTML to text step: text nodes in document order, a line break at each
// block element, and nothing from scripts, styles or the head. It streams, so
// it works on a part of any size.

import { Parser } from 'htmlparser2';

const SKIP_TAGS = new Set(['script', 'style', 'head', 'template', 'noscript', 'title']);
const BLOCK_TAGS = new Set([
  'p',
  'br',
  'div',
  'li',
  'tr',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'table',
  'ul',
  'ol',
  'hr',
  'section',
  'article',
]);

/** A streaming parser that passes the text of the HTML written to it to `add`. */
export function htmlTextParser(add: (text: string) => void): Parser {
  let skip = 0;
  return new Parser(
    {
      onopentagname(name) {
        if (SKIP_TAGS.has(name)) skip += 1;
        else if (BLOCK_TAGS.has(name)) add('\n');
      },
      onclosetag(name) {
        if (SKIP_TAGS.has(name)) skip = Math.max(0, skip - 1);
        else if (BLOCK_TAGS.has(name)) add('\n');
      },
      ontext(text) {
        if (skip === 0) add(text);
      },
    },
    { decodeEntities: true },
  );
}

/** The text of a whole HTML document. */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  const parser = htmlTextParser((text) => parts.push(text));
  parser.write(html);
  parser.end();
  return parts.join('');
}
