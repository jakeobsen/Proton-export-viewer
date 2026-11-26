// SPDX-License-Identifier: AGPL-3.0-or-later
// The exports the folder-proof build accepts, and the bounded copy its
// positive control uses.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectedExports, overlaps } from '../../scripts/folder-proof-exports.mjs';
import { removeOutputDir, removeTestOutput, testOutputOf } from '../../scripts/test-output.mjs';
import { scanTree, walk } from '../../src/testhooks/proof/fs';
import { copyTree, unlockFolders } from '../copy-tree';
import { permissionDenials } from '../permission-check';
import { testDir } from '../paths';

const DIGEST = 'ab'.repeat(32);
const asRoot = process.getuid?.() === 0;
const modeOf = (path: string) => lstatSync(path).mode & 0o777;

/** Gives every folder and file below and including `root` the owner's full access again. */
function unlock(root: string) {
  if (!existsSync(root)) return;
  chmodSync(root, 0o755);
  for (const entry of walk(root)) chmodSync(entry.full, entry.type === 'dir' ? 0o755 : 0o644);
}

/** Makes every folder and file below and including `root` read-only. */
function lock(root: string) {
  for (const entry of walk(root).reverse()) {
    chmodSync(entry.full, entry.type === 'dir' ? 0o555 : 0o444);
  }
  chmodSync(root, 0o555);
}

/** A small export with three message pairs; returns the root and its run folder. */
function smallExport(root: string) {
  const run = join(root, 'acct@example.com', 'mail_20250101_000000');
  mkdirSync(run, { recursive: true });
  for (const id of ['a', 'b', 'c']) {
    writeFileSync(join(run, `${id}.metadata.json`), `{"ID":"${id}"}`);
    writeFileSync(join(run, `${id}.eml`), `Subject: ${id}\r\n\r\n`);
  }
  return { root, run };
}

/** A folder with a manifest next to it, as the generator writes them. */
function generated(root: string, name: string, manifest: Record<string, unknown> = {}) {
  const folder = join(root, name);
  mkdirSync(join(folder, 'acct'), { recursive: true });
  writeFileSync(
    `${folder}.manifest.json`,
    JSON.stringify({ destination: folder, digest: DIGEST, ...manifest }),
  );
  return folder;
}

describe('expectedExports', () => {
  it('gives each export its physical path and manifest digest, in order', () => {
    const root = realpathSync(testDir('proof-exports'));
    const a = generated(root, 'small1');
    const b = generated(root, 'small2', { digest: 'cd'.repeat(32) });
    expect(expectedExports(`${a}:${b}/`)).toEqual([
      { path: a, digest: DIGEST },
      { path: b, digest: 'cd'.repeat(32) },
    ]);
  });

  it('refuses anything but two separate generated exports', () => {
    const root = realpathSync(testDir('proof-exports-bad'));
    const a = generated(root, 'small1');
    const b = generated(root, 'small2');
    expect(() => expectedExports(undefined)).toThrow('must name two exports');
    expect(() => expectedExports(a)).toThrow('must name two exports');
    expect(() => expectedExports(`${a}:${b}:${a}`)).toThrow('must name two exports');
    expect(() => expectedExports(`small1:${b}`)).toThrow('not an absolute path');
    expect(() => expectedExports(`${a}:${a}`)).toThrow('separate folders');
    const inner = generated(a, 'inner');
    expect(() => expectedExports(`${a}:${inner}`)).toThrow('separate folders');
    const none = join(root, 'none');
    mkdirSync(none);
    expect(() => expectedExports(`${a}:${none}`)).toThrow('ENOENT');
    const noDigest = generated(root, 'nodigest', { digest: 'short' });
    expect(() => expectedExports(`${a}:${noDigest}`)).toThrow('has no digest');
    const moved = generated(root, 'moved', { destination: b });
    expect(() => expectedExports(`${a}:${moved}`)).toThrow('written for another folder');
  });

  it('compares physical paths: a link to an export resolves to the export', () => {
    const root = realpathSync(testDir('proof-exports-link'));
    const a = generated(root, 'small1');
    const b = generated(root, 'small2');
    symlinkSync(b, join(root, 'link'));
    symlinkSync(`${b}.manifest.json`, join(root, 'link.manifest.json'));
    expect(expectedExports(`${a}:${join(root, 'link')}`)[1]).toEqual({ path: b, digest: DIGEST });
  });
});

