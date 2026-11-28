// SPDX-License-Identifier: AGPL-3.0-or-later
// The fetcher's URL and address policy: http or https on port 80 or 443 with
// no user info; every candidate address normalized, then allowed only if it is
// global unicast and in no IANA special-purpose block.

import { describe, expect, it } from 'vitest';
import {
  IPV4_SPECIAL,
  IPV6_SPECIAL,
  checkAddress,
  checkAnswers,
  embeddedV4,
  formatIp,
  parseIp,
  parseTarget,
  type Ip,
} from '../../src/fetcher/address';

const ip = (text: string): Ip => {
  const parsed = parseIp(text);
  if (!parsed) throw new Error(`not an address: ${text}`);
  return parsed;
};

const refusedBy = (text: string) => {
  const result = checkAddress(text);
  return result.ok ? 'allowed' : result.block;
};

describe('URLs', () => {
  const target = (raw: string) => {
    const r = parseTarget(raw);
    return r.ok ? { host: r.target.host, port: r.target.port, secure: r.target.secure } : r.reason;
  };

  it('takes http and https on ports 80 and 443 only', () => {
    expect(target('http://example.com/a.png')).toEqual({
      host: 'example.com',
      port: 80,
      secure: false,
    });
    expect(target('https://example.com/a.png')).toEqual({
      host: 'example.com',
      port: 443,
      secure: true,
    });
    expect(target('https://example.com:80/')).toEqual({
      host: 'example.com',
      port: 80,
      secure: true,
    });
    expect(target('http://example.com:443/')).toEqual({
      host: 'example.com',
      port: 443,
      secure: false,
    });
    expect(target('https://example.com:8443/')).toBe('port');
    expect(target('http://example.com:81/')).toBe('port');
    expect(target('http://example.com:0/')).toBe('port');
  });

  it('refuses other schemes, user info and junk', () => {
    expect(target('ftp://example.com/a.png')).toBe('scheme');
    expect(target('file:///etc/hosts')).toBe('scheme');
    expect(target('data:image/png;base64,AA==')).toBe('scheme');
    expect(target('ws://example.com/')).toBe('scheme');
    expect(target('http://user@example.com/')).toBe('userinfo');
    expect(target('http://:pass@example.com/')).toBe('userinfo');
    expect(target('http://user:pass@example.com/')).toBe('userinfo');
    expect(target('not a url')).toBe('invalid');
    expect(target('http://[::1/')).toBe('invalid');
  });

  it('converts an international name to its ASCII form before resolving', () => {
    expect(target('https://bücher.example/a.png')).toMatchObject({ host: 'xn--bcher-kva.example' });
    expect(target('https://EXAMPLE.com/')).toMatchObject({ host: 'example.com' });
  });

  it('reads IPv4 in decimal, octal, hex and short forms as the same address', () => {
    for (const form of [
      '127.0.0.1',
      '2130706433',
      '0x7f000001',
      '017700000001',
      '0x7f.1',
      '127.1',
      '0177.0.0.01',
    ]) {
      const r = parseTarget(`http://${form}/`);
      expect(r.ok && r.target.literal && formatIp(r.target.literal)).toBe('127.0.0.1');
    }
    const r = parseTarget('http://[::ffff:7f00:1]/');
    expect(r.ok && r.target.host).toBe('::ffff:7f00:1');
    expect(r.ok && r.target.literal && formatIp(r.target.literal)).toBe('::ffff:7f00:1');
  });

  it('resolves a redirect against the URL that gave it', () => {
    const base = new URL('https://example.com/a/b.png');
    const r = parseTarget('../c.png?x=1', base);
    expect(r.ok && r.target.url.href).toBe('https://example.com/c.png?x=1');
    expect(parseTarget('//other.example:8080/x', base)).toEqual({ ok: false, reason: 'port' });
  });

  it('the test entry lets only its exact address and port through', () => {
    const allow = { address: '127.0.0.1', port: 41234 };
    expect(parseTarget('http://127.0.0.1:41234/x', undefined, allow).ok).toBe(true);
    expect(parseTarget('https://127.0.0.1:41234/x', undefined, allow).ok).toBe(true);
    expect(parseTarget('http://127.0.0.1:41235/x', undefined, allow)).toEqual({
      ok: false,
      reason: 'port',
    });
    expect(parseTarget('http://127.0.0.2:41234/x', undefined, allow)).toEqual({
      ok: false,
      reason: 'port',
    });
    expect(parseTarget('http://[::1]:41234/x', undefined, allow)).toEqual({
      ok: false,
      reason: 'port',
    });
    // A name on the test port passes here; its addresses are checked once resolved.
    const named = parseTarget('http://localhost:41234/x', undefined, allow);
    expect(named.ok && named.target.testPort).toBe(true);
    expect(parseTarget('http://localhost:41234/x')).toEqual({ ok: false, reason: 'port' });
    const standard = parseTarget('http://localhost/x', undefined, allow);
    expect(standard.ok && standard.target.testPort).toBe(false);
  });
});

