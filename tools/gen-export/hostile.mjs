// SPDX-License-Identifier: AGPL-3.0-or-later
// The hostile corpus: messages and export entries that a mail viewer must
// render safely or reject. Every external reference points at a canary: a
// name under leak-<nonce>.test, an IP from the documentation ranges, or
// loopback. Images are built here, byte by byte; nothing comes from outside.

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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buffer) {
  let a = 1;
  let b = 0;
  for (const byte of buffer) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A 1-bit grayscale PNG that declares width x height pixels but carries one
 * row of image data, in an uncompressed (stored) zlib stream, so its bytes
 * never depend on a zlib version.
 */
export function dimensionBombPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([1, 0, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + Math.ceil(width / 8));
  const stored = Buffer.alloc(5);
  stored[0] = 1;
  stored.writeUInt16LE(row.length, 1);
  stored.writeUInt16LE(~row.length & 0xffff, 3);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(row), 0);
  const zlib = Buffer.concat([Buffer.from([0x78, 0x01]), stored, row, adler]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An animated GIF: a width x height canvas and `frames` 1x1 frames. */
export function gif(width, height, frames) {
  const parts = [Buffer.from('GIF89a', 'ascii')];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen.set([0x80, 0, 0], 4);
  parts.push(screen, Buffer.from([0, 0, 0, 255, 255, 255]));
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0]));
  const frame = Buffer.from([
    0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02,
    0x44, 0x01, 0x00,
  ]);
  for (let i = 0; i < frames; i++) parts.push(frame);
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// --- Messages ------------------------------------------------------------------

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

  const add = (category, name, contentType, body, extra = {}) => {
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
    };
    plans.push(plan);
    return plan;
  };
  const page = (inner, head = '') =>
    `<html><head>${head}</head><body>\r\n${inner}\r\n</body></html>`;
  const htmlType = 'text/html; charset=utf-8';

  // Script and markup.
  const markup = {
    'script-inline': page(`<script>document.title = 'ran';</script><p>text</p>`),
    'script-src': page(`<script src="${url('script.js')}"></script>`),
    'event-handlers': page(
      `<img src="x" onerror="this.src='${url('onerror.png')}'"><div onmouseover="fetch('${url('hover')}')">hover</div>`,
      '',
    ).replace('<body>', `<body onload="new Image().src='${url('onload.png')}'">`),
    'javascript-url': page(
      `<a href="javascript:fetch('${url('js-link')}')">link</a><iframe src="javascript:alert(1)"></iframe>`,
    ),
    'svg-image': page(`<svg><image href="${url('svg-image.png')}" width="10" height="10"/></svg>`),
    'svg-use': page(`<svg><use href="${url('sprite.svg')}#icon"/></svg>`),
    'svg-feimage': page(
      `<svg><filter id="f"><feImage href="${url('feimage.png')}"/></filter><rect filter="url(#f)" width="9" height="9"/></svg>`,
    ),
    srcset: page(
      `<img srcset="${url('srcset-1x.png')} 1x, ${url('srcset-2x.png')} 2x"><picture><source srcset="${url('source.png')}"><img src="cid:none"></picture>`,
    ),
    poster: page(`<video poster="${url('poster.png')}" src="${url('video.mp4')}"></video>`),
    'background-attribute': page(
      `<table background="${url('table-bg.png')}"><tr><td background="${url('td-bg.png')}">cell</td></tr></table>`,
    ).replace('<body>', `<body background="${url('body-bg.png')}">`),
    'css-url': page(
      `<div style="background:url('${url('style-attr.png')}')">x</div>`,
      `<style>p{background-image:url(${url('style-block.png')})}</style>`,
    ),
    'css-image-set': page(
      `<div style="background-image:image-set('${url('set-1x.png')}' 1x, '${url('set-2x.png')}' 2x)">x</div>`,
    ),
    'css-import': page('<p>x</p>', `<style>@import url("${url('import.css')}");</style>`),
    'css-font-face': page(
      '<p style="font-family:Canary">x</p>',
      `<style>@font-face{font-family:Canary;src:url(${url('font.woff2')})}</style>`,
    ),
    'meta-refresh': page(
      '<p>x</p>',
      `<meta http-equiv="refresh" content="0;url=${url('refresh')}">`,
    ),
    base: page(
      '<img src="relative.png"><a href="relative">link</a>',
      `<base href="${url('base/')}">`,
    ),
    form: page(
      `<form action="${url('form')}" method="post"><input name="q" value="1"><button>Send</button></form>`,
    ),
    'link-hints': page(
      '<p>x</p>',
      `<link rel="preconnect" href="https://pc.${host}"><link rel="dns-prefetch" href="//dns.${host}">` +
        `<link rel="prefetch" href="${url('prefetch')}"><link rel="preload" as="image" href="${url('preload.png')}">`,
    ),
    'speculation-rules': page(
      `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${url('spec-prefetch')}"],"eagerness":"eager"}],` +
        `"prerender":[{"source":"list","urls":["${url('spec-prerender')}"],"eagerness":"eager"}]}</script>`,
    ),
    'remote-image': page(`<img src="${url('pixel.png')}" width="1" height="1">`),
    'embedded-content': page(
      `<iframe src="${url('frame')}"></iframe><object data="${url('object')}"></object><embed src="${url('embed')}"><audio src="${url('audio.mp3')}"></audio>`,
    ),
    stylesheet: page('<p>x</p>', `<link rel="stylesheet" href="${url('sheet.css')}">`),
    'anchor-ping': page(`<a href="${url('ping-target')}" ping="${url('ping')}">link</a>`),
  };
  for (const [name, body] of Object.entries(markup)) add('script_markup', name, htmlType, body);

  // IP-literal URLs, as links and as images.
  for (const [name, literal] of IP_LITERAL_FORMS) {
    add(
      'ip_literals',
      name,
      htmlType,
      page(`<a href="http://${literal}/link">link</a> <img src="http://${literal}/image.png">`),
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
    add('malformed_mime', name, type, body);
  add(
    'malformed_mime',
    'bad-quoted-printable',
    'text/plain; charset=utf-8',
    '=ZZ broken =\r\nline=4',
    {
      headers: ['Content-Transfer-Encoding: quoted-printable'],
    },
  );
  add('malformed_mime', 'long-header-line', 'text/plain', 'body', {
    subject: `long ${'x'.repeat(100000)}`,
  });
  add('malformed_mime', 'lf-only', 'text/plain', Buffer.from('line one\nline two\nline three\n'));

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
    add('odd_charsets', charset, `text/plain; charset=${charset}`, bytes);
  }

  // Inputs that are slow to parse or render.
  add(
    'pathological',
    'nested-divs',
    htmlType,
    page(`${'<div>'.repeat(5000)}deep${'</div>'.repeat(5000)}`),
  );
  add(
    'pathological',
    'nested-tables',
    htmlType,
    page(`${'<table><tr><td>'.repeat(1000)}deep${'</td></tr></table>'.repeat(1000)}`),
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
  );
  add('pathological', 'long-line', htmlType, page(`<p>${'word '.repeat(200000)}</p>`));

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
      { attachments: [{ name: `${name}.${type.split('/')[1]}`, type, bytes: bytes.length }] },
    );
  }

  // Export structure.
  add('export_structure', 'unknown-label-ids', 'text/plain', 'unknown labels', {
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
  const symlinkEml = add('export_structure', 'symlink-eml', 'text/plain', 'replaced by a link', {
    skipEml: true,
  });
  extras.push({ path: `${symlinkEml.id}.eml`, type: 'symlink', target: '../../decoy/decoy.eml' });
  const symlinkMeta = add('export_structure', 'symlink-metadata', 'text/plain', 'real eml', {
    skipMetadata: true,
  });
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
    { skipEml: true },
  );
  extras.push({ path: `${symlinkDir.id}.eml`, type: 'symlink', target: '../../decoy' });
  const fifoEml = add('export_structure', 'fifo-eml', 'text/plain', 'replaced by a FIFO', {
    skipEml: true,
  });
  extras.push({ path: `${fifoEml.id}.eml`, type: 'fifo' });
  const fifoMeta = add('export_structure', 'fifo-metadata', 'text/plain', 'real eml', {
    skipMetadata: true,
  });
  extras.push({ path: `${fifoMeta.id}.metadata.json`, type: 'fifo' });
  add('export_structure', 'metadata-only-1', 'text/plain', 'no eml', { skipEml: true });
  add('export_structure', 'metadata-only-2', 'text/plain', 'no eml', { skipEml: true });
  add('export_structure', 'eml-only-1', 'text/plain', 'no metadata', { skipMetadata: true });
  add('export_structure', 'eml-only-2', 'text/plain', 'no metadata', { skipMetadata: true });
  const emptyEml = add('export_structure', 'empty-eml', 'text/plain', 'replaced by an empty file', {
    skipEml: true,
  });
  extras.push({ path: `${emptyEml.id}.eml`, type: 'file', data: Buffer.alloc(0) });
  const badJson = add('export_structure', 'invalid-json', 'text/plain', 'metadata is not JSON', {
    skipMetadata: true,
  });
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
