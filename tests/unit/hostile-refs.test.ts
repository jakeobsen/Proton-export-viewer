// SPDX-License-Identifier: AGPL-3.0-or-later
// The hostile corpus's reference declarations, its uniform script marker, the
// fixtures added for the sanitizer and the link dialog, and its determinism.

import { describe, expect, it } from 'vitest';
import {
  MARKER_ATTRIBUTE,
  SCRIPT_MARKER,
  checkRefs,
  hostileMessages,
  paddedPng,
  type HostilePlan,
} from '../../tools/gen-export/hostile.mjs';

const OWNER = { Name: 'Owner', Address: 'owner@example.com' };
const LABELS = { file: { Payload: [] } };
const MARKER_JS = `document.documentElement.setAttribute('${MARKER_ATTRIBUTE}','ran');console.log('${SCRIPT_MARKER}')`;

function generate(nonce: string, seed = 1) {
  return hostileMessages({ seed, nonce, labelInfo: LABELS, owner: OWNER });
}

const category = (p: HostilePlan) => p.key.split('/')[3] ?? '';
const name = (p: HostilePlan) => `${category(p)}/${p.key.split('/')[4] ?? ''}`;

/** The message body (without the top-level header), with every data: URI in it decoded and appended. */
function fullText(plan: HostilePlan): string {
  const eml = plan.emlData.toString('utf8');
  const text = eml.slice(eml.indexOf('\r\n\r\n') + 4);
  const decoded: string[] = [];
  for (const m of text.matchAll(/data:([a-z+/-]+)(;base64)?,([^"\s>]+)/g)) {
    const payload = m[3] ?? '';
    decoded.push(
      m[2] ? Buffer.from(payload, 'base64').toString('latin1') : decodeURIComponent(payload),
    );
  }
  return [text, ...decoded].join('\n');
}

describe('hostile reference declarations', () => {
  const { plans, counts } = generate('decl0001');

  it('are on every message, and valid', () => {
    expect(plans.length).toBeGreaterThan(100);
    for (const plan of plans)
      expect(() => checkRefs(name(plan), plan.refs), name(plan)).not.toThrow();
  });

  it('are required: a missing or malformed one fails', () => {
    for (const bad of [
      undefined,
      null,
      {},
      { rewrite: 0, loads: [] },
      { rewrite: -1, loads: [], hints: [] },
      { rewrite: 1.5, loads: [], hints: [] },
      { rewrite: 0, loads: [7], hints: [] },
      { rewrite: 0, loads: [['only-one']], hints: [] },
      { rewrite: 0, loads: [], hints: [null] },
    ]) {
      expect(() => checkRefs('x/y', bad), JSON.stringify(bad)).toThrow(/x\/y/);
    }
    expect(() =>
      checkRefs('x/y', { rewrite: 0, loads: [['a', 'b'], 'c'], hints: [] }),
    ).not.toThrow();
  });

  it('name only references that are in their message', () => {
    for (const plan of plans) {
      const text = plan.emlData.toString('utf8');
      const urls = [...plan.refs.loads.flat(), ...plan.refs.hints];
      for (const url of urls) expect(text, `${name(plan)}: ${url}`).toContain(url);
    }
  });

  it('declare loads and rewrites where the corpus has remote images and styles', () => {
    const byName = new Map(plans.map((p) => [name(p), p.refs]));
    expect(byName.get('script_markup/remote-image')?.rewrite).toBe(1);
    expect(byName.get('script_markup/srcset')?.loads[0]).toHaveLength(2);
    expect(byName.get('script_markup/link-hints')?.hints).toHaveLength(2);
    expect(byName.get('script_markup/dns-prefetch-control')?.hints).toHaveLength(1);
    expect(byName.get('css/media-url')?.rewrite).toBe(1);
    expect(byName.get('plain_text/alternative')?.rewrite).toBe(1);
    const loads = plans.reduce((n, p) => n + p.refs.loads.length, 0);
    expect(loads).toBeGreaterThan(30);
    expect(plans.filter((p) => p.refs.loads.length === 0).length).toBeGreaterThan(30);
    expect(counts.css).toBe(9);
    expect(counts.data_uris).toBe(6);
    expect(counts.links).toBe(3);
    expect(counts.plain_text).toBe(2);
  });
});

describe('the hostile corpus additions', () => {
  const nonce = 'add00001';
  const { plans } = generate(nonce);
  const byName = new Map(plans.map((p) => [name(p), p]));
  const text = (n: string) => byName.get(n)?.emlData.toString('utf8') ?? '';
  const host = `leak-${nonce}.test`;

  it('carry one uniform marker in every message that has script', () => {
    const scriptish = /<script(?=[\s>])(?![^>]*type="speculationrules")|\son[a-z]+=|javascript:/i;
    const withScript = plans.filter((p) => scriptish.test(fullText(p)));
    expect(withScript.map(name).sort()).toEqual(
      [
        'data_uris/html-image',
        'data_uris/html-link',
        'data_uris/svg-image',
        'data_uris/svg-link',
        'plain_text/alternative',
        'plain_text/markup-and-urls',
        'script_markup/event-handlers',
        'script_markup/javascript-url',
        'script_markup/script-inline',
        'script_markup/script-src',
      ].sort(),
    );
    for (const plan of withScript) expect(fullText(plan), name(plan)).toContain(MARKER_JS);
  });

  it('have the CSS the filter must handle', () => {
    expect(text('css/behavior')).toContain('behavior:url(');
    expect(text('css/moz-binding')).toContain('-moz-binding:url(');
    expect(text('css/expression')).toContain('expression(');
    expect(text('css/position-fixed')).toContain('position:fixed');
    for (const rule of ['@keyframes', '@supports', '@namespace', '@page'])
      expect(
        plans.some((p) => p.emlData.toString('utf8').includes(rule)),
        rule,
      ).toBe(true);
    expect(text('css/media-url')).toMatch(/@media screen\{p\{background-image:url\(https:/);
  });

  it('have data: URIs of every kind, one over 1 MB', () => {
    expect(text('data_uris/html-link')).toContain('<a href="data:text/html,');
    expect(text('data_uris/html-image')).toContain('<img src="data:text/html,');
    expect(text('data_uris/svg-link')).toContain('<a href="data:image/svg+xml;base64,');
    expect(text('data_uris/svg-image')).toContain('<img src="data:image/svg+xml;base64,');
    expect(fullText(byName.get('data_uris/svg-image')!)).toContain(`https://${host}/data-svg.png`);
    const fake = /data:image\/png;base64,([^"]+)/.exec(text('data_uris/fake-png'))?.[1] ?? '';
    expect(Buffer.from(fake, 'base64').subarray(0, 8).toString('hex')).not.toBe('89504e470d0a1a0a');
    const large = /data:image\/png;base64,([^"]+)/.exec(text('data_uris/large-png'))?.[1] ?? '';
    const png = Buffer.from(large, 'base64');
    expect(png.length).toBeGreaterThan(1024 * 1024);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('have misleading links under the canary name', () => {
    expect(text('links/text-names-other-host')).toContain(
      `<a href="https://${host}/real">https://bank.${host}/login</a>`,
    );
    expect(text('links/idn-host')).toContain(`https://bücher.${host}/`);
    const mixed = /https:\/\/([^/]+)\//.exec(text('links/mixed-script-host'))?.[1] ?? '';
    expect(mixed.endsWith(`.${host}`)).toBe(true);
    expect(/[Ѐ-ӿ]/.test(mixed) && /[a-z]/.test(mixed)).toBe(true);
  });

  it('have plain text with markup, javascript: and IP-literal URLs, and both forms', () => {
    const plain = text('plain_text/markup-and-urls');
    expect(plain).toContain('Content-Type: text/plain');
    for (const part of [
      '<script>',
      '<img src=',
      'javascript:',
      'http://192.0.2.10/',
      'http://[2001:db8::10]/',
    ])
      expect(plain, part).toContain(part);
    const alt = text('plain_text/alternative');
    expect(alt).toContain('multipart/alternative');
    expect(alt).toContain('Content-Type: text/plain');
    expect(alt).toContain('Content-Type: text/html');
  });

  it('make the x-dns-prefetch-control meta with a link to a canary name', () => {
    expect(text('script_markup/dns-prefetch-control')).toContain(
      `<meta http-equiv="x-dns-prefetch-control" content="on"><link rel="dns-prefetch" href="//dns-control.${host}">`,
    );
  });
});

describe('the hostile corpus', () => {
  it('is the same for a seed and nonce, and changes with the nonce', () => {
    const a = generate('same0001');
    const b = generate('same0001');
    const c = generate('other001');
    expect(a.plans.map((p) => p.emlData.toString('base64'))).toEqual(
      b.plans.map((p) => p.emlData.toString('base64')),
    );
    expect(a.plans.map((p) => p.refs)).toEqual(b.plans.map((p) => p.refs));
    expect(a.plans.map((p) => p.emlData.toString('base64'))).not.toEqual(
      c.plans.map((p) => p.emlData.toString('base64')),
    );
  });

  it('stays small', () => {
    const bytes = generate('size0001').plans.reduce((n, p) => n + p.emlData.length, 0);
    console.log(`hostile messages: ${bytes} bytes`);
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
  });

  it('builds a padded PNG that is valid up to its size', () => {
    const png = paddedPng(5000);
    expect(png.length).toBeGreaterThanOrEqual(5000);
    expect(png.length).toBeLessThan(5100);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1);
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });
});
