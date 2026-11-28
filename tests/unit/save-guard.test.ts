// SPDX-License-Identifier: AGPL-3.0-or-later
// A save never goes into an export: a destination that is an export root, lies
// inside one, or reaches one through a link, is refused, before anything is
// made there. An export inside the destination is fine.

import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insideExport, type GuardFs } from '../../src/main/saves/guard';
import { testDir } from '../paths';

function layout() {
  const dir = testDir('save-guard');
  const exportRoot = join(dir, 'exports', 'mail_20250101_000000');
  const downloads = join(dir, 'Downloads');
  mkdirSync(exportRoot, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  return { dir, exportRoot, downloads };
}

describe('insideExport', () => {
  it('a folder apart from every export is allowed', () => {
    const { downloads, exportRoot } = layout();
    expect(insideExport(downloads, [exportRoot])).toBe(false);
  });

  it('an export root that is the destination itself is refused', () => {
    const { exportRoot } = layout();
    expect(insideExport(exportRoot, [exportRoot])).toBe(true);
  });

  it('a destination inside an export is refused, whether it exists yet or not', () => {
    const { exportRoot } = layout();
    const inside = join(exportRoot, 'sub');
    mkdirSync(inside);
    expect(insideExport(inside, [exportRoot])).toBe(true);
    expect(insideExport(join(exportRoot, 'not', 'yet'), [exportRoot])).toBe(true);
  });

  it('a link that resolves to an export is refused (an alias of it)', () => {
    const { dir, exportRoot } = layout();
    const alias = join(dir, 'alias');
    symlinkSync(exportRoot, alias);
    expect(insideExport(alias, [exportRoot])).toBe(true);
    expect(insideExport(join(alias, 'staging'), [exportRoot])).toBe(true);
  });

  it('an export reached through a link is matched by device and inode', () => {
    const { dir, downloads } = layout();
    const viaLink = join(dir, 'via');
    symlinkSync(downloads, viaLink);
    // The export is named by its link; the destination by its real path.
    expect(insideExport(downloads, [viaLink])).toBe(true);
  });

  it('an export inside the destination is allowed', () => {
    const { downloads } = layout();
    const exportInDownloads = join(downloads, 'export');
    mkdirSync(exportInDownloads);
    expect(insideExport(downloads, [exportInDownloads])).toBe(false);
  });

  it('a destination that can’t be checked counts as inside', () => {
    const fs: GuardFs = {
      realpath: (p) => p,
      id: () => {
        throw new Error('EACCES');
      },
    };
    expect(insideExport('/a/b', ['/c'], fs)).toBe(true);
  });

  it('matches by identity where the paths differ, as through a firmlink', () => {
    // `/System/Volumes/Data/Vol/Mail` is the same folder as `/Vol/Mail`: same inode.
    const ids: Record<string, string> = {
      '/': '1:2',
      '/Vol': '1:3',
      '/Vol/Mail': '1:4',
      '/System/Volumes/Data/Vol/Mail': '1:4',
    };
    const fs: GuardFs = {
      realpath: (p) => {
        if (p in ids) return p;
        throw new Error('ENOENT');
      },
      id: (p) => {
        const found = ids[p];
        if (!found) throw new Error('ENOENT');
        return found;
      },
    };
    expect(insideExport('/Vol/Mail', ['/System/Volumes/Data/Vol/Mail'], fs)).toBe(true);
    expect(insideExport('/Vol', ['/System/Volumes/Data/Vol/Mail'], fs)).toBe(false);
  });

  it('an export that isn’t there now is still compared by its path', () => {
    const { downloads } = layout();
    const gone = join(downloads, 'gone-export');
    expect(insideExport(join(gone, 'sub'), [gone])).toBe(true);
    expect(insideExport(downloads, [join(downloads, '..', 'gone')])).toBe(false);
  });
});
