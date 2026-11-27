// SPDX-License-Identifier: AGPL-3.0-or-later
// Reading a run folder without leaving it: what the scan accepts and rejects,
// how an open checks that it got the file it was looking for, and where a
// file listed by name only gets its identity.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
  listRunAsync,
  openContained,
  openListed,
  pairCounts,
  readCapped,
  readContained,
  openWithRescan,
  readWithRescan,
  realFs,
  realListFs,
  resolveRoot,
  scanRun,
  statListed,
  type FileRef,
  type ListedEntry,
  type ListedFile,
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

/** A file's identity from lstat, as reconcile looks at the files of stored pairs. */
function identityOf(root: string, file: ListedFile): FileRef {
  const found = examine(root, file.rel);
  if (!found || !('ref' in found)) throw new Error(`no regular file ${file.rel}`);
  return found.ref;
}

/** The scan's metadata and message files with their identity, as stored pairs have them. */
function identified(root: string): { metadata: Map<string, FileRef>; eml: Map<string, FileRef> } {
  const scan = scanRun(root);
  const withIdentity = (files: Map<string, ListedFile>) =>
    new Map([...files].map(([id, file]) => [id, identityOf(root, file)]));
  return { metadata: withIdentity(scan.metadata), eml: withIdentity(scan.eml) };
}

