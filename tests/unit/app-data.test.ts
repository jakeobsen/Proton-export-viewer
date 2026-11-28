// SPDX-License-Identifier: AGPL-3.0-or-later
// A reset deletes only the files the app makes in its data folder, and its
// folders only once they are empty. Anything else there stays.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeAppData } from '../../src/main/sources/app-data';
import { digest } from '../../tools/gen-export/tree.mjs';
import { writeExport } from '../exports';
import { testDir } from '../paths';

const KEY = '00000000-0000-4000-8000-0000000000c3';

function appFiles(userData: string): void {
  mkdirSync(join(userData, 'index'), { recursive: true });
  mkdirSync(join(userData, 'logs'), { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    writeFileSync(join(userData, 'index', `${KEY}.sqlite${suffix}`), 'x');
  }
  for (const name of ['main.jsonl', 'main.1.jsonl', 'renderer.jsonl', 'core.2.jsonl']) {
    writeFileSync(join(userData, 'logs', name), '{}\n');
  }
  writeFileSync(join(userData, 'sources.json'), '{}');
  writeFileSync(join(userData, 'sources.json.tmp'), '{}');
  writeFileSync(join(userData, 'settings.json'), '{}');
  writeFileSync(join(userData, 'settings.json.tmp'), '{}');
}

describe('removeAppData', () => {
  it('deletes the app’s files and then its empty folders', () => {
    const userData = realpathSync(testDir('appdata-all'));
    appFiles(userData);
    mkdirSync(join(userData, 'session'));
    removeAppData(userData);
    expect(readdirSync(userData)).toEqual(['session']);
  });

  it('leaves an export inside its folders, and everything else it didn’t make', () => {
    const userData = realpathSync(testDir('appdata-nested'));
    appFiles(userData);
    const inIndex = join(userData, 'index', 'nested');
    const inLogs = join(userData, 'logs', 'nested');
    writeExport(inIndex, { seed: 31, messages: 4 });
    writeExport(inLogs, { seed: 32, messages: 4 });
    // The export tool's own files, right in the app's folders.
    const run = join(userData, 'index');
    writeFileSync(join(run, 'labels.json'), '{}');
    writeFileSync(join(run, 'a.metadata.json'), '{}');
    writeFileSync(join(run, 'a.eml'), 'Subject: a\r\n\r\n');
    writeFileSync(join(userData, 'logs', 'notes.txt'), 'kept');
    // Folders named like the app's files are never deleted.
    mkdirSync(join(userData, 'index', `${KEY.replace('c3', 'd4')}.sqlite`));
    mkdirSync(join(userData, 'settings.json.d'));
    const before = [digest(inIndex), digest(inLogs)];

    removeAppData(userData);
    expect([digest(inIndex), digest(inLogs)]).toEqual(before);
    expect(readdirSync(join(userData, 'index')).sort()).toEqual(
      [
        'nested',
        'labels.json',
        'a.metadata.json',
        'a.eml',
        `${KEY.replace('c3', 'd4')}.sqlite`,
      ].sort(),
    );
    expect(readdirSync(join(userData, 'logs')).sort()).toEqual(['nested', 'notes.txt']);
    expect(existsSync(join(userData, 'sources.json'))).toBe(false);
    expect(existsSync(join(userData, 'settings.json'))).toBe(false);
    expect(existsSync(join(userData, 'settings.json.d'))).toBe(true);
  });

  it('removes a link with an app file’s name, never what it points to', () => {
    const userData = realpathSync(testDir('appdata-link'));
    const elsewhere = realpathSync(testDir('appdata-link-target'));
    writeExport(elsewhere, { seed: 33, messages: 3 });
    const before = digest(elsewhere);
    mkdirSync(join(userData, 'index'));
    symlinkSync(elsewhere, join(userData, 'index', `${KEY}.sqlite`));
    symlinkSync(elsewhere, join(userData, 'logs'));
    removeAppData(userData);
    expect(readdirSync(userData)).toEqual(['logs']);
    expect(digest(elsewhere)).toBe(before);
  });
});
