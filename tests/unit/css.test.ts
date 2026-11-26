// SPDX-License-Identifier: AGPL-3.0-or-later
// The CSS filter: what it keeps, what it drops, how it rewrites image URLs,
// and that what it returns parses back clean.

import { describe, expect, it } from 'vitest';
import {
  cssProblems,
  filterStyleAttribute,
  filterStyleSheet,
  type UrlRewriter,
} from '../../src/core/reader/css';
import { hostileMessages } from '../../tools/gen-export/hostile.mjs';

const BASE = 'mail-asset://v/0123456789abcdef0123456789abcdef';

/**
 * A rewriter like the sanitizer's: http(s) to r<n>, cid: to c<n>, anything
 * else refused, and at most `room` ids. `handed` lists the ids not taken back.
 */
function rewriter(room = Infinity): UrlRewriter & { handed: string[] } {
  const ids = new Map<string, string>();
  const handed: string[] = [];
  const kind = (url: string) =>
    /^cid:/i.test(url) ? 'c' : /^https?:\/\/[^/]/i.test(url.trim()) ? 'r' : null;
  return {
    handed,
    rewrite: (url) => {
      const k = kind(url);
      if (k === null) return null;
      let id = ids.get(url);
      if (!id) {
        if (ids.size >= room) return null;
        id = `${k}${[...ids.values()].filter((v) => v.startsWith(k)).length + 1}`;
        ids.set(url, id);
        handed.push(id);
      }
      return `${BASE}/${id}`;
    },
    mark: () => ids.size,
    rollback: (mark) => {
      for (const url of [...ids.keys()].slice(mark)) ids.delete(url);
      handed.length = mark;
    },
  };
}

