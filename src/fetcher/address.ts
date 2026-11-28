// SPDX-License-Identifier: AGPL-3.0-or-later
// Which URLs and addresses the remote-image fetcher may reach. Pure code: no
// I/O, so every rule is unit-tested on its own.
//
// A URL must be http or https, with no user name or password, on port 80 or
// 443. Its host is taken from the WHATWG URL parser, which has already
// converted an international name to its ASCII form and rewritten an IPv4
// address written in decimal, octal, hex or short form as four decimal parts.
//
// An address may be connected to only if it is global unicast and in no block
// of IANA's IPv4 or IPv6 special-purpose address registry, the blocks marked
// globally reachable included. IPv6 is limited to 2000::/3. An IPv6 address
// that carries an IPv4 address (mapped, compatible, NAT64, 6to4 and Teredo) is
// refused, and the IPv4 address inside is decoded and checked too.
//
// One known limit: on an IPv6-only network that reaches IPv4 hosts through
// NAT64 (64:ff9b::/96), names that resolve only to IPv4 can't be reached, so
// their images don't load.

/** The refusals this module gives. */
export type UrlRefusal = 'invalid' | 'scheme' | 'userinfo' | 'port' | 'address';

export const ALLOWED_PORTS: readonly number[] = [80, 443];

/** One parsed address: IPv4 as a 32-bit number, IPv6 as a 128-bit bigint. */
export type Ip = { family: 4; value: number } | { family: 6; value: bigint };

/** A URL the fetcher may request, once its addresses pass the address check. */
export interface Target {
  url: URL;
  secure: boolean;
  /** The host name as the URL parser gave it; for IPv6 without brackets. */
  host: string;
  port: number;
  /** The address, when the host is an IP literal; null for a name. */
  literal: Ip | null;
  /**
   * Builds with test hooks only: the port is the test entry's, not 80 or 443,
   * so the only address it may reach is the test entry's own.
   */
  testPort: boolean;
}

export interface TestAllow {
  address: string;
  port: number;
}

/**
 * Parses a URL the mail named, or a redirect's Location against the URL that
 * gave it. Refuses anything that isn't http or https, has a user name or
 * password, or names a port other than 80 or 443. `allow` (builds with test
 * hooks only) lets its own port through too, for its own address only: an IP
 * literal is checked here, a name once it is resolved.
 */
export function parseTarget(
  raw: string,
  base?: URL,
  allow?: TestAllow | null,
): { ok: true; target: Target } | { ok: false; reason: UrlRefusal } {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'userinfo' };
  const secure = url.protocol === 'https:';
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
  let host = url.hostname;
  let literal: Ip | null = null;
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
    literal = parseIp(host);
    if (literal === null) return { ok: false, reason: 'invalid' };
  } else if (IPV4_RE.test(host)) {
    literal = parseIp(host);
  }
  if (host === '') return { ok: false, reason: 'invalid' };
  const testPort = !ALLOWED_PORTS.includes(port);
  if (testPort) {
    const testEntry = __PEV_TEST_HOOKS__ && allow != null && allow.port === port;
    if (!testEntry) return { ok: false, reason: 'port' };
    if (literal !== null && !isTestAllowed(allow, formatIp(literal), port)) {
      return { ok: false, reason: 'port' };
    }
  }
  return { ok: true, target: { url, secure, host, port, literal, testPort } };
}

/** The test-hook entry matches only its exact address and port, in builds with test hooks. */
export function isTestAllowed(
  allow: TestAllow | null | undefined,
  address: string | null,
  port: number,
): boolean {
  if (!__PEV_TEST_HOOKS__ || !allow || address === null) return false;
  return allow.address === address && allow.port === port;
}

// --- Parsing --------------------------------------------------------------------

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/i;

