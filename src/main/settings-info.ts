// SPDX-License-Identifier: AGPL-3.0-or-later
// What Settings shows about the app's own files: where an export's index and
// the logs are, how large the index is and when it last changed. Only the
// app's data folder is looked at, never an export.

import { lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, sep } from 'node:path';

/** The files of one index: the database and its sidecars. */
const FAMILY = ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-journal'] as const;

/**
 * The account's home folder, from the user database rather than `HOME`: in
 * the App Sandbox, `HOME` and `os.homedir()` are the app's container, and a
 * path shown with `~` from there wouldn't exist. '' if it can't be found, and
 * paths then show in full.
 */
export function accountHome(info: () => { homedir: string } = () => userInfo()): string {
  try {
    const home = info().homedir;
    return typeof home === 'string' ? home : '';
  } catch {
    return '';
  }
}

/** A path with the home folder shown as `~`. */
export function homeRelative(path: string, home: string): string {
  if (home === '' || home === sep) return path;
  const root = home.endsWith(sep) ? home.slice(0, -1) : home;
  if (path === root) return '~';
  if (path.startsWith(root + sep)) return `~${path.slice(root.length)}`;
  return path;
}

export interface IndexFiles {
  /** The database's full path, with home as `~`. */
  location: string;
  /** The database and its sidecars, regular files only. */
  bytes: number;
  /** When the database, or its log if it holds anything, last changed, in ms since the epoch. */
  updatedAt: number | null;
}

/** Looks at one source's index files; `sourceKey` is a registry UUID. */
export function indexFiles(indexDir: string, sourceKey: string, home: string): IndexFiles {
  let bytes = 0;
  let updatedAt: number | null = null;
  for (const suffix of FAMILY) {
    let stat;
    try {
      stat = lstatSync(join(indexDir, `${sourceKey}${suffix}`));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    bytes += stat.size;
    // Readers write to -shm, and opening the index makes an empty -wal: only
    // the database, and a log that holds something, say the index changed.
    const changed = suffix === '.sqlite' || (suffix === '.sqlite-wal' && stat.size > 0);
    if (changed) updatedAt = Math.max(updatedAt ?? 0, stat.mtimeMs);
  }
  return {
    location: homeRelative(join(indexDir, `${sourceKey}.sqlite`), home),
    bytes,
    updatedAt: updatedAt === null ? null : Math.floor(updatedAt),
  };
}

/** A folder's path as Settings shows it: home as `~`, ending in a separator. */
export function folderLocation(dir: string, home: string): string {
  const shown = homeRelative(dir, home);
  return shown.endsWith(sep) ? shown : shown + sep;
}
