// SPDX-License-Identifier: AGPL-3.0-or-later
// The HTML sanitizer: DOMPurify on jsdom, which runs no scripts and loads no
// resources. It is one layer, not the guarantee: the body's CSP, the frame
// sandbox and the request filter hold even if it fails.
//
// What happens to references:
// - links (`<a>` and `<area>` to http, https or mailto) get an opaque id for
//   the view, `<assetBase>/l<n>`; the URL and the link text go to `links`;
// - remote images and media (`src`, `srcset`, `background` and `poster` to
//   http or https) become `<assetBase>/r<n>`, one id per distinct URL;
// - `cid:` references become `<assetBase>/c<n>`. Given the message's inline
//   images, each id is one part the references name (or one reference that
//   names none), resolved in the HTML part the reference is in; without
//   them, one id per distinct cid;
// - a `data:` image in `<img src>`, given the inline images, stays if it
//   passes their checks, or becomes the placeholder;
// - any other URL is removed, `data:` images elsewhere included.
// Style sheets and style attributes keep the subset the CSS filter allows,
// with their image URLs rewritten the same way.
//
// A body made of several HTML parts is sanitized part by part, each as a
// document of its own, so that markup one part leaves open can't reach into
// the next; ids and limits are shared. The parts are then put together as
// the HTML parser puts joined parts together: each later part's content
// follows a line break in the first part's body.

import createDOMPurify, { type Config, type UponSanitizeAttributeHookEvent } from 'dompurify';
import { JSDOM } from 'jsdom';
import type { BodyLink } from '../../shared/reader-protocol';
import { filterStyleAttribute, filterStyleSheet, type UrlRewriter } from './css';
import type { CidTarget } from './parts';
import { MAX_LINKS, MAX_URL_LENGTH, linkUrl } from './plain';
import { MAX_BODY_REFERENCES, MAX_REMOTE_URL_LENGTH } from '../../shared/constants';

/** The longest link text kept for the link dialog, in characters. */
export const MAX_LINK_TEXT = 1000;
/** The most remote or cid references one body gets; further ones are removed. */
export const MAX_REFERENCES = MAX_BODY_REFERENCES;

/** Elements removed with everything in them. */
export const DROPPED_ELEMENTS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'param',
  'form',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'datalist',
  'output',
  'keygen',
  'meta',
  'base',
  'link',
  'svg',
  'math',
  'noscript',
  'noembed',
  'noframes',
  'template',
  'title',
  'plaintext',
  'xmp',
  'listing',
  'portal',
  'fencedframe',
] as const;

/** Attributes removed wherever they are; event handlers go as well. */
export const DROPPED_ATTRIBUTES = [
  'ping',
  'srcdoc',
  'formaction',
  'action',
  'manifest',
  'cite',
  'longdesc',
  'lowsrc',
  'dynsrc',
  'usemap',
  'profile',
  'codebase',
  'classid',
  'archive',
  'data',
  'icon',
  'itemtype',
  'itemid',
  'xmlns',
  'xlink:href',
  'http-equiv',
  'target',
  'rel',
  'referrerpolicy',
  'crossorigin',
  'integrity',
  'autofocus',
  'is',
] as const;

/** Attributes whose value is a remote image or media reference. */
const RESOURCE_ATTRIBUTES = new Set(['src', 'background', 'poster']);
const LINK_ELEMENTS = new Set(['a', 'area']);
const SRCSET_DESCRIPTOR_RE = /^(?:\d+(?:\.\d+)?x|\d+w)$/;

export interface SanitizedBody {
  /** The whole body document, with a doctype. */
  html: string;
  links: BodyLink[];
  /** How many distinct remote references became `r<n>`. */
  remote: number;
  /** What each `r<n>` names, `remoteRefs[n - 1]`: its absolute `http` or `https` URL. */
  remoteRefs: string[];
  /** How many distinct `cid:` references became `c<n>`. */
  cids: number;
  /** What each `c<n>` names, `cidTargets[n - 1]`, when inline images were given. */
  cidTargets: CidTarget[];
}

