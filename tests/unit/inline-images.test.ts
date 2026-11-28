// SPDX-License-Identifier: AGPL-3.0-or-later
// Inline images in the reader: which part a `cid:` reference names (its HTML
// part's branch, alternatives apart), the caps on `cid:` and `data:` images,
// the pixel budget, the places a `data:` image may stay, and the second read
// that must find the same file and the same parts.

import {
  closeSync,
  fstatSync,
  futimesSync,
  mkdirSync,
  openSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { fdRead, fdReread } from '../../src/core/reader/fd-input';
import {
  CID_IMAGE_BYTES,
  CID_MAX_IMAGES,
  CID_TOTAL_BYTES,
  DATA_IMAGE_BYTES,
  DATA_TOTAL_BYTES,
  IMAGE_REFUSALS,
  InlineImages,
  MESSAGE_PIXELS,
  type ImageRefusal,
  type Reread,
} from '../../src/core/reader/images';
import { PartTree, cidUrlKey, contentIdKey } from '../../src/core/reader/parts';
import { MAX_MIME_PARTS } from '../../src/core/mime-limits';
import { MAX_TOTAL_PIXELS } from '../../src/core/reader/raster';
import { renderMessage } from '../../src/core/reader/render';
import { sanitizeHtml } from '../../src/core/reader/sanitize';
import { REASONS } from '../../src/shared/log/codes';
import { PLACEHOLDER_DATA_URL } from '../../src/shared/placeholder';
import { entries } from '../../tools/gen-export/generator.mjs';
import { INLINE_BOMBS, INLINE_COLORS, hostileMessages } from '../../tools/gen-export/hostile.mjs';
import { gifImage, paddedPng, solidPng } from '../../tools/gen-export/images.mjs';
import { testDir } from '../paths';

const TOKEN = '0123456789abcdef0123456789abcdef';
const BASE = `mail-asset://v/${TOKEN}`;

// --- Building messages ----------------------------------------------------------

/** A MIME part: a leaf with a body, or a container of parts. */
interface Part {
  type: string;
  headers?: string[];
  body?: string | Buffer;
  parts?: Part[];
}

let boundaries = 0;

/** Base64 in lines of 76, as a part's body. */
const wrapped = (bytes: Buffer) => bytes.toString('base64').replace(/.{76}/g, '$&\r\n');

function mime(part: Part): string {
  if (part.parts) {
    boundaries += 1;
    const b = `b${boundaries}`;
    const lines = [`Content-Type: ${part.type}; boundary="${b}"`, ...(part.headers ?? []), ''];
    for (const child of part.parts) lines.push(`--${b}`, mime(child));
    lines.push(`--${b}--`, '');
    return lines.join('\r\n');
  }
  const body = part.body ?? '';
  if (Buffer.isBuffer(body)) {
    const encoded = wrapped(body);
    return [
      `Content-Type: ${part.type}`,
      'Content-Transfer-Encoding: base64',
      ...(part.headers ?? []),
      '',
      encoded,
    ].join('\r\n');
  }
  return [`Content-Type: ${part.type}`, ...(part.headers ?? []), '', body].join('\r\n');
}

function message(root: Part): Buffer {
  return Buffer.from(`Subject: inline\r\nMIME-Version: 1.0\r\n${mime(root)}`);
}

const html = (body: string): Part => ({ type: 'text/html; charset=utf-8', body });
const image = (cid: string, bytes: Buffer, extra: string[] = []): Part => ({
  type: 'image/png',
  headers: [`Content-ID: <${cid}>`, ...extra],
  body: bytes,
});
const text = (body: string): Part => ({ type: 'text/plain; charset=utf-8', body });
const related = (...parts: Part[]): Part => ({ type: 'multipart/related', parts });
const alternative = (...parts: Part[]): Part => ({ type: 'multipart/alternative', parts });
const mixed = (...parts: Part[]): Part => ({ type: 'multipart/mixed', parts });

const RED = solidPng(2, 2, [255, 0, 0]);
const BLUE = solidPng(2, 2, [0, 0, 255]);
const GREEN = solidPng(2, 2, [0, 255, 0]);

/** The message again from its bytes, as the worker reads it again from its file. */
function again(bytes: Buffer): Reread {
  return { open: () => Promise.resolve(Readable.from([bytes])) };
}

async function render(bytes: Buffer, reread: Reread | null = again(bytes)) {
  let refused = new Map<ImageRefusal, number>();
  const rendered = await renderMessage(Readable.from([bytes]), {
    mode: 'html',
    assetBase: BASE,
    ...(reread ? { reread } : {}),
    onImagesRefused: (r) => {
      refused = new Map(r);
    },
  });
  const doc = new JSDOM(rendered.html).window.document;
  const images = new Map(rendered.images.map((i) => [i.id, Buffer.from(i.bytes)]));
  /** The bytes an `<img>` shows, by its `alt` or `id`: an image, 'placeholder', or its src. */
  const shown = (alt: string): Buffer | string => {
    const img = doc.querySelector(`img[alt="${alt}"]`) ?? doc.getElementById(alt);
    const src = img?.getAttribute('src') ?? '';
    const id = src.startsWith(`${BASE}/`) ? src.slice(BASE.length + 1) : null;
    if (id === null) return src;
    return images.get(id) ?? 'placeholder';
  };
  return { rendered, doc, images, refused: Object.fromEntries(refused), shown };
}

// --- Content-ID matching -----------------------------------------------------------

describe('Content-ID matching', () => {
  it('strips angle brackets and ignores case in the header', () => {
    expect(contentIdKey(' <Part1@Example.ORG> ')).toBe('part1@example.org');
    expect(contentIdKey('bare@x')).toBe('bare@x');
    expect(contentIdKey('<>')).toBeNull();
    expect(contentIdKey('')).toBeNull();
  });

  it('percent-decodes the URL, strips angle brackets and ignores case', () => {
    expect(cidUrlKey('cid:Part1@Example.org')).toBe('part1@example.org');
    expect(cidUrlKey('CID:%3Cpart%201%40x%3E')).toBe('part 1@x');
    expect(cidUrlKey('cid:<a@b>')).toBe('a@b');
    expect(cidUrlKey('  cid:a@b  ')).toBe('a@b');
  });

  it('matches nothing for an invalid escape or another scheme', () => {
    expect(cidUrlKey('cid:%zz@x')).toBeNull();
    expect(cidUrlKey('cid:%E0%A4%A@x')).toBeNull();
    expect(cidUrlKey('cid:%C0@x')).toBeNull();
    expect(cidUrlKey('mid:a@b')).toBeNull();
  });
});

// --- Which part a reference names --------------------------------------------------

describe('cid: scope', () => {
  it('finds the part in the multipart/related around the HTML part', async () => {
    const bytes = message(related(html('<img alt="a" src="cid:a@x">'), image('a@x', RED)));
    const { shown, refused } = await render(bytes);
    expect(shown('a')).toEqual(RED);
    expect(refused).toEqual({});
  });

  it('serves each image with its detected type, not the declared one', async () => {
    const gif = gifImage(2, 2, 1);
    const bytes = message(
      related(html('<img alt="g" src="cid:g@x">'), { ...image('g@x', gif), type: 'image/png' }),
    );
    const { rendered } = await render(bytes);
    expect(rendered.images).toEqual([
      { id: 'c1', contentType: 'image/gif', bytes: new Uint8Array(gif) },
    ]);
  });

  it('falls back to the message when there is no multipart/related', async () => {
    const bytes = message(
      mixed(alternative(text('t'), html('<img alt="a" src="cid:a@x">')), image('a@x', RED)),
    );
    expect((await render(bytes)).shown('a')).toEqual(RED);
  });

  it('resolves a duplicate ID across two alternatives in the related part of each', async () => {
    const bytes = message(
      alternative(
        related(html('<img alt="first" src="cid:x@x">'), image('x@x', RED)),
        related(html('<img alt="second" src="cid:x@x">'), image('x@x', BLUE)),
      ),
    );
    const { shown, rendered, refused } = await render(bytes);
    expect(shown('first')).toEqual(RED);
    expect(shown('second')).toEqual(BLUE);
    expect(rendered.cids).toBe(2);
    expect(refused).toEqual({});
  });

  it('resolves a duplicate ID across two alternatives without related parts, leaving out the other alternative', async () => {
    const bytes = message(
      alternative(
        mixed(html('<img alt="first" src="cid:x@x">'), image('x@x', RED)),
        mixed(html('<img alt="second" src="cid:x@x">'), image('x@x', BLUE)),
      ),
    );
    const { shown, refused } = await render(bytes);
    expect(shown('first')).toEqual(RED);
    expect(shown('second')).toEqual(BLUE);
    expect(refused).toEqual({});
  });

  it('leaves out a part behind an alternative the HTML part is not in', async () => {
    const bytes = message(
      mixed(
        html('<img alt="a" src="cid:a@x">'),
        alternative(image('a@x', RED), text('the other form')),
      ),
    );
    const { shown, refused } = await render(bytes);
    expect(shown('a')).toBe('placeholder');
    expect(refused).toEqual({ missing: 1 });
  });

  it('leaves out a part outside the multipart/related around the HTML part', async () => {
    const bytes = message(
      mixed(related(html('<img alt="y" src="cid:y@x">'), image('a@x', RED)), image('y@x', BLUE)),
    );
    const { shown, refused } = await render(bytes);
    expect(shown('y')).toBe('placeholder');
    expect(refused).toEqual({ missing: 1 });
  });

  it('names nothing when two parts in reach share the ID', async () => {
    const bytes = message(
      related(html('<img alt="d" src="cid:d@x">'), image('d@x', RED), image('D@X', BLUE)),
    );
    const { shown, refused } = await render(bytes);
    expect(shown('d')).toBe('placeholder');
    expect(refused).toEqual({ ambiguous: 1 });
  });

  it('names nothing for an invalid escape or an unknown ID', async () => {
    const bytes = message(
      related(
        html('<img alt="bad" src="cid:%zz@x"><img alt="none" src="cid:none@x">'),
        image('%zz@x', RED),
      ),
    );
    const { shown, refused } = await render(bytes);
    expect(shown('bad')).toBe('placeholder');
    expect(shown('none')).toBe('placeholder');
    expect(refused).toEqual({ missing: 2 });
  });

  it('gives one id to every reference to the same part, in attributes and CSS', async () => {
    const bytes = message(
      related(
        html(
          '<style>p{background:url(cid:A@X)}</style><img alt="1" src="cid:a@x"><img alt="2" src="CID:%61@x"><p>p</p>',
        ),
        image('a@x', RED),
      ),
    );
    const { rendered, doc } = await render(bytes);
    expect(rendered.cids).toBe(1);
    expect(doc.querySelector('style')?.textContent).toContain(`${BASE}/c1`);
    expect(rendered.images.map((i) => i.id)).toEqual(['c1']);
  });
});

// --- Several HTML parts ------------------------------------------------------------

describe('a body of several HTML parts', () => {
  it('keeps markup one part leaves open out of the next', async () => {
    const bytes = message(
      alternative(
        related(html('<table><tr><td>first<style>p{color:red'), image('x@x', RED)),
        related(
          html('<p id="second">second</p><img alt="second" src="cid:x@x">'),
          image('x@x', BLUE),
        ),
      ),
    );
    const { doc, shown } = await render(bytes);
    const second = doc.getElementById('second');
    expect(second?.closest('table')).toBeNull();
    expect(second?.parentElement?.tagName).toBe('BODY');
    expect(shown('second')).toEqual(BLUE);
  });

  it('resolves the CSS of each part in that part', async () => {
    const bytes = message(
      alternative(
        related(html('<style>.a{background:url(cid:x@x)}</style>'), image('x@x', RED)),
        related(html('<style>.b{background:url(cid:x@x)}</style>'), image('x@x', BLUE)),
      ),
    );
    const { doc, images } = await render(bytes);
    const css = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '');
    const id = (rule: string) => /\/(c\d+)\)/.exec(css.find((c) => c.includes(rule)) ?? '')?.[1];
    expect(images.get(id('.a') ?? '')).toEqual(RED);
    expect(images.get(id('.b') ?? '')).toEqual(BLUE);
  });

  it('joins the parts after a line break, keeping the body attributes of the first', async () => {
    const bytes = message(
      mixed(
        html('<html><body bgcolor="#ffffff"><p id="one">one</p></body></html>'),
        html('<html><body bgcolor="#000000" lang="fr"><p id="two">two</p></body></html>'),
      ),
    );
    const { doc } = await render(bytes);
    const body = doc.body;
    expect(body.getAttribute('bgcolor')).toBe('#ffffff');
    expect(body.getAttribute('lang')).toBe('fr');
    const one = doc.getElementById('one');
    expect(one?.nextElementSibling?.tagName).toBe('BR');
    expect(one?.nextElementSibling?.nextElementSibling?.id).toBe('two');
  });

  it('shares ids and counts across the parts', async () => {
    const bytes = message(
      mixed(
        html('<a href="https://a.test/">a</a><img src="https://a.test/i.png">'),
        html('<a href="https://b.test/">b</a><img src="https://a.test/i.png">'),
      ),
    );
    const { rendered } = await render(bytes);
    expect(rendered.links.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(rendered.remote).toBe(1);
  });
});