describe('overlaps', () => {
  it('is true for the same folder or one inside the other, and only then', () => {
    expect(overlaps('/a/b', '/a/b')).toBe(true);
    expect(overlaps('/a/b', '/a/b/c')).toBe(true);
    expect(overlaps('/a/b/c', '/a/b')).toBe(true);
    expect(overlaps('/a/b', '/a/bc')).toBe(false);
    expect(overlaps('/a/b', '/a/c')).toBe(false);
  });
});

describe('copyTree', () => {
  function source(root: string) {
    const src = join(root, 'src');
    mkdirSync(join(src, 'acct', 'run'), { recursive: true });
    writeFileSync(join(src, 'acct', 'run', 'a.eml'), 'a'.repeat(100));
    writeFileSync(join(src, 'acct', 'run', 'b.eml'), 'b'.repeat(50));
    const when = new Date('2025-06-30T12:00:00Z');
    for (const p of ['acct/run/a.eml', 'acct/run/b.eml', 'acct/run', 'acct']) {
      utimesSync(join(src, p), when, when);
    }
    return src;
  }

  it('copies folders and files with their times, so the digest is the same', () => {
    const root = testDir('copy-tree');
    const src = source(root);
    expect(copyTree(src, join(root, 'copy'), 150)).toBe(150);
    expect(scanTree(join(root, 'copy')).digest).toBe(scanTree(src).digest);
  });

  it('refuses more bytes than the cap before copying anything', () => {
    const root = testDir('copy-tree-cap');
    const src = source(root);
    expect(() => copyTree(src, join(root, 'copy'), 149)).toThrow('150 bytes is over the cap');
    expect(existsSync(join(root, 'copy'))).toBe(false);
  });

  it('refuses links and other entries before copying anything', () => {
    const root = testDir('copy-tree-link');
    const src = source(root);
    symlinkSync('/', join(src, 'acct', 'out'));
    expect(() => copyTree(src, join(root, 'copy'), 1_000)).toThrow('acct/out is not a folder');
    expect(existsSync(join(root, 'copy'))).toBe(false);
  });

  it.skipIf(asRoot)('keeps permission bits, so a read-only source gives a read-only copy', () => {
    const root = testDir('copy-tree-modes');
    const src = source(root);
    const copy = join(root, 'copy');
    chmodSync(join(src, 'acct', 'run', 'a.eml'), 0o444);
    chmodSync(join(src, 'acct', 'run'), 0o555);
    try {
      copyTree(src, copy, 1_000);
      for (const p of ['acct/run/a.eml', 'acct/run/b.eml', 'acct/run', 'acct']) {
        expect([p, modeOf(join(copy, p))]).toEqual([p, modeOf(join(src, p))]);
      }
      expect(modeOf(join(copy, 'acct', 'run'))).toBe(0o555);
      expect(scanTree(copy).digest).toBe(scanTree(src).digest);
    } finally {
      unlock(src);
      unlock(copy);
    }
  });

  it('copies into a new folder only', () => {
    const root = testDir('copy-tree-exists');
    const src = source(root);
    mkdirSync(join(root, 'copy'));
    expect(() => copyTree(src, join(root, 'copy'), 1_000)).toThrow('EEXIST');
    expect(lstatSync(join(root, 'copy')).isDirectory()).toBe(true);
  });
});