/** One HTML part of a body: its markup, and its index in the message's part tree. */
export interface HtmlSource {
  html: string;
  part: number;
}

/** The message's inline images, as the sanitizer asks about them. */
export interface ImageResolver {
  /** The part a `cid:` URL in the HTML part `from` names. */
  resolve(from: number, url: string): CidTarget;
  /** The `src` an `<img>` keeps for a `data:` URL, or null if it goes. */
  dataImage(value: string): string | null;
}

/** The per-body state the hooks write to. */
class References {
  readonly links: BodyLink[] = [];
  readonly linkNodes: Array<[Element, number]> = [];
  private readonly remote = new Map<string, string>();
  private readonly cids = new Map<string, string>();
  /** What each cid key names, when inline images are given. */
  private readonly targets = new Map<string, CidTarget>();
  /** Every id handed out, as its map and key, in order, so the latest can be taken back. */
  private readonly handed: Array<[Map<string, string>, string]> = [];
  /** The HTML part being sanitized. */
  scope = -1;

  constructor(
    private readonly base: string,
    readonly images: ImageResolver | null = null,
  ) {}

  get remoteCount(): number {
    return this.remote.size;
  }

  /** The remote URLs in id order: `r<n>`'s is at n - 1. */
  remoteRefs(): string[] {
    return [...this.remote.keys()];
  }

  get cidCount(): number {
    return this.cids.size;
  }

  /** The id URL a link gets, or null if it may not be a link. */
  link(node: Element, value: string): string | null {
    const url = linkUrl(value.trim());
    if (url === null || this.links.length >= MAX_LINKS) return null;
    const id = `l${this.links.length + 1}`;
    this.links.push({ id, url, text: '' });
    this.linkNodes.push([node, this.links.length - 1]);
    return `${this.base}/${id}`;
  }

  /** Which map and key an image or media reference has, or null if it goes. */
  private key(value: string): { map: Map<string, string>; key: string; prefix: string } | null {
    const raw = value.trim();
    if (raw.length > MAX_URL_LENGTH) return null;
    if (/^cid:/i.test(raw)) {
      const cid = raw.slice(4).trim().toLowerCase();
      if (cid === '') return null;
      if (!this.images) return { map: this.cids, key: cid, prefix: 'c' };
      const target = this.images.resolve(this.scope, raw);
      // A resolved reference is keyed by its part, so that every reference to
      // the part shares its id; one that resolves to nothing, by its URL.
      const key = 'part' in target ? `part:${target.part}` : `none:${cid}`;
      if (!this.targets.has(key)) this.targets.set(key, target);
      return { map: this.cids, key, prefix: 'c' };
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return null;
    // Percent-encoding can make the resolved URL longer than what was written.
    if (url.href.length > MAX_REMOTE_URL_LENGTH) return null;
    return { map: this.remote, key: url.href, prefix: 'r' };
  }

  /** What each `c<n>` names, in id order. */
  cidTargets(): CidTarget[] {
    const out: CidTarget[] = [];
    for (const key of this.cids.keys()) out.push(this.targets.get(key) ?? { refused: 'missing' });
    return out;
  }

  /** The id URL an image or media reference gets, or null if it goes. */
  resource(value: string): string | null {
    const found = this.key(value);
    return found === null ? null : this.idFor(found.map, found.key, found.prefix);
  }

  /** A `srcset` with each candidate's URL replaced, or null if none is left. */
  srcset(value: string): string | null {
    const kept: string[] = [];
    for (const { url, descriptor } of parseSrcset(value)) {
      const id = this.resource(url);
      if (id === null) continue;
      kept.push(SRCSET_DESCRIPTOR_RE.test(descriptor) ? `${id} ${descriptor}` : id);
    }
    return kept.length > 0 ? kept.join(', ') : null;
  }

  /** How many ids are handed out: a point `rollback` can go back to. */
  mark(): number {
    return this.handed.length;
  }

  /**
   * Takes back every id handed out since `mark`, latest first. Each map loses
   * only its latest entries, so its ids stay 1..size and are handed out again.
   */
  rollback(mark: number): void {
    while (this.handed.length > mark) {
      const [map, key] = this.handed.pop() as [Map<string, string>, string];
      map.delete(key);
    }
  }

  private idFor(map: Map<string, string>, key: string, prefix: string): string | null {
    let id = map.get(key);
    if (id === undefined) {
      if (map.size >= MAX_REFERENCES) return null;
      id = `${prefix}${map.size + 1}`;
      map.set(key, id);
      this.handed.push([map, key]);
    }
    return `${this.base}/${id}`;
  }
}

/** Splits a `srcset` value into candidates, as the HTML parsing rules do. */
export function parseSrcset(value: string): Array<{ url: string; descriptor: string }> {
  const out: Array<{ url: string; descriptor: string }> = [];
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (space(value[i]) || value[i] === ',')) i += 1;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !space(value[i])) i += 1;
    let url = value.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let depth = 0;
      const from = i;
      while (i < value.length) {
        const c = value[i];
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        else if (c === ',' && depth <= 0) break;
        i += 1;
      }
      descriptor = value.slice(from, i).trim();
      i += 1;
    }
    if (url !== '') out.push({ url, descriptor });
  }
  return out;
}

