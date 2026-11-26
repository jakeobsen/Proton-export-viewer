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
  /** The host the link goes to, in ASCII form, or null if it has none. */
  host: string | null;
  /** Where that host is in the shown URL. */
  span: { start: number; end: number } | null;
  lookalike: boolean;
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
    host: asciiHost(url.hostname),
    span: url.hostname && href.slice(start, end) === url.hostname ? { start, end } : null,
    lookalike: isLookalike(url.hostname),
  };
}

// A host name made only of letters, digits, hyphens and dots.
const LDH_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
// A name made only of characters that a host name's labels and dots can hold.
const HOST_CHARS_RE = /^[\p{L}\p{N}\p{M}.-]+$/u;

/**
 * An address domain in ASCII form, or null when its decoded form is not a
 * plain host name: one with a separator, a space or another character a host
 * can't hold, or one without an ASCII form made of letters, digits and hyphens.
 */
function mailDomain(domain: string): string | null {
  const name = decoded(domain);
  if (!HOST_CHARS_RE.test(name)) return null;
  const ascii = asciiHost(name);
  return LDH_HOST_RE.test(ascii) ? ascii : null;
}

function mailTarget(url: URL): Target {
  const addresses = url.pathname.split(',').map((address) => {
    const at = address.lastIndexOf('@');
    const domain = at < 0 ? '' : address.slice(at + 1);
    const ascii = domain === '' ? null : mailDomain(domain);
    return {
      local: at < 0 ? address : address.slice(0, at + 1),
      domain,
      ascii,
      // A percent-encoded domain shows in its ASCII form; one that has none
      // shows as it is in the URL.
      shown: ascii !== null && domain.includes('%') ? ascii : domain,
    };
  });
  const shown = `${url.protocol}${addresses.map((a) => a.local + a.shown).join(',')}${url.search}${url.hash}`;
  const lookalike = addresses.some((a) => isLookalike(decoded(a.domain)));
  const first = addresses[0];
  if (!first || first.domain === '') return { shown, host: null, span: null, lookalike };
  const start = url.protocol.length + first.local.length;
  const end = start + first.shown.length;
  return {
    shown,
    // A domain without an ASCII form is not marked, and matches no host the
    // title names.
    host: first.ascii,
    span: first.ascii !== null && shown.slice(start, end) === first.shown ? { start, end } : null,
    lookalike,
  };
}

/**
 * What the dialog shows for a link: the URL with its hosts in punycode, also
 * an address's domain in a `mailto:` URL. Main keeps the URL it acts on.
 */
export function linkPrompt(dialogId: string, link: ViewLink): LinkPrompt {
  const title = displayTitle(link.text);
  let url: URL | null;
  try {
    url = new URL(link.url);
  } catch {
    url = null;
  }
  const target: Target = !url
    ? { shown: link.url, host: null, span: null, lookalike: false }
    : url.protocol === 'mailto:'
      ? mailTarget(url)
      : webTarget(url);
  const named = hostsIn(title);
  return {
    dialogId,
    title,
    url: target.shown,
    host: target.span,
    mismatch: named.some((host) => target.host === null || !sameHost(host, target.host)),
    lookalike: target.lookalike,
  };
}
