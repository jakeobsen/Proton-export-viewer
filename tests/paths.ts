// SPDX-License-Identifier: AGPL-3.0-or-later
// Test output stays inside the repository, in the ignored test-output/ folder.
// Folders of tests that pass are removed again (see removeTestDirs); a failed
// test keeps its folders as evidence until the next `npm run ci`.

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..');
export const TEST_OUTPUT = join(REPO_ROOT, 'test-output');
const RUNS = join(TEST_OUTPUT, 'runs');

let counter = 0;
let made: string[] = [];

/** A new, empty directory under test-output/ for one test. */
export function testDir(name: string): string {
  counter += 1;
  const dir = join(RUNS, `${Date.now()}-${process.pid}-${counter}-${name}`);
  mkdirSync(dir, { recursive: true });
  made.push(dir);
  return dir;
}

/** The directories testDir made since the last call. */
export function takeTestDirs(): string[] {
  const taken = made;
  made = [];
  return taken;
}

/**
 * Removes directories that testDir made. Anything outside test-output/runs/
 * is refused. A directory that can't be removed (a process still writing
 * into it) is reported and left for the next `npm run ci`, which empties
 * test-output/ first.
 */
export function removeTestDirs(dirs: string[]): void {
  for (const dir of dirs) {
    if (!resolve(dir).startsWith(RUNS + sep)) throw new Error(`not a test directory: ${dir}`);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.warn(`could not remove ${dir}: ${String(err)}`);
    }
  }
}
