// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader's test source: rowids map to files under one folder, and a file
// opens only if it is a regular file inside it.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestReaderSource, openContained, parsePayload } from '../../src/testhooks/reader-source';
import { testDir } from '../paths';

function layout() {
  const dir = testDir('reader-source');
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'a.eml'), 'Subject: a\r\n\r\nA\r\n');
  writeFileSync(join(root, 'sub', 'b.eml'), 'Subject: b\r\n\r\nB\r\n');
  writeFileSync(join(outside, 'secret.eml'), 'Subject: s\r\n\r\nS\r\n');
  symlinkSync(join(root, 'a.eml'), join(root, 'link.eml'));
  symlinkSync(join(outside, 'secret.eml'), join(root, 'out-link.eml'));
  symlinkSync(outside, join(root, 'out-dir'));
  symlinkSync(join(root, 'sub'), join(root, 'in-dir'));
  if (process.platform !== 'win32') execFileSync('mkfifo', [join(root, 'pipe.eml')]);
  return { dir, root, outside };
}

function readAll(fd: number): string {
  const buf = Buffer.alloc(256);
  const n = readSync(fd, buf, 0, buf.length, 0);
  return buf.subarray(0, n).toString();
}

describe('the reader test source', () => {
  it('opens regular files inside its folder, read-only', async () => {
    const { root } = layout();
    for (const [rel, text] of [
      ['a.eml', 'A'],
      ['sub/b.eml', 'B'],
    ] as const) {
      const handle = await openContained(root, rel);
      expect(handle, rel).not.toBeNull();
      expect(readAll(handle!.fd)).toContain(text);
      await expect(handle!.write('x')).rejects.toThrow();
      await handle!.close();
    }
  });

  it('refuses links, other file types and paths that leave the folder', async () => {
    const { root, outside } = layout();
    const refused = [
      'link.eml',
      'out-link.eml',
      'out-dir/secret.eml',
      'in-dir/b.eml',
      'sub',
      '../outside/secret.eml',
      'sub/../a.eml',
      join(outside, 'secret.eml'),
      '',
      'a.eml\0',
      'missing.eml',
      ...(process.platform === 'win32' ? [] : ['pipe.eml']),
    ];
    for (const rel of refused) expect(await openContained(root, rel), rel).toBeNull();
  });

  it('maps rowids to files and test inputs, and nothing else', async () => {
    const { root } = layout();
    const source = await TestReaderSource.create({
      root,
      entries: [
        [1, { file: 'a.eml' }],
        [2, { file: 'link.eml' }],
        [3, { test: { kind: 'spin' } }],
      ],
    });
    expect(source).not.toBeNull();
    const file = await source!.open(1);
    expect(file?.input.kind).toBe('fd');
    if (file?.input.kind === 'fd') expect(readAll(file.input.fd)).toContain('A');
    await file?.close();
    expect(await source!.open(2)).toBeNull();
    expect((await source!.open(3))?.input).toEqual({ kind: 'test', input: { kind: 'spin' } });
    expect(await source!.open(4)).toBeNull();
  });

  it('needs a folder as its root', async () => {
    const { root } = layout();
    expect(await TestReaderSource.create({ root: join(root, 'a.eml'), entries: [] })).toBeNull();
    expect(await TestReaderSource.create({ root: join(root, 'none'), entries: [] })).toBeNull();
  });

  it('checks the payload it is set with', () => {
    const root = '/tmp/x';
    expect(parsePayload({ root, entries: [[1, { file: 'a.eml' }]] })).not.toBeNull();
    expect(parsePayload({ root, entries: [[1, { test: { kind: 'heap' } }]] })).not.toBeNull();
    for (const bad of [
      null,
      { root: 'relative', entries: [] },
      { root, entries: [[0, { file: 'a' }]] },
      { root, entries: [[1.5, { file: 'a' }]] },
      { root, entries: [[1, { path: 'a' }]] },
      { root, entries: [[1, { test: { kind: 'other' } }]] },
      { root, entries: [[1]] },
      { root },
    ]) {
      expect(parsePayload(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
