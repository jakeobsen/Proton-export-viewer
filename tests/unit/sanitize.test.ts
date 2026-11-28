// SPDX-License-Identifier: AGPL-3.0-or-later
// The HTML sanitizer and the CSS filter behind it: every hostile message loses
// everything on the drop list and has its remote references rewritten as
// declared, with no network call; known mutation-XSS forms stay inert; links
// and references get view ids; the CSS left parses back clean.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cssProblems } from '../../src/core/reader/css';
import { MAX_BODY_REFERENCES, MAX_REMOTE_URL_LENGTH } from '../../src/shared/constants';
import {
  DROPPED_ATTRIBUTES,
  DROPPED_ELEMENTS,
  MAX_REFERENCES,
  parseSrcset,
  sanitizeHtml,
} from '../../src/core/reader/sanitize';
import { hostileMessages, type HostilePlan } from '../../tools/gen-export/hostile.mjs';

const TOKEN = '0123456789abcdef0123456789abcdef';
const BASE = `mail-asset://v/${TOKEN}`;
const ID_RE = new RegExp(`^mail-asset://v/${TOKEN}/([rcl])(\\d+)$`);
const URL_ATTRIBUTES = ['href', 'src', 'background', 'poster', 'srcset'];

/** The distinct ids of one kind used in the body's URL attributes, sorted. */
function usedIds(doc: Document, kind: 'r' | 'l' | 'c'): string[] {
  const ids = new Set<string>();
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of URL_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value === null) continue;
      const urls = attr === 'srcset' ? parseSrcset(value).map((c) => c.url) : [value];
      for (const url of urls) {
        const m = ID_RE.exec(url);
        if (m && m[1] === kind) ids.add(`${kind}${m[2]}`);
      }
    }
    const css = el.localName === 'style' ? el.textContent : el.getAttribute('style');
    for (const m of (css ?? '').matchAll(/url\(["']?([^"')]+)/g)) {
      const id = ID_RE.exec(m[1] ?? '');
      if (id && id[1] === kind) ids.add(`${kind}${id[2]}`);
    }
  }
  return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function range(kind: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${kind}${i + 1}`);
}

function parse(html: string): Document {
  return new JSDOM(html).window.document;
}

/** Every problem with a sanitized document: anything that should not be there. */
function problems(doc: Document): string[] {
  const found: string[] = [];
  for (const tag of DROPPED_ELEMENTS) {
    if (doc.getElementsByTagName(tag).length > 0) found.push(`<${tag}>`);
  }
  for (const style of doc.querySelectorAll('style')) {
    for (const p of cssProblems(style.textContent ?? '', 'stylesheet')) found.push(`<style> ${p}`);
  }
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      const value = el.getAttribute(attr) ?? '';
      if (attr === 'style') {
        for (const p of cssProblems(value, 'declarationList')) found.push(`style ${p}`);
        continue;
      }
      if (/^on/i.test(attr)) found.push(`${attr} on <${el.localName}>`);
      if (
        (DROPPED_ATTRIBUTES as readonly string[]).includes(attr) &&
        attr !== 'target' &&
        attr !== 'rel'
      )
        found.push(`${attr} on <${el.localName}>`);
      if (attr.startsWith('data-')) found.push(attr);
      if (URL_ATTRIBUTES.includes(attr)) {
        const urls = attr === 'srcset' ? parseSrcset(value).map((c) => c.url) : [value];
        for (const url of urls) {
          const m = ID_RE.exec(url);
          const kind = attr === 'href' ? 'l' : null;
          if (!m || (kind === 'l') !== (m[1] === 'l')) found.push(`${attr}=${url}`);
        }
      }
      if (
        /javascript:|data:|https?:|\/\//i.test(value) &&
        !ID_RE.test(value.split(/[\s,]/)[0] ?? '')
      )
        if (!['alt', 'title'].includes(attr)) found.push(`${attr}=${value.slice(0, 60)}`);
    }
    if (el.localName === 'a' && el.hasAttribute('href')) {
      if (el.getAttribute('target') !== '_blank') found.push('a without target');
      if (el.getAttribute('rel') !== 'noopener noreferrer') found.push('a without rel');
    }
  }
  return found;
}

describe('the sanitizer on the hostile corpus', () => {
  const nonce = randomBytes(6).toString('hex');
  const { plans } = hostileMessages({
    seed: 1,
    nonce,
    labelInfo: { file: { Payload: [] } },
    owner: { Name: 'Owner', Address: 'owner@example.com' },
  });
  const name = (p: HostilePlan) => p.key.split('/').slice(3).join('/');
  const calls: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];
  const bodies = new Map<string, string>();

  beforeAll(async () => {
    for (const plan of plans) {
      const parsed = await simpleParser(plan.emlData, { skipImageLinks: true });
      if (typeof parsed.html === 'string' && parsed.html) bodies.set(name(plan), parsed.html);
    }
    // Any network use while sanitizing is recorded and refused.
    const trap = (label: string) => (): never => {
      calls.push(label);
      throw new Error(`network: ${label}`);
    };
    const stub = <T extends object>(target: T, key: keyof T & string, label: string) =>
      spies.push(vi.spyOn(target, key as never).mockImplementation(trap(label) as never));
    stub(net, 'connect', 'net.connect');
    stub(net, 'createConnection', 'net.createConnection');
    stub(net.Socket.prototype, 'connect', 'net.Socket.connect');
    stub(tls, 'connect', 'tls.connect');
    stub(http, 'request', 'http.request');
    stub(http, 'get', 'http.get');
    stub(https, 'request', 'https.request');
    stub(https, 'get', 'https.get');
    stub(dns, 'lookup', 'dns.lookup');
    stub(dns.promises, 'lookup', 'dns.promises.lookup');
    stub(globalThis, 'fetch', 'fetch');
  });

  afterAll(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it('has HTML bodies to sanitize', () => {
    expect(bodies.size).toBeGreaterThan(60);
  });

  for (const plan of plans) {
    it(`${name(plan)}: drops what it must and rewrites as declared`, () => {
      const html = bodies.get(name(plan));
      if (html === undefined) return;
      const out = sanitizeHtml(html, BASE);
      const doc = parse(out.html);
      expect(problems(doc), name(plan)).toEqual([]);
      expect(out.remote, name(plan)).toBe(plan.refs.rewrite);
      // Every id handed out is in the body: r1..rN and l1..lN, none lost.
      expect(usedIds(doc, 'r'), name(plan)).toEqual(range('r', out.remote));
      expect(usedIds(doc, 'l'), name(plan)).toEqual(range('l', out.links.length));
      for (const hint of plan.refs.hints) {
        const host = new URL(hint.startsWith('//') ? `https:${hint}` : hint).host;
        expect(out.html, hint).not.toContain(host);
      }
      expect(out.html).not.toContain('data-pev-script');
      expect(out.html).not.toContain(`leak-${nonce}.test/`.replace(/\/$/, '"'));
    });
  }

  it('makes no network call for any of them', () => {
    expect(calls).toEqual([]);
  });
});

describe('known mutation-XSS forms', () => {
  const forms = [
    '<svg><style><img src=x onerror=alert(1)></style></svg>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
    '<math><mi><table><mglyph><svg><mtext><style><img src=x onerror=alert(1)>',
    '<template><img src=x onerror=alert(1)></template>',
    '<img src="x` `<script>alert(1)</script>"` `>',
    '<a href="jav&#x09;ascript:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<object data="javascript:alert(1)"></object>',
    '<xmp><img src=x onerror=alert(1)></xmp>',
    '<title><img src=x onerror=alert(1)></title>',
    '<textarea><img src=x onerror=alert(1)></textarea>',
    '<select><style><img src=x onerror=alert(1)></style></select>',
    '<div id="x"><a href="https://a.test/" id="cookie">c</a></div><form id="f"><input name="attributes"></form>',
    '<!--<img src="--><img src=x onerror=alert(1)//">',
    '<?xml version="1.0"?><img src=x onerror=alert(1)>',
    // CSS escapes that decode to markup must not close the style element.
    String.raw`<style>a{content:"\3c/style>\3c img src=x onerror=alert(1)>"}</style>`,
    String.raw`<style>p{font-family:"\3c/STYLE>\3c link rel=dns-prefetch href=//a.test>"}</style>`,
    String.raw`<p style='font-family:"\22>\3c img src=x onerror=alert(1)>"'>x</p>`,
  ];
  for (const form of forms) {
    it(form.slice(0, 60), () => {
      const out = sanitizeHtml(`<html><body>${form}</body></html>`, BASE);
      // Parsed again, as the browser will: nothing that runs, nothing on the drop list.
      const doc = parse(out.html);
      expect(problems(doc)).toEqual([]);
      expect(doc.querySelectorAll('script').length).toBe(0);
      // Escaped text may still read like markup; what counts is what parses.
      const handlers = [...doc.querySelectorAll('*')].flatMap((e) =>
        e.getAttributeNames().filter((a) => /^on/i.test(a)),
      );
      expect(handlers).toEqual([]);
    });
  }
});

describe('links and references', () => {
  it('gives links opaque ids, keeps their text, and drops other schemes', () => {
    const out = sanitizeHtml(
      [
        '<a href="https://a.test/x?y=1&amp;z=2">See <b>this</b>  page</a>',
        '<a href="mailto:someone@a.test">mail</a>',
        '<a href="javascript:alert(1)">js</a>',
        '<a href="relative/path">rel</a>',
        '<a href="#top">frag</a>',
        '<a href="ftp://a.test/">ftp</a>',
        '<map><area href="http://b.test/" alt="Area link"></map>',
        '<link href="https://c.test/">',
      ].join(''),
      BASE,
    );
    expect(out.links).toEqual([
      { id: 'l1', url: 'https://a.test/x?y=1&z=2', text: 'See this page' },
      { id: 'l2', url: 'mailto:someone@a.test', text: 'mail' },
      { id: 'l3', url: 'http://b.test/', text: 'Area link' },
    ]);
    const doc = parse(out.html);
    const hrefs = [...doc.querySelectorAll('[href]')].map((e) => e.getAttribute('href'));
    expect(hrefs).toEqual([`${BASE}/l1`, `${BASE}/l2`, `${BASE}/l3`]);
    expect(doc.querySelectorAll('a').length).toBe(6);
  });

  it('gives one r id per distinct remote URL, c ids to cid:, and drops the rest', () => {
    const out = sanitizeHtml(
      [
        '<body background="https://a.test/bg.png">',
        '<img src="https://a.test/1.png"><img src="https://A.TEST/1.png">',
        '<img src="cid:Part1@example.org"><img src="CID:part1@example.org"><img src="cid:other">',
        '<img src="data:image/png;base64,iVBORw0KGgo="><img src="relative.png"><img src="//a.test/proto.png">',
        '<img srcset="https://a.test/1.png 1x, https://a.test/2.png 2x, data:image/png;base64,AA 3x">',
        '<video poster="https://a.test/p.png" src="http://a.test/v.mp4"></video>',
        '<table background="javascript:alert(1)"><tr><td background="https://a.test/td.png">x</td></tr></table>',
        '</body>',
      ].join(''),
      BASE,
    );
    expect(out.remote).toBe(6);
    expect(out.cids).toBe(2);
    const doc = parse(out.html);
    expect(doc.body.getAttribute('background')).toBe(`${BASE}/r1`);
    const srcs = [...doc.querySelectorAll('img')].map((e) => e.getAttribute('src'));
    expect(srcs).toEqual([
      `${BASE}/r2`,
      `${BASE}/r2`,
      `${BASE}/c1`,
      `${BASE}/c1`,
      `${BASE}/c2`,
      null,
      null,
      null,
      null,
    ]);
    expect(doc.querySelectorAll('img')[8]?.getAttribute('srcset')).toBe(
      `${BASE}/r2 1x, ${BASE}/r3 2x`,
    );
    // DOMPurify visits an element's attributes last to first.
    expect(doc.querySelector('video')?.getAttribute('src')).toBe(`${BASE}/r4`);
    expect(doc.querySelector('video')?.getAttribute('poster')).toBe(`${BASE}/r5`);
    expect(doc.querySelector('table')?.hasAttribute('background')).toBe(false);
    expect(doc.querySelector('td')?.getAttribute('background')).toBe(`${BASE}/r6`);
  });

  it('keeps the CSS the filter allows, with its image URLs rewritten, and ordinary attributes', () => {
    const out = sanitizeHtml(
      [
        '<html><head><style>@import url(https://a.test/i.css); p{color:red;background:url(https://a.test/bg.png)}',
        '@font-face{font-family:F;src:url(https://a.test/f.woff2)} div{position:fixed;top:0}</style></head>',
        '<body><p style="color:blue;behavior:url(https://a.test/b.htc)" class="c" align="center" width="10">Hi &amp; bye</p>',
        '<div style="background-image:url(https://a.test/bg.png);cursor:url(https://a.test/c.cur),auto">x</div></body></html>',
      ].join(''),
      BASE,
    );
    const doc = parse(out.html);
    expect(out.html.startsWith('<!doctype html><html>')).toBe(true);
    expect(problems(doc)).toEqual([]);
    expect(out.remote).toBe(1);
    expect(doc.querySelector('style')?.textContent).toBe(
      `p{color:red;background:url(${BASE}/r1)}div{top:0}`,
    );
    const p = doc.querySelector('p');
    expect(p?.getAttribute('style')).toBe('color:blue');
    expect(p?.getAttribute('class')).toBe('c');
    expect(p?.getAttribute('align')).toBe('center');
    expect(p?.textContent).toBe('Hi & bye');
    expect(doc.querySelector('div')?.getAttribute('style')).toBe(
      `background-image:url(${BASE}/r1)`,
    );
  });

  it('counts only the ids in the CSS it keeps, near the cap', () => {
    // All but one id go to images; the first declaration's two new URLs can't
    // both get one, so it goes, and the next declaration gets the last id.
    const images = Array.from(
      { length: MAX_REFERENCES - 1 },
      (_, i) => `<img src="https://a.test/${i}.png">`,
    ).join('');
    const out = sanitizeHtml(
      [
        "<style>a{background-image:image-set('https://b.test/1.png' 1x,'https://b.test/2.png' 2x)}",
        'b{background:url(https://b.test/3.png)}</style>',
        `<body>${images}</body>`,
      ].join(''),
      BASE,
    );
    expect(out.remote).toBe(MAX_REFERENCES);
    const doc = parse(out.html);
    expect(doc.querySelector('style')?.textContent).toBe(
      `b{background:url(${BASE}/r${MAX_REFERENCES})}`,
    );
    expect(usedIds(doc, 'r')).toEqual(range('r', MAX_REFERENCES));
  });

  it('names each r<n> by its URL for main, in id order: src, srcset, poster, background and style', () => {
    const out = sanitizeHtml(
      [
        '<body>',
        '<img src="http://a.test/1.png">',
        '<img srcset="https://a.test/2.png 1x, http://a.test/1.png 2x">',
        '<video poster="HTTPS://Poster.Test/p.png"></video>',
        '<table background="https://bg.test/b.png"><tr><td>x</td></tr></table>',
        '<p style="background-image:url(https://css.test/c.png)">x</p>',
        '<img src="ftp://x.test/no.png"><img src="http://a.test/1.png">',
        '</body>',
      ].join(''),
      BASE,
    );
    // Repeats share one id; only http and https URLs get one, as resolved.
    expect(out.remoteRefs).toEqual([
      'http://a.test/1.png',
      'https://a.test/2.png',
      'https://poster.test/p.png',
      'https://bg.test/b.png',
      'https://css.test/c.png',
    ]);
    expect(out.remote).toBe(5);
    const doc = parse(out.html);
    const imgs = doc.querySelectorAll('img');
    expect(imgs[0]?.getAttribute('src')).toBe(`${BASE}/r1`);
    expect(imgs[1]?.getAttribute('srcset')).toBe(`${BASE}/r2 1x, ${BASE}/r1 2x`);
    expect(doc.querySelector('video')?.getAttribute('poster')).toBe(`${BASE}/r3`);
    expect(doc.querySelector('table')?.getAttribute('background')).toBe(`${BASE}/r4`);
    expect(doc.querySelector('p')?.getAttribute('style')).toBe(`background-image:url(${BASE}/r5)`);
    expect(imgs[imgs.length - 1]?.getAttribute('src')).toBe(`${BASE}/r1`);
    expect(usedIds(doc, 'r')).toEqual(range('r', 5));
  });

  it('gives main at most MAX_REFERENCES remote URLs; the next reference is removed', () => {
    expect(MAX_REFERENCES).toBe(MAX_BODY_REFERENCES);
    const images = Array.from(
      { length: MAX_REFERENCES + 1 },
      (_, i) => `<img src="https://a.test/${i}.png">`,
    ).join('');
    const out = sanitizeHtml(`<body>${images}</body>`, BASE);
    expect(out.remote).toBe(MAX_REFERENCES);
    expect(out.remoteRefs).toHaveLength(MAX_REFERENCES);
    expect(out.remoteRefs.at(-1)).toBe(`https://a.test/${MAX_REFERENCES - 1}.png`);
    const imgs = parse(out.html).querySelectorAll('img');
    expect(imgs[MAX_REFERENCES - 1]?.getAttribute('src')).toBe(`${BASE}/r${MAX_REFERENCES}`);
    expect(imgs[MAX_REFERENCES]?.getAttribute('src') ?? null).toBeNull();
  });

  it('removes a remote reference whose resolved URL is longer than main accepts', () => {
    // Written short enough, but percent-encoding makes the URL longer.
    const prefix = 'https://a.test/';
    const fits = prefix + 'a'.repeat(MAX_REMOTE_URL_LENGTH - prefix.length);
    const grows = prefix + '\u00e9'.repeat(Math.ceil((MAX_REMOTE_URL_LENGTH - prefix.length) / 4));
    expect(grows.length).toBeLessThan(MAX_REMOTE_URL_LENGTH);
    expect(new URL(grows).href.length).toBeGreaterThan(MAX_REMOTE_URL_LENGTH);
    const out = sanitizeHtml(`<body><img src="${fits}"><img src="${grows}"></body>`, BASE);
    expect(out.remoteRefs).toEqual([fits]);
    const imgs = parse(out.html).querySelectorAll('img');
    expect(imgs[0]?.getAttribute('src')).toBe(`${BASE}/r1`);
    expect(imgs[1]?.getAttribute('src') ?? null).toBeNull();
  });

  it('counts no ids for a declaration dropped because css-tree writes it with an escape or `</`', () => {
    // css-tree writes the quote in the string back with an escape, and the
    // `</` would end a style element: those declarations go, with their ids.
    const out = sanitizeHtml(
      [
        `<style>p{background:url(https://a.test/1.png),'say "hi"'}q{color:red}</style>`,
        `<p style="background:url(https://a.test/2.png),'</b>';color:blue">x</p>`,
        '<img src="cid:part"><img src="https://a.test/3.png">',
        '<div style="background:url(https://a.test/4.png)">y</div>',
      ].join(''),
      BASE,
    );
    const doc = parse(out.html);
    expect(doc.querySelector('style')?.textContent).toBe('q{color:red}');
    expect(doc.querySelector('p')?.getAttribute('style')).toBe('color:blue');
    expect(doc.querySelector('div')?.getAttribute('style')).toBe(`background:url(${BASE}/r2)`);
    expect(out.remote).toBe(2);
    expect(out.cids).toBe(1);
    expect(usedIds(doc, 'r')).toEqual(range('r', 2));
    expect(problems(doc)).toEqual([]);
  });

  it('parses srcset like the HTML rules do', () => {
    expect(parseSrcset(' a.png 1x,b.png 2x , c.png,d.png e(1).png, f.png 100w')).toEqual([
      { url: 'a.png', descriptor: '1x' },
      { url: 'b.png', descriptor: '2x' },
      // A comma inside a URL belongs to it; only one at its end separates.
      { url: 'c.png,d.png', descriptor: 'e(1).png' },
      { url: 'f.png', descriptor: '100w' },
    ]);
  });
});
