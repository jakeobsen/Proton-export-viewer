// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { isRisky, typeLabel } from '../../src/shared/attachment-types';
import {
  FALLBACK_NAME,
  MAX_NAME_BYTES,
  MAX_NAME_CHARS,
  boundedName,
  cleanFilename,
  extensionOf,
} from '../../src/shared/filename';
import { hostileMessages } from '../../tools/gen-export/hostile.mjs';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const chars = (s: string) => [...s].length;

describe('cleanFilename', () => {
  it('composes the name (NFC)', () => {
    expect(cleanFilename('cafe\u0301.txt')).toBe('caf\u00e9.txt');
  });

  it('removes controls, bidi controls, zero-width and format characters', () => {
    expect(cleanFilename('bell\u0007tab\tnul.txt')).toBe('belltabnul.txt');
    expect(cleanFilename('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
    for (const ch of [
      '\u200b',
      '\u200c',
      '\u200d',
      '\u2060',
      '\ufeff',
      '\u200e',
      '\u200f',
      '\u061c',
      '\u202a',
      '\u202b',
      '\u202c',
      '\u202d',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
      '\u0085',
      '\u009f',
      '\u007f',
    ]) {
      expect(cleanFilename(`a${ch}b.pdf`), JSON.stringify(ch)).toBe('ab.pdf');
    }
  });

  it('turns path separators and look-alike slashes into _', () => {
    expect(cleanFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(cleanFilename('a/b\\c:d.txt')).toBe('a_b_c_d.txt');
    expect(cleanFilename('a∕b／c.txt')).toBe('a_b_c.txt');
  });

  it('removes leading dots and dashes, and trailing dots and spaces', () => {
    expect(cleanFilename('.bashrc')).toBe('bashrc');
    expect(cleanFilename('-rf')).toBe('rf');
    expect(cleanFilename('..--.x.pdf')).toBe('x.pdf');
    expect(cleanFilename('report.pdf. ')).toBe('report.pdf');
    expect(cleanFilename('report.pdf...')).toBe('report.pdf');
  });

  it('prefixes names Windows reserves, in any case and with any extension', () => {
    for (const [raw, clean] of [
      ['CON', '_CON'],
      ['con.TXT', '_con.TXT'],
      ['NUL.txt', '_NUL.txt'],
      ['COM1', '_COM1'],
      ['Lpt9.log', '_Lpt9.log'],
      ['aux.pdf', '_aux.pdf'],
      ['prn.tar.gz', '_prn.tar.gz'],
    ]) {
      expect(cleanFilename(raw!), raw).toBe(clean);
    }
    for (const name of ['console.txt', 'com10.txt', 'lpt0', 'auxiliary.pdf', 'nul_.txt']) {
      expect(cleanFilename(name), name).toBe(name);
    }
  });

  it('gives "attachment" for a name that is empty, or dots only, after cleaning', () => {
    for (const raw of ['', '...', '. . .', '\u200b\u202e', '\u0007', ' ', '-', '.-.']) {
      expect(cleanFilename(raw), JSON.stringify(raw)).toBe(FALLBACK_NAME);
    }
  });

  it('keeps at most 200 characters and 255 bytes, with the final extension whole', () => {
    const long = cleanFilename(`${'n'.repeat(300)}.txt`);
    expect(long).toBe(`${'n'.repeat(MAX_NAME_CHARS - 4)}.txt`);
    // Three bytes a character: the byte bound comes first, on a character boundary.
    const wide = cleanFilename(`${'文'.repeat(150)}.pdf`);
    expect(bytes(wide)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(wide).toBe(`${'文'.repeat(83)}.pdf`);
    // Four bytes a character, two UTF-16 units each: never half a pair.
    const emoji = cleanFilename(`${'\u{1F600}'.repeat(100)}.png`);
    expect(bytes(emoji)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(emoji).toBe(`${'\u{1F600}'.repeat(62)}.png`);
    // No lone surrogate.
    expect(emoji).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
  });

  it('keeps a long extension of up to 20 characters, and cuts a longer one as part of the name', () => {
    const ext = `.${'e'.repeat(20)}`;
    expect(cleanFilename(`${'n'.repeat(300)}${ext}`)).toBe(`${'n'.repeat(179)}${ext}`);
    const longer = cleanFilename(`n.${'e'.repeat(300)}`);
    expect(chars(longer)).toBe(MAX_NAME_CHARS);
    expect(extensionOf(longer)).toBe('');
  });

  it('cleans every hostile attachment name of the test corpus to a safe name', () => {
    const plans = hostileMessages({
      seed: 1,
      nonce: 'names1',
      labelInfo: { file: { Payload: [] } },
      owner: { Name: 'Owner', Address: 'owner@example.com' },
    }).plans;
    const names = plans.flatMap((p) => p.attachments.map((a) => a.name));
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const name of names) {
      const clean = cleanFilename(name);
      expect(clean, name).toBe(clean.normalize('NFC'));
      expect(clean, name).not.toMatch(/[/\\:\p{Cc}\p{Cf}]/u);
      expect(clean, name).not.toMatch(/^[.-]|[. ]$/);
      expect(clean, name).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i);
      expect(chars(clean), name).toBeLessThanOrEqual(MAX_NAME_CHARS);
      expect(bytes(clean), name).toBeLessThanOrEqual(MAX_NAME_BYTES);
      expect(clean, name).not.toBe('');
    }
  });
});

describe('boundedName', () => {
  it('puts a suffix before the extension and cuts the stem to make room', () => {
    expect(boundedName('report.pdf', ' (2)')).toBe('report (2).pdf');
    expect(boundedName('README', ' (3)')).toBe('README (3)');
    const full = `${'n'.repeat(MAX_NAME_CHARS - 4)}.txt`;
    expect(boundedName(full, ' (12)')).toBe(`${'n'.repeat(MAX_NAME_CHARS - 9)} (12).txt`);
    const wide = `${'文'.repeat(83)}.pdf`;
    const numbered = boundedName(wide, ' (2)');
    expect(bytes(numbered)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(numbered).toBe(`${'文'.repeat(82)} (2).pdf`);
  });
});

describe('typeLabel and isRisky', () => {
  it('labels images by the format their bytes have', () => {
    expect(typeLabel('photo.jpg', 'jpeg')).toBe('JPEG image');
    expect(typeLabel('photo.jpg', 'png')).toBe('PNG image');
    expect(typeLabel('scan', 'gif')).toBe('GIF image');
    expect(typeLabel('x.exe', 'webp')).toBe('WebP image');
    // Not an image by its bytes: the extension says nothing about the content.
    expect(typeLabel('photo.jpg', null)).toBe('File');
  });

  it('labels everything else by its cleaned final extension, from a fixed map', () => {
    expect(typeLabel('a.PDF', null)).toBe('PDF document');
    expect(typeLabel('notes.txt', null)).toBe('Text');
    expect(typeLabel('invite.ics', null)).toBe('Calendar invite');
    for (const ext of ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']) {
      expect(typeLabel(`a.${ext}`, null), ext).toBe('Archive');
    }
    expect(typeLabel('setup.EXE', null)).toBe('Windows program');
    expect(typeLabel('run.ps1', null)).toBe('Windows program');
    expect(typeLabel('tool.jar', null)).toBe('Program');
    expect(typeLabel('page.html', null)).toBe('Program');
    expect(typeLabel('data.bin', null)).toBe('File');
    expect(typeLabel('README', null)).toBe('File');
  });

  it('marks the risky extensions, in any case, by the final extension only', () => {
    const risky = [
      'exe',
      'msi',
      'bat',
      'cmd',
      'com',
      'scr',
      'pif',
      'cpl',
      'vbs',
      'vbe',
      'js',
      'jse',
      'wsf',
      'wsh',
      'ps1',
      'hta',
      'lnk',
      'reg',
      'jar',
      'app',
      'pkg',
      'dmg',
      'command',
      'tool',
      'workflow',
      'sh',
      'docm',
      'xlsm',
      'pptm',
      'terminal',
      'scpt',
      'applescript',
      'webloc',
      'inetloc',
      'fileloc',
      'mpkg',
      'prefpane',
      'jnlp',
      'url',
      'html',
      'htm',
      'xhtml',
      'svg',
    ];
    for (const ext of risky) {
      expect(isRisky(`file.${ext}`), ext).toBe(true);
      expect(isRisky(`file.${ext.toUpperCase()}`), ext).toBe(true);
    }
    expect(isRisky('invoice.exe.pdf')).toBe(false);
    expect(isRisky('invoice.pdf.exe')).toBe(true);
    expect(isRisky(cleanFilename('invoice\u202efdp.exe'))).toBe(true);
    expect(isRisky('exe')).toBe(false);
    expect(isRisky('notes.txt')).toBe(false);
  });
});