// --- data: images ----------------------------------------------------------------

describe('data: images', () => {
  const base64 = (bytes: Buffer, type = 'image/png') =>
    `data:${type};base64,${bytes.toString('base64')}`;

  const check = (value: string) => {
    const images = new InlineImages(new PartTree());
    return { src: images.dataImage(value), refused: Object.fromEntries(images.refused) };
  };

  it('keeps a valid image, rewritten with the type found and plain base64', () => {
    const gif = gifImage(3, 3, 1);
    expect(check(base64(gif, 'image/jpeg'))).toEqual({
      src: base64(gif, 'image/gif'),
      refused: {},
    });
    const spaced = ` DATA:image/PNG;BASE64,${RED.toString('base64').replace(/(.{10})/g, '$1\n ')}  `;
    expect(check(spaced).src).toBe(base64(RED));
    const escaped = `data:image/gif,${[...gif].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('')}`;
    expect(check(escaped).src).toBe(base64(gif, 'image/gif'));
    expect(check(`data:image/png;base64,${encodeURIComponent(RED.toString('base64'))}`).src).toBe(
      base64(RED),
    );
  });

  it('drops a data: URL of another type, with parameters, or another encoding', () => {
    for (const value of [
      `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
      'data:text/html,<script>x</script>',
      `data:image/png;charset=utf-8;base64,${RED.toString('base64')}`,
      `data:image/bmp;base64,${RED.toString('base64')}`,
      `data:;base64,${RED.toString('base64')}`,
    ]) {
      expect(check(value)).toEqual({ src: null, refused: {} });
    }
  });

  it('refuses a broken encoding', () => {
    for (const value of [
      'data:image/png;base64,iVBOR!w0K',
      'data:image/png;base64,iVBORw0KG',
      'data:image/png;base64,iVBORw0K%zz',
      'data:image/png,%89PNG%0',
      'data:image/png,é',
      'data:image/png,a b',
    ]) {
      expect([value, check(value)]).toEqual([
        value,
        { src: PLACEHOLDER_DATA_URL, refused: { encoding: 1 } },
      ]);
    }
  });

  it('refuses what the raster check refuses', () => {
    expect(check(base64(Buffer.from('not an image')))).toEqual({
      src: PLACEHOLDER_DATA_URL,
      refused: { format: 1 },
    });
    expect(check(base64(gifImage(1, 1, 1001), 'image/gif')).refused).toEqual({ frames: 1 });
  });

  it('allows DATA_IMAGE_BYTES per image and refuses one byte more', () => {
    expect(check(base64(paddedPng(DATA_IMAGE_BYTES))).src).toBe(
      base64(paddedPng(DATA_IMAGE_BYTES)),
    );
    expect(check(base64(paddedPng(DATA_IMAGE_BYTES + 1))).refused).toEqual({ too_large: 1 });
    const escaped = `data:image/png,${'%00'.repeat(DATA_IMAGE_BYTES + 1)}`;
    expect(check(escaped).refused).toEqual({ too_large: 1 });
  });

  it('allows DATA_TOTAL_BYTES per message, in document order', () => {
    const images = new InlineImages(new PartTree());
    const one = base64(paddedPng(DATA_IMAGE_BYTES));
    const fit = DATA_TOTAL_BYTES / DATA_IMAGE_BYTES;
    for (let i = 0; i < fit; i++) expect(images.dataImage(one)).toBe(one);
    expect(images.dataImage(one)).toBe(PLACEHOLDER_DATA_URL);
    expect(images.dataImage(base64(RED))).toBe(PLACEHOLDER_DATA_URL);
    expect(Object.fromEntries(images.refused)).toEqual({ total: 2 });
  });

  it('stays only in <img src>', () => {
    const url = base64(RED);
    const out = sanitizeHtml(
      [
        {
          part: 0,
          html: [
            `<img id="kept" src="${url}">`,
            `<img id="srcset" srcset="${url} 1x">`,
            `<picture><source id="source" srcset="${url}"></picture>`,
            `<table id="table" background="${url}"><tr><td>x</td></tr></table>`,
            `<video id="video" poster="${url}" src="${url}"></video>`,
            `<audio id="audio" src="${url}"></audio>`,
            `<div id="css" style="background:url('${url}')">x</div>`,
            `<div id="set" style="background-image:image-set('${url}' 1x)">x</div>`,
            `<style>p{background:url(${url})}</style><p>p</p>`,
            `<input type="image" src="${url}">`,
            `<svg><image href="${url}"/></svg>`,
            `<a id="link" href="${url}">link</a>`,
          ].join(''),
        },
      ],
      BASE,
      new InlineImages(new PartTree()),
    );
    const doc = new JSDOM(out.html).window.document;
    expect(doc.getElementById('kept')?.getAttribute('src')).toBe(url);
    expect(out.html.split('data:').length - 1).toBe(1);
    for (const id of ['srcset', 'source', 'table', 'video', 'audio', 'link']) {
      const el = doc.getElementById(id);
      expect([id, el !== null]).toEqual([id, true]);
    }
    expect(doc.querySelector('input, svg, image')).toBeNull();
  });
});

// --- Caps and the pixel budget -------------------------------------------------------

describe('caps on cid: images', () => {
  /** A related part with `count` images, each `bytes` of PNG, referred to in order. */
  const many = (count: number, bytes: number) => {
    const png = paddedPng(bytes);
    const imgs = Array.from({ length: count }, (_, i) => `<img alt="${i}" src="cid:i${i}@x">`);
    return message(
      related(
        html(imgs.join('')),
        ...Array.from({ length: count }, (_, i) => image(`i${i}@x`, png)),
      ),
    );
  };

  it(`serves CID_MAX_IMAGES images and refuses the rest`, async () => {
    const { rendered, refused } = await render(many(CID_MAX_IMAGES + 2, 100));
    expect(rendered.cids).toBe(CID_MAX_IMAGES + 2);
    expect(rendered.images).toHaveLength(CID_MAX_IMAGES);
    expect(rendered.images.at(-1)?.id).toBe(`c${CID_MAX_IMAGES}`);
    expect(refused).toEqual({ too_many: 2 });
    expect(rendered.imagesRefused).toBe(2);
  });

  it('allows CID_IMAGE_BYTES per image and refuses one byte more', async () => {
    const bytes = message(
      related(
        html('<img alt="fits" src="cid:fits@x"><img alt="over" src="cid:over@x">'),
        image('fits@x', paddedPng(CID_IMAGE_BYTES)),
        image('over@x', paddedPng(CID_IMAGE_BYTES + 1)),
      ),
    );
    const { shown, refused } = await render(bytes);
    expect((shown('fits') as Buffer).length).toBe(CID_IMAGE_BYTES);
    expect(shown('over')).toBe('placeholder');
    expect(refused).toEqual({ too_large: 1 });
  });

  it('serves cid: parts that add up to exactly CID_TOTAL_BYTES', async () => {
    const third = CID_TOTAL_BYTES - 2 * CID_IMAGE_BYTES;
    const bytes = message(
      related(
        html('<img alt="a" src="cid:a@x"><img alt="b" src="cid:b@x"><img alt="c" src="cid:c@x">'),
        image('a@x', paddedPng(CID_IMAGE_BYTES)),
        image('b@x', paddedPng(CID_IMAGE_BYTES)),
        image('c@x', paddedPng(third)),
      ),
    );
    const { rendered, refused } = await render(bytes);
    expect(rendered.images.map((i) => i.bytes.length)).toEqual([
      CID_IMAGE_BYTES,
      CID_IMAGE_BYTES,
      third,
    ]);
    expect(refused).toEqual({});
  });

  it('allows CID_TOTAL_BYTES per message, in message order', async () => {
    const third = CID_TOTAL_BYTES - 2 * CID_IMAGE_BYTES;
    const bytes = message(
      related(
        // Referred to in the other order: the message order decides.
        html('<img alt="c" src="cid:c@x"><img alt="b" src="cid:b@x"><img alt="a" src="cid:a@x">'),
        image('a@x', paddedPng(CID_IMAGE_BYTES)),
        image('b@x', paddedPng(CID_IMAGE_BYTES)),
        image('c@x', paddedPng(third + 1)),
      ),
    );
    const { shown, refused } = await render(bytes);
    expect((shown('a') as Buffer).length).toBe(CID_IMAGE_BYTES);
    expect((shown('b') as Buffer).length).toBe(CID_IMAGE_BYTES);
    expect(shown('c')).toBe('placeholder');
    expect(refused).toEqual({ total: 1 });
  });

  describe('MESSAGE_PIXELS', () => {
    // MAX_TOTAL_PIXELS each: two make the whole budget.
    const big = gifImage(8000, 5000, MAX_TOTAL_PIXELS / 40_000_000);
    const dot = gifImage(1, 1, 1);
    const url = (gif: Buffer) => `data:image/gif;base64,${gif.toString('base64')}`;

    it('shows data: images that use exactly the budget, counting identical URLs each time, and refuses one pixel more', () => {
      expect(2 * MAX_TOTAL_PIXELS).toBe(MESSAGE_PIXELS);
      const images = new InlineImages(new PartTree());
      expect(images.dataImage(url(big))).toBe(url(big));
      expect(images.dataImage(url(big))).toBe(url(big));
      expect(images.dataImage(url(dot))).toBe(PLACEHOLDER_DATA_URL);
      expect(Object.fromEntries(images.refused)).toEqual({ budget: 1 });
    });

    it('shows a cid: image that uses exactly what is left, and refuses one pixel more', async () => {
      const bytes = message(
        related(
          html(
            `<img alt="data" src="${url(big)}"><img alt="cid" src="cid:big@x"><img alt="dot" src="cid:dot@x">`,
          ),
          image('big@x', big),
          image('dot@x', dot),
        ),
      );
      const { shown, refused } = await render(bytes);
      expect(shown('data')).toBe(url(big));
      expect(shown('cid')).toEqual(big);
      expect(shown('dot')).toBe('placeholder');
      expect(refused).toEqual({ budget: 1 });
    });
  });

  it('counts pixels against MESSAGE_PIXELS: data: images first, then cid: images by id', async () => {
    // Each image is MAX_TOTAL_PIXELS of frames x canvas.
    const big = gifImage(8000, 5000, MAX_TOTAL_PIXELS / 40_000_000);
    expect(MESSAGE_PIXELS / MAX_TOTAL_PIXELS).toBe(2);
    // 160 MP: with one big image, 40 MP short of the budget.
    const medium = gifImage(8000, 5000, 4);
    const data = `data:image/gif;base64,${big.toString('base64')}`;
    const data2 = `data:image/gif;base64,${medium.toString('base64')}`;
    const bytes = message(
      related(
        html(
          `<img alt="cid1" src="cid:one@x"><img alt="data1" src="${data}"><img alt="cid2" src="cid:two@x"><img alt="data2" src="${data2}">`,
        ),
        image('one@x', big),
        image('two@x', GREEN),
      ),
    );
    const { shown, refused } = await render(bytes);
    expect(shown('data1')).toBe(data);
    expect(shown('data2')).toBe(data2);
    expect(shown('cid1')).toBe('placeholder');
    // A small image still fits what is left.
    expect(shown('cid2')).toEqual(GREEN);
    expect(refused).toEqual({ budget: 1 });
  });

  it('logs only reasons the log schema accepts', () => {
    for (const reason of IMAGE_REFUSALS) expect(REASONS).toContain(reason);
  });
});

// --- The second read ---------------------------------------------------------------

describe('the second read', () => {
  const bytes = message(
    related(
      html('<img alt="a" src="cid:a@x"><img alt="b" src="cid:b@x">'),
      image('a@x', RED),
      image('b@x', BLUE),
    ),
  );

  it('serves no cid: image without a second read', async () => {
    const { shown, refused } = await render(bytes, null);
    expect(shown('a')).toBe('placeholder');
    expect(refused).toEqual({ unreadable: 2 });
  });

  it('serves no cid: image when the second read fails to open', async () => {
    const { refused } = await render(bytes, { open: () => Promise.resolve(null) });
    expect(refused).toEqual({ unreadable: 2 });
  });

  it('serves no cid: image when the file changed between the reads', async () => {
    const { shown, refused } = await render(bytes, {
      ...again(bytes),
      unchanged: () => Promise.resolve(false),
    });
    expect(shown('a')).toBe('placeholder');
    expect(refused).toEqual({ changed: 2 });
  });

  it('refuses a part that is no longer where the first read found it', async () => {
    const other = message(
      related(
        html('<img alt="a" src="cid:a@x"><img alt="b" src="cid:b@x">'),
        image('z@x', RED),
        image('b@x', BLUE),
      ),
    );
    const { shown, refused } = await render(bytes, again(other));
    expect(shown('a')).toBe('placeholder');
    expect(shown('b')).toEqual(BLUE);
    expect(refused).toEqual({ changed: 1 });
  });

  it('refuses a part that became a container', async () => {
    const other = message(related(html('x'), mixed(text('now a container')), image('b@x', BLUE)));
    const { shown, refused } = await render(bytes, again(other));
    expect(shown('a')).toBe('placeholder');
    expect(shown('b')).toEqual(BLUE);
    expect(refused).toEqual({ changed: 1 });
  });

  it('keeps the parts read whole when the second read fails after them', async () => {
    // The message up to the boundary after the first image's part, then,
    // once that is read, a read error.
    const cut = bytes.indexOf('Content-ID: <b@x>');
    const failing = () =>
      Readable.from(
        (async function* () {
          yield bytes.subarray(0, cut);
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('read error');
        })(),
      );
    const { shown, refused } = await render(bytes, { open: () => Promise.resolve(failing()) });
    expect(shown('a')).toEqual(RED);
    expect(shown('b')).toBe('placeholder');
    expect(refused).toEqual({ unreadable: 1 });
  });

  it('shows an image before the part limit in a message cut at it', async () => {
    const fillers = Array.from({ length: MAX_MIME_PARTS + 10 }, (_, i) => ({
      type: 'application/octet-stream',
      headers: [`Content-Disposition: attachment; filename="f${i}.bin"`],
      body: 'x',
    }));
    const cut = message(
      mixed(related(html('<img alt="a" src="cid:a@x">'), image('a@x', RED)), ...fillers),
    );
    const { rendered, shown, refused } = await render(cut);
    expect(rendered.cut).toBe('parts');
    expect(shown('a')).toEqual(RED);
    expect(refused).toEqual({});
  });

  it('stops after the last part it needs', async () => {
    // The message, and then nothing: a read that waits for its end never ends.
    const stream = () => {
      let sent = false;
      return new Readable({
        read() {
          if (!sent) this.push(bytes);
          sent = true;
        },
      });
    };
    let refused = new Map<ImageRefusal, number>();
    const rendered = await renderMessage(Readable.from([bytes]), {
      mode: 'html',
      assetBase: BASE,
      reread: { open: () => Promise.resolve(stream()) },
      onImagesRefused: (r) => {
        refused = new Map(r);
      },
    });
    expect(rendered.images.map((i) => i.id)).toEqual(['c1', 'c2']);
    expect(refused.size).toBe(0);
  });

  describe('of a file', () => {
    const dir = testDir('inline-images-fd');
    mkdirSync(dir, { recursive: true });

    /** A whole second: what any file system keeps exactly. */
    const SET_TIME = new Date(Date.UTC(2020, 0, 1));

    async function renderFile(change: ((fd: number, path: string) => void) | null) {
      const path = join(dir, `m${Math.random().toString(36).slice(2)}.eml`);
      writeFileSync(path, bytes);
      utimesSync(path, SET_TIME, SET_TIME);
      const fd = openSync(path, 'r');
      try {
        const reread = fdReread(fd, async () => {
          change?.(fd, path);
        });
        let refused = new Map<ImageRefusal, number>();
        const rendered = await renderMessage(fdRead(fd), {
          mode: 'html',
          assetBase: BASE,
          reread,
          onImagesRefused: (r) => {
            refused = new Map(r);
          },
        });
        // Both reads leave core's descriptor open, for core's one close.
        expect(() => fstatSync(fd)).not.toThrow();
        return { rendered, refused: Object.fromEntries(refused) };
      } finally {
        closeSync(fd);
      }
    }

    it('reads the images through the same descriptor', async () => {
      const { rendered, refused } = await renderFile(null);
      expect(rendered.images.map((i) => [i.id, Buffer.from(i.bytes)])).toEqual([
        ['c1', RED],
        ['c2', BLUE],
      ]);
      expect(refused).toEqual({});
    });

    it('serves no cid: image when the file is rewritten in place while held between the reads', async () => {
      const { rendered, refused } = await renderFile((_fd, path) => {
        // The same size, other image bytes, and a new modification time.
        const swapped = Buffer.from(
          bytes.toString('latin1').replace(wrapped(RED), wrapped(BLUE)),
          'latin1',
        );
        expect(swapped.length).toBe(bytes.length);
        expect(swapped.equals(bytes)).toBe(false);
        const out = openSync(path, 'r+');
        writeSync(out, swapped, 0, swapped.length, 0);
        futimesSync(out, new Date(2001, 0, 1), new Date(2001, 0, 1));
        closeSync(out);
      });
      expect(rendered.images).toEqual([]);
      expect(refused).toEqual({ changed: 2 });
    });

    it('serves no cid: image when only the size changed between the reads', async () => {
      const { rendered, refused } = await renderFile((_fd, path) => {
        writeFileSync(path, Buffer.from('\r\n'), { flag: 'a' });
        utimesSync(path, SET_TIME, SET_TIME);
      });
      expect(rendered.images).toEqual([]);
      expect(refused).toEqual({ changed: 2 });
    });

    it('serves no cid: image when the file grows between the reads', async () => {
      const { rendered, refused } = await renderFile((_fd, path) => {
        writeFileSync(path, Buffer.concat([bytes, Buffer.from('\r\n')]), { flag: 'a' });
      });
      expect(rendered.images).toEqual([]);
      expect(refused).toEqual({ changed: 2 });
    });
  });
});

// --- The hostile corpus and the perf mix ----------------------------------------

describe('the inline-image fixtures', () => {
  const plans = new Map(
    hostileMessages({
      seed: 1,
      nonce: 'inline1',
      labelInfo: { file: { Payload: [] } },
      owner: { Name: 'Owner', Address: 'owner@example.com' },
    })
      .plans.filter((p) => p.key.includes('/inline_images/'))
      .map((p) => [p.key.split('/').at(-1) ?? '', p.emlData]),
  );

  it.each(
    Object.entries(INLINE_BOMBS).flatMap(([name, [, reason]]) => [
      [`cid-${name}`, reason],
      [`data-${name}`, reason],
    ]),
  )('%s is refused as %s, and shows the placeholder', async (name, reason) => {
    const bytes = plans.get(name);
    expect(bytes).toBeDefined();
    const { rendered, refused, doc } = await render(bytes as Buffer);
    expect(refused).toEqual({ [reason]: 1 });
    expect(rendered.images).toEqual([]);
    expect(rendered.imagesRefused).toBe(1);
    const src = doc.getElementById('bomb')?.getAttribute('src');
    expect(src === PLACEHOLDER_DATA_URL || src === `${BASE}/c1`).toBe(true);
  });

  it('shows the valid cid: PNG and the valid data: GIF', async () => {
    const cid = await render(plans.get('cid-valid') as Buffer);
    expect(cid.refused).toEqual({});
    expect(cid.rendered.images.map((i) => [i.id, i.contentType])).toEqual([['c1', 'image/png']]);
    const data = await render(plans.get('data-valid') as Buffer);
    expect(data.refused).toEqual({});
    expect(data.doc.getElementById('inline')?.getAttribute('src')).toMatch(
      /^data:image\/gif;base64,/,
    );
  });

  it.each(['scope-related', 'scope-mixed'])(
    '%s: each alternative shows its own image',
    async (name) => {
      const { shown, refused } = await render(plans.get(name) as Buffer);
      const pixel = (bytes: Buffer | string) => {
        // A solid PNG of stored rows: the first pixel follows the row's filter byte.
        const png = bytes as Buffer;
        const at = png.indexOf('IDAT') + 4 + 2 + 5 + 1;
        return [...png.subarray(at, at + 3)];
      };
      expect(pixel(shown('first'))).toEqual(INLINE_COLORS.first);
      expect(pixel(shown('second'))).toEqual(INLINE_COLORS.second);
      expect(refused).toEqual({});
    },
  );

  it('shows nothing for a duplicate ID in reach, or an invalid escape', async () => {
    expect((await render(plans.get('scope-duplicate') as Buffer)).refused).toEqual({
      ambiguous: 1,
    });
    expect((await render(plans.get('scope-escape') as Buffer)).refused).toEqual({ missing: 1 });
  });

  it('keeps a data: image only in <img src>', async () => {
    const { doc, rendered } = await render(plans.get('data-places') as Buffer);
    expect(doc.getElementById('kept')?.getAttribute('src')).toMatch(/^data:image\/gif;base64,/);
    expect(rendered.html.split('data:').length - 1).toBe(1);
  });
});

describe('the perf mix', () => {
  it('has inline images in about a tenth of its messages, and every one shows', async () => {
    let messages = 0;
    let withImages = 0;
    for (const entry of entries('small', { seed: 3 })) {
      if (!('path' in entry) || !entry.path.endsWith('.eml')) continue;
      messages += 1;
      const bytes = entry.data as Buffer;
      const text = bytes.toString('latin1');
      if (!text.includes('multipart/related')) continue;
      withImages += 1;
      expect(bytes.length).toBeLessThanOrEqual(1024 * 1024);
      const cids = text.match(/^Content-ID: /gm)?.length ?? 0;
      const { rendered, refused } = await render(bytes);
      expect(refused).toEqual({});
      expect(rendered.images).toHaveLength(cids);
    }
    expect(withImages / messages).toBeGreaterThan(0.05);
    expect(withImages / messages).toBeLessThan(0.15);
  });
});
