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
// - `cid:` references become `<assetBase>/c<n>`, one id per distinct cid;
// - any other URL is removed, `data:` images included.
// All CSS is removed as well.

import createDOMPurify, { type Config, type UponSanitizeAttributeHookEvent } from 'dompurify';
import { JSDOM } from 'jsdom';
import type { BodyLink } from '../../shared/reader-protocol';
import { MAX_LINKS, MAX_URL_LENGTH, linkUrl } from './plain';

/** The longest link text kept for the link dialog, in characters. */
export const MAX_LINK_TEXT = 1000;
/** The most remote or cid references one body gets; further ones are removed. */
export const MAX_REFERENCES = 5000;

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
  'style',
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
  'style',
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
  /** How many distinct `cid:` references became `c<n>`. */
  cids: number;
}

/** The per-body state the hooks write to. */
class References {
  readonly links: BodyLink[] = [];
  readonly linkNodes: Array<[Element, number]> = [];
  private readonly remote = new Map<string, string>();
  private readonly cids = new Map<string, string>();

  constructor(private readonly base: string) {}

  get remoteCount(): number {
    return this.remote.size;
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

  /** The id URL an image or media reference gets, or null if it goes. */
  resource(value: string): string | null {
    const raw = value.trim();
    if (raw.length > MAX_URL_LENGTH) return null;
    if (/^cid:/i.test(raw)) {
      const cid = raw.slice(4).trim().toLowerCase();
      if (cid === '') return null;
      return this.idFor(this.cids, cid, 'c');
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return null;
    return this.idFor(this.remote, url.href, 'r');
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

  private idFor(map: Map<string, string>, key: string, prefix: string): string | null {
    let id = map.get(key);
    if (id === undefined) {
      if (map.size >= MAX_REFERENCES) return null;
      id = `${prefix}${map.size + 1}`;
      map.set(key, id);
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

/** Sanitizes an HTML body for the view whose asset URLs start with `assetBase`. */
export function sanitizeHtml(html: string, assetBase: string): SanitizedBody {
  const purify = instance();
  const refs = new References(assetBase);
  current = refs;
  let root: Node;
  try {
    root = purify.sanitize(html, CONFIG) as unknown as Node;
  } finally {
    current = null;
  }
  for (const [node, index] of refs.linkNodes) {
    const link = refs.links[index];
    if (link) link.text = linkText(node);
  }
  const outer = (root as Element).outerHTML ?? '';
  return {
    html: `<!doctype html>${outer}`,
    links: refs.links,
    remote: refs.remoteCount,
    cids: refs.cidCount,
  };
}