describe('address parsing', () => {
  it('reads and writes IPv6 in every form', () => {
    expect(formatIp(ip('2001:db8:0:0:0:0:0:1'))).toBe('2001:db8::1');
    expect(formatIp(ip('2001:DB8::1'))).toBe('2001:db8::1');
    expect(formatIp(ip('::'))).toBe('::');
    expect(formatIp(ip('::1'))).toBe('::1');
    expect(formatIp(ip('1::'))).toBe('1::');
    expect(formatIp(ip('::ffff:1.2.3.4'))).toBe('::ffff:102:304');
    expect(formatIp(ip('1:0:0:2:0:0:0:3'))).toBe('1:0:0:2::3');
    expect(formatIp(ip('1:2:3:4:5:6:7:8'))).toBe('1:2:3:4:5:6:7:8');
    expect(formatIp(ip('1:2:3:4:5:6:1.2.3.4'))).toBe('1:2:3:4:5:6:102:304');
  });

  it('refuses what isn’t one address', () => {
    for (const bad of [
      '',
      '1.2.3',
      '1.2.3.256',
      '01.2.3.4',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      '1::2::3',
      '12345::',
      'fe80::1%en0',
      '::1.2.3',
      'example.com',
    ]) {
      expect(parseIp(bad)).toBeNull();
      expect(checkAddress(bad)).toEqual({ ok: false, reason: 'address', block: 'unparsed' });
    }
  });
});

describe('normalization', () => {
  it('decodes the IPv4 address in each IPv6 form that carries one', () => {
    expect(embeddedV4(ip('::ffff:10.0.0.1'))).toEqual({ form: 'mapped', v4: [ip('10.0.0.1')] });
    expect(embeddedV4(ip('::8.8.8.8'))).toEqual({ form: 'compatible', v4: [ip('8.8.8.8')] });
    expect(embeddedV4(ip('64:ff9b::192.168.1.1'))).toEqual({
      form: 'nat64',
      v4: [ip('192.168.1.1')],
    });
    expect(embeddedV4(ip('2002:7f00:1::'))).toEqual({ form: '6to4', v4: [ip('127.0.0.1')] });
    // Teredo: server 65.54.227.120, client 192.0.2.45 stored inverted (3fff:fdd2).
    expect(embeddedV4(ip('2001:0:4136:e378:8000:63bf:3fff:fdd2'))).toEqual({
      form: 'teredo',
      v4: [ip('65.54.227.120'), ip('192.0.2.45')],
    });
    expect(embeddedV4(ip('::'))).toBeNull();
    expect(embeddedV4(ip('::1'))).toBeNull();
    expect(embeddedV4(ip('2606:4700::1'))).toBeNull();
    expect(embeddedV4(ip('8.8.8.8'))).toBeNull();
  });

  it('refuses every carrying form, and reports the IPv4 address inside', () => {
    for (const [text, form, inner] of [
      ['::ffff:8.8.8.8', 'mapped', '8.8.8.8'],
      ['::ffff:127.0.0.1', 'mapped', '127.0.0.1'],
      ['::8.8.8.8', 'compatible', '8.8.8.8'],
      ['64:ff9b::8.8.8.8', 'nat64', '8.8.8.8'],
      ['64:ff9b::10.1.2.3', 'nat64', '10.1.2.3'],
      ['2002:808:808::1', '6to4', '8.8.8.8'],
    ] as const) {
      const result = checkAddress(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.embedded).toEqual({ form, v4: [inner] });
    }
  });
});

