// SPDX-License-Identifier: AGPL-3.0-or-later
// Publishing a staged download: link() to the first free name, never
// replacing anything; on any other link() failure, a hidden exclusive copy in
// the destination folder, linked the same way. Nothing temporary or staged is
// left, whatever the outcome.

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publish, realPublishFs, type FileId, type PublishFs } from '../../src/main/saves/publish';
import { PARTIAL_RE, Staging } from '../../src/main/saves/staging';
import { testDir } from '../paths';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function setup(bytes = Buffer.from('saved bytes')) {
  const dir = testDir('save-publish');
  const staging = join(dir, 'staging');
  const dest = join(dir, 'Downloads');
  mkdirSync(staging);
  mkdirSync(dest);
  const staged = join(staging, 'a'.repeat(32) + '.part');
  writeFileSync(staged, bytes);
  const notes: string[] = [];
  const owned: Array<{ path: string } & FileId> = [];
  const kept: string[] = [];
  const options = {
    partialPath: (d: string) => Staging.partialIn(d),
    notePartial: (p: string) => notes.push(p),
    ownPartial: (p: string, id: FileId) => owned.push({ path: p, ...id }),
    clearNote: () => notes.push('cleared'),
    onPartialKept: (reason: string) => kept.push(reason),
  };
  return { dir, staging, dest, staged, bytes, notes, owned, kept, options };
}

const leftovers = (dir: string) => readdirSync(dir).filter((n) => PARTIAL_RE.test(n));

