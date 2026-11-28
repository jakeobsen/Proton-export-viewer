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
];

/** Every place in the data folder where a reset deletes something. */
export function appDataPaths(userData: string): string[] {
  return [...APP_FILES, ...APP_FOLDERS.map((f) => f.name)].map((name) => join(userData, name));
}

/** Deletes a file or a link; never a folder. */
function removeFile(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) return;
    rmSync(path, { force: true });
  } catch {
    // Not there.
  }
}

/** Deletes the app's data, and nothing else, from its data folder. */
export function removeAppData(userData: string): void {
  for (const name of APP_FILES) removeFile(join(userData, name));
  for (const { name, files } of APP_FOLDERS) {
    const dir = join(userData, name);
    let entries: string[];
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) if (files.test(entry)) removeFile(join(dir, entry));
    try {
      rmdirSync(dir);
    } catch {
      // Something else is in it, and stays.
    }
  }
}
