// SPDX-License-Identifier: AGPL-3.0-or-later
// Test output stays inside the repository, in the ignored test-output/ folder.
// Folders of tests that pass are removed again (see removeTestDirs); a failed
// test keeps its folders as evidence until the next `npm run ci`.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, TEST_OUTPUT, TEST_RUNS, removeOutputDir } from '../scripts/test-output.mjs';

export { REPO_ROOT, TEST_OUTPUT };
export const RUNS = TEST_RUNS;

let counter = 0;
let made: string[] = [];
let report: ((dir: string) => void) | undefined;

/** A new, empty directory under test-output/runs/ for one test. */
export function testDir(name: string): string {
  counter += 1;
  const dir = join(RUNS, `${Date.now()}-${process.pid}-${counter}-${name}`);
  mkdirSync(dir, { recursive: true });
  made.push(dir);
  report?.(dir);
  return dir;
}

/** The directories testDir made since the last call. */
export function takeTestDirs(): string[] {
  const taken = made;
  made = [];
  return taken;
}

/** Calls `record` with every directory testDir makes from now on. */
export function onTestDir(record: (dir: string) => void): void {
  report = record;
}

/**
 * Removes directories that testDir made. Only folders directly inside
 * test-output/runs/ are removed, and only when neither they nor test-output/
 * or runs/ are symbolic links; anything else is refused with an error.
 */
export function removeTestDirs(dirs: string[]): void {
  for (const dir of dirs) removeOutputDir(RUNS, dir);
}
