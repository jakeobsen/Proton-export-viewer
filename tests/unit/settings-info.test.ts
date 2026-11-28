// SPDX-License-Identifier: AGPL-3.0-or-later
// What Settings shows about the app's own files, and how sizes read.

import { mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { byteSize } from '../../src/shared/bytes';
import { userInfo } from 'node:os';
import {
  accountHome,
  folderLocation,
  homeRelative,
  indexFiles,
} from '../../src/main/settings-info';
import { testDir } from '../paths';

const KEY = '3f9c2a71-8d4e-4b6a-9c1f-52e07d1ab3c4';

describe('homeRelative', () => {
  it('shows the home folder as ~, and nothing else', () => {
    expect(homeRelative('/home/sam/Library/App/index/a.sqlite', '/home/sam')).toBe(
      '~/Library/App/index/a.sqlite',
    );
    expect(homeRelative('/home/sam/x', '/home/sam/')).toBe('~/x');
    expect(homeRelative('/home/sam', '/home/sam')).toBe('~');
    // A sibling whose name starts with the home folder's is not inside it.
    expect(homeRelative('/home/samuel/x', '/home/sam')).toBe('/home/samuel/x');
    expect(homeRelative('/var/x', '/home/sam')).toBe('/var/x');
    expect(homeRelative('/var/x', '')).toBe('/var/x');
    expect(homeRelative('/var/x', '/')).toBe('/var/x');
  });

  it('ends a folder with a separator', () => {
    expect(folderLocation('/home/sam/Library/App/logs', '/home/sam')).toBe('~/Library/App/logs/');
    expect(folderLocation('/home/sam/Library/App/logs/', '/home/sam')).toBe('~/Library/App/logs/');
  });
});

describe('accountHome', () => {
  it("is the account's home, not HOME, which is the container in the sandbox", () => {
    const saved = process.env.HOME;
    process.env.HOME = '/home/sam/Library/Containers/com.example.app/Data';
    try {
      expect(accountHome()).toBe(userInfo().homedir);
      expect(accountHome()).not.toBe(process.env.HOME);
    } finally {
      process.env.HOME = saved;
    }
  });

  it('is empty when it cannot be found, so paths show in full', () => {
    const home = accountHome(() => {
      throw new Error('no entry');
    });
    expect(home).toBe('');
    expect(homeRelative('/home/sam/Library/x', home)).toBe('/home/sam/Library/x');
  });
});

describe('indexFiles', () => {
  const dir = () => {
    const d = join(
      realpathSync(testDir('settings-info')),
      `i${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(d, { recursive: true });
    return d;
  };

  it('adds up the database and its sidecars, regular files only', () => {
    const d = dir();
    writeFileSync(join(d, `${KEY}.sqlite`), Buffer.alloc(4096));
    writeFileSync(join(d, `${KEY}.sqlite-wal`), Buffer.alloc(1000));
    writeFileSync(join(d, `${KEY}.sqlite-shm`), Buffer.alloc(32768));
    writeFileSync(join(d, `${KEY}.sqlite-journal`), Buffer.alloc(10));
    // Another index's files and a stray name don't count.
    writeFileSync(join(d, `00000000-0000-4000-8000-000000000000.sqlite`), Buffer.alloc(999));
    writeFileSync(join(d, `${KEY}.sqlite.bak`), Buffer.alloc(999));
    const info = indexFiles(d, KEY, d);
    expect(info.bytes).toBe(4096 + 1000 + 32768 + 10);
    expect(info.location).toBe(`~/${KEY}.sqlite`);
  });

  it('never follows a link and counts no folder', () => {
    const d = dir();
    writeFileSync(join(d, 'big'), Buffer.alloc(50_000));
    writeFileSync(join(d, `${KEY}.sqlite`), Buffer.alloc(100));
    symlinkSync(join(d, 'big'), join(d, `${KEY}.sqlite-wal`));
    mkdirSync(join(d, `${KEY}.sqlite-journal`));
    expect(indexFiles(d, KEY, '/nowhere').bytes).toBe(100);
  });

  it('takes the last change from the database and its log, not from -shm', () => {
    const d = dir();
    const at = (s: number) => new Date(s * 1000);
    writeFileSync(join(d, `${KEY}.sqlite`), 'x');
    writeFileSync(join(d, `${KEY}.sqlite-wal`), 'x');
    writeFileSync(join(d, `${KEY}.sqlite-shm`), 'x');
    utimesSync(join(d, `${KEY}.sqlite`), at(1_700_000_000), at(1_700_000_000));
    utimesSync(join(d, `${KEY}.sqlite-wal`), at(1_700_000_500), at(1_700_000_500));
    utimesSync(join(d, `${KEY}.sqlite-shm`), at(1_800_000_000), at(1_800_000_000));
    expect(indexFiles(d, KEY, '').updatedAt).toBe(1_700_000_500_000);
  });

  it('ignores an empty log, which only opening the index made', () => {
    const d = dir();
    const at = (s: number) => new Date(s * 1000);
    writeFileSync(join(d, `${KEY}.sqlite`), 'x');
    writeFileSync(join(d, `${KEY}.sqlite-wal`), '');
    utimesSync(join(d, `${KEY}.sqlite`), at(1_700_000_000), at(1_700_000_000));
    utimesSync(join(d, `${KEY}.sqlite-wal`), at(1_800_000_000), at(1_800_000_000));
    expect(indexFiles(d, KEY, '').updatedAt).toBe(1_700_000_000_000);
  });

  it('gives no size or time when there is no index yet', () => {
    const d = dir();
    expect(indexFiles(d, KEY, '')).toEqual({
      location: join(d, `${KEY}.sqlite`),
      bytes: 0,
      updatedAt: null,
    });
  });
});

describe('byteSize', () => {
  it('uses decimal units with three significant digits', () => {
    expect(byteSize(0)).toBe('0 bytes');
    expect(byteSize(1)).toBe('1 byte');
    expect(byteSize(999)).toBe('999 bytes');
    expect(byteSize(1000)).toBe('1.00 KB');
    expect(byteSize(12_345)).toBe('12.3 KB');
    expect(byteSize(182_400)).toBe('182 KB');
    expect(byteSize(99_960)).toBe('100 KB');
    expect(byteSize(9_996)).toBe('10.0 KB');
    expect(byteSize(999_499)).toBe('999 KB');
    expect(byteSize(999_999)).toBe('1.00 MB');
    expect(byteSize(1_840_000_000)).toBe('1.84 GB');
    expect(byteSize(12_300_000_000_000)).toBe('12.3 TB');
    expect(byteSize(5e18)).toBe('5000000 TB');
    expect(byteSize(-1)).toBe('0 bytes');
    expect(byteSize(Number.NaN)).toBe('0 bytes');
  });
});
