// SPDX-License-Identifier: AGPL-3.0-or-later
// The hostile corpus: messages and export entries that a mail viewer must
// render safely or reject. Every external reference points at a canary: a
// name under leak-<nonce>.test, an IP from the documentation ranges, or
// loopback. Images are built here, byte by byte; nothing comes from outside.

import {
  apng,
  dimensionBombPng,
  gif,
  gifImage,
  jpegImage,
  paddedPng,
  solidPng,
  webpAnimated,
  webpImage,
} from './images.mjs';
import { Random } from './random.mjs';
import { base64Lines, exportId, rfcDate } from './text.mjs';

/** Canary IPs: documentation ranges only (RFC 5737, RFC 3849). */
export const CANARY_IPS = ['192.0.2.10', '198.51.100.10', '203.0.113.10', '2001:db8::10'];

/** Every way to write 192.0.2.10 and 127.0.0.1 in a URL host. */
export const IP_LITERAL_FORMS = [
  ['ipv4', '192.0.2.10'],
  ['ipv4-decimal', '3221225994'],
  ['ipv4-octal', '0300.0000.0002.0012'],
  ['ipv4-hex', '0xc0.0x0.0x2.0xa'],
  ['ipv4-hex-whole', '0xc000020a'],
  ['ipv4-short-3', '192.0.522'],
  ['ipv4-short-2', '192.522'],
  ['ipv6', '[2001:db8::10]'],
  ['ipv4-mapped', '[::ffff:192.0.2.10]'],
  ['ipv4-mapped-hex', '[::ffff:c000:20a]'],
  ['loopback-ipv4', '127.0.0.1'],
  ['loopback-decimal', '2130706433'],
  ['loopback-octal', '0177.0.0.1'],
  ['loopback-hex', '0x7f000001'],
  ['loopback-short', '127.1'],
  ['loopback-ipv6', '[::1]'],
  ['loopback-mapped', '[::ffff:127.0.0.1]'],
];

// --- Images --------------------------------------------------------------------

export { dimensionBombPng, gif, paddedPng } from './images.mjs';

/**
 * Inline images the raster check must refuse, each as a `cid:` part
 * (`inline_images/cid-<name>`) and as a `data:` image (`inline_images/data-<name>`),
 * by the reason it gives. Each is within 1 MB.
 */
export const INLINE_BOMBS = {
  // 6 frames of a 40 MP canvas: every other limit is met.
  pixels: [() => gifImage(8000, 5000, 6), 'pixels'],
  'apng-count': [() => apng(4, 4, 3, { declared: 2 }), 'container'],
  'apng-frames': [() => apng(1, 1, 1001), 'frames'],
  'webp-frames': [() => webpAnimated(1, 1, 1001), 'frames'],
  'png-truncated': [() => solidPng(8, 8, [0, 0, 0]).subarray(0, -20), 'container'],
  'gif-truncated': [() => gifImage(8, 8, 1, { full: true }).subarray(0, -5), 'container'],
  'webp-truncated': [() => webpImage(8, 8).subarray(0, -4), 'container'],
  'jpeg-canvas': [() => jpegImage(9000, 9000), 'canvas'],
  'gif-outside': [
    () => gifImage(10, 10, 2, { rect: { x: 5, y: 0, width: 10, height: 1 } }),
    'container',
  ],
  'apng-outside': [
    () => apng(10, 10, 2, { rect: { x: 0, y: 5, width: 1, height: 10 } }),
    'container',
  ],
  'webp-outside': [
    () => webpAnimated(10, 10, 2, { rect: { x: 4, y: 0, width: 8, height: 1 } }),
    'container',
  ],
  'jpeg-scans': [() => jpegImage(8, 8, { scans: 101 }), 'frames'],
};

/** The colours of the inline images that must show, for a pixel check. */
export const INLINE_COLORS = {
  cid: [0, 160, 80],
  data: [200, 0, 160],
  first: [220, 30, 30],
  second: [30, 30, 220],
};

// --- Messages ------------------------------------------------------------------

/** Script that runs anywhere sets this attribute on the root element and logs this line. */
export const SCRIPT_MARKER = 'pev-script-marker';
export const MARKER_ATTRIBUTE = 'data-pev-script';
const MARKER_JS = `document.documentElement.setAttribute('${MARKER_ATTRIBUTE}','ran');console.log('${SCRIPT_MARKER}')`;

