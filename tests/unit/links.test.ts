// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  MAX_TITLE,
  displayTitle,
  hostsIn,
  isLookalike,
  linkPrompt,
  resolveLink,
  sameHost,
} from '../../src/main/links';
import { ViewRegistry } from '../../src/main/views';

const LINKS = [
  { id: 'l1', url: 'https://example.org/a', text: 'a page' },
  { id: 'l2', url: 'mailto:someone@example.org', text: 'mail' },
  { id: 'l3', url: 'javascript:alert(1)', text: 'poisoned' },
  { id: 'l4', url: 'data:text/html,x', text: 'poisoned' },
];

function registry(generation = 1): { views: ViewRegistry; token: string } {
  let n = 0;
  const views = new ViewRegistry(
    () => `${'ab'.repeat(15)}${(n += 1).toString(16).padStart(2, '0')}`,
  );
  const { openId, token } = views.accept();
  const outcome = views.install(openId, token, generation, generation, {
    html: '',
    assets: [],
    links: LINKS,
  });
  expect(outcome.ok).toBe(true);
  return { views, token };
}

const link = (token: string, id: string) => `mail-asset://v/${token}/${id}`;

describe('resolveLink', () => {
  it('resolves an id of the live view at the current generation', () => {
    const { views, token } = registry();
    expect(resolveLink(link(token, 'l1'), views, 1)).toEqual({
      ok: true,
      token,
      generation: 1,
      link: { url: 'https://example.org/a', text: 'a page' },
    });
    expect(resolveLink(link(token, 'l2'), views, 1)).toMatchObject({ ok: true });
  });

  it('refuses an id that is unknown, revoked, of another window or of an old generation', () => {
    const { views, token } = registry();
    expect(resolveLink(link(token, 'l9'), views, 1)).toEqual({ ok: false, reason: 'unknown_link' });
    expect(resolveLink(link('f'.repeat(32), 'l1'), views, 1)).toEqual({
      ok: false,
      reason: 'unknown_token',
    });
    expect(resolveLink(link(token, 'l1'), views, 2)).toEqual({ ok: false, reason: 'generation' });

    const other = registry();
    other.views.revokeAll();
    expect(resolveLink(link(token, 'l1'), other.views, 1)).toEqual({
      ok: false,
      reason: 'unknown_token',
    });

    views.accept();
    expect(resolveLink(link(token, 'l1'), views, 1)).toEqual({
      ok: false,
      reason: 'unknown_token',
    });
  });

  it('never offers a URL without a link scheme, even one in the view', () => {
    const { views, token } = registry();
    expect(resolveLink(link(token, 'l3'), views, 1)).toEqual({ ok: false, reason: 'scheme' });
    expect(resolveLink(link(token, 'l4'), views, 1)).toEqual({ ok: false, reason: 'scheme' });
  });

  it('takes only the exact link id form', () => {
    const { views, token } = registry();
    for (const url of [
      'https://example.org/a',
      'javascript:alert(1)',
      'data:text/html,x',
      `mail-body://v/${token}`,
      `mail-asset://v/${token}/r1`,
      `mail-asset://v/${token}/c1`,
      `mail-asset://v/${token}/l0`,
      `mail-asset://v/${token}/l01`,
      `mail-asset://v/${token}/l1?x`,
      `mail-asset://v/${token}/l1#x`,
      `mail-asset://v/${token}/l1/`,
      `mail-asset://w/${token}/l1`,
      `mail-asset://v/${token.toUpperCase()}/l1`,
      `mail-asset://v/${token}/L1`,
      'not a url',
    ]) {
      expect(resolveLink(url, views, 1), url).toEqual({ ok: false, reason: 'not_link' });
    }
  });
});