function parseV4(text: string): number | null {
  if (!IPV4_RE.test(text)) return null;
  return text.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function parseV6(text: string): bigint | null {
  // A zone (fe80::1%en0) never names a global address.
  if (text.includes('%')) return null;
  let body = text;
  // An IPv4 tail ("::ffff:1.2.3.4") is the last two groups written in decimal.
  const lastColon = body.lastIndexOf(':');
  if (body.slice(lastColon + 1).includes('.')) {
    const tail = parseV4(body.slice(lastColon + 1));
    if (tail === null) return null;
    body = `${body.slice(0, lastColon + 1)}${(tail >>> 16).toString(16)}:${(tail & 0xffff).toString(16)}`;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const split = (s: string) => (s === '' ? [] : s.split(':'));
  let groups: string[];
  if (halves.length === 2) {
    const head = split(halves[0]!);
    const rest = split(halves[1]!);
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  } else {
    groups = split(body);
    if (groups.length !== 8) return null;
  }
  let value = 0n;
  for (const g of groups) {
    if (!HEX_GROUP_RE.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/** Parses an IPv4 address in four decimal parts, or an IPv6 address; null for anything else. */
export function parseIp(text: string): Ip | null {
  const v4 = parseV4(text);
  if (v4 !== null) return { family: 4, value: v4 };
  if (!text.includes(':')) return null;
  const v6 = parseV6(text);
  return v6 === null ? null : { family: 6, value: v6 };
}

/** The usual text form: four decimal parts, or IPv6 in its shortest form. */
export function formatIp(ip: Ip): string {
  if (ip.family === 4) return v4Text(ip.value);
  const groups: number[] = [];
  for (let i = 7; i >= 0; i -= 1) groups.push(Number((ip.value >> BigInt(i * 16)) & 0xffffn));
  // The longest run of two or more zero groups becomes "::".
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

function v4Text(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Two addresses are the same address, whatever their text form. */
export function sameIp(a: Ip, b: Ip): boolean {
  return a.family === b.family && a.value === b.value;
}

// --- The registries -------------------------------------------------------------

interface Block {
  /** The block as the registry writes it. */
  name: string;
  family: 4 | 6;
  base: bigint;
  bits: number;
}

function block(cidr: string): Block {
  const [addr, len] = cidr.split('/');
  const ip = parseIp(addr!);
  if (!ip) throw new Error('bad block');
  return { name: cidr, family: ip.family, base: BigInt(ip.value), bits: Number(len) };
}

/**
 * IANA IPv4 Special-Purpose Address Registry, as last updated 2025-10-09,
 * every entry. Multicast (224.0.0.0/4) isn't in the registry but isn't
 * unicast, so it is listed too.
 */
export const IPV4_SPECIAL: readonly Block[] = [
  '0.0.0.0/8',
  '0.0.0.0/32',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.0.0/29',
  '192.0.0.8/32',
  '192.0.0.9/32',
  '192.0.0.10/32',
  '192.0.0.170/32',
  '192.0.0.171/32',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.88.99.2/32',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '240.0.0.0/4',
  '255.255.255.255/32',
  // Not in the registry: multicast.
  '224.0.0.0/4',
].map(block);

/** IANA IPv6 Special-Purpose Address Registry, as last updated 2025-10-09, every entry. */
export const IPV6_SPECIAL: readonly Block[] = [
  '::1/128',
  '::/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '100:0:0:1::/64',
  '2001::/23',
  '2001::/32',
  '2001:1::1/128',
  '2001:1::2/128',
  '2001:1::3/128',
  '2001:2::/48',
  '2001:3::/32',
  '2001:4:112::/48',
  '2001:10::/28',
  '2001:20::/28',
  '2001:30::/28',
  '2001:db8::/32',
  '2002::/16',
  '2620:4f:8000::/48',
  '3fff::/20',
  '5f00::/16',
  'fc00::/7',
  'fe80::/10',
].map(block);

/** IPv6 global unicast. */
const GLOBAL_UNICAST_V6 = block('2000::/3');

function inBlock(ip: Ip, b: Block): boolean {
  if (ip.family !== b.family) return false;
  const width = ip.family === 4 ? 32 : 128;
  const shift = BigInt(width - b.bits);
  return BigInt(ip.value) >> shift === b.base >> shift;
}

// --- Normalization --------------------------------------------------------------

const V4_MAPPED = block('::ffff:0:0/96');
const V4_COMPATIBLE = block('::/96');
const NAT64 = block('64:ff9b::/96');
const SIX_TO_FOUR = block('2002::/16');
const TEREDO = block('2001::/32');

/** How an IPv6 address carries an IPv4 address, if it does. */
export type Embedding = 'mapped' | 'compatible' | 'nat64' | '6to4' | 'teredo';

/** The IPv4 addresses an IPv6 address carries, with the form it uses. */
export function embeddedV4(ip: Ip): { form: Embedding; v4: Ip[] } | null {
  if (ip.family !== 6) return null;
  const low32 = (v: bigint, shift: bigint) => Number((v >> shift) & 0xffffffffn);
  const v4 = (n: number): Ip => ({ family: 4, value: n >>> 0 });
  if (inBlock(ip, V4_MAPPED)) return { form: 'mapped', v4: [v4(low32(ip.value, 0n))] };
  // :: and ::1 have no IPv4 address in them.
  if (inBlock(ip, V4_COMPATIBLE) && ip.value > 1n) {
    return { form: 'compatible', v4: [v4(low32(ip.value, 0n))] };
  }
  if (inBlock(ip, NAT64)) return { form: 'nat64', v4: [v4(low32(ip.value, 0n))] };
  if (inBlock(ip, SIX_TO_FOUR)) return { form: '6to4', v4: [v4(low32(ip.value, 80n))] };
  if (inBlock(ip, TEREDO)) {
    // The server, then the client, whose bits are stored inverted.
    return {
      form: 'teredo',
      v4: [v4(low32(ip.value, 64n)), v4(~low32(ip.value, 0n))],
    };
  }
  return null;
}

export type AddressCheck =
  | { ok: true; ip: Ip }
  | {
      ok: false;
      reason: 'address';
      /** The first block that refused it, or "not-unicast" outside 2000::/3. */
      block: string;
      /** The IPv4 addresses decoded from it, when it carries any. */
      embedded?: { form: Embedding; v4: string[] };
    };

function specialBlock(ip: Ip): string | null {
  const list = ip.family === 4 ? IPV4_SPECIAL : IPV6_SPECIAL;
  for (const b of list) if (inBlock(ip, b)) return b.name;
  if (ip.family === 6 && !inBlock(ip, GLOBAL_UNICAST_V6)) return 'not-unicast';
  return null;
}

/** Checks one candidate address, given as text or parsed. */
export function checkAddress(candidate: string | Ip): AddressCheck {
  const ip = typeof candidate === 'string' ? parseIp(candidate) : candidate;
  if (ip === null) return { ok: false, reason: 'address', block: 'unparsed' };
  const carried = embeddedV4(ip);
  const embedded = carried
    ? { embedded: { form: carried.form, v4: carried.v4.map(formatIp) } }
    : {};
  const own = specialBlock(ip);
  if (own !== null) return { ok: false, reason: 'address', block: own, ...embedded };
  // Not reached today, since every carrying form lies in a refused block, but
  // the IPv4 address inside must pass on its own whatever the registry says.
  for (const inner of carried?.v4 ?? []) {
    const innerBlock = specialBlock(inner);
    if (innerBlock !== null)
      return { ok: false, reason: 'address', block: innerBlock, ...embedded };
  }
  return { ok: true, ip };
}

/**
 * Checks every address a name resolved to. One refused address refuses the
 * name: a mix of good and bad answers is how DNS rebinding starts.
 */
export function checkAnswers(
  answers: ReadonlyArray<{ address: string; family: number }>,
  /** Builds with test hooks only: the test entry's address passes too. */
  testEntry: (ip: Ip) => boolean = () => false,
): { ok: true; ips: Ip[] } | { ok: false; reason: 'address' | 'dns' } {
  if (answers.length === 0) return { ok: false, reason: 'dns' };
  const ips: Ip[] = [];
  for (const answer of answers) {
    const ip = parseIp(answer.address);
    if (ip === null || ip.family !== answer.family) return { ok: false, reason: 'address' };
    if (!testEntry(ip) && !checkAddress(ip).ok) return { ok: false, reason: 'address' };
    ips.push(ip);
  }
  return { ok: true, ips };
}
