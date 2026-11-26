// SPDX-License-Identifier: AGPL-3.0-or-later
// The folder-access proof's file operations, outside any sandbox.

import { createHash } from 'node:crypto';
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  changeOps,
  exportTargets,
  isDenial,
  readFile,
  scanTree,
} from '../../src/testhooks/proof/fs';
import { testDir } from '../paths';

const sha = (data: string) => createHash('sha256').update(data).digest('hex');

/** Message pairs in `run`; `noEml` and `noMeta` leave one file of a pair out. */
function pairs(run: string, ids: string[], gaps: { noEml?: string; noMeta?: string } = {}) {
  mkdirSync(run, { recursive: true });
  for (const id of ids) {
    if (id !== gaps.noMeta) writeFileSync(join(run, `${id}.metadata.json`), `{"id":"${id}"}`);
    if (id !== gaps.noEml) writeFileSync(join(run, `${id}.eml`), `Subject: ${id}\r\n\r\n`);
  }
}

describe('scanTree', () => {
  it('digests one line per entry, "<type> <path> <mtime> <detail>", names in byte order', () => {
    const root = testDir('proof-scan');
    mkdirSync(join(root, 'b'));
    writeFileSync(join(root, 'b', 'x.eml'), 'mail');
    writeFileSync(join(root, 'B.json'), '{}');
    symlinkSync('b/x.eml', join(root, 'link'));
    const when = new Date('2025-06-30T12:00:00Z');
    for (const p of ['b/x.eml', 'B.json', 'b']) utimesSync(join(root, p), when, when);
    lutimesSync(join(root, 'link'), when, when);
    const t = when.getTime() / 1000;
    const lines = [
      `file B.json ${t} ${sha('{}')}`,
      `dir b ${t} -`,
      `file b/x.eml ${t} ${sha('mail')}`,
      `symlink link ${t} b/x.eml`,
    ];
    expect(scanTree(root)).toEqual({
      ok: true,
      code: null,
      digest: sha(lines.map((l) => `${l}\n`).join('')),
      entries: 4,
      files: 2,
    });
  });

  it('gives the error code when the folder cannot be read', () => {
    expect(scanTree(join(testDir('proof-scan-missing'), 'none'))).toEqual({
      ok: false,
      code: 'ENOENT',
      digest: null,
      entries: 0,
      files: 0,
    });
  });
});

describe('readFile', () => {
  it('gives the size and SHA-256, or the error code', () => {
    const file = join(testDir('proof-read'), 'a.eml');
    writeFileSync(file, 'hello');
    expect(readFile(file)).toEqual({
      ok: true,
      code: null,
      path: file,
      bytes: 5,
      sha256: sha('hello'),
    });
    expect(readFile(`${file}.none`)).toMatchObject({ ok: false, code: 'ENOENT', sha256: null });
  });
});

describe('changeOps', () => {
  it('changes the files where it may, and gives the error code where it fails', () => {
    const run = testDir('proof-ops');
    pairs(run, ['a']);
    const targets = {
      write: join(run, 'a.eml'),
      create: join(run, 'new.created'),
      rename: join(run, 'a.metadata.json'),
      remove: join(run, 'a.eml'),
    };
    const ok = { ok: true, code: null };
    expect(changeOps(targets)).toEqual({ write: ok, create: ok, rename: ok, remove: ok });
    expect(existsSync(targets.create)).toBe(true);
    expect(existsSync(`${targets.rename}.renamed`)).toBe(true);
    expect(existsSync(targets.remove)).toBe(false);
    expect(changeOps(targets)).toEqual({
      write: { ok: false, code: 'ENOENT' },
      create: { ok: false, code: 'EEXIST' },
      rename: { ok: false, code: 'ENOENT' },
      remove: { ok: false, code: 'ENOENT' },
    });
  });

  it('counts only EPERM and EACCES as a denial', () => {
    expect(isDenial({ ok: false, code: 'EPERM' })).toBe(true);
    expect(isDenial({ ok: false, code: 'EACCES' })).toBe(true);
    expect(isDenial({ ok: false, code: 'ENOENT' })).toBe(false);
    expect(isDenial({ ok: false, code: 'EROFS' })).toBe(false);
    expect(isDenial({ ok: true, code: null })).toBe(false);
  });
});

describe('exportTargets', () => {
  it('reads the first complete pair and changes the last two, one each for main and core', () => {
    const root = testDir('proof-targets');
    const run = join(root, 'acct@example.com', 'mail_20250101_000000');
    pairs(run, ['a', 'b', 'c', 'd', 'e', 'f'], { noEml: 'a', noMeta: 'f' });
    const t = exportTargets(root, 'tag1');
    expect(t.read).toEqual([join(run, 'b.metadata.json'), join(run, 'b.eml')]);
    expect(t.main).toEqual({
      write: join(run, 'd.eml'),
      create: join(run, 'proof-main-tag1.created'),
      rename: join(run, 'd.metadata.json'),
      remove: join(run, 'd.eml'),
    });
    expect(t.core).toMatchObject({
      write: join(run, 'e.eml'),
      rename: join(run, 'e.metadata.json'),
    });
    expect(t.core.create).toBe(join(run, 'proof-core-tag1.created'));
  });

  it('needs three complete pairs', () => {
    const root = testDir('proof-targets-few');
    pairs(join(root, 'run'), ['a', 'b', 'c'], { noEml: 'c' });
    expect(() => exportTargets(root, 'x')).toThrow('at least three complete message pairs');
  });
});
