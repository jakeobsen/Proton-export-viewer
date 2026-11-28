// SPDX-License-Identifier: AGPL-3.0-or-later
// The staging folder: the app's own, a real folder; emptied by the sweep,
// which also removes a fallback copy the app made, and nothing else, outside
// it: only a file whose identity and folder match the note, in a folder the
// export guard allows.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARTIAL_NOTE, STAGING_DIR, Staging } from '../../src/main/saves/staging';
import { testDir } from '../paths';

describe('Staging', () => {
  it('makes its folder when missing, and names files inside it', () => {
    const userData = testDir('save-staging');
    const staging = new Staging(userData);
    expect(staging.ensure()).toBe(join(userData, STAGING_DIR));
    expect(staging.newFile().startsWith(join(userData, STAGING_DIR) + '/')).toBe(true);
    expect(staging.newFile()).not.toBe(staging.newFile());
  });

  it('refuses a link in the folder’s place', () => {
    const userData = testDir('save-staging');
    const elsewhere = join(userData, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(userData, STAGING_DIR));
    expect(() => new Staging(userData).ensure()).toThrow();
  });

  /** A staging folder, a destination folder, and a fallback copy made as a publish makes it. */
  function made(content = 'copy') {
    const userData = testDir('save-staging');
    const dest = join(userData, 'Downloads');
    mkdirSync(dest);
    const staging = new Staging(userData);
    staging.ensure();
    writeFileSync(staging.newFile(), 'staged');
    const partial = Staging.partialIn(dest);
    staging.notePartial(partial);
    writeFileSync(partial, content, { flag: 'wx' });
    staging.ownPartial(partial, idOf(partial));
    writeFileSync(join(dest, 'kept.pdf'), 'theirs');
    return { userData, dest, staging, partial };
  }

  const anywhere = () => true;

  it('the sweep empties the folder and removes the fallback copy the app made', () => {
    const t = made();
    t.staging.sweep(anywhere);
    expect(existsSync(t.staging.dir)).toBe(false);
    expect(readdirSync(t.dest)).toEqual(['kept.pdf']);
  });

  it('the note holds the copy’s identity and its folder’s real path', () => {
    const t = made();
    const note = JSON.parse(readFileSync(join(t.staging.dir, PARTIAL_NOTE), 'utf8'));
    expect(note).toEqual({
      path: t.partial,
      ...idOf(t.partial),
      real: realpathSync.native(t.dest),
    });
  });

  it('keeps a file put in the copy’s place (another inode)', () => {
    const t = made();
    unlinkSync(t.partial);
    writeFileSync(t.partial, 'theirs');
    t.staging.sweep(anywhere);
    expect(readFileSync(t.partial, 'utf8')).toBe('theirs');
    expect(existsSync(t.staging.dir)).toBe(false);
  });

  it('keeps a file it never made: a note with a path only, as after a refused create', () => {
    const userData = testDir('save-staging');
    const dest = join(userData, 'Downloads');
    mkdirSync(dest);
    const staging = new Staging(userData);
    const partial = Staging.partialIn(dest);
    staging.notePartial(partial);
    // The exclusive create was refused: this file is someone else's.
    writeFileSync(partial, 'theirs');
    staging.sweep(anywhere);
    expect(readFileSync(partial, 'utf8')).toBe('theirs');
  });

  it('keeps the copy when its folder is now a link to another folder', () => {
    const t = made();
    // The same file, reached through a folder link put where the folder was.
    const moved = join(t.userData, 'moved');
    renameSync(t.dest, moved);
    symlinkSync(moved, t.dest);
    t.staging.sweep(anywhere);
    expect(readdirSync(moved).sort()).toEqual([basename(t.partial), 'kept.pdf'].sort());
  });

  it('keeps the copy when its folder is now in an export', () => {
    const t = made();
    const asked: string[] = [];
    t.staging.sweep((dir) => {
      asked.push(dir);
      return false;
    });
    expect(asked).toEqual([realpathSync.native(t.dest)]);
    expect(existsSync(t.partial)).toBe(true);
    expect(existsSync(t.staging.dir)).toBe(false);
  });

  it('a note that names anything but a fallback copy removes nothing', () => {
    const userData = testDir('save-staging');
    const dest = join(userData, 'Downloads');
    mkdirSync(dest);
    const staging = new Staging(userData);
    staging.ensure();
    const other = join(dest, 'report.pdf');
    writeFileSync(other, 'theirs');
    writeFileSync(
      join(staging.dir, PARTIAL_NOTE),
      JSON.stringify({ path: other, ...idOf(other), real: realpathSync.native(dest) }),
    );
    const folder = join(dest, '.' + 'b'.repeat(32) + '.partial');
    mkdirSync(folder);
    staging.sweep(anywhere);
    expect(readdirSync(dest).sort()).toEqual(['.' + 'b'.repeat(32) + '.partial', 'report.pdf']);
    // A folder with a fallback copy's name is never removed either.
    writeFileSync(
      join(new Staging(userData).ensure(), PARTIAL_NOTE),
      JSON.stringify({ path: folder, ...idOf(folder), real: realpathSync.native(dest) }),
    );
    new Staging(userData).sweep(anywhere);
    expect(existsSync(folder)).toBe(true);
  });
});

function idOf(path: string): { dev: string; ino: string } {
  const st = lstatSync(path, { bigint: true });
  return { dev: st.dev.toString(), ino: st.ino.toString() };
}