describe('publish', () => {
  it('links the staged file to the name and removes the staged one', async () => {
    const t = setup();
    const result = await publish(t.staged, t.dest, 'report.pdf', t.options);
    expect(result).toMatchObject({ ok: true, method: 'link', path: join(t.dest, 'report.pdf') });
    expect(readFileSync(join(t.dest, 'report.pdf'))).toEqual(t.bytes);
    expect(existsSync(t.staged)).toBe(false);
    if (result.ok) {
      const st = lstatSync(result.path, { bigint: true });
      expect([result.dev, result.ino]).toEqual([st.dev.toString(), st.ino.toString()]);
    }
  });

  it('a file, a folder or a dangling link in the way gives the next number', async () => {
    const t = setup();
    writeFileSync(join(t.dest, 'report.pdf'), 'theirs');
    mkdirSync(join(t.dest, 'report (2).pdf'));
    symlinkSync(join(t.dir, 'nowhere'), join(t.dest, 'report (3).pdf'));
    const result = await publish(t.staged, t.dest, 'report.pdf', t.options);
    expect(result).toMatchObject({ ok: true, path: join(t.dest, 'report (4).pdf') });
    expect(readFileSync(join(t.dest, 'report.pdf'), 'utf8')).toBe('theirs');
    expect(lstatSync(join(t.dest, 'report (3).pdf')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(t.dir, 'nowhere'))).toBe(false);
  });

  it('a name with no free number left fails, and the staged file goes', async () => {
    const t = setup();
    const fs: PublishFs = {
      ...realPublishFs,
      link: () => Promise.reject(Object.assign(new Error('EEXIST'), { code: 'EEXIST' })),
    };
    expect(await publish(t.staged, t.dest, 'x.txt', { ...t.options, fs })).toEqual({
      ok: false,
      reason: 'exists',
    });
    expect(existsSync(t.staged)).toBe(false);
  });

  it('forced fallback: the copy is published under the name, with the same bytes, nothing left', async () => {
    const t = setup(Buffer.alloc(3 * 1024 * 1024, 0x5a));
    const result = await publish(t.staged, t.dest, 'big.bin', { ...t.options, forceCopy: true });
    expect(result).toMatchObject({ ok: true, method: 'copy', path: join(t.dest, 'big.bin') });
    expect(sha(readFileSync(join(t.dest, 'big.bin')))).toBe(sha(t.bytes));
    expect(readdirSync(t.dest)).toEqual(['big.bin']);
    expect(readdirSync(t.staging)).toEqual([]);
    expect(t.notes).toHaveLength(2);
    expect(PARTIAL_RE.test(t.notes[0]!.split('/').pop()!)).toBe(true);
    expect(t.notes[1]).toBe('cleared');
    // The copy's identity was noted for the path noted before it was made.
    expect(t.owned).toHaveLength(1);
    expect(t.owned[0]!.path).toBe(t.notes[0]);
    expect(t.owned[0]!.ino).toMatch(/^\d+$/);
    // Its birth time, read from the open file, is the published file's own.
    const st = lstatSync(join(t.dest, 'big.bin'), { bigint: true });
    expect(t.owned[0]!.birth).toBe(st.birthtimeNs.toString());
    expect(t.owned[0]!.birth).not.toBe('0');
    expect(t.kept).toEqual([]);
  });

  it('a link() that fails otherwise (another volume) takes the copy', async () => {
    const t = setup();
    let calls = 0;
    const fs: PublishFs = {
      ...realPublishFs,
      link: (from, to) => {
        calls += 1;
        if (calls === 1)
          return Promise.reject(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
        return realPublishFs.link(from, to);
      },
    };
    const result = await publish(t.staged, t.dest, 'a.txt', { ...t.options, fs });
    expect(result).toMatchObject({ ok: true, method: 'copy' });
    expect(readFileSync(join(t.dest, 'a.txt'))).toEqual(t.bytes);
    expect(leftovers(t.dest)).toEqual([]);
    expect(existsSync(t.staged)).toBe(false);
  });

  it('held copy: no final name exists while it is held; a failed copy leaves nothing', async () => {
    const t = setup();
    let release!: (err?: Error) => void;
    let held = false;
    const fs: PublishFs = {
      ...realPublishFs,
      copyNew: async (from, path, created) => {
        await realPublishFs.copyNew(from, path, created);
        held = true;
        try {
          await new Promise<void>((resolve, reject) => {
            release = (err) => (err ? reject(err) : resolve());
          });
        } catch (err) {
          // A copy that fails after it made its file removes it, as the real one does.
          await realPublishFs.unlink(path);
          throw err;
        }
      },
    };
    const publishing = publish(t.staged, t.dest, 'held.txt', { ...t.options, fs, forceCopy: true });
    while (!held) await new Promise((r) => setTimeout(r, 2));
    expect(existsSync(join(t.dest, 'held.txt'))).toBe(false);
    expect(leftovers(t.dest)).toHaveLength(1);
    release(new Error('EIO'));
    expect(await publishing).toEqual({ ok: false, reason: 'publish' });
    expect(readdirSync(t.dest)).toEqual([]);
    expect(readdirSync(t.staging)).toEqual([]);
    expect(t.notes.at(-1)).toBe('cleared');
  });

  it('a destination made by someone else while publishing is not overwritten', async () => {
    const t = setup();
    const fs: PublishFs = {
      ...realPublishFs,
      link: async (from, to) => {
        // Someone makes the first name just before the link.
        if (to.endsWith('race.txt')) writeFileSync(to, 'theirs');
        return realPublishFs.link(from, to);
      },
    };
    const result = await publish(t.staged, t.dest, 'race.txt', { ...t.options, fs });
    expect(result).toMatchObject({ ok: true, path: join(t.dest, 'race (2).txt') });
    expect(readFileSync(join(t.dest, 'race.txt'), 'utf8')).toBe('theirs');
  });

  it('the real copy removes its own file when it fails, and never one it didn’t make', async () => {
    const t = setup();
    const none = () => undefined;
    const existing = join(t.dest, '.existing.partial');
    writeFileSync(existing, 'not ours');
    await expect(realPublishFs.copyNew(t.staged, existing, none)).rejects.toThrow();
    expect(readFileSync(existing, 'utf8')).toBe('not ours');
    const target = join(t.dest, '.made.partial');
    await expect(realPublishFs.copyNew(join(t.dir, 'missing'), target, none)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it('the real copy keeps a file put in its place before it fails', async () => {
    const t = setup();
    const target = join(t.dest, '.swapped.partial');
    await expect(
      realPublishFs.copyNew(join(t.dir, 'missing'), target, () => {
        // Someone replaces the new file before the copy fails.
        unlinkSync(target);
        writeFileSync(target, 'theirs');
      }),
    ).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('theirs');
  });

  it('cleanup keeps a file put in the copy’s place during the publish', async () => {
    const t = setup();
    let swapped = '';
    let inodes: bigint[] = [];
    const fs: PublishFs = {
      ...realPublishFs,
      link: async (from) => {
        if (PARTIAL_RE.test(from.split('/').pop()!)) {
          // The copy is replaced by someone else's file, then the link fails.
          // Theirs is made while the copy still exists, so it can't reuse its inode.
          const ours = lstatSync(from, { bigint: true }).ino;
          writeFileSync(`${from}.theirs`, 'theirs');
          renameSync(`${from}.theirs`, from);
          inodes = [ours, lstatSync(from, { bigint: true }).ino];
          swapped = from;
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      },
    };
    expect(await publish(t.staged, t.dest, 'a.txt', { ...t.options, fs })).toEqual({
      ok: false,
      reason: 'publish',
    });
    expect(inodes[1]).not.toBe(inodes[0]);
    expect(readFileSync(swapped, 'utf8')).toBe('theirs');
    expect(existsSync(t.staged)).toBe(false);
  });

  it('cleanup keeps the copy when its birth time differs, with the same device and inode', async () => {
    const t = setup();
    // The copy's path reads as a newer file that got the copy's device and inode.
    const fs: PublishFs = {
      ...realPublishFs,
      id: (path) => {
        const id = realPublishFs.id(path);
        if (!PARTIAL_RE.test(path.split('/').pop()!)) return id;
        return { ...id, birth: (BigInt(id.birth) + 1n).toString() };
      },
    };
    const result = await publish(t.staged, t.dest, 'a.txt', { ...t.options, fs, forceCopy: true });
    expect(result).toMatchObject({ ok: true, method: 'copy' });
    expect(leftovers(t.dest)).toEqual([t.owned[0]!.path.split('/').pop()]);
    expect(t.kept).toEqual(['foreign']);
    expect(existsSync(t.staged)).toBe(false);
  });

  it('cleanup keeps the copy when the file system reports no birth time', async () => {
    const t = setup();
    // Every file reads with a birth time of 0, as where the file system has none.
    const fs: PublishFs = {
      ...realPublishFs,
      copyNew: (from, path, created) =>
        realPublishFs.copyNew(from, path, (id) => created({ ...id, birth: '0' })),
      id: (path) => ({ ...realPublishFs.id(path), birth: '0' }),
    };
    const result = await publish(t.staged, t.dest, 'a.txt', { ...t.options, fs, forceCopy: true });
    expect(result).toMatchObject({ ok: true, method: 'copy' });
    expect(t.owned[0]!.birth).toBe('0');
    expect(leftovers(t.dest)).toEqual([t.owned[0]!.path.split('/').pop()]);
    expect(t.kept).toEqual(['incomplete']);
  });
});
