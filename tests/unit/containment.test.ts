// SPDX-License-Identifier: AGPL-3.0-or-later
// Reading a run folder without leaving it: what the scan accepts and rejects,
// and how an open checks that it got the file the scan saw.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContainmentError,
  MAX_METADATA_BYTES,
  countRejections,
  examine,
  openContained,
  pairCounts,
  readContained,
  readWithRescan,
  realFs,
  resolveRoot,
  scanRun,
  type ScanFs,
} from '../../src/core/containment';
import { runIdentity } from '../../src/core/identity';
import { testDir } from '../paths';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function mkfifo(path: string) {
  const made = spawnSync('/usr/bin/mkfifo', ['-m', '0644', path]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${String(made.stderr)}`);
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/**
 * A Unix socket named `name` in `dir`. It's bound by a relative name from
 * inside `dir`, because socket paths are limited to about 100 bytes.
 */
async function socketIn(dir: string, name: string) {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(name, resolve);
    });
  } finally {
    process.chdir(cwd);
  }
}

/** A run folder with labels.json and message pairs `ids`. */
function run(name: string, ids = ['a', 'b']) {
  const dir = realpathSync(testDir(name));
  writeFileSync(join(dir, 'labels.json'), '{"Version":1,"Payload":[]}');
  for (const id of ids) {
    writeFileSync(join(dir, `${id}.metadata.json`), `{"ID":"${id}"}`);
    writeFileSync(join(dir, `${id}.eml`), `Subject: ${id}\r\n\r\n`);
  }
  return dir;
}

describe('the scan', () => {
  it('accepts the three kinds of regular files, by relative name, and ignores other files', () => {
    const root = run('scan-kinds');
    writeFileSync(join(root, 'notes.txt'), 'x');
    writeFileSync(join(root, 'c.metadata.json'), '{}');
    writeFileSync(join(root, 'd.eml'), 'Subject: d\r\n\r\n');
    const scan = scanRun(root);
    expect(scan.root).toBe(root);
    expect(scan.labels?.rel).toBe('labels.json');
    expect([...scan.metadata.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect([...scan.eml.keys()].sort()).toEqual(['a', 'b', 'd']);
    expect(scan.metadata.get('a')).toMatchObject({ rel: 'a.metadata.json', kind: 'metadata' });
    expect(scan.ignored).toBe(1);
    expect(scan.rejected).toEqual([]);
    expect(pairCounts(scan)).toEqual({ pairs: 2, metadataOnly: 1, emlOnly: 1 });
  });

  it('rejects a symlink, a directory, a FIFO and a socket, and follows none of them', async () => {
    const root = run('scan-rejects');
    const outside = realpathSync(testDir('scan-rejects-outside'));
    writeFileSync(join(outside, 'x.eml'), 'outside');
    symlinkSync(join(outside, 'x.eml'), join(root, 'link.eml'));
    symlinkSync(outside, join(root, 'dirlink.metadata.json'));
    mkdirSync(join(root, 'mail_inner'));
    mkdirSync(join(root, 'e.eml'));
    mkfifo(join(root, 'f.metadata.json'));
    await socketIn(root, 's.eml');
    expect(lstatSync(join(root, 's.eml')).isSocket()).toBe(true);

    const scan = scanRun(root);
    expect(new Set(scan.rejected.map((r) => `${r.kind} ${r.rel}`))).toEqual(
      new Set([
        'symlink link.eml',
        'symlink dirlink.metadata.json',
        'directory mail_inner',
        'directory e.eml',
        'fifo f.metadata.json',
        'socket s.eml',
      ]),
    );
    expect([...scan.eml.keys()].sort()).toEqual(['a', 'b']);
    expect([...scan.metadata.keys()].sort()).toEqual(['a', 'b']);
    expect(countRejections(scan.rejected)).toMatchObject({
      symlink: 2,
      directory: 2,
      fifo: 1,
      socket: 1,
      device: 0,
    });
  });

  it('rejects a device node (a stubbed lstat result: creating one needs root)', () => {
    const root = run('scan-device');
    const device = lstatSync(join(root, 'a.eml'), { bigint: true });
    const fake = Object.assign(Object.create(Object.getPrototypeOf(device) as object), device, {
      isFile: () => false,
      isCharacterDevice: () => true,
    }) as BigIntStats;
    const fs: ScanFs = {
      readdir: realFs.readdir,
      lstat: (path) => (path.endsWith('a.eml') ? fake : realFs.lstat(path)),
    };
    const scan = scanRun(root, fs);
    expect(scan.rejected).toEqual([{ rel: 'a.eml', kind: 'device' }]);
    expect(scan.eml.has('a')).toBe(false);
  });

  it('rejects metadata over 4 MiB without reading it', () => {
    const root = run('scan-large');
    // Sparse, so it takes no space.
    truncateSync(join(root, 'a.metadata.json'), MAX_METADATA_BYTES + 1);
    truncateSync(join(root, 'b.metadata.json'), MAX_METADATA_BYTES);
    const scan = scanRun(root);
    expect(scan.rejected).toEqual([{ rel: 'a.metadata.json', kind: 'too_large' }]);
    expect(scan.metadata.has('b')).toBe(true);
  });

  it('resolves the root with realpath and refuses a missing one', () => {
    const root = run('scan-root');
    const via = join(testDir('scan-root-link'), 'link');
    symlinkSync(root, via);
    expect(resolveRoot(via)).toBe(root);
    expect(scanRun(resolveRoot(via)).root).toBe(root);
    rmSync(root, { recursive: true });
    expect(() => resolveRoot(via)).toThrow(ContainmentError);
  });
});

describe('the open procedure', () => {
  it('reads a file the scan accepted', () => {
    const root = run('open-ok');
    const ref = scanRun(root).metadata.get('a')!;
    expect(readContained(root, ref, MAX_METADATA_BYTES).toString()).toBe('{"ID":"a"}');
  });

  it("doesn't block on a file swapped for a FIFO after the scan, and rejects it", () => {
    const root = run('open-fifo');
    const ref = scanRun(root).eml.get('a')!;
    rmSync(join(root, 'a.eml'));
    mkfifo(join(root, 'a.eml'));
    const started = performance.now();
    let error: unknown;
    try {
      openContained(root, ref);
    } catch (err) {
      error = err;
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(ContainmentError);
    expect((error as ContainmentError).kind).toBe('fifo');
    expect(readWithRescan(root, ref)).toEqual({
      ok: false,
      rejection: { rel: 'a.eml', kind: 'fifo' },
    });
  });

  it('refuses a file swapped for a symlink after the scan', () => {
    const root = run('open-link');
    const ref = scanRun(root).eml.get('a')!;
    rmSync(join(root, 'a.eml'));
    symlinkSync(join(root, 'b.eml'), join(root, 'a.eml'));
    expect(() => openContained(root, ref)).toThrow(
      expect.objectContaining({ kind: 'symlink' }) as Error,
    );
  });

  it('rejects a file whose device and inode changed, then reads it again after a rescan', () => {
    const root = run('open-changed');
    const ref = scanRun(root).metadata.get('a')!;
    // Another regular file takes its place: same name, new inode.
    writeFileSync(join(root, 'new.tmp'), '{"ID":"a","v":2}');
    renameSync(join(root, 'new.tmp'), join(root, 'a.metadata.json'));
    expect(() => openContained(root, ref)).toThrow(
      expect.objectContaining({ kind: 'changed' }) as Error,
    );
    const read = readWithRescan(root, ref);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.bytes.toString()).toBe('{"ID":"a","v":2}');
    expect(read.ref.ino).not.toBe(ref.ino);
    expect(read.ref.ino).toBe(lstatSync(join(root, 'a.metadata.json'), { bigint: true }).ino);
  });

  it('rejects a file that went away, and one that grew past its limit', () => {
    const root = run('open-gone');
    const scan = scanRun(root);
    rmSync(join(root, 'a.eml'));
    expect(readWithRescan(root, scan.eml.get('a')!)).toEqual({
      ok: false,
      rejection: { rel: 'a.eml', kind: 'changed' },
    });
    truncateSync(join(root, 'b.metadata.json'), MAX_METADATA_BYTES + 1);
    expect(() => readContained(root, scan.metadata.get('b')!, MAX_METADATA_BYTES)).toThrow(
      expect.objectContaining({ kind: 'too_large' }) as Error,
    );
  });

  it('examines one name at a time, never a path with a separator', () => {
    const root = run('open-names');
    expect(examine(root, '../a.eml')).toBeNull();
    expect(examine(root, '..')).toBeNull();
  });
});

describe('the run identity', () => {
  it('is the SHA-256 of labels.json and of the sorted metadata names, from one readdir', async () => {
    const root = run('identity', ['b', 'a', 'c']);
    const identity = await runIdentity(root);
    expect(identity).toEqual({
      labelsSha256: sha('{"Version":1,"Payload":[]}'),
      namesSha256: sha('a.metadata.json\0b.metadata.json\0c.metadata.json\0'),
      metadataNames: 3,
    });
  });

  it('changes with the set of messages, not with the other files', async () => {
    const first = await runIdentity(run('identity-a', ['a', 'b']));
    const other = run('identity-b', ['a', 'c']);
    writeFileSync(join(other, 'notes.txt'), 'x');
    const second = await runIdentity(other);
    expect(second.labelsSha256).toBe(first.labelsSha256);
    expect(second.namesSha256).not.toBe(first.namesSha256);
    rmSync(join(other, 'c.metadata.json'));
    writeFileSync(join(other, 'b.metadata.json'), '{"ID":"other"}');
    expect((await runIdentity(other)).namesSha256).toBe(first.namesSha256);
  });

  it('has no labels digest when labels.json is missing or a link', async () => {
    const root = run('identity-labels');
    rmSync(join(root, 'labels.json'));
    expect((await runIdentity(root)).labelsSha256).toBeNull();
    symlinkSync(join(root, 'a.metadata.json'), join(root, 'labels.json'));
    expect((await runIdentity(root)).labelsSha256).toBeNull();
  });
});