/**
 * What a message's body refers to. Every hostile message declares it next to
 * its definition:
 * - `rewrite`: how many distinct remote URLs the sanitizer must rewrite to
 *   placeholders: `src`, `srcset`, `background`, `poster` and CSS image
 *   `url()`/`image-set()` on what it keeps;
 * - `loads`: the remote references a browser fetches or reports when the body
 *   is served unsanitized, with the header CSP and the frame sandbox in place.
 *   An item that is a list names alternatives, of which the browser picks one
 *   (by pixel density, as for `srcset`). URLs are as written; compare them
 *   after URL parsing;
 * - `hints`: DNS-only hints (`dns-prefetch`, `preconnect`). They are no load
 *   but must not survive the sanitizer.
 */
function refs(rewrite, loads = [], hints = []) {
  return { rewrite, loads, hints };
}

export function checkRefs(where, declared) {
  const ok =
    declared &&
    Number.isSafeInteger(declared.rewrite) &&
    declared.rewrite >= 0 &&
    Array.isArray(declared.loads) &&
    declared.loads.every(
      (l) =>
        typeof l === 'string' ||
        (Array.isArray(l) && l.length > 1 && l.every((a) => typeof a === 'string')),
    ) &&
    Array.isArray(declared.hints) &&
    declared.hints.every((h) => typeof h === 'string');
  if (!ok) throw new Error(`${where}: no valid reference declaration`);
}

function crlf(lines) {
  return lines.join('\r\n');
}

/**
 * The hostile messages and the extra export entries. Returns
 * {plans, extras, counts}: plans carry ready-made .eml bytes.
 */
