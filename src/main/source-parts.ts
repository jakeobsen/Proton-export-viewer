// SPDX-License-Identifier: AGPL-3.0-or-later
// The source view's tree as the shell gets it. A part's type and charset are
// mail data: the shell gets each only as a plain token of bounded length, or
// not at all, so nothing in them can hide or reorder text there.

import type { SourceNode } from '../shared/api';
import { isRisky } from '../shared/attachment-types';
import type { SourcePart } from '../shared/reader-protocol';

/** What the tree shows for a type that isn't a plain `type/subtype`. */
export const UNKNOWN_TYPE = 'unknown type';

const TOKEN = "[a-z0-9][a-z0-9!#$&^_.+'-]{0,62}";
const TYPE_RE = new RegExp(`^${TOKEN}/${TOKEN}$`);
const MAX_TYPE_CHARS = 80;
const CHARSET_RE = /^[a-z0-9][a-z0-9._:+-]{0,39}$/;

/** The type as the tree shows it: a lower-case `type/subtype` of at most 80 characters. */
export function displayType(contentType: string): string {
  const type = contentType.toLowerCase();
  return type.length <= MAX_TYPE_CHARS && TYPE_RE.test(type) ? type : UNKNOWN_TYPE;
}

/** The charset as the tree shows it: a lower-case token of at most 40 characters, or none. */
export function displayCharset(charset: string | null): string | null {
  if (charset === null) return null;
  const lower = charset.toLowerCase();
  return CHARSET_RE.test(lower) ? lower : null;
}

/** The tree for the shell, from the parts core read. */
export function sourceNodes(parts: readonly SourcePart[]): SourceNode[] {
  return parts.map((part) => ({
    path: part.path,
    parent: part.parent,
    type: displayType(part.contentType),
    charset: displayCharset(part.charset),
    name: part.name,
    inline: part.inline,
    size: part.size,
    cut: part.cut,
    risky: part.name !== '' && isRisky(part.name),
  }));
}
