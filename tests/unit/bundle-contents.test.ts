// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleContents, machOKind } from '../../scripts/bundle-contents.mjs';
import { testDir } from '../paths';

const MH_EXECUTE = 2;
const MH_DYLIB = 6;

/** A minimal 64-bit Mach-O header (little-endian, as on Apple silicon and Intel). */
function thin(filetype: number, magic = 0xfeedfacf): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(magic, 0);
  b.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  b.writeUInt32LE(0, 8);
  b.writeUInt32LE(filetype, 12);
  return b;
}

/** A universal file whose first architecture is `slice`, stored at offset 64. */
function fat(slice: Buffer): Buffer {
  const b = Buffer.alloc(64 + slice.length);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(1, 4);
  b.writeUInt32BE(0x0100000c, 8);
  b.writeUInt32BE(0, 12);
  b.writeUInt32BE(64, 16);
  b.writeUInt32BE(slice.length, 20);
  b.writeUInt32BE(14, 24);
  slice.copy(b, 64);
  return b;
}

const reader = (b: Buffer) => (offset: number, length: number) =>
  b.subarray(offset, offset + length);

describe('machOKind', () => {
  it('tells a main executable from a library', () => {
    expect(machOKind(reader(thin(MH_EXECUTE)))).toEqual({ filetype: 2, executable: true });
    expect(machOKind(reader(thin(MH_DYLIB)))).toEqual({ filetype: 6, executable: false });
    expect(machOKind(reader(thin(MH_EXECUTE, 0xfeedface)))?.executable).toBe(true);
  });

  it('reads the first architecture of a universal file', () => {
    expect(machOKind(reader(fat(thin(MH_EXECUTE))))?.executable).toBe(true);
    expect(machOKind(reader(fat(thin(MH_DYLIB))))?.executable).toBe(false);
  });

  it('rejects files that are not Mach-O', () => {
    expect(machOKind(reader(Buffer.from('#!/bin/sh\necho hi\n')))).toBeNull();
    expect(machOKind(reader(Buffer.alloc(0)))).toBeNull();
    // A Java class file starts with the same magic as a universal file.
    const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(machOKind(reader(javaClass))).toBeNull();
  });
});

describe('bundleContents', () => {
  it('finds nested bundles and Mach-O files anywhere, without following links', () => {
    const app = join(testDir('bundle-contents'), 'Sample.app');
    const helper = join(app, 'Contents', 'Frameworks', 'Sample Helper.app', 'Contents', 'MacOS');
    const login = join(app, 'Contents', 'Library', 'LoginItems', 'Login.app', 'Contents', 'MacOS');
    const fw = join(app, 'Contents', 'Frameworks', 'Lib.framework', 'Versions', 'A');
    for (const dir of [join(app, 'Contents', 'MacOS'), helper, login, fw]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(app, 'Contents', 'MacOS', 'Sample'), thin(MH_EXECUTE));
    writeFileSync(join(helper, 'Sample Helper'), fat(thin(MH_EXECUTE)));
    writeFileSync(join(login, 'Login'), thin(MH_EXECUTE));
    writeFileSync(join(fw, 'Lib'), thin(MH_DYLIB));
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>');
    symlinkSync('Versions/A/Lib', join(app, 'Contents', 'Frameworks', 'Lib.framework', 'Lib'));

    const { bundles, machO } = bundleContents(app);
    expect(bundles).toEqual([
      'Contents/Frameworks/Lib.framework',
      'Contents/Frameworks/Sample Helper.app',
      'Contents/Library/LoginItems/Login.app',
    ]);
    expect(machO.map((m) => [m.path, m.executable])).toEqual([
      ['Contents/Frameworks/Lib.framework/Versions/A/Lib', false],
      ['Contents/Frameworks/Sample Helper.app/Contents/MacOS/Sample Helper', true],
      ['Contents/Library/LoginItems/Login.app/Contents/MacOS/Login', true],
      ['Contents/MacOS/Sample', true],
    ]);
  });
});
