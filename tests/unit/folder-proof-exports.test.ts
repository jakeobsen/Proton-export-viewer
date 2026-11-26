// SPDX-License-Identifier: AGPL-3.0-or-later
// The exports the folder-proof build accepts, and the bounded copy its
// positive control uses.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectedExports, overlaps } from '../../scripts/folder-proof-exports.mjs';
import { scanTree } from '../../src/testhooks/proof/fs';
import { copyTree } from '../copy-tree';
import { testDir } from '../paths';

const DIGEST = 'ab'.repeat(32);

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

  it('copies into a new folder only', () => {
    const root = testDir('copy-tree-exists');
    const src = source(root);
    mkdirSync(join(root, 'copy'));
    expect(() => copyTree(src, join(root, 'copy'), 1_000)).toThrow('EEXIST');
    expect(lstatSync(join(root, 'copy')).isDirectory()).toBe(true);
  });
});
