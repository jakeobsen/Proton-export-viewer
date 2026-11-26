// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  MAX_TITLE,
  displayTitle,
  hostsIn,
  isLookalike,
  linkPrompt,
  resolveLink,
  sameSite,
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

describe('sameSite and isLookalike', () => {
  it('matches the same host, www and subdomains of the named host', () => {
    expect(sameSite('shop.example', 'shop.example')).toBe(true);
    expect(sameSite('www.shop.example', 'shop.example')).toBe(true);
    expect(sameSite('shop.example', 'www.shop.example')).toBe(true);
    expect(sameSite('shop.example', 'mail.shop.example')).toBe(true);
    expect(sameSite('shop.example', 'shop.example.evil.test')).toBe(false);
    expect(sameSite('shop.example', 'evilshop.example')).toBe(false);
    expect(sameSite('bank.example', 'evil.test')).toBe(false);
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

  it('drops bidirectional controls from the title and caps its length', () => {
    expect(displayTitle('‮moc.elpmaxe‬  now\n')).toBe('moc.elpmaxe now');
    expect(prompt('https://example.org/', '‮moc.elpmaxe')).toMatchObject({ mismatch: true });
    const long = displayTitle('x'.repeat(MAX_TITLE + 50));
    expect(long).toHaveLength(MAX_TITLE);
    expect(long.endsWith('…')).toBe(true);
  });
});