describe('hostsIn', () => {
  it('finds host names, never plain words', () => {
    expect(hostsIn('Click here to read more')).toEqual([]);
    expect(hostsIn('Version 1.2 and e.g. this')).toEqual([]);
    expect(hostsIn('Visit shop.example today.')).toEqual(['shop.example']);
    expect(hostsIn('https://Bank.Example/login')).toEqual(['bank.example']);
    expect(hostsIn('mail help@shop.example')).toEqual(['shop.example']);
    expect(hostsIn('at 192.0.2.7 now')).toEqual(['192.0.2.7']);
    expect(hostsIn('a.example and b.example')).toEqual(['a.example', 'b.example']);
  });

  it('gives non-ASCII names in punycode', () => {
    expect(hostsIn('аpple.test')).toEqual(['xn--pple-43d.test']);
    expect(hostsIn('bücher。example')).toEqual(['xn--bcher-kva.example']);
  });

  it('stays fast on long dotted text', () => {
    const start = Date.now();
    hostsIn(`${'a.'.repeat(4000)}1`);
    hostsIn('a'.repeat(8000));
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('sameHost and isLookalike', () => {
  it('matches only the same host, with a leading www ignored', () => {
    expect(sameHost('shop.example', 'shop.example')).toBe(true);
    expect(sameHost('www.shop.example', 'shop.example')).toBe(true);
    expect(sameHost('shop.example', 'www.shop.example')).toBe(true);
    expect(sameHost('shop.example', 'mail.shop.example')).toBe(false);
    expect(sameHost('mail.shop.example', 'shop.example')).toBe(false);
    expect(sameHost('shop.example', 'shop.example.evil.test')).toBe(false);
    expect(sameHost('shop.example', 'evilshop.example')).toBe(false);
    expect(sameHost('bank.example', 'evil.test')).toBe(false);
  });

  it('flags non-ASCII and punycode hosts', () => {
    expect(isLookalike('example.org')).toBe(false);
    expect(isLookalike('xn--pple-43d.test')).toBe(true);
    expect(isLookalike('sub.XN--P1AI')).toBe(true);
    expect(isLookalike('аpple.test')).toBe(true);
  });
});

describe('linkPrompt', () => {
  const prompt = (url: string, text: string) => linkPrompt('d'.repeat(32), { url, text });

  it('shows no warning for plain words or a matching host', () => {
    expect(prompt('https://shop.example/a', 'Your account')).toEqual({
      dialogId: 'd'.repeat(32),
      title: 'Your account',
      url: 'https://shop.example/a',
      host: { start: 8, end: 20 },
      mismatch: false,
      lookalike: false,
      mail: false,
      unclear: false,
    });
    expect(prompt('https://www.shop.example/a', 'shop.example')).toMatchObject({
      mismatch: false,
      lookalike: false,
    });
  });

  it('warns when the title names another host', () => {
    expect(prompt('https://evil.test/login', 'https://bank.example/login')).toMatchObject({
      mismatch: true,
      lookalike: false,
    });
    expect(prompt('https://evil.test/', 'evil.test or bank.example')).toMatchObject({
      mismatch: true,
    });
  });

  it('warns when the URL goes to a subdomain of the host the title names', () => {
    expect(prompt('https://evil.example.com/login', 'example.com')).toMatchObject({
      mismatch: true,
    });
    expect(prompt('https://login.bank.example/', 'https://www.bank.example/')).toMatchObject({
      mismatch: true,
    });
    expect(prompt('mailto:x@mail.shop.example', 'help@shop.example')).toMatchObject({
      mismatch: true,
    });
    expect(prompt('https://www.example.com/', 'example.com')).toMatchObject({ mismatch: false });
  });

  it('warns about a non-ASCII host and shows it in punycode', () => {
    const p = prompt(new URL('https://аpple.test/verify').href, 'Sign in');
    expect(p).toMatchObject({
      url: 'https://xn--pple-43d.test/verify',
      mismatch: false,
      lookalike: true,
    });
    expect(p.url.slice(p.host!.start, p.host!.end)).toBe('xn--pple-43d.test');
  });

  it('gives both warnings together', () => {
    expect(prompt('https://xn--pple-43d.test/', 'apple.test')).toMatchObject({
      mismatch: true,
      lookalike: true,
    });
  });

  it('does not warn when the title has the same non-ASCII host', () => {
    const url = new URL('https://аpple.test/x').href;
    expect(prompt(url, 'https://аpple.test/x')).toMatchObject({ mismatch: false, lookalike: true });
  });

  it('marks the real host after a user name', () => {
    const p = prompt('https://bank.example@evil.test/', 'bank.example');
    expect(p.url.slice(p.host!.start, p.host!.end)).toBe('evil.test');
    expect(p.mismatch).toBe(true);
  });

  it('marks IP hosts', () => {
    const v4 = prompt('http://192.0.2.7:8080/x', '192.0.2.7');
    expect(v4.url.slice(v4.host!.start, v4.host!.end)).toBe('192.0.2.7');
    expect(v4.mismatch).toBe(false);
    const v6 = prompt('http://[2001:db8::1]/x', 'a link');
    expect(v6.url.slice(v6.host!.start, v6.host!.end)).toBe('[2001:db8::1]');
  });

  it('checks mailto links against the address domain', () => {
    const ok = prompt('mailto:help@shop.example?subject=Hi', 'help@shop.example');
    expect(ok).toMatchObject({ mismatch: false, lookalike: false });
    expect(ok.url.slice(ok.host!.start, ok.host!.end)).toBe('shop.example');
    expect(prompt('mailto:x@evil.test', 'support@bank.example')).toMatchObject({ mismatch: true });
    expect(prompt(new URL('mailto:x@аpple.test').href, 'Write to us')).toMatchObject({
      mismatch: false,
      lookalike: true,
    });
    expect(prompt('mailto:a@shop.example,b@xn--pple-43d.test', 'Write')).toMatchObject({
      lookalike: true,
    });
    expect(prompt('mailto:nobody', 'shop.example')).toMatchObject({ host: null, mismatch: true });
  });

  it('shows mailto address domains in punycode and marks the first', () => {
    const idn = prompt(new URL('mailto:x@аpple.test').href, 'Write to us');
    expect(idn).toMatchObject({ url: 'mailto:x@xn--pple-43d.test', lookalike: true });
    expect(idn.url.slice(idn.host!.start, idn.host!.end)).toBe('xn--pple-43d.test');
    const first = prompt(new URL('mailto:%D0%B0@Exämple.test,b@аpple.test?subject=Hi#f').href, 'x');
    expect(first.url).toBe('mailto:%D0%B0@xn--exmple-cua.test,b@xn--pple-43d.test?subject=Hi#f');
    expect(first.url.slice(first.host!.start, first.host!.end)).toBe('xn--exmple-cua.test');
    expect(prompt('mailto:x@xn--pple-43d.test', 'аpple.test')).toMatchObject({ mismatch: false });
    const typed = prompt('mailto:x@Shop.Example', 'shop.example');
    expect(typed).toMatchObject({ url: 'mailto:x@Shop.Example', mismatch: false });
    expect(typed.url.slice(typed.host!.start, typed.host!.end)).toBe('Shop.Example');
  });

  it('keeps a mailto domain as it is, unmarked, when its decoded form is not a plain host name', () => {
    for (const url of [
      'mailto:a@ex%2Cample.test',
      'mailto:a@%E2%80%AEevil.test',
      'mailto:a@shop%E3%80%82example',
    ]) {
      expect(prompt(url, 'Write')).toMatchObject({ url, host: null, mismatch: false });
    }
  });

  it('shows a mailto domain with a separator in full, unmarked, and never matches it to the title', () => {
    const urls = [
      'mailto:a@paypal.com%2Fx.evil.test',
      'mailto:a@paypal.com%2Fevil',
      'mailto:a@paypal.com%3Fx',
      'mailto:a@paypal.com%23x',
      'mailto:a@paypal.com%3Fx.evil.test',
      'mailto:a@paypal.com%23.evil.test',
      'mailto:a@paypal.com%5Cevil.test',
      'mailto:a@paypal.com/evil.test',
      'mailto:a@p%D0%B0ypal.com%2Fevil.test',
      'mailto:a@paypal%E2%92%88com',
    ];
    for (const url of urls) {
      expect(prompt(url, 'paypal.com')).toMatchObject({ url, host: null, mismatch: true });
    }
    expect(prompt('mailto:a@paypal%E2%92%88com', 'paypal1.com').mismatch).toBe(true);
    expect(prompt('mailto:a@paypal.com', 'paypal.com').mismatch).toBe(false);
  });

  it('warns for a look-alike host name split or dotted by invisible or compatibility characters', () => {
    const titles = ['paypal\u2060.com', 'paypal\u2024com', 'pay\u00adpal.com', 'p\u200baypal.com'];
    for (const text of titles) {
      expect(hostsIn(displayTitle(text))).toEqual(['paypal.com']);
      expect(prompt('https://evil.example/', text)).toMatchObject({ mismatch: true });
      expect(prompt('https://paypal.com/', text)).toMatchObject({ mismatch: false });
    }
    expect(displayTitle('pay\u00adpal\u2060.com\u200b')).toBe('paypal.com');
    expect(hostsIn('ｐａｙｐａｌ．ｃｏｍ')).toEqual(['paypal.com']);
    expect(hostsIn('p\u200baypal\u2060.com')).toEqual(['paypal.com']);
  });

  it('drops bidirectional controls from the title and caps its length', () => {
    expect(displayTitle('‮moc.elpmaxe‬  now\n')).toBe('moc.elpmaxe now');
    expect(prompt('https://example.org/', '‮moc.elpmaxe')).toMatchObject({ mismatch: true });
    const long = displayTitle('x'.repeat(MAX_TITLE + 50));
    expect(long).toHaveLength(MAX_TITLE);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('linkPrompt for mailto: links', () => {
  const prompt = (url: string, text: string) => linkPrompt('d'.repeat(32), { url, text });
  const marked = (p: ReturnType<typeof prompt>) =>
    p.host === null ? null : p.url.slice(p.host.start, p.host.end);

  it('goes to the mail app; a web link goes to the browser', () => {
    expect(prompt('mailto:help@shop.example', 'help')).toMatchObject({
      mail: true,
      unclear: false,
    });
    expect(prompt('https://shop.example/', 'shop')).toMatchObject({ mail: false, unclear: false });
    expect(prompt('MAILTO:help@shop.example', 'help').mail).toBe(true);
  });

  it('checks the recipients in the to, cc and bcc fields as well as the path', () => {
    // Every recipient must be the host the title names.
    for (const url of [
      'mailto:help@paypal.com?bcc=x@evil.test',
      'mailto:help@paypal.com?cc=x@evil.test&subject=Hi',
      'mailto:help@paypal.com?To=a@paypal.com,x@evil.test',
      'mailto:?to=x@evil.test',
      'mailto:?to=help%40paypal.com%2Cx%40evil.test',
    ]) {
      expect(prompt(url, 'paypal.com'), url).toMatchObject({ mismatch: true, unclear: false });
    }
    for (const url of [
      'mailto:help@paypal.com?cc=billing@paypal.com',
      'mailto:?to=help@paypal.com&bcc=a@www.paypal.com',
      'mailto:help@paypal.com?subject=x@evil.test&body=evil.test',
    ]) {
      expect(prompt(url, 'paypal.com'), url).toMatchObject({ mismatch: false, unclear: false });
    }
    // The fields stay in the URL as written; only the path's first domain is marked.
    const fields = prompt('mailto:help@shop.example?cc=x@evil.test', 'Write');
    expect(fields.url).toBe('mailto:help@shop.example?cc=x@evil.test');
    expect(marked(fields)).toBe('shop.example');
    expect(marked(prompt('mailto:?to=help@shop.example', 'Write'))).toBeNull();
  });

  it('flags IDN and mixed-script domains in the path and the fields', () => {
    const mixed = prompt(new URL('mailto:help@pаypal.com').href, 'paypal.com');
    expect(mixed).toMatchObject({
      url: 'mailto:help@xn--pypal-4ve.com',
      mismatch: true,
      lookalike: true,
      unclear: false,
    });
    expect(marked(mixed)).toBe('xn--pypal-4ve.com');
    for (const url of [
      new URL('mailto:help@shop.example?cc=x@аpple.test').href,
      'mailto:help@shop.example?bcc=x%40xn--pple-43d.test',
      new URL('mailto:?to=x@Exämple.test').href,
    ]) {
      expect(prompt(url, 'Write to us'), url).toMatchObject({
        mismatch: false,
        lookalike: true,
        unclear: false,
      });
    }
    expect(prompt('mailto:help@shop.example?cc=x@other.example', 'Write').lookalike).toBe(false);
  });

  it('calls an address with an encoded comma or a second @ in its local part unclear', () => {
    for (const url of [
      'mailto:a@evil.test%2C@paypal.com',
      'mailto:a%40evil.test@paypal.com',
      'mailto:a%2Cb@paypal.com',
      'mailto:help@shop.example,a@evil.test%2C@paypal.com',
    ]) {
      const p = prompt(url, 'paypal.com');
      expect(p, url).toMatchObject({ url, unclear: true, mismatch: true });
    }
    // An unclear first address is not marked, and matches no host the title names.
    expect(marked(prompt('mailto:a@evil.test%2C@paypal.com', 'paypal.com'))).toBeNull();
    expect(prompt('mailto:a@evil.test%2C@paypal.com', 'Write')).toMatchObject({
      mismatch: false,
      unclear: true,
    });
  });

  it('decodes the fields once, and keeps a + as a +', () => {
    // An encoded list is two clear recipients.
    const list = prompt('mailto:?to=a%40x.test%2Cb%40y.test', 'x.test');
    expect(list).toMatchObject({ unclear: false, mismatch: true });
    expect(prompt('mailto:?to=a%40x.test%2Cb%40x.test', 'x.test')).toMatchObject({
      unclear: false,
      mismatch: false,
    });
    // A + is part of the address: decoded as a space, it would make it unclear.
    expect(prompt('mailto:?to=a+b@x.test', 'x.test')).toMatchObject({
      unclear: false,
      mismatch: false,
    });
    expect(prompt('mailto:?to=a%20b@x.test', 'x.test')).toMatchObject({ unclear: true });
    // Decoded once: %2540 is the text %40, not an @.
    expect(prompt('mailto:?to=a%2540evil.test@paypal.com', 'paypal.com')).toMatchObject({
      unclear: false,
      mismatch: false,
    });
    // A value that can't be decoded is unclear.
    expect(prompt('mailto:?to=a%E0%A4@x.test', 'Write')).toMatchObject({ unclear: true });
  });

  it('calls a quoted local part, a display name, a comment or a group unclear', () => {
    for (const url of [
      // Quoted, with a comma that is no separator: one address at bank.com.
      'mailto:?to=%22evil%40attacker.com%2C%22%40bank.com',
      new URL('mailto:?to="evil@attacker.com,"@bank.com').href,
      'mailto:%22a%2Cb%22@bank.com',
      new URL('mailto:?to=Bank <x@evil.test>').href,
      new URL('mailto:?cc=x@evil.test (bank.com)').href,
      new URL('mailto:?bcc=Friends: a@x.test, b@y.test;').href,
      'mailto:a%5C@bank.com',
    ]) {
      expect(prompt(url, 'Write'), url).toMatchObject({ unclear: true, mismatch: false });
      expect(prompt(url, 'bank.com'), url).toMatchObject({ unclear: true, mismatch: true });
    }
    // Spaces around the list's commas are not part of an address.
    expect(prompt('mailto:?to=a@x.test,%20b@x.test', 'x.test')).toMatchObject({
      unclear: false,
      mismatch: false,
    });
  });

  it('calls an address with no domain, or one that is not a plain host name, unclear', () => {
    for (const url of [
      'mailto:nobody',
      'mailto:a@',
      'mailto:a@paypal.com%2Fx.evil.test',
      'mailto:a@ex%2Cample.test',
      'mailto:help@shop.example?bcc=x@evil.test%2F',
    ]) {
      expect(prompt(url, 'Write'), url).toMatchObject({ unclear: true });
    }
    expect(prompt('mailto:?subject=Hi', 'Write')).toMatchObject({
      unclear: false,
      mismatch: false,
      host: null,
    });
    expect(prompt('mailto:?subject=Hi', 'paypal.com').mismatch).toBe(true);
  });
});