describe('the CSS filter, on style sheets', () => {
  it('keeps plain rules and @media, and drops every other at-rule', () => {
    const css = [
      '@charset "utf-8";',
      '@import url(https://a.test/i.css);',
      '@namespace url(https://a.test/ns);',
      '@font-face{font-family:F;src:url(https://a.test/f.woff2)}',
      '@keyframes k{from{background-image:url(https://a.test/k.png)}}',
      '@supports (display:grid){p{color:red}}',
      '@page{margin:1cm}',
      '@layer base{p{color:red}}',
      '@container (min-width:1px){p{color:red}}',
      'p{color:#123;font-weight:700}',
      '@media screen and (max-width:600px){p{color:blue}@media print{p{color:red}}}',
    ].join('');
    expect(filterStyleSheet(css, rewriter())).toBe(
      'p{color:#123;font-weight:700}@media screen and (max-width:600px){p{color:blue}}',
    );
  });

  it('drops behavior, -moz-binding, expression(), position:fixed and custom properties', () => {
    const css = [
      'p{behavior:url(https://a.test/b.htc);color:red}',
      'p{-moz-binding:url(https://a.test/x.xml#b);color:red}',
      'p{width:expression(alert(1));color:red}',
      'p{position:fixed;position:absolute}',
      'p{--x:url(https://a.test/v.png);background:var(--x)}',
      'p{background:url(https://a.test/ok.png)}',
    ].join('');
    const urls = rewriter();
    expect(filterStyleSheet(css, urls)).toBe(
      `p{color:red}p{color:red}p{color:red}p{position:absolute}p{background:url(${BASE}/r1)}`,
    );
    expect(urls.handed).toEqual(['r1']);
  });

  it('rewrites image url() and image-set() candidates, one id per distinct URL', () => {
    const css = [
      'a{background:url("https://a.test/1.png") no-repeat}',
      "b{background-image:image-set('https://a.test/1.png' 1x, url(https://a.test/2.png) 2x)}",
      'i{background-image:-webkit-image-set(url(https://a.test/3.png) 1x)}',
      'li{list-style:url(cid:bullet@x) inside}',
      'td{border-image:url(https://a.test/4.png) 30 round}',
    ].join('');
    const urls = rewriter();
    const out = filterStyleSheet(css, urls);
    // css-tree's compact output needs no space after url(…): it ends its own token.
    expect(out).toBe(
      [
        `a{background:url(${BASE}/r1)no-repeat}`,
        `b{background-image:image-set(url(${BASE}/r1)1x,url(${BASE}/r2)2x)}`,
        `i{background-image:-webkit-image-set(url(${BASE}/r3)1x)}`,
        `li{list-style:url(${BASE}/c1)inside}`,
        `td{border-image:url(${BASE}/r4)30 round}`,
      ].join(''),
    );
    expect(urls.handed).toEqual(['r1', 'r2', 'r3', 'c1', 'r4']);
    expect(cssProblems(out, 'stylesheet')).toEqual([]);
  });

  it('drops a declaration with a URL it may not keep, and hands no id out for it', () => {
    const css = [
      'a{background:url(data:image/png;base64,AAAA)}',
      'a{background:url(relative.png)}',
      'a{background:url(//a.test/proto.png)}',
      'a{background:url(javascript:alert(1))}',
      'a{cursor:url(https://a.test/c.cur),auto}',
      'a{content:url(https://a.test/c.png)}',
      'a{mask-image:url(https://a.test/m.png)}',
      'a{cursor:image-set("https://a.test/c.png" 1x),auto}',
      'a{background:url(https://a.test/ok.png),url(data:image/png;base64,AAAA)}',
      "a{content:'https://a.test/text'}",
      'a{color:green}',
    ].join('');
    const urls = rewriter();
    expect(filterStyleSheet(css, urls)).toBe('a{color:green}');
    expect(urls.handed).toEqual([]);
  });

  it('takes back the ids of a declaration it drops because one of its URLs gets none', () => {
    // One id left: both image-set() candidates are new, so the first gets it and
    // the second does not; the declaration goes, and the id is free again.
    const css = [
      "a{background-image:image-set('https://a.test/1.png' 1x,'https://a.test/2.png' 2x)}",
      'b{background:url(https://a.test/3.png)}',
      'i{background:url(https://a.test/3.png),url(https://a.test/4.png)}',
      'p{color:green}',
    ].join('');
    const urls = rewriter(1);
    expect(filterStyleSheet(css, urls)).toBe(`b{background:url(${BASE}/r1)}p{color:green}`);
    expect(urls.handed).toEqual(['r1']);
    // An id handed out before the declaration stays.
    expect(urls.rewrite('https://a.test/3.png')).toBe(`${BASE}/r1`);
  });

  it('drops only the declaration or rule that css-tree writes with an escape or `</`', () => {
    // css-tree writes a quote or a tab in a string with an escape; none is in the source.
    const css = [
      'p{background:url(https://a.test/1.png);color:red}',
      'q{content:"</sty";color:red}',
      `r{content:'say "hi"';color:green}`,
      's{font-family:"a\tb";color:blue}',
      't{background:url(https://a.test/2.png),\'say "hi"\'}',
      `a[title='say "hi"']{color:red}`,
    ].join('');
    const urls = rewriter();
    expect(filterStyleSheet(css, urls)).toBe(
      `p{background:url(${BASE}/r1);color:red}q{color:red}r{color:green}s{color:blue}`,
    );
    expect(urls.handed).toEqual(['r1']);
    expect(
      filterStyleAttribute(
        `background:url(https://a.test/3.png),'a"b';font-family:"</b>";color:blue`,
        urls,
      ),
    ).toBe('color:blue');
    expect(urls.handed).toEqual(['r1']);
  });

  it('keeps nothing, and takes back every id, when the result fails the final check', () => {
    // Only a rewriter that hands out something other than an id gets this far.
    const urls = rewriter();
    const rewrite = urls.rewrite;
    urls.rewrite = (url) => (rewrite(url) === null ? null : 'https://a.test/not-an-id.png');
    expect(filterStyleSheet('p{background:url(https://a.test/1.png)}q{color:red}', urls)).toBe('');
    expect(urls.handed).toEqual([]);
    expect(filterStyleAttribute('background:url(https://a.test/1.png);color:red', urls)).toBe('');
    expect(urls.handed).toEqual([]);
  });

  it('takes back every id when the filter throws', () => {
    const urls = rewriter();
    const rewrite = urls.rewrite;
    urls.rewrite = (url) => {
      if (url.endsWith('/2.png')) throw new Error('boom');
      return rewrite(url);
    };
    expect(() =>
      filterStyleSheet(
        'p{background:url(https://a.test/1.png)}q{background:url(https://a.test/2.png)}',
        urls,
      ),
    ).toThrow('boom');
    expect(urls.handed).toEqual([]);
    expect(filterStyleSheet('p{background:url(https://a.test/3.png)}', urls)).toBe(
      `p{background:url(${BASE}/r1)}`,
    );
  });

  it('drops rules and declarations with escapes or that only parse as raw text', () => {
    const css = [
      'p{b\\61ckground:url(https://a.test/e.png)}',
      'p{background:u\\72l(https://a.test/e.png)}',
      'p{background:url(https://a.test/e\\.png)}',
      'p\\:hover{color:red}',
      'p{color:red;;;}',
      'p{color: }',
      'p{color:green}',
    ].join('');
    const urls = rewriter();
    const out = filterStyleSheet(css, urls);
    // css-tree decodes the escapes, so only the check on the source drops these.
    expect(out).toBe('p{color:red}p{color:}p{color:green}');
    expect(urls.handed).toEqual([]);
    expect(cssProblems(out, 'stylesheet')).toEqual([]);
  });

  it('checks escapes in the source, since css-tree decodes them', () => {
    const css = [
      String.raw`a{content:"\3c/style>\3c link rel=dns-prefetch href=//a.test>"}`,
      String.raw`a[title="\3c/style>"]{color:red}`,
      String.raw`@media \73 creen{p{color:red}}`,
      'p{color:green}',
    ].join('');
    const out = filterStyleSheet(css, rewriter());
    expect(out).toBe('p{color:green}');
    expect(filterStyleAttribute(String.raw`font-family:"\3c/style>";color:green`, rewriter())).toBe(
      'color:green',
    );
  });

  it('keeps selectors with attribute strings, and drops comments', () => {
    expect(
      filterStyleSheet(
        '/* note */ a[href^="https://"]{color:red} <!-- --> p{margin:0}',
        rewriter(),
      ),
    ).toBe('a[href^="https://"]{color:red}p{margin:0}');
  });

  it('gives nothing back when nothing is left', () => {
    expect(filterStyleSheet('@import url(https://a.test/i.css);', rewriter())).toBe('');
    expect(filterStyleSheet('', rewriter())).toBe('');
  });
});

