// SPDX-License-Identifier: AGPL-3.0-or-later
// Link ids and what the link dialog shows for one. A body's links point at
// `mail-asset://v/<token>/l<n>`; only the window that holds that live view, at
// the current generation, can turn one into the URL it stands for.

import { domainToASCII } from 'node:url';
import type { LinkPrompt } from '../shared/api';
import { ASSET_SCHEME, LINK_SCHEMES, VIEW_HOST } from '../shared/constants';
import type { ViewLink, ViewRegistry } from './views';

const LINK_PATH_RE = /^\/([0-9a-f]{32})\/(l[1-9]\d{0,3})$/;

/** The longest title the dialog shows, in characters. */
export const MAX_TITLE = 1000;

/** Why a URL opens no link dialog. */
export type LinkRefusal = 'not_link' | 'unknown_token' | 'unknown_link' | 'generation' | 'scheme';

export type LinkLookup =
  | { ok: true; token: string; generation: number; link: ViewLink }
  | { ok: false; reason: LinkRefusal };

/** The scheme of a URL that may be opened outside the app, or null. */
export function linkScheme(url: string): string | null {
  try {
    const protocol = new URL(url).protocol;
    return LINK_SCHEMES.includes(protocol) ? protocol : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a link id URL against one window's views: the id must belong to
 * that window's live view, the view must be of the current generation, and
 * the URL behind it must have a link scheme.
 */
export function resolveLink(url: string, views: ViewRegistry, generation: number): LinkLookup {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'not_link' };
  }
  const match =
    parsed.protocol === `${ASSET_SCHEME}:` &&
    parsed.host === VIEW_HOST &&
    parsed.search === '' &&
    parsed.hash === ''
      ? LINK_PATH_RE.exec(parsed.pathname)
      : null;
  if (!match?.[1] || !match[2]) return { ok: false, reason: 'not_link' };
  const view = views.lookup(match[1]);
  if (!view) return { ok: false, reason: 'unknown_token' };
  if (view.generation !== generation) return { ok: false, reason: 'generation' };
  const link = view.links.get(match[2]);
  if (!link) return { ok: false, reason: 'unknown_link' };
  if (!linkScheme(link.url)) return { ok: false, reason: 'scheme' };
  return { ok: true, token: view.token, generation: view.generation, link };
}

// Invisible characters, bidirectional controls among them, could make a title
// read differently from what it holds, or split a host name it shows whole.
const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
const DOTS_RE = /[。．｡]/g;
// Anything but printable ASCII.
const UNUSUAL_RE = /[^ -~]/;
// A run of characters that can be part of a host name.
const TOKEN_RE = /[\p{L}\p{N}\p{M}.。．｡-]+/gu;
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}\\p{M}-]{0,61}[\\p{L}\\p{N}\\p{M}])?';
// A dotted name whose last label is a word or a punycode label: never a plain word.
const HOST_NAME_RE = new RegExp(
  `^(?:${LABEL}\\.)+(?:\\p{L}[\\p{L}\\p{M}]{1,62}|xn--[a-z0-9-]{1,59})$`,
  'iu',
);
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The title as the dialog shows it. */
export function displayTitle(text: string): string {
  const clean = text.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_TITLE ? clean : `${clean.slice(0, MAX_TITLE - 1)}…`;
}

/** A host name in ASCII form: lower case, punycode for non-ASCII labels, no final dot. */
export function asciiHost(host: string): string {
  const name = host.normalize('NFC').toLowerCase().replace(DOTS_RE, '.').replace(/\.$/, '');
  return domainToASCII(name) || name;
}

/** True when a host has characters other than printable ASCII, or a punycode label. */
export function isLookalike(host: string): boolean {
  if (UNUSUAL_RE.test(host)) return true;
  return host
    .toLowerCase()
    .split('.')
    .some((label) => label.startsWith('xn--'));
}

