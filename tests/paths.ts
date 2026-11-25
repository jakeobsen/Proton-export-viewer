// SPDX-License-Identifier: AGPL-3.0-or-later
// Test output stays inside the repository, in the ignored test-output/ folder.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..');
export const TEST_OUTPUT = join(REPO_ROOT, 'test-output');

let counter = 0;

/** A new, empty directory under test-output/ for one test. */
export function testDir(name: string): string {
  counter += 1;
  const dir = join(TEST_OUTPUT, 'runs', `${Date.now()}-${process.pid}-${counter}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