describe('the CSS filter, on style attributes', () => {
  it('keeps safe declarations and rewrites image URLs', () => {
    const urls = rewriter();
    expect(
      filterStyleAttribute(
        'color:blue; background:url(https://a.test/1.png); position:fixed; behavior:url(x.htc); width:expression(1)',
        urls,
      ),
    ).toBe(`color:blue;background:url(${BASE}/r1)`);
    expect(filterStyleAttribute('position:fixed', rewriter())).toBe('');
  });
});

describe('the check on filtered CSS', () => {
  it('finds what the filter must have removed', () => {
    expect(cssProblems('@import url(x.css);', 'stylesheet')).toContain('@import');
    expect(cssProblems('p{background:url(https://a.test/x.png)}', 'stylesheet')).toEqual([
      'url(https://a.test/x.png)',
    ]);
    expect(cssProblems('position:fixed', 'declarationList')).toEqual(['position:fixed']);
    expect(cssProblems('width:expression(1)', 'declarationList')).toContain('expression()');
    expect(cssProblems(`background:url(${BASE}/r1)`, 'declarationList')).toEqual([]);
    expect(cssProblems('a{content:"</style>"}', 'stylesheet')).toContain('end tag');
  });
});

describe('the slow CSS of the hostile corpus', () => {
  it('filters the huge style sheet and the regex-heavy one quickly, and clean', () => {
    const { plans } = hostileMessages({
      seed: 1,
      nonce: 'cssslow1',
      labelInfo: { file: { Payload: [] } },
      owner: { Name: 'Owner', Address: 'owner@example.com' },
    });
    for (const name of ['huge-style', 'regex-heavy-css']) {
      const plan = plans.find((p) => p.key.endsWith(`/pathological/${name}`));
      const css = /<style>([\s\S]*?)<\/style>/.exec(plan?.emlData.toString('utf8') ?? '')?.[1];
      expect(css, name).toBeTruthy();
      const started = performance.now();
      const out = filterStyleSheet(css ?? '', rewriter());
      const ms = performance.now() - started;
      expect(ms, name).toBeLessThan(2000);
      expect(out.length, name).toBeGreaterThan(0);
      expect(cssProblems(out, 'stylesheet'), name).toEqual([]);
    }
  });
});