describe('permissionDenials', () => {
  it('is empty when ordinary permissions allow every read and change', () => {
    const { root } = smallExport(testDir('permissions-open'));
    expect(permissionDenials(root)).toEqual([]);
  });

  it.skipIf(asRoot)('lists what a read-only export denies, and its copy denies the same', () => {
    const base = testDir('permissions-locked');
    const { root, run } = smallExport(join(base, 'src'));
    const copy = join(base, 'copy');
    for (const entry of walk(root).reverse()) {
      chmodSync(entry.full, entry.type === 'dir' ? 0o555 : 0o444);
    }
    try {
      const denied = permissionDenials(root);
      expect(denied).toEqual([
        `folder ${dirname(run)}: EACCES`,
        `folder ${run}: EACCES`,
        `write ${join(run, 'b.eml')}: EACCES`,
        `write ${join(run, 'c.eml')}: EACCES`,
      ]);
      copyTree(root, copy, 1_000);
      expect(permissionDenials(copy)).toEqual(denied.map((d) => d.replaceAll(root, copy)));
    } finally {
      unlock(root);
      unlock(copy);
    }
  });
});

describe('unlockFolders', () => {
  it.skipIf(asRoot)('restores owner access to every folder inside, never through a link', () => {
    const root = testDir('unlock');
    const parent = join(root, 'parent');
    const dir = join(parent, 'scratch');
    const outside = join(root, 'outside');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(dir, 'sub', 'a.eml'), 'a');
    symlinkSync(outside, join(dir, 'link'));
    chmodSync(join(dir, 'sub', 'a.eml'), 0o444);
    for (const p of [join(dir, 'sub'), dir, outside]) chmodSync(p, 0o555);
    try {
      unlockFolders(parent, dir);
      expect(modeOf(dir)).toBe(0o755);
      expect(modeOf(join(dir, 'sub'))).toBe(0o755);
      expect(modeOf(join(dir, 'sub', 'a.eml'))).toBe(0o444);
      expect(modeOf(outside)).toBe(0o555);
    } finally {
      chmodSync(outside, 0o755);
    }
  });

  it.skipIf(asRoot)('refuses a link or a folder elsewhere, and accepts a missing one', () => {
    const root = testDir('unlock-refuse');
    const parent = join(root, 'parent');
    const outside = join(root, 'outside');
    mkdirSync(parent);
    mkdirSync(join(outside, 'deep'), { recursive: true });
    chmodSync(outside, 0o555);
    try {
      symlinkSync(outside, join(parent, 'scratch'));
      expect(() => unlockFolders(parent, join(parent, 'scratch'))).toThrow('is not a folder');
      expect(() => unlockFolders(parent, join(outside, 'deep'))).toThrow(
        'not a folder directly inside',
      );
      expect(() => unlockFolders(join(parent, 'scratch'), join(parent, 'scratch', 'deep'))).toThrow(
        'is not a folder',
      );
      expect(modeOf(outside)).toBe(0o555);
      expect(() => unlockFolders(parent, join(parent, 'none'))).not.toThrow();
    } finally {
      chmodSync(outside, 0o755);
    }
  });
});

describe('a read-only scratch copy kept after a failed run', () => {
  it.skipIf(asRoot)('is removed by the next startup cleanup; then a clean run', () => {
    const root = realpathSync(testDir('scratch-retry'));
    const output = testOutputOf(root);
    const scratch = join(output, 'folder-proof-control');
    const { root: original } = smallExport(join(root, 'original'));
    const copy = join(scratch, '1-original');
    lock(original);
    try {
      // A run fails after copying and keeps its read-only copy as evidence.
      mkdirSync(scratch, { recursive: true });
      copyTree(original, copy, 1_000);
      expect(modeOf(join(copy, 'acct@example.com'))).toBe(0o555);
      expect(walk(copy).filter((e) => e.type === 'file')).toHaveLength(6);

      // The next `npm run ci` starts by removing test-output/, read-only copy included.
      removeTestOutput(root);
      expect(existsSync(output)).toBe(false);

      // A clean run copies again and removes its scratch folder itself.
      mkdirSync(scratch, { recursive: true });
      copyTree(original, copy, 1_000);
      unlockFolders(output, scratch);
      removeOutputDir(output, scratch, root);
      expect(existsSync(scratch)).toBe(false);
    } finally {
      unlock(original);
      unlock(output);
    }
  });
});