/** A ScanFs that counts its lstats and can change what the listing says. */
function countingFs(change: (entries: ListedEntry[]) => ListedEntry[] = (e) => e) {
  const looked: string[] = [];
  const fs: ScanFs = {
    list: (path) => change(realFs.list(path)),
    readdir: realFs.readdir,
    lstat: (path) => {
      looked.push(path.slice(path.lastIndexOf('/') + 1));
      return realFs.lstat(path);
    },
  };
  return { fs, looked };
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
    // The listing gives no type for it, so it is looked at with lstat.
    const fs: ScanFs = {
      list: (path) =>
        realFs.list(path).map((e) => (e.name === 'a.eml' ? { ...e, type: 'unknown' } : e)),
      readdir: realFs.readdir,
      lstat: (path) => (path.endsWith('a.eml') ? fake : realFs.lstat(path)),
    };
    const scan = scanRun(root, fs);
    expect(scan.rejected).toEqual([{ rel: 'a.eml', kind: 'device' }]);
    expect(scan.eml.has('a')).toBe(false);
    // A device the listing names as one is rejected without a look.
    const typed = countingFs((entries) =>
      entries.map((e) => (e.name === 'b.eml' ? { ...e, type: 'device' } : e)),
    );
    const again = scanRun(root, typed.fs);
    expect(again.rejected).toEqual([{ rel: 'b.eml', kind: 'device' }]);
    expect(typed.looked).not.toContain('b.eml');
  });

  it('lists metadata over 4 MiB by name; its read rejects it after 4 MiB + 1 bytes', () => {
    const root = run('scan-large');
    // Sparse, so it takes no space.
    truncateSync(join(root, 'a.metadata.json'), MAX_METADATA_BYTES + 1);
    truncateSync(join(root, 'b.metadata.json'), MAX_METADATA_BYTES);
    const scan = scanRun(root);
    expect(scan.rejected).toEqual([]);
    expect(readWithRescan(root, scan.metadata.get('a')!)).toEqual({
      ok: false,
      rejection: { rel: 'a.metadata.json', kind: 'too_large' },
    });
    const b = readWithRescan(root, scan.metadata.get('b')!);
    expect(b.ok && b.bytes.length).toBe(MAX_METADATA_BYTES);
  });

  it('records metadata and message files by name, and looks only at labels.json', () => {
    const root = run('scan-names', ['a', 'b', 'c']);
    writeFileSync(join(root, 'notes.txt'), 'x');
    const { fs, looked } = countingFs();
    const scan = scanRun(root, fs);
    expect(looked).toEqual(['labels.json']);
    expect(scan.metadata.get('a')).toEqual({ rel: 'a.metadata.json', kind: 'metadata' });
    expect(scan.eml.get('c')).toEqual({ rel: 'c.eml', kind: 'eml' });
    expect(scan.labels).toMatchObject({ rel: 'labels.json', kind: 'labels' });
    expect(scan.labels?.ino).toBe(lstatSync(join(root, 'labels.json'), { bigint: true }).ino);
    expect(scan.ignored).toBe(1);
  });

  it('looks with lstat at an entry of unknown type, and skips one that went away', async () => {
    const root = run('scan-unknown', ['a', 'b']);
    symlinkSync(join(root, 'a.eml'), join(root, 'link.eml'));
    mkfifo(join(root, 'f.metadata.json'));
    const typed = scanRun(root);
    // A volume that gives no types: every entry is looked at, with the same outcome.
    const unknown = countingFs((entries) => entries.map((e) => ({ ...e, type: 'unknown' })));
    const scan = scanRun(root, unknown.fs);
    expect(unknown.looked.sort()).toEqual(realFs.readdir(root).sort());
    expect(scan).toEqual(typed);
    expect(countRejections(scan.rejected)).toMatchObject({ symlink: 1, fifo: 1 });
    // An entry gone between the listing and its lstat is skipped.
    const gone = countingFs((entries) => [
      ...entries.map((e) => ({ ...e, type: 'unknown' as const })),
      { name: 'gone.eml', type: 'unknown' },
    ]);
    expect(scanRun(root, gone.fs)).toEqual(typed);
    expect(gone.looked).toContain('gone.eml');
    // The listing off the main thread gives the same entries as the one on it.
    const listed = await listRunAsync(root);
    expect(listed.sort((x, y) => (x.name < y.name ? -1 : 1))).toEqual(
      realFs.list(root).sort((x, y) => (x.name < y.name ? -1 : 1)),
    );
  });

  it('lists by name and looks at every entry when the typed listing fails; fails if that does too', async () => {
    const root = run('scan-fallback', ['a', 'b']);
    mkfifo(join(root, 'f.eml'));
    const typed = scanRun(root);
    // Node looks at an entry of unknown type while it lists; one gone in that
    // moment fails the whole typed listing.
    const enoent = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const looked: string[] = [];
    const fallback: ScanFs = {
      list: enoent,
      readdir: realFs.readdir,
      lstat: (path) => {
        looked.push(path);
        return realFs.lstat(path);
      },
    };
    expect(scanRun(root, fallback)).toEqual(typed);
    expect(looked).toHaveLength(realFs.readdir(root).length);
    expect(
      await listRunAsync(root, {
        list: () => Promise.reject(new Error('ENOENT')),
        readdir: realListFs.readdir,
      }),
    ).toEqual(realFs.readdir(root).map((name) => ({ name, type: 'unknown' })));
    // With the folder gone, both listings fail, and so does the scan.
    rmSync(root, { recursive: true });
    expect(() => scanRun(root)).toThrow();
    await expect(listRunAsync(root)).rejects.toThrow();
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
    const ref = identified(root).metadata.get('a')!;
    expect(readContained(root, ref, MAX_METADATA_BYTES).toString()).toBe('{"ID":"a"}');
  });

  it("doesn't block on a file swapped for a FIFO after the scan, and rejects it", () => {
    const root = run('open-fifo');
    const ref = identified(root).eml.get('a')!;
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
    const ref = identified(root).eml.get('a')!;
    rmSync(join(root, 'a.eml'));
    symlinkSync(join(root, 'b.eml'), join(root, 'a.eml'));
    expect(() => openContained(root, ref)).toThrow(
      expect.objectContaining({ kind: 'symlink' }) as Error,
    );
  });

  it('rejects a file whose device and inode changed, then reads it again after a rescan', () => {
    const root = run('open-changed');
    const ref = identified(root).metadata.get('a')!;
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
    const scan = identified(root);
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

  it('opens a message file for the reader; one replaced by a regular file opens after a rescan', () => {
    const root = run('open-reader');
    const scan = identified(root);
    const opened = openWithRescan(root, scan.eml.get('a')!);
    expect(opened.ok).toBe(true);
    if (opened.ok) closeSync(opened.fd);

    writeFileSync(join(root, 'new.tmp'), 'Subject: b again\r\n\r\n');
    renameSync(join(root, 'new.tmp'), join(root, 'b.eml'));
    const again = openWithRescan(root, scan.eml.get('b')!);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    try {
      expect(readFileSync(again.fd, 'utf8')).toBe('Subject: b again\r\n\r\n');
      expect(again.ref.ino).toBe(lstatSync(join(root, 'b.eml'), { bigint: true }).ino);
    } finally {
      closeSync(again.fd);
    }
  });

  it('opens no message file that went away, or that a link or a FIFO took the place of', () => {
    const root = run('open-reader-refused', ['a', 'b', 'c']);
    const scan = identified(root);
    rmSync(join(root, 'a.eml'));
    expect(openWithRescan(root, scan.eml.get('a')!)).toEqual({
      ok: false,
      rejection: { rel: 'a.eml', kind: 'changed' },
      gone: true,
    });
    rmSync(join(root, 'b.eml'));
    symlinkSync(join(root, 'c.eml'), join(root, 'b.eml'));
    expect(openWithRescan(root, scan.eml.get('b')!)).toEqual({
      ok: false,
      rejection: { rel: 'b.eml', kind: 'symlink' },
      gone: false,
    });
    rmSync(join(root, 'c.eml'));
    mkfifo(join(root, 'c.eml'));
    expect(openWithRescan(root, scan.eml.get('c')!)).toEqual({
      ok: false,
      rejection: { rel: 'c.eml', kind: 'fifo' },
      gone: false,
    });
  });

  it('gives a file listed by name the identity of its first open, and holds it to it after', () => {
    const root = run('open-listed');
    const listed = scanRun(root).metadata.get('a')!;
    // The boundary: a name-only listing has nothing to compare a file with,
    // so a regular file put in place of the listed one before its first open
    // can't be told from it. That open defines which file it is.
    writeFileSync(join(root, 'new.tmp'), '{"ID":"a","v":2}');
    renameSync(join(root, 'new.tmp'), join(root, 'a.metadata.json'));
    const first = readWithRescan(root, listed);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.bytes.toString()).toBe('{"ID":"a","v":2}');
    const st = lstatSync(join(root, 'a.metadata.json'), { bigint: true });
    expect(first.ref).toEqual({
      rel: 'a.metadata.json',
      kind: 'metadata',
      dev: st.dev,
      ino: st.ino,
      size: Number(st.size),
      mtimeNs: st.mtimeNs,
    });
    // From then on the identity is checked: the next replacement is caught.
    writeFileSync(join(root, 'new.tmp'), '{"ID":"a","v":3}');
    renameSync(join(root, 'new.tmp'), join(root, 'a.metadata.json'));
    expect(() => openContained(root, first.ref)).toThrow(
      expect.objectContaining({ kind: 'changed' }) as Error,
    );
  });

  it('refuses a file listed as regular that became a link, a FIFO or a folder before its read or look', () => {
    const root = run('open-swapped', ['a', 'b', 'c', 'd']);
    const scan = scanRun(root);
    const meta = (id: string) => join(root, `${id}.metadata.json`);
    rmSync(meta('a'));
    symlinkSync(meta('d'), meta('a'));
    rmSync(meta('b'));
    mkfifo(meta('b'));
    rmSync(meta('c'));
    mkdirSync(meta('c'));
    for (const [id, kind] of [
      ['a', 'symlink'],
      ['b', 'fifo'],
      ['c', 'directory'],
    ] as const) {
      const rejection = { rel: `${id}.metadata.json`, kind };
      const started = performance.now();
      expect(readWithRescan(root, scan.metadata.get(id)!)).toEqual({ ok: false, rejection });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(statListed(root, scan.metadata.get(id)!)).toEqual({ rejected: rejection });
    }
    // A message file is looked at with lstat: its identity, or nothing once it is gone.
    expect(statListed(root, scan.eml.get('a')!)).toEqual({
      ref: identityOf(root, scan.eml.get('a')!),
    });
    rmSync(join(root, 'd.eml'));
    expect(statListed(root, scan.eml.get('d')!)).toBeNull();
  });

  it('limits the bytes read, not the size the file had: one that grows past it after its open is too large', () => {
    const root = run('open-grown');
    const { fd, ref } = openListed(root, scanRun(root).metadata.get('a')!);
    try {
      expect(ref.size).toBe('{"ID":"a"}'.length);
      truncateSync(join(root, 'a.metadata.json'), MAX_METADATA_BYTES + 1);
      expect(() => readCapped(fd, MAX_METADATA_BYTES)).toThrow(
        expect.objectContaining({ kind: 'too_large' }) as Error,
      );
    } finally {
      closeSync(fd);
    }
    // A file that claims no size at all, but whose reads never end.
    const zero = openSync('/dev/zero', 'r');
    try {
      expect(fstatSync(zero).size).toBe(0);
      expect(() => readCapped(zero, 100_000)).toThrow(
        expect.objectContaining({ kind: 'too_large' }) as Error,
      );
    } finally {
      closeSync(zero);
    }
  });

  it('reads in chunks, whole files up to the limit and nothing past it', () => {
    const root = run('open-chunks');
    const chunk = 64 * 1024;
    for (const size of [0, 1, chunk - 1, chunk, chunk + 1, 3 * chunk + 7]) {
      const data = Buffer.alloc(size, 0);
      for (let i = 0; i < size; i += 1) data[i] = (i * 31 + size) % 251;
      writeFileSync(join(root, 'a.metadata.json'), data);
      const read = readWithRescan(
        root,
        identityOf(root, { rel: 'a.metadata.json', kind: 'metadata' }),
      );
      expect(read.ok && read.bytes.equals(data), String(size)).toBe(true);
      const { fd } = openListed(root, { rel: 'a.metadata.json', kind: 'metadata' });
      try {
        if (size > 0) {
          expect(() => readCapped(fd, size - 1)).toThrow(
            expect.objectContaining({ kind: 'too_large' }) as Error,
          );
        }
      } finally {
        closeSync(fd);
      }
    }
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