describe('the registries', () => {
  /** The first and last address of a block, and the ones just outside it. */
  function edges(name: string, family: 4 | 6) {
    const [base, len] = name.split('/');
    const width = family === 4 ? 32n : 128n;
    const size = 1n << (width - BigInt(len!));
    const start = BigInt(ip(base!).value);
    const end = start + size - 1n;
    const max = (1n << width) - 1n;
    const at = (v: bigint): Ip | null =>
      v < 0n || v > max
        ? null
        : family === 4
          ? { family: 4, value: Number(v) }
          : { family: 6, value: v };
    return { first: at(start)!, last: at(end)!, before: at(start - 1n), after: at(end + 1n) };
  }

  /** Whether any listed block (or, for IPv6, being outside 2000::/3) refuses it. */
  function refusedAtAll(address: Ip): boolean {
    return !checkAddress(address).ok;
  }

  it.each(IPV4_SPECIAL.map((b) => b.name))('IPv4 %s is refused at both ends', (name) => {
    const { first, last } = edges(name, 4);
    expect(refusedAtAll(first)).toBe(true);
    expect(refusedAtAll(last)).toBe(true);
  });

  it.each(IPV6_SPECIAL.map((b) => b.name))('IPv6 %s is refused at both ends', (name) => {
    const { first, last } = edges(name, 6);
    expect(refusedAtAll(first)).toBe(true);
    expect(refusedAtAll(last)).toBe(true);
  });

  // Just outside each block: allowed, unless a neighbouring block (or IPv6's
  // 2000::/3 limit) covers it, which these expectations name.
  it('IPv4: the addresses just outside each block', () => {
    const outside: Record<string, [string, string]> = {};
    for (const b of IPV4_SPECIAL) {
      const { before, after } = edges(b.name, 4);
      outside[b.name] = [
        before ? refusedBy(formatIp(before)) : '-',
        after ? refusedBy(formatIp(after)) : '-',
      ];
    }
    expect(outside).toEqual({
      '0.0.0.0/8': ['-', 'allowed'],
      '0.0.0.0/32': ['-', '0.0.0.0/8'],
      '10.0.0.0/8': ['allowed', 'allowed'],
      '100.64.0.0/10': ['allowed', 'allowed'],
      '127.0.0.0/8': ['allowed', 'allowed'],
      '169.254.0.0/16': ['allowed', 'allowed'],
      '172.16.0.0/12': ['allowed', 'allowed'],
      '192.0.0.0/24': ['allowed', 'allowed'],
      '192.0.0.0/29': ['allowed', '192.0.0.0/24'],
      '192.0.0.8/32': ['192.0.0.0/24', '192.0.0.0/24'],
      '192.0.0.9/32': ['192.0.0.0/24', '192.0.0.0/24'],
      '192.0.0.10/32': ['192.0.0.0/24', '192.0.0.0/24'],
      '192.0.0.170/32': ['192.0.0.0/24', '192.0.0.0/24'],
      '192.0.0.171/32': ['192.0.0.0/24', '192.0.0.0/24'],
      '192.0.2.0/24': ['allowed', 'allowed'],
      '192.31.196.0/24': ['allowed', 'allowed'],
      '192.52.193.0/24': ['allowed', 'allowed'],
      '192.88.99.0/24': ['allowed', 'allowed'],
      '192.88.99.2/32': ['192.88.99.0/24', '192.88.99.0/24'],
      '192.168.0.0/16': ['allowed', 'allowed'],
      '192.175.48.0/24': ['allowed', 'allowed'],
      '198.18.0.0/15': ['allowed', 'allowed'],
      '198.51.100.0/24': ['allowed', 'allowed'],
      '203.0.113.0/24': ['allowed', 'allowed'],
      '240.0.0.0/4': ['224.0.0.0/4', '-'],
      '255.255.255.255/32': ['240.0.0.0/4', '-'],
      '224.0.0.0/4': ['allowed', '240.0.0.0/4'],
    });
  });

  it('IPv6: the addresses just outside each block', () => {
    const outside: Record<string, [string, string]> = {};
    for (const b of IPV6_SPECIAL) {
      const { before, after } = edges(b.name, 6);
      outside[b.name] = [
        before ? refusedBy(formatIp(before)) : '-',
        after ? refusedBy(formatIp(after)) : '-',
      ];
    }
    expect(outside).toEqual({
      '::1/128': ['::/128', 'not-unicast'],
      '::/128': ['-', '::1/128'],
      '::ffff:0:0/96': ['not-unicast', 'not-unicast'],
      '64:ff9b::/96': ['not-unicast', 'not-unicast'],
      '64:ff9b:1::/48': ['not-unicast', 'not-unicast'],
      '100::/64': ['not-unicast', '100:0:0:1::/64'],
      '100:0:0:1::/64': ['100::/64', 'not-unicast'],
      '2001::/23': ['allowed', 'allowed'],
      '2001::/32': ['allowed', '2001::/23'],
      '2001:1::1/128': ['2001::/23', '2001::/23'],
      '2001:1::2/128': ['2001::/23', '2001::/23'],
      '2001:1::3/128': ['2001::/23', '2001::/23'],
      '2001:2::/48': ['2001::/23', '2001::/23'],
      '2001:3::/32': ['2001::/23', '2001::/23'],
      '2001:4:112::/48': ['2001::/23', '2001::/23'],
      '2001:10::/28': ['2001::/23', '2001::/23'],
      '2001:20::/28': ['2001::/23', '2001::/23'],
      '2001:30::/28': ['2001::/23', '2001::/23'],
      '2001:db8::/32': ['allowed', 'allowed'],
      '2002::/16': ['allowed', 'allowed'],
      '2620:4f:8000::/48': ['allowed', 'allowed'],
      '3fff::/20': ['allowed', 'allowed'],
      '5f00::/16': ['not-unicast', 'not-unicast'],
      'fc00::/7': ['not-unicast', 'not-unicast'],
      'fe80::/10': ['not-unicast', 'not-unicast'],
    });
  });

  it('allows global unicast addresses and only those', () => {
    for (const good of ['8.8.8.8', '1.1.1.1', '93.184.215.14', '2606:4700::1111', '2a00:1450::1']) {
      expect(checkAddress(good)).toEqual({ ok: true, ip: ip(good) });
    }
    expect(refusedBy('1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe('not-unicast');
    expect(refusedBy('4000::')).toBe('not-unicast');
    expect(refusedBy('ff02::1')).toBe('not-unicast');
    expect(refusedBy('239.255.255.250')).toBe('224.0.0.0/4');
  });
});

describe('DNS answers', () => {
  it('a name passes only if every answer passes', () => {
    expect(checkAnswers([{ address: '8.8.8.8', family: 4 }])).toEqual({
      ok: true,
      ips: [ip('8.8.8.8')],
    });
    expect(
      checkAnswers([
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ]),
    ).toEqual({ ok: true, ips: [ip('8.8.8.8'), ip('2606:4700::1111')] });
    expect(
      checkAnswers([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).toEqual({ ok: false, reason: 'address' });
    expect(
      checkAnswers([
        { address: '::ffff:127.0.0.1', family: 6 },
        { address: '8.8.8.8', family: 4 },
      ]),
    ).toEqual({ ok: false, reason: 'address' });
  });

  it('refuses no answers, junk and a family that doesn’t match', () => {
    expect(checkAnswers([])).toEqual({ ok: false, reason: 'dns' });
    expect(checkAnswers([{ address: 'example.com', family: 4 }])).toEqual({
      ok: false,
      reason: 'address',
    });
    expect(checkAnswers([{ address: '8.8.8.8', family: 6 }])).toEqual({
      ok: false,
      reason: 'address',
    });
  });

  it('the test entry passes its own address only', () => {
    const entry = (i: Ip) => formatIp(i) === '127.0.0.1';
    expect(checkAnswers([{ address: '127.0.0.1', family: 4 }], entry).ok).toBe(true);
    expect(
      checkAnswers(
        [
          { address: '127.0.0.1', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
        entry,
      ),
    ).toEqual({ ok: false, reason: 'address' });
  });
});
