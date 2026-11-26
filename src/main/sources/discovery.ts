// SPDX-License-Identifier: AGPL-3.0-or-later
// Finds the export runs below a picked folder. The pick may be the export
// tool's folder (account folders, each with mail_* runs), one account folder
// (mail_* runs) or a run folder itself. Discovery looks no deeper than that
// layout, uses lstat and never follows a link, so a wrong pick such as a home
// folder isn't walked in full and a link loop can't hold it up. It reads
// folder listings only, never a file.

import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const RUN_PREFIX = 'mail_';

export interface FoundRun {
  /** The run folder's path relative to the pick; '' when the pick is the run. */
  rel: string;
  runName: string;
  /** The account folder's name, when the pick holds it or is it. */
  accountName: string | null;
}

export interface Discovery {
  /** The pick's canonical path. */
  root: string;
  /** Newest first. */
  runs: FoundRun[];
}

export interface DiscoveryFs {
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<Dirent[]>;
  lstat(path: string): Promise<{ isDirectory(): boolean }>;
}

const realFs: DiscoveryFs = {
  realpath: (path) => realpath(path),
  readdir: (path) => readdir(path, { withFileTypes: true }),
  lstat: (path) => lstat(path),
};

export function isRunName(name: string): boolean {
  return name.startsWith(RUN_PREFIX) && name.length > RUN_PREFIX.length;
}

/** Run folders sort newest first by name (mail_YYYYMMDD_HHMMSS), then by path. */
export function compareRuns(a: FoundRun, b: FoundRun): number {
  if (a.runName !== b.runName) return a.runName < b.runName ? 1 : -1;
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

async function isRealDirectory(fs: DiscoveryFs, path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listing(fs: DiscoveryFs, path: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

/** An entry that may be a directory: links, files and the like are skipped without a call. */
function maybeDirectory(entry: Dirent): boolean {
  return (
    entry.isDirectory() ||
    !(
      entry.isSymbolicLink() ||
      entry.isFile() ||
      entry.isFIFO() ||
      entry.isSocket() ||
      entry.isBlockDevice() ||
      entry.isCharacterDevice()
    )
  );
}

/** The runs below `pick`, newest first; none when the pick isn't a folder. */
export async function discoverRuns(pick: string, fs: DiscoveryFs = realFs): Promise<Discovery> {
  let root: string;
  try {
    root = await fs.realpath(pick);
  } catch {
    return { root: pick, runs: [] };
  }
  if (!(await isRealDirectory(fs, root))) return { root, runs: [] };
  const own = basename(root);
  if (isRunName(own)) return { root, runs: [{ rel: '', runName: own, accountName: null }] };

  const runs: FoundRun[] = [];
  for (const entry of await listing(fs, root)) {
    if (!maybeDirectory(entry)) continue;
    const path = join(root, entry.name);
    if (!(await isRealDirectory(fs, path))) continue;
    if (isRunName(entry.name)) {
      // The pick is an account folder.
      runs.push({ rel: entry.name, runName: entry.name, accountName: own });
      continue;
    }
    // The pick may be the tool's folder and this an account folder: one level more.
    for (const inner of await listing(fs, path)) {
      if (!isRunName(inner.name) || !maybeDirectory(inner)) continue;
      if (!(await isRealDirectory(fs, join(path, inner.name)))) continue;
      runs.push({
        rel: join(entry.name, inner.name),
        runName: inner.name,
        accountName: entry.name,
      });
    }
  }
  runs.sort(compareRuns);
  return { root, runs };
}