export function hostileMessages({ seed, nonce, labelInfo, owner }) {
  if (!/^[a-z0-9]{6,32}$/.test(nonce ?? '')) {
    throw new Error('the hostile profile needs --nonce: 6 to 32 lowercase letters and digits');
  }
  const rng = new Random(`plan/hostile/${seed}/${nonce}`);
  const host = `leak-${nonce}.test`;
  const url = (path) => `https://${host}/${path}`;
  const plans = [];
  const extras = [];
  const counts = {};
  let time = Date.UTC(2024, 0, 1) / 1000;
  const sender = { Name: 'Hostile Sender', Address: 'sender@example.org' };

  const add = (category, name, contentType, body, declared, extra = {}) => {
    checkRefs(`${category}/${name}`, declared);
    counts[category] = (counts[category] ?? 0) + 1;
    time += 600;
    const id = exportId(rng);
    const messageId = `${category}.${name}.${nonce}@example.org`;
    const header = [
      `Date: ${rfcDate(time)}`,
      `From: ${sender.Name} <${sender.Address}>`,
      `To: <${owner.Address}>`,
      `Subject: ${extra.subject ?? `${category}: ${name}`}`,
      `Message-ID: <${messageId}>`,
      `References: <${id}@protonmail.internalid>`,
      'MIME-Version: 1.0',
      ...(contentType ? [`Content-Type: ${contentType}`] : []),
      ...(extra.headers ?? []),
    ];
    const head = Buffer.from(`${crlf(header)}\r\n\r\n`);
    const data = Buffer.concat([head, Buffer.isBuffer(body) ? body : Buffer.from(`${body}\r\n`)]);
    const plan = {
      key: `hostile/${seed}/${nonce}/${category}/${name}`,
      id,
      messageId,
      inReplyTo: null,
      references: null,
      time,
      direction: 'received',
      from: sender,
      to: [owner],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: extra.subject ?? `${category}: ${name}`,
      labels: extra.labels ?? ['0', '5'],
      unread: 1,
      replied: 0,
      repliedAll: 0,
      forwarded: 0,
      attachments: extra.attachments ?? [],
      externalId: true,
      minimal: true,
      emlData: data,
      mimeType: contentType?.split(';')[0] ?? 'text/plain',
      skipEml: extra.skipEml,
      skipMetadata: extra.skipMetadata,
      refs: declared,
    };
    plans.push(plan);
    return plan;
  };
  const page = (inner, head = '') =>
    `<html><head>${head}</head><body>\r\n${inner}\r\n</body></html>`;
  const htmlType = 'text/html; charset=utf-8';

  // Script and markup.
  const markup = {
    'script-inline': [
      page(`<script>document.title = 'ran';${MARKER_JS}</script><p>text</p>`),
      refs(0),
    ],
    'script-src': [
      page(`<script src="${url('script.js')}"></script><script>${MARKER_JS}</script>`),
      refs(0),
    ],
    'event-handlers': [
      page(
        `<img src="x" onerror="${MARKER_JS};this.src='${url('onerror.png')}'"><div onmouseover="${MARKER_JS};fetch('${url('hover')}')">hover</div>`,
        '',
      ).replace('<body>', `<body onload="${MARKER_JS};new Image().src='${url('onload.png')}'">`),
      refs(0),
    ],
    'javascript-url': [
      page(
        `<a href="javascript:${MARKER_JS};fetch('${url('js-link')}')">link</a><iframe src="javascript:${MARKER_JS}"></iframe>`,
      ),
      refs(0),
    ],
    'svg-image': [
      page(`<svg><image href="${url('svg-image.png')}" width="10" height="10"/></svg>`),
      refs(0, [url('svg-image.png')]),
    ],
    'svg-use': [page(`<svg><use href="${url('sprite.svg')}#icon"/></svg>`), refs(0)],
    'svg-feimage': [
      page(
        `<svg><filter id="f"><feImage href="${url('feimage.png')}"/></filter><rect filter="url(#f)" width="9" height="9"/></svg>`,
      ),
      refs(0, [url('feimage.png')]),
    ],
    srcset: [
      page(
        `<img srcset="${url('srcset-1x.png')} 1x, ${url('srcset-2x.png')} 2x"><picture><source srcset="${url('source.png')}"><img src="cid:none"></picture>`,
      ),
      refs(3, [[url('srcset-1x.png'), url('srcset-2x.png')], url('source.png')]),
    ],
    poster: [
      page(`<video poster="${url('poster.png')}" src="${url('video.mp4')}"></video>`),
      refs(2, [url('poster.png'), url('video.mp4')]),
    ],
    'background-attribute': [
      page(
        `<table background="${url('table-bg.png')}"><tr><td background="${url('td-bg.png')}">cell</td></tr></table>`,
      ).replace('<body>', `<body background="${url('body-bg.png')}">`),
      refs(3, [url('body-bg.png'), url('table-bg.png'), url('td-bg.png')]),
    ],
    'css-url': [
      page(
        `<div style="background:url('${url('style-attr.png')}')">x</div>`,
        `<style>p{background-image:url(${url('style-block.png')})}</style>`,
      ),
      // Nothing matches the <style> rule, so only the attribute's image loads.
      refs(2, [url('style-attr.png')]),
    ],
    'css-image-set': [
      page(
        `<div style="background-image:image-set('${url('set-1x.png')}' 1x, '${url('set-2x.png')}' 2x)">x</div>`,
      ),
      refs(2, [[url('set-1x.png'), url('set-2x.png')]]),
    ],
    'css-import': [
      page('<p>x</p>', `<style>@import url("${url('import.css')}");</style>`),
      refs(0, [url('import.css')]),
    ],
    'css-font-face': [
      page(
        '<p style="font-family:Canary">x</p>',
        `<style>@font-face{font-family:Canary;src:url(${url('font.woff2')})}</style>`,
      ),
      refs(0, [url('font.woff2')]),
    ],
    'meta-refresh': [
      page('<p>x</p>', `<meta http-equiv="refresh" content="0;url=${url('refresh')}">`),
      refs(0),
    ],
    base: [
      page('<img src="relative.png"><a href="relative">link</a>', `<base href="${url('base/')}">`),
      // The header CSP refuses the base URL, and reports it.
      refs(0, [url('base/')]),
    ],
    form: [
      page(
        `<form action="${url('form')}" method="post"><input name="q" value="1"><button>Send</button></form>`,
      ),
      refs(0),
    ],
    'link-hints': [
      page(
        '<p>x</p>',
        `<link rel="preconnect" href="https://pc.${host}"><link rel="dns-prefetch" href="//dns.${host}">` +
          `<link rel="prefetch" href="${url('prefetch')}"><link rel="preload" as="image" href="${url('preload.png')}">`,
      ),
      refs(0, [url('prefetch'), url('preload.png')], [`https://pc.${host}`, `//dns.${host}`]),
    ],
    'dns-prefetch-control': [
      page(
        `<a href="https://dns-link.${host}/">link</a>`,
        `<meta http-equiv="x-dns-prefetch-control" content="on"><link rel="dns-prefetch" href="//dns-control.${host}">`,
      ),
      // With prefetching on, the link's host is a DNS hint too.
      refs(0, [], [`//dns-control.${host}`, `https://dns-link.${host}/`]),
    ],
    'speculation-rules': [
      page(
        `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${url('spec-prefetch')}"],"eagerness":"eager"}],` +
          `"prerender":[{"source":"list","urls":["${url('spec-prerender')}"],"eagerness":"eager"}]}</script>`,
      ),
      refs(0),
    ],
    'remote-image': [
      page(`<img src="${url('pixel.png')}" width="1" height="1">`),
      refs(1, [url('pixel.png')]),
    ],
    'embedded-content': [
      page(
        `<iframe src="${url('frame')}"></iframe><object data="${url('object')}"></object><embed src="${url('embed')}"><audio src="${url('audio.mp3')}"></audio>`,
      ),
      // The CSP reports a refused frame by its origin only.
      refs(1, [`https://${host}/`, url('object'), url('embed'), url('audio.mp3')]),
    ],
    stylesheet: [
      page('<p>x</p>', `<link rel="stylesheet" href="${url('sheet.css')}">`),
      refs(0, [url('sheet.css')]),
    ],
    'anchor-ping': [
      page(`<a href="${url('ping-target')}" ping="${url('ping')}">link</a>`),
      refs(0),
    ],
  };
  for (const [name, [body, declared]] of Object.entries(markup))
    add('script_markup', name, htmlType, body, declared);

  // CSS the filter must drop or keep.
  const css = {
    behavior: [page(`<p style="behavior:url(${url('behavior.htc')})">x</p>`), refs(0)],
    'moz-binding': [page(`<p style="-moz-binding:url(${url('binding.xml')}#b)">x</p>`), refs(0)],
    expression: [page(`<p style="width:expression(fetch('${url('expression')}'))">x</p>`), refs(0)],
    'position-fixed': [
      page('<div style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:9">cover</div>'),
      refs(0),
    ],
    keyframes: [
      page(
        '<p>x</p>',
        `<style>@keyframes k{from{background-image:url(${url('keyframes.png')})}}p{animation:k 1s}</style>`,
      ),
      refs(0, [url('keyframes.png')]),
    ],
    supports: [
      page(
        '<p>x</p>',
        `<style>@supports (display:block){p{background-image:url(${url('supports.png')})}}</style>`,
      ),
      refs(0, [url('supports.png')]),
    ],
    namespace: [
      page('<p>x</p>', `<style>@namespace url(${url('namespace')});p{color:red}</style>`),
      refs(0),
    ],
    page: [
      page('<p>x</p>', `<style>@page{background-image:url(${url('page.png')})}</style>`),
      refs(0),
    ],
    'media-url': [
      page(
        '<p>x</p>',
        `<style>@media screen{p{background-image:url(${url('media.png')})}}</style>`,
      ),
      refs(1, [url('media.png')]),
    ],
  };
  for (const [name, [body, declared]] of Object.entries(css))
    add('css', name, htmlType, body, declared);

  // data: URIs on links and images.
  const dataHtml = `data:text/html,${encodeURIComponent(`<script>${MARKER_JS}</script>`)}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
    `<image href="${url('data-svg.png')}" width="10" height="10"/><script>${MARKER_JS}</script></svg>`;
  const dataSvg = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const fakePng = `data:image/png;base64,${Buffer.from('not an image at all').toString('base64')}`;
  const largePng = `data:image/png;base64,${paddedPng(1024 * 1024 + 4096).toString('base64')}`;
  const dataUris = {
    'html-link': [page(`<a href="${dataHtml}">link</a>`), refs(0)],
    'html-image': [page(`<img src="${dataHtml}" width="10" height="10">`), refs(0)],
    'svg-link': [page(`<a href="${dataSvg}">link</a>`), refs(0)],
    'svg-image': [page(`<img src="${dataSvg}" width="10" height="10">`), refs(0)],
    'fake-png': [page(`<img src="${fakePng}" width="10" height="10">`), refs(0)],
    'large-png': [page(`<img src="${largePng}" width="10" height="10">`), refs(0)],
  };
  for (const [name, [body, declared]] of Object.entries(dataUris))
    add('data_uris', name, htmlType, body, declared);

  // Links whose text or host misleads.
  const links = {
    'text-names-other-host': [
      page(`<a href="${url('real')}">https://bank.${host}/login</a>`),
      refs(0),
    ],
    'idn-host': [page(`<a href="https://bücher.${host}/">bücher</a>`), refs(0)],
    'mixed-script-host': [page(`<a href="https://pаypal.${host}/">paypal</a>`), refs(0)],
  };
  for (const [name, [body, declared]] of Object.entries(links))
    add('links', name, htmlType, body, declared);

  // Plain text with markup and URLs, and a message with both forms.
  add(
    'plain_text',
    'markup-and-urls',
    'text/plain; charset=utf-8',
    crlf([
      `<script>${MARKER_JS}</script> <b>bold?</b> <img src="${url('plain.png')}">`,
      `javascript:${MARKER_JS}`,
      `http://192.0.2.10/plain http://[2001:db8::10]/plain http://0x7f000001/plain`,
      `${url('plain-link')} and mailto:someone@${host}`,
    ]),
    refs(0),
  );
  add(
    'plain_text',
    'alternative',
    'multipart/alternative; boundary="alt"',
    crlf([
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      `The plain form, with a link: ${url('alt-link')}`,
      '--alt',
      `Content-Type: ${htmlType}`,
      '',
      page(`<p>The HTML form.</p><img src="${url('alt.png')}"><script>${MARKER_JS}</script>`),
      '--alt--',
    ]),
    refs(1, [url('alt.png')]),
  );

  // IP-literal URLs, as links and as images.
  for (const [name, literal] of IP_LITERAL_FORMS) {
    add(
      'ip_literals',
      name,
      htmlType,
      page(`<a href="http://${literal}/link">link</a> <img src="http://${literal}/image.png">`),
      refs(1, [`http://${literal}/image.png`]),
    );
  }

  // Malformed MIME and odd charsets.
  const malformed = {
    'no-boundary': ['multipart/mixed', 'text without any boundary'],
    'unclosed-multipart': [
      'multipart/mixed; boundary="b1"',
      crlf(['--b1', 'Content-Type: text/plain', '', 'first part, never closed']),
    ],
    'bad-base64': [
      'multipart/mixed; boundary="b2"',
      crlf([
        '--b2',
        'Content-Type: text/plain',
        'Content-Transfer-Encoding: base64',
        '',
        'This is not base64 !!! ====',
        '--b2--',
      ]),
    ],
    'garbage-content-type': [';;;=;', 'body'],
    'deep-multipart': [
      'multipart/mixed; boundary="d0"',
      (() => {
        const lines = [];
        for (let i = 0; i < 60; i++) {
          lines.push(`--d${i}`, `Content-Type: multipart/mixed; boundary="d${i + 1}"`, '');
        }
        lines.push('--d60', 'Content-Type: text/plain', '', 'deepest');
        for (let i = 60; i >= 0; i--) lines.push(`--d${i}--`);
        return crlf(lines);
      })(),
    ],
  };
  for (const [name, [type, body]] of Object.entries(malformed))
    add('malformed_mime', name, type, body, refs(0));
  add(
    'malformed_mime',
    'bad-quoted-printable',
    'text/plain; charset=utf-8',
    '=ZZ broken =\r\nline=4',
    refs(0),
    {
      headers: ['Content-Transfer-Encoding: quoted-printable'],
    },
  );
  add('malformed_mime', 'long-header-line', 'text/plain', 'body', refs(0), {
    subject: `long ${'x'.repeat(100000)}`,
  });
  add(
    'malformed_mime',
    'lf-only',
    'text/plain',
    Buffer.from('line one\nline two\nline three\n'),
    refs(0),
  );

  const charsets = {
    'iso-8859-1': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65]),
    'windows-1252': Buffer.from([0x93, 0x71, 0x75, 0x6f, 0x74, 0x65, 0x64, 0x94, 0x20, 0x80]),
    'iso-2022-jp': Buffer.from([0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x1b, 0x28, 0x42]),
    shift_jis: Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]),
    'koi8-r': Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]),
    'utf-16': Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]),
    'utf-7': Buffer.from('Hi Mom -+Jjo--!', 'ascii'),
    'x-made-up': Buffer.from([0xc3, 0x28, 0xa0, 0xa1]),
  };
  for (const [charset, bytes] of Object.entries(charsets)) {
    add('odd_charsets', charset, `text/plain; charset=${charset}`, bytes, refs(0));
  }

  // Inputs that are slow to parse or render.
  add(
    'pathological',
    'nested-divs',
    htmlType,
    page(`${'<div>'.repeat(5000)}deep${'</div>'.repeat(5000)}`),
    refs(0),
  );
  add(
    'pathological',
    'nested-tables',
    htmlType,
    page(`${'<table><tr><td>'.repeat(1000)}deep${'</td></tr></table>'.repeat(1000)}`),
    refs(0),
  );
  {
    const rules = [];
    for (let i = 0; rules.join('\n').length < 400000; i++)
      rules.push(`.c${i} > p ~ span + a { color: #${(i % 4096).toString(16).padStart(3, '0')} }`);
    add(
      'pathological',
      'huge-style',
      htmlType,
      page('<p class="c1">x</p>', `<style>\n${rules.join('\n')}\n</style>`),
      refs(0),
    );
  }
  add(
    'pathological',
    'regex-heavy-css',
    htmlType,
    page(
      `<p>x</p>`,
      `<style>${':not('.repeat(200)}p${')'.repeat(200)}{color:red} ` +
        `[title*="${'a'.repeat(5000)}"]{color:blue} ` +
        `${'div '.repeat(2000)}p{color:green}</style>`,
    ),
    refs(0),
  );
  add('pathological', 'long-line', htmlType, page(`<p>${'word '.repeat(200000)}</p>`), refs(0));

  // Attachments with hostile file names, and image bombs.
  const names = [
    ['rtlo', 'invoice‮fdp.exe'],
    ['reserved-con', 'CON'],
    ['reserved-nul', 'NUL.txt'],
    ['reserved-com1', 'COM1'],
    ['reserved-aux', 'aux.pdf'],
    ['traversal', '../../etc/passwd'],
    ['separators', 'a/b\\c:d*e?f"g<h>i|j'],
    ['leading-dot', '.bashrc'],
    ['leading-dash', '-rf'],
    ['trailing-dot-space', 'report.pdf. '],
    ['control-chars', 'bell\u0007tab\tnul.txt'],
    ['long', `${'n'.repeat(300)}.txt`],
    ['decomposed', 'café.txt'],
  ];
  for (const [name, filename] of names) {
    const b = `h-${name}`;
    const star = `UTF-8''${encodeURIComponent(filename)}`;
    add(
      'attachments_images',
      `filename-${name}`,
      `multipart/mixed; boundary="${b}"`,
      crlf([
        `--${b}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        'See the attachment.',
        `--${b}`,
        `Content-Type: application/octet-stream; name*=${star}`,
        `Content-Disposition: attachment; filename*=${star}`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(Buffer.from('attachment\n')),
        `--${b}--`,
      ]),
      refs(0),
      { attachments: [{ name: filename, type: 'application/octet-stream', bytes: 11 }] },
    );
  }
  const bombs = {
    'png-dimensions': ['image/png', dimensionBombPng(30000, 30000)],
    'png-aspect': ['image/png', dimensionBombPng(100000, 1)],
    'gif-frames': ['image/gif', gif(1, 1, 3000)],
    'gif-canvas': ['image/gif', gif(65535, 65535, 1)],
  };
  for (const [name, [type, bytes]] of Object.entries(bombs)) {
    const b = `r-${name}`;
    add(
      'attachments_images',
      `bomb-${name}`,
      `multipart/related; boundary="${b}"`,
      crlf([
        `--${b}`,
        `Content-Type: ${htmlType}`,
        '',
        `<html><body><img src="cid:${name}@example.org"></body></html>`,
        `--${b}`,
        `Content-Type: ${type}`,
        `Content-ID: <${name}@example.org>`,
        'Content-Disposition: inline',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(bytes),
        `--${b}--`,
      ]),
      // The image is a cid: part, not a remote reference.
      refs(0),
      { attachments: [{ name: `${name}.${type.split('/')[1]}`, type, bytes: bytes.length }] },
    );
  }

  // Inline images: cid: parts and data: images, shown only if they pass the
  // raster check, and cid: references resolved in their HTML part's branch.
  const inlineHtml = (inner) => page(inner);
  const imagePart = (cid, bytes, type = 'image/png') => [
    `Content-Type: ${type}`,
    `Content-ID: <${cid}>`,
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(bytes),
  ];
  const htmlPart = (inner) => [`Content-Type: ${htmlType}`, '', inlineHtml(inner)];
  /** A multipart body of the given parts, each a list of lines; nested ones are [type, parts]. */
  const multipart = (type, parts, name) => {
    const b = `i-${name}-${type.split('/')[1]}`;
    const lines = [];
    for (const part of parts) {
      lines.push(`--${b}`);
      if (Array.isArray(part[0])) {
        const [innerType, innerParts] = part[0];
        const inner = multipart(innerType, innerParts, `${name}-${lines.length}`);
        lines.push(`Content-Type: ${innerType}; boundary="${inner.boundary}"`, '', inner.body);
      } else {
        lines.push(...part);
      }
    }
    lines.push(`--${b}--`);
    return { boundary: b, body: crlf(lines) };
  };
  const addInline = (name, type, parts) => {
    const { boundary, body } = multipart(type, parts, name);
    add('inline_images', name, `${type}; boundary="${boundary}"`, body, refs(0));
  };
  const img = (id, src, size = 40) =>
    `<img id="${id}" alt="" width="${size}" height="${size}" src="${src}">`;

  for (const [name, [make, reason]] of Object.entries(INLINE_BOMBS)) {
    const bytes = make();
    const cid = `${name}@example.org`;
    addInline(`cid-${name}`, 'multipart/related', [
      htmlPart(`<p>${reason}</p>${img('bomb', `cid:${cid}`)}`),
      imagePart(cid, bytes),
    ]);
    add(
      'inline_images',
      `data-${name}`,
      htmlType,
      page(`<p>${reason}</p>${img('bomb', `data:image/png;base64,${bytes.toString('base64')}`)}`),
      refs(0),
    );
  }
  const color = (which) => INLINE_COLORS[which];
  addInline('cid-valid', 'multipart/related', [
    htmlPart(img('inline', 'cid:valid@example.org')),
    imagePart('valid@example.org', solidPng(40, 40, color('cid'))),
  ]);
  add(
    'inline_images',
    'data-valid',
    htmlType,
    page(
      img(
        'inline',
        `data:image/gif;base64,${gifImage(40, 40, 1, { rgb: color('data'), full: true }).toString('base64')}`,
      ),
    ),
    refs(0),
  );
  // The same Content-ID in two alternatives: each HTML part shows its own.
  for (const [name, wrapper] of [
    ['scope-related', 'multipart/related'],
    ['scope-mixed', 'multipart/mixed'],
  ]) {
    addInline(name, 'multipart/alternative', [
      [
        [
          wrapper,
          [
            htmlPart(img('first', 'cid:same@example.org')),
            imagePart('same@example.org', solidPng(40, 40, color('first'))),
          ],
        ],
      ],
      [
        [
          wrapper,
          [
            htmlPart(img('second', 'cid:same@example.org')),
            imagePart('same@example.org', solidPng(40, 40, color('second'))),
          ],
        ],
      ],
    ]);
  }
  // Two parts in reach with one Content-ID, and an invalid escape: nothing shows.
  addInline('scope-duplicate', 'multipart/related', [
    htmlPart(img('duplicate', 'cid:twice@example.org')),
    imagePart('twice@example.org', solidPng(40, 40, color('first'))),
    imagePart('twice@example.org', solidPng(40, 40, color('second'))),
  ]);
  addInline('scope-escape', 'multipart/related', [
    htmlPart(img('escape', 'cid:%zz@example.org')),
    imagePart('%zz@example.org', solidPng(40, 40, color('first'))),
  ]);
  // A data: image stays only in <img src>.
  const dot = `data:image/gif;base64,${gifImage(4, 4, 1, { rgb: color('data'), full: true }).toString('base64')}`;
  add(
    'inline_images',
    'data-places',
    htmlType,
    page(
      [
        img('kept', dot),
        `<img id="srcset" alt="" srcset="${dot} 1x">`,
        `<picture><source srcset="${dot}"><img alt="" id="picture" src="cid:none"></picture>`,
        `<table id="table" background="${dot}"><tr><td>cell</td></tr></table>`,
        `<video id="video" poster="${dot}"></video>`,
        `<div id="css" style="background:url('${dot}')">css</div>`,
        `<div id="set" style="background-image:image-set('${dot}' 1x)">set</div>`,
        `<style>p{background:url(${dot})}</style><p>style sheet</p>`,
        `<input type="image" src="${dot}">`,
        `<svg><image href="${dot}" width="4" height="4"/></svg>`,
      ].join(''),
    ),
    refs(0),
  );

  // Export structure.
  add('export_structure', 'unknown-label-ids', 'text/plain', 'unknown labels', refs(0), {
    labels: ['0', '5', '22', '24', 'NotALabel=='],
  });
  counts.export_structure_nested_labels = labelInfo.file.Payload.filter((l) => l.ParentID).length;
  extras.push(
    { base: 'root', path: 'decoy', type: 'dir' },
    {
      base: 'root',
      path: 'decoy/decoy.eml',
      type: 'file',
      data: Buffer.from('Subject: decoy\r\n\r\ndecoy\r\n'),
    },
    {
      base: 'root',
      path: 'decoy/decoy.metadata.json',
      type: 'file',
      data: Buffer.from('{"Version":1,"Payload":{"ID":"decoy"}}'),
    },
  );
  const symlinkEml = add(
    'export_structure',
    'symlink-eml',
    'text/plain',
    'replaced by a link',
    refs(0),
    {
      skipEml: true,
    },
  );
  extras.push({ path: `${symlinkEml.id}.eml`, type: 'symlink', target: '../../decoy/decoy.eml' });
  const symlinkMeta = add(
    'export_structure',
    'symlink-metadata',
    'text/plain',
    'real eml',
    refs(0),
    {
      skipMetadata: true,
    },
  );
  extras.push(
    {
      path: 'decoy-target.metadata.txt',
      type: 'file',
      data: Buffer.from('{"Version":1,"Payload":{"ID":"decoy-target"}}'),
    },
    {
      path: `${symlinkMeta.id}.metadata.json`,
      type: 'symlink',
      target: 'decoy-target.metadata.txt',
    },
  );
  const symlinkDir = add(
    'export_structure',
    'symlink-directory',
    'text/plain',
    'link to a folder',
    refs(0),
    { skipEml: true },
  );
  extras.push({ path: `${symlinkDir.id}.eml`, type: 'symlink', target: '../../decoy' });
  const fifoEml = add('export_structure', 'fifo-eml', 'text/plain', 'replaced by a FIFO', refs(0), {
    skipEml: true,
  });
  extras.push({ path: `${fifoEml.id}.eml`, type: 'fifo' });
  const fifoMeta = add('export_structure', 'fifo-metadata', 'text/plain', 'real eml', refs(0), {
    skipMetadata: true,
  });
  extras.push({ path: `${fifoMeta.id}.metadata.json`, type: 'fifo' });
  add('export_structure', 'metadata-only-1', 'text/plain', 'no eml', refs(0), { skipEml: true });
  add('export_structure', 'metadata-only-2', 'text/plain', 'no eml', refs(0), { skipEml: true });
  add('export_structure', 'eml-only-1', 'text/plain', 'no metadata', refs(0), {
    skipMetadata: true,
  });
  add('export_structure', 'eml-only-2', 'text/plain', 'no metadata', refs(0), {
    skipMetadata: true,
  });
  const emptyEml = add(
    'export_structure',
    'empty-eml',
    'text/plain',
    'replaced by an empty file',
    refs(0),
    {
      skipEml: true,
    },
  );
  extras.push({ path: `${emptyEml.id}.eml`, type: 'file', data: Buffer.alloc(0) });
  const badJson = add(
    'export_structure',
    'invalid-json',
    'text/plain',
    'metadata is not JSON',
    refs(0),
    {
      skipMetadata: true,
    },
  );
  extras.push({
    path: `${badJson.id}.metadata.json`,
    type: 'file',
    data: Buffer.from('{"Version":1,"Payload":{"ID":'),
  });
  const wrongTypes = add(
    'export_structure',
    'wrong-types',
    'text/plain',
    'metadata has wrong types',
    refs(0),
    { skipMetadata: true },
  );
  extras.push({
    path: `${wrongTypes.id}.metadata.json`,
    type: 'file',
    data: Buffer.from(
      JSON.stringify({
        Version: '1',
        Payload: { ID: 7, Time: 'yesterday', LabelIDs: 'Inbox', Size: -1 },
      }),
    ),
  });
  extras.push({ path: 'notes.txt', type: 'file', data: Buffer.from('not part of any pair\n') });
  counts.export_structure_extra_files = extras.filter((e) => e.type === 'file' && !e.base).length;

  return { plans, extras, counts };
}
