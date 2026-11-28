// SPDX-License-Identifier: AGPL-3.0-or-later
// The app's own data in its data folder, and how a reset deletes it: only the
// files the app makes, found by name, and a folder of its own only once that
// leaves it empty. Anything else there stays, and links are removed, never
// followed.

import { lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_FILE } from '../settings';
import { REGISTRY_FILE } from './registry';

/** Files the app keeps at the top of its data folder. */
const APP_FILES = [REGISTRY_FILE, `${REGISTRY_FILE}.tmp`, SETTINGS_FILE, `${SETTINGS_FILE}.tmp`];

/** The app's folders there, each with the names of the files it makes in it. */
const APP_FOLDERS: ReadonlyArray<{ name: string; files: RegExp }> = [
  {
    name: 'index',
    files:
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite(?:-wal|-shm|-journal)?$/,
  },
  { name: 'logs', files: /^(?:main|renderer|core)(?:\.\d+)?\.jsonl$/ },
  // Downloads waiting to be published, and the note of a fallback copy.
  { name: 'save-staging', files: /^(?:[0-9a-f]{32}\.part(?:\.[a-z]{1,16})?|partial\.json)$/ },
];

/** Every place in the data folder where a reset deletes something. */
export function appDataPaths(userData: string): string[] {
  return [...APP_FILES, ...APP_FOLDERS.map((f) => f.name)].map((name) => join(userData, name));
}

/** True if the error says the path isn't there. */
const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Deletes a file or a link; never a folder. False only if a file is still there. */
function removeFile(path: string): boolean {
  try {
    if (lstatSync(path).isDirectory()) return true;
    rmSync(path, { force: true });
    return true;
  } catch (err) {
    return isMissing(err);
  }
}

/**
 * Deletes the app's data, and nothing else, from its data folder. Returns
 * how many of the app's files, or folders of its own that couldn't be read,
 * are still there; a path that isn't there counts as deleted.
 */
export function removeAppData(userData: string): number {
  let left = 0;
  for (const name of APP_FILES) if (!removeFile(join(userData, name))) left += 1;
  for (const { name, files } of APP_FOLDERS) {
    const dir = join(userData, name);
    let entries: string[];
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch (err) {
      // A folder that can't be read may still hold the app's files.
      if (!isMissing(err)) left += 1;
      continue;
    }
    for (const entry of entries) {
      if (files.test(entry) && !removeFile(join(dir, entry))) left += 1;
    }
    try {
      rmdirSync(dir);
    } catch {
      // Something else is in it, and stays.
    }
  }
  return left;
}
