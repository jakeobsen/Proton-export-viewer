// SPDX-License-Identifier: AGPL-3.0-or-later
// A source's index on disk is a family of files: the database and its
// sidecars. An open SQLite connection keeps reading a file after it is
// unlinked, so nothing in a family is deleted while this process still holds
// a file descriptor on any of its files.

import { fstatSync, readdirSync, rmSync, statSync } from 'node:fs';

/** The database file and its sidecars. */
export const FAMILY_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

export function familyPaths(dbPath: string): string[] {
  return FAMILY_SUFFIXES.map((suffix) => dbPath + suffix);
}

export function familyBytes(dbPath: string): number {
  let total = 0;
  for (const path of familyPaths(dbPath)) {
    try {
      total += statSync(path).size;
    } catch {
      // A file of the family that doesn't exist counts as empty.
    }
  }
  return total;
}

/** Highest descriptor number tried when the process's descriptor list can't be read. */
const FD_SCAN_MAX = 65_536;

function openDescriptors(): number[] {
  const dir = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  try {
    return readdirSync(dir)
      .map(Number)
      .filter((fd) => Number.isSafeInteger(fd));
  } catch {
    return Array.from({ length: FD_SCAN_MAX }, (_, fd) => fd);
  }
}

/** How many of this process's file descriptors are open on a file of the family. */
export function descriptorsOn(dbPath: string): number {
  const files = new Set<string>();
  for (const path of familyPaths(dbPath)) {
    try {
      const st = statSync(path);
      files.add(`${st.dev}:${st.ino}`);
    } catch {
      // Not there: nothing can be open on it.
    }
  }
  if (files.size === 0) return 0;
  let count = 0;
  for (const fd of openDescriptors()) {
    try {
      const st = fstatSync(fd);
      if (files.has(`${st.dev}:${st.ino}`)) count += 1;
    } catch {
      // Closed meanwhile, or the listing's own descriptor.
    }
  }
  return count;
}

export class FamilyInUse extends Error {
  constructor() {
    super('FAMILY_IN_USE');
  }
}

/**
 * Deletes the database and every sidecar, but only once no descriptor of
 * this process is open on any of them; otherwise deletes nothing and throws.
 */
export function deleteFamily(dbPath: string): void {
  if (descriptorsOn(dbPath) > 0) throw new FamilyInUse();
  for (const path of familyPaths(dbPath)) rmSync(path, { force: true });
}

/** True if any file of the family exists. */
export function familyExists(dbPath: string): boolean {
  return familyPaths(dbPath).some((path) => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  });
}
