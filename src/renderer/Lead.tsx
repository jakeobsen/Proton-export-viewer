// SPDX-License-Identifier: AGPL-3.0-or-later
// A snippet or a lead line, as text: a snippet's marked spans are <mark>
// elements, and nothing in either is markup. The element around it isolates
// it, so nothing in mail text can reorder the row it is in.

import type { MarkedSnippet } from '../shared/index-types';
import type { LeadLine } from './leads';
import { cleanParts, snippetParts } from './search';

export function Snippet({ snippet }: { snippet: MarkedSnippet }) {
  return (
    <>
      {cleanParts(snippetParts(snippet)).map((part, i) =>
        part.mark ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

/** A message's line: its snippet if it has one, else its lead text; nothing until it is read. */
export function LeadText({ line }: { line: LeadLine | undefined }) {
  if (!line) return null;
  if (line.snippet) return <Snippet snippet={line.snippet} />;
  return line.text === null ? null : <>{line.text}</>;
}