/**
 * The host names a text holds, in ASCII form. Plain words hold none. The text
 * is read in its compatibility form without invisible characters, so a dot
 * leader or a full-width letter counts as the character it looks like.
 */
export function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  const folded = text.replace(INVISIBLE_RE, '').normalize('NFKC').replace(INVISIBLE_RE, '');
  for (const [token] of folded.matchAll(TOKEN_RE)) {
    const name = token.replace(DOTS_RE, '.').replace(/^[.-]+|[.-]+$/g, '');
    if (IPV4_RE.test(name) || HOST_NAME_RE.test(name)) hosts.add(asciiHost(name));
  }
  return [...hosts];
}

const bare = (host: string) => (host.startsWith('www.') ? host.slice(4) : host);

/** True when a text names the target's host itself; a leading `www.` is ignored on both. */
export function sameHost(named: string, target: string): boolean {
  return bare(named) === bare(target);
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

interface Target {
  /** The URL as the dialog shows it. */
  shown: string;
  /**
   * The hosts the link goes to, in ASCII form: one for a web link, one per
   * recipient for a `mailto:` link. Null for a recipient with no plain host.
   */
  hosts: Array<string | null>;
  /** Where the first host is in the shown URL. */
  span: { start: number; end: number } | null;
  lookalike: boolean;
  /** A `mailto:` recipient whose address can't be read one way only. */
  unclear: boolean;
}

function webTarget(url: URL): Target {
  const href = url.href;
  const user = url.username
    ? url.username.length + (url.password ? url.password.length + 1 : 0) + 1
    : 0;
  const start = url.protocol.length + 2 + user;
  const end = start + url.hostname.length;
  return {
    shown: href,
    hosts: [asciiHost(url.hostname)],
    span: url.hostname && href.slice(start, end) === url.hostname ? { start, end } : null,
    lookalike: isLookalike(url.hostname),
    unclear: false,
  };
}

// A host name made only of letters, digits, hyphens and dots.
const LDH_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
// A name made only of characters that a host name's labels and dots can hold.
const HOST_CHARS_RE = /^[\p{L}\p{N}\p{M}.-]+$/u;
// The header fields of a `mailto:` URL that name recipients.
const RECIPIENT_FIELDS = new Set(['to', 'cc', 'bcc']);

/**
 * An address domain in ASCII form, or null when it is not a plain host name:
 * one with a separator, a space or another character a host can't hold, or one
 * without an ASCII form made of letters, digits and hyphens. `name` is decoded.
 */
function mailDomain(name: string): string | null {
  if (!HOST_CHARS_RE.test(name)) return null;
  const ascii = asciiHost(name);
  return LDH_HOST_RE.test(ascii) ? ascii : null;
}

// RFC 5322 specials other than the list comma: text holding one may be a
// quoted local part, a display name, a comment or a group, which a mail app
// reads as another address than the plain one shown.
const SPECIALS_RE = /["<>()[\];:\\]/;

interface Recipient {
  /** The part before the domain, with its `@`, as written. */
  local: string;
  /** The domain as written. */
  domain: string;
  /** The domain in ASCII form, or null when the address is unclear. */
  host: string | null;
  lookalike: boolean;
  unclear: boolean;
}

/**
 * One address, as written, with `decode` giving the text each of its parts
 * stands for (its parts decoded once). It is unclear when it has no domain,
 * when its domain is not a plain host name, when its local part holds a comma,
 * another `@` or white space, or when `unclear` says so already: the path or
 * the field value it came from holds a special.
 */
function recipient(address: string, decode: (s: string) => string, unclear: boolean): Recipient {
  const at = address.lastIndexOf('@');
  const local = at < 0 ? address : address.slice(0, at);
  const domain = at < 0 ? '' : address.slice(at + 1);
  const localText = decode(local);
  const domainText = decode(domain);
  const ascii = domain === '' ? null : mailDomain(domainText);
  const odd = unclear || ascii === null || /[,@\s]/u.test(localText);
  return {
    local: at < 0 ? address : `${local}@`,
    domain,
    host: odd ? null : ascii,
    lookalike: isLookalike(domainText),
    unclear: odd,
  };
}

/**
 * The fields of a `mailto:` URL's query, each name and value decoded once. A
 * `+` stays a `+`: in a `mailto:` URL it is part of an address, never a space.
 * A field that can't be decoded keeps its value as written, marked.
 */
function mailFields(search: string): Array<{ name: string; value: string; bad: boolean }> {
  if (search.length <= 1) return [];
  return search
    .slice(1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? '' : pair.slice(eq + 1);
      try {
        return { name: decodeURIComponent(name), value: decodeURIComponent(value), bad: false };
      } catch {
        return { name: decoded(name), value, bad: true };
      }
    });
}

/**
 * A `mailto:` link's recipients: the addresses in its path, and those in its
 * `to`, `cc` and `bcc` fields. Each one is checked, so a look-alike domain or
 * an unclear address anywhere in the URL warns. A path or a field value that
 * holds a special anywhere makes every address in it unclear, as its commas
 * may then not separate addresses.
 */
function mailTarget(url: URL): Target {
  const path = url.pathname;
  const pathOdd = SPECIALS_RE.test(decoded(path));
  const inPath =
    path === '' ? [] : path.split(',').map((address) => recipient(address, decoded, pathOdd));
  const inFields: Recipient[] = [];
  for (const { name, value, bad } of mailFields(url.search)) {
    if (!RECIPIENT_FIELDS.has(name.toLowerCase())) continue;
    const odd = bad || SPECIALS_RE.test(value);
    for (const address of value.split(',')) {
      const trimmed = address.trim();
      if (trimmed !== '') inFields.push(recipient(trimmed, (s) => s, odd));
    }
  }
  // A percent-encoded domain shows in its ASCII form; any other shows as it
  // is in the URL.
  const shownDomain = (a: Recipient) =>
    a.host !== null && a.domain.includes('%') ? a.host : a.domain;
  const shown = `${url.protocol}${inPath.map((a) => a.local + shownDomain(a)).join(',')}${url.search}${url.hash}`;
  const all = [...inPath, ...inFields];
  const first = inPath[0];
  let span: Target['span'] = null;
  if (first && first.host !== null) {
    const start = url.protocol.length + first.local.length;
    const end = start + shownDomain(first).length;
    // A domain without an ASCII form is not marked.
    if (shown.slice(start, end) === shownDomain(first)) span = { start, end };
  }
  return {
    shown,
    hosts: all.map((a) => a.host),
    span,
    lookalike: all.some((a) => a.lookalike),
    unclear: all.some((a) => a.unclear),
  };
}

/**
 * What the dialog shows for a link: the URL with its hosts in punycode, also
 * an address's domain in a `mailto:` URL, and the warnings that apply. Main
 * keeps the URL it acts on.
 */
export function linkPrompt(dialogId: string, link: ViewLink): LinkPrompt {
  const title = displayTitle(link.text);
  let url: URL | null;
  try {
    url = new URL(link.url);
  } catch {
    url = null;
  }
  const mail = url?.protocol === 'mailto:';
  const target: Target = !url
    ? { shown: link.url, hosts: [null], span: null, lookalike: false, unclear: false }
    : mail
      ? mailTarget(url)
      : webTarget(url);
  // A host the title names must be the host of the link, and of every
  // recipient of a mail link; a recipient with no plain host never matches.
  const named = hostsIn(title);
  const differs = (host: string) =>
    target.hosts.length === 0 || target.hosts.some((h) => h === null || !sameHost(host, h));
  return {
    dialogId,
    title,
    url: target.shown,
    host: target.span,
    mismatch: named.some(differs),
    lookalike: target.lookalike,
    mail,
    unclear: target.unclear,
  };
}
