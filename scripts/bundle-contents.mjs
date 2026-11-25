// SPDX-License-Identifier: AGPL-3.0-or-later
// Lists the code inside a macOS app bundle: every nested bundle, and every
// Mach-O file classified from its header as a main executable or not.

import { closeSync, openSync, readSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BUNDLE_EXTENSIONS = [
  '.app',
  '.appex',
  '.bundle',
  '.framework',
  '.kext',
  '.plugin',
  '.systemextension',
  '.xpc',
];

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_EXECUTE = 2;
// Java class files share the universal-binary magic; their version field reads
// as a count far above any real number of architectures.
const MAX_FAT_ARCHS = 32;

function thinHeader(header) {
  if (header.length < 16) return null;
  for (const endian of ['LE', 'BE']) {
    const magic = endian === 'LE' ? header.readUInt32LE(0) : header.readUInt32BE(0);
    if (magic === MH_MAGIC || magic === MH_MAGIC_64) {
      const filetype = endian === 'LE' ? header.readUInt32LE(12) : header.readUInt32BE(12);
      return { filetype, executable: filetype === MH_EXECUTE };
    }
  }
  return null;
}

/**
 * Classifies a file as Mach-O from its header. `read(offset, length)` returns
 * the bytes at that position. A universal file is classified by its first
 * architecture. Returns `{ filetype, executable }`, or null if not Mach-O.
 */
export function machOKind(read) {
  const head = read(0, 16);
  if (head.length < 8) return null;
  const magic = head.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const count = head.readUInt32BE(4);
    if (count === 0 || count > MAX_FAT_ARCHS) return null;
    const arch = read(8, magic === FAT_MAGIC ? 20 : 32);
    if (arch.length < 16) return null;
    const offset = magic === FAT_MAGIC ? arch.readUInt32BE(8) : Number(arch.readBigUInt64BE(8));
    return thinHeader(read(offset, 16));
  }
  return thinHeader(head);
}

function machOKindOfFile(path) {
  const fd = openSync(path, 'r');
  try {
    return machOKind((offset, length) => {
      const buffer = Buffer.alloc(length);
      const n = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, n);
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * Walks `app` without following symbolic links. Paths are relative to `app`,
 * with `/` separators, sorted. `bundles` lists every nested bundle directory;
 * `machO` lists every Mach-O file with its kind.
 */
export function bundleContents(app) {
  const bundles = [];
  const machO = [];
  const rel = (path) => relative(app, path).split(sep).join('/');
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (BUNDLE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) bundles.push(rel(path));
        walk(path);
      } else if (entry.isFile()) {
        const kind = machOKindOfFile(path);
        if (kind) machO.push({ path: rel(path), ...kind });
      }
    }
  };
  walk(app);
  bundles.sort();
  machO.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { bundles, machO };
}