// The only URLs left in attributes are this view's ids; other values pass
// when they don't start with a scheme (the second part is DOMPurify's own).
// DOMPurify removes whitespace before it tests a value, so a rewritten srcset
// is checked by its first id.
const ALLOWED_VALUES =
  /^(?:mail-asset:\/\/v\/[0-9a-f]{32}\/[rcl]\d|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const CONFIG: Config = {
  WHOLE_DOCUMENT: true,
  RETURN_DOM: true,
  USE_PROFILES: { html: true },
  FORBID_TAGS: [...DROPPED_ELEMENTS],
  FORBID_ATTR: [...DROPPED_ATTRIBUTES],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOWED_URI_REGEXP: ALLOWED_VALUES,
  SANITIZE_DOM: true,
  KEEP_CONTENT: true,
};

type Purifier = ReturnType<typeof createDOMPurify>;

let purifier: Purifier | null = null;
let current: References | null = null;

function rewrite(node: Element, data: UponSanitizeAttributeHookEvent): void {
  const refs = current;
  if (!refs) return;
  const name = data.attrName;
  let next: string | null | undefined;
  if (name === 'href') {
    next = LINK_ELEMENTS.has(node.nodeName.toLowerCase()) ? refs.link(node, data.attrValue) : null;
  } else if (
    name === 'src' &&
    refs.images &&
    node.nodeName.toLowerCase() === 'img' &&
    /^[\t\n\f\r ]*data:/i.test(data.attrValue)
  ) {
    // The one place a data: image may stay.
    next = refs.images.dataImage(data.attrValue);
  } else if (RESOURCE_ATTRIBUTES.has(name)) {
    next = refs.resource(data.attrValue);
  } else if (name === 'srcset') {
    next = refs.srcset(data.attrValue);
  }
  if (next === undefined) return;
  if (next === null) data.keepAttr = false;
  else data.attrValue = next;
}

function instance(): Purifier {
  if (purifier) return purifier;
  // A window that never runs scripts or loads anything; DOMPurify parses
  // each body into a separate inert document of its own.
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const made = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
  made.addHook('uponSanitizeAttribute', (node, data) => rewrite(node as Element, data));
  made.addHook('afterSanitizeAttributes', (node) => {
    const element = node as Element;
    if (LINK_ELEMENTS.has(element.nodeName.toLowerCase()) && element.hasAttribute('href')) {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  });
  purifier = made;
  return made;
}

function linkText(node: Element): string {
  const raw =
    node.nodeName.toLowerCase() === 'area' ? (node.getAttribute('alt') ?? '') : node.textContent;
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= MAX_LINK_TEXT ? text : `${text.slice(0, MAX_LINK_TEXT - 1)}…`;
}

/**
 * Runs every style sheet and style attribute through the CSS filter; what is
 * left empty goes. The filter takes back the ids of the CSS it drops, so the
 * counts are of ids that are in the body.
 */
function filterCss(root: Element, refs: References): void {
  const urls: UrlRewriter = {
    rewrite: (url) => refs.resource(url),
    mark: () => refs.mark(),
    rollback: (mark) => refs.rollback(mark),
  };
  const safely = (filter: () => string): string => {
    try {
      return filter();
    } catch {
      return '';
    }
  };
  for (const style of [...root.querySelectorAll('style')]) {
    const css = safely(() => filterStyleSheet(style.textContent ?? '', urls));
    if (css === '') style.remove();
    else style.textContent = css;
  }
  for (const element of [...root.querySelectorAll('[style]')]) {
    const css = safely(() => filterStyleAttribute(element.getAttribute('style') ?? '', urls));
    if (css === '') element.removeAttribute('style');
    else element.setAttribute('style', css);
  }
}

/** Sanitizes one HTML part, as a document of its own, and filters its CSS. */
function sanitizePart(html: string, part: number, refs: References): Element {
  const purify = instance();
  refs.scope = part;
  current = refs;
  let root: Node;
  try {
    root = purify.sanitize(html, CONFIG) as unknown as Node;
  } finally {
    current = null;
  }
  filterCss(root as Element, refs);
  return root as Element;
}

/**
 * Puts later parts into the first part's document: after a line break, each
 * part's head and body content goes at the end of the first part's body, and
 * its `<html>` and `<body>` attributes are added where the first part's
 * elements lack them.
 */
function combine(roots: readonly Element[]): Element {
  const [first, ...rest] = roots as [Element, ...Element[]];
  const doc = first.ownerDocument;
  const body = doc.body;
  for (const root of rest) {
    const part = root.ownerDocument;
    body.append(doc.createElement('br'), doc.createTextNode('\n'));
    for (const [from, to] of [
      [part.documentElement, first],
      [part.body, body],
    ] as const) {
      for (const attr of Array.from(from?.attributes ?? [])) {
        if (!to.hasAttribute(attr.name)) to.setAttribute(attr.name, attr.value);
      }
    }
    body.append(
      ...Array.from(part.head?.childNodes ?? []),
      ...Array.from(part.body?.childNodes ?? []),
    );
  }
  return first;
}

/**
 * Sanitizes an HTML body for the view whose asset URLs start with
 * `assetBase`: one string, or the message's HTML parts. Given the message's
 * inline images, `cid:` references resolve in the part they are in, and
 * `data:` images in `<img src>` are checked.
 */
export function sanitizeHtml(
  html: string | readonly HtmlSource[],
  assetBase: string,
  images: ImageResolver | null = null,
): SanitizedBody {
  const refs = new References(assetBase, images);
  const sources = typeof html === 'string' ? [{ html, part: -1 }] : html;
  const roots = (sources.length > 0 ? sources : [{ html: '', part: -1 }]).map((source) =>
    sanitizePart(source.html, source.part, refs),
  );
  for (const [node, index] of refs.linkNodes) {
    const link = refs.links[index];
    if (link) link.text = linkText(node);
  }
  const outer = combine(roots).outerHTML ?? '';
  return {
    html: `<!doctype html>${outer}`,
    links: refs.links,
    remote: refs.remoteCount,
    remoteRefs: refs.remoteRefs(),
    cids: refs.cidCount,
    cidTargets: refs.cidTargets(),
  };
}
