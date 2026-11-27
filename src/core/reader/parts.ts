// SPDX-License-Identifier: AGPL-3.0-or-later
// The parts of a message as the reader's splitter finds them, and how a
// `cid:` reference in an HTML part finds the part it names.
//
// Parts are numbered depth-first with dotted paths, containers included: the
// message itself is `1`, its first child `1.1`, that one's second child
// `1.1.2`. An attached message (message/rfc822) is one part, not split.
//
// A `cid:` reference made in an HTML part can name only a part in that HTML
// part's branch: the nearest multipart/related around it, or the whole
// message if there is none. Within that branch, a part behind a different
// alternative of a multipart/alternative is out of reach, whether that
// alternative holds the HTML part's siblings or not. Matching follows RFC
// 2392: the URL is percent-decoded (an invalid escape matches nothing),
// angle brackets are stripped, and case is ignored for compatibility. A
// reference that two or more parts in reach answer to names none of them.

import type { MimeNode } from '@zone-eu/mailsplit';

export interface PartRecord {
  /** Dotted path: `1` is the message, `1.2` its second child. */
  path: string;
  /** The parent's index in the tree, or -1 for the message. */
  parent: number;
  /** A container's subtype (`mixed`, `alternative`, `related`…), or null for a leaf. */
  multipart: string | null;
  /** The Content-Type's type and subtype, lower case, or '' when the header has none. */
  contentType: string;
  /** The Content-Disposition's type, lower case, or null. */
  disposition: string | null;
  /** The file name the part's headers give, or null. Mail data: never logged. */
  filename: string | null;
  /** The Content-ID, as matched (see contentIdKey), or null. */
  contentId: string | null;
}

/** What a `cid:` reference names: a part, or nothing, and why. */
export type CidTarget = { part: number } | { refused: 'missing' | 'ambiguous' };

/** The Content-ID header value as matched: angle brackets stripped, lower case. */
export function contentIdKey(value: string): string | null {
  let id = value.trim();
  if (id.startsWith('<') && id.endsWith('>')) id = id.slice(1, -1).trim();
  return id === '' ? null : id.toLowerCase();
}

/**
 * A `cid:` URL as matched: percent-decoded, angle brackets stripped, lower
 * case. Null if it is not a `cid:` URL or an escape in it is invalid.
 */
export function cidUrlKey(url: string): string | null {
  const raw = url.trim();
  if (!/^cid:/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.slice(4));
  } catch {
    return null;
  }
  return contentIdKey(decoded);
}

/** The parts of one message, in the order the splitter gives them. */
export class PartTree {
  readonly parts: PartRecord[] = [];
  private readonly indexOf = new Map<MimeNode, number>();
  private readonly childCount: number[] = [];
  private readonly byContentId = new Map<string, number[]>();
  /** What a reference resolved to, by HTML part and key: many references can share one. */
  private readonly resolved = new Map<string, CidTarget>();

  /** Records a part as it comes; returns its index. */
  add(node: MimeNode): number {
    const parent = node.parentNode ? (this.indexOf.get(node.parentNode) ?? -1) : -1;
    const parentRecord = this.parts[parent];
    let path = '1';
    if (parentRecord) {
      this.childCount[parent] = (this.childCount[parent] ?? 0) + 1;
      path = `${parentRecord.path}.${this.childCount[parent]}`;
    }
    const multipart = node.multipart ? String(node.multipart).toLowerCase() : null;
    const header = node.headers ? node.headers.getFirst('content-id') : '';
    const contentId = multipart === null ? contentIdKey(header) : null;
    const index = this.parts.length;
    this.parts.push({
      path,
      parent,
      multipart,
      contentType: typeof node.contentType === 'string' ? node.contentType.toLowerCase() : '',
      disposition: typeof node.disposition === 'string' ? node.disposition.toLowerCase() : null,
      filename: typeof node.filename === 'string' && node.filename !== '' ? node.filename : null,
      contentId,
    });
    this.childCount.push(0);
    this.indexOf.set(node, index);
    if (contentId !== null) {
      const list = this.byContentId.get(contentId);
      if (list) list.push(index);
      else this.byContentId.set(contentId, [index]);
    }
    return index;
  }

  /** The index of the part a MIME node was recorded as. */
  index(node: MimeNode): number | undefined {
    return this.indexOf.get(node);
  }

  /** The part a `cid:` reference made in the HTML part `from` names. */
  resolve(from: number, url: string): CidTarget {
    const key = cidUrlKey(url);
    const named = key === null ? undefined : this.byContentId.get(key);
    if (!named) return { refused: 'missing' };
    const cacheKey = `${from} ${key}`;
    const known = this.resolved.get(cacheKey);
    if (known) return known;
    const target = this.find(from, named);
    this.resolved.set(cacheKey, target);
    return target;
  }

  /** Which of the parts `named` an HTML part can reach. */
  private find(from: number, named: readonly number[]): CidTarget {
    // The HTML part's ancestors, itself first, up to its branch's top.
    const line = new Set<number>();
    for (let at = from; at >= 0; at = this.parts[at]?.parent ?? -1) {
      line.add(at);
      if (at !== from && this.parts[at]?.multipart === 'related') break;
    }
    const inReach = named.filter((part) => this.reaches(line, part));
    if (inReach.length === 0) return { refused: 'missing' };
    if (inReach.length > 1) return { refused: 'ambiguous' };
    return { part: inReach[0] as number };
  }

  /**
   * Whether `part` is in the branch `line` describes, with no alternative
   * between it and the HTML part: it meets the line at a part that isn't a
   * multipart/alternative, and passes none on its way there.
   */
  private reaches(line: ReadonlySet<number>, part: number): boolean {
    let at = part;
    while (!line.has(at)) {
      const record = this.parts[at];
      if (!record || record.parent < 0) return false;
      at = record.parent;
      if (!line.has(at) && this.parts[at]?.multipart === 'alternative') return false;
    }
    return at === part || this.parts[at]?.multipart !== 'alternative';
  }
}
