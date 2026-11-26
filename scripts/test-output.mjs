// SPDX-License-Identifier: AGPL-3.0-or-later
// Removal of test output. Tests and checks write into test-output/ inside the
// repository; these functions remove folders there and nothing else. Before
// removing anything they check the physical layout: test-output/ and every
// folder from it down to the one being removed must be a real folder, not a
// symbolic link, so a removal can never reach a folder outside test-output/.

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..');

/** test-output/ inside `root`. */
export function testOutputOf(root = REPO_ROOT) {
  return join(resolve(root), 'test-output');
}

export const TEST_OUTPUT = testOutputOf(REPO_ROOT);
/** One folder per test in here (tests/paths.ts). */
export const TEST_RUNS = join(TEST_OUTPUT, 'runs');

/** The path of `path` relative to `base`, or null if it is not `base` or below it. */
function below(base, path) {
  const steps = relative(base, path);
  if (steps === '..' || steps.startsWith(`..${sep}`) || isAbsolute(steps)) return null;
  return steps;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Checks `path`, test-output/ itself or a path below it, and every folder
 * between them. Returns false if one of them does not exist. Throws if one is
 * a symbolic link or not a folder, or if `path` does not lie physically inside
 * the physical test-output/.
 */
function checkPhysical(root, path) {
  const output = testOutputOf(root);
  const steps = below(output, path);
  if (steps === null) throw new Error(`refusing to remove ${path}: not inside ${output}`);
  let current = output;
  for (const step of ['', ...steps.split(sep).filter(Boolean)]) {
    current = join(current, step);
    const stat = lstatOrNull(current);
    if (stat === null) return false;
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to remove ${path}: ${current} is a symbolic link`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`refusing to remove ${path}: ${current} is not a folder`);
    }
  }
  const physical = join(realpathSync(resolve(root)), 'test-output', steps);
  if (realpathSync(path) !== physical) {
    throw new Error(`refusing to remove ${path}: its physical path is not ${physical}`);
  }
  return true;
}

/**
 * Gives the owner full access to the folder `dir` and every folder below it,
 * so that a read-only copy a failed test left behind can be removed. Each
 * folder is opened without following a link, and only entries that are real
 * folders are visited: links are never followed, and files keep their modes.
 */
function unlockFolders(dir) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    fchmodSync(fd, (fstatSync(fd).mode & 0o777) | 0o700);
  } finally {
    closeSync(fd);
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) unlockFolders(join(dir, entry.name));
  }
}

/**
 * Removes test-output/ with everything in it. A missing test-output/ is fine;
 * one that is a symbolic link or not a folder is refused. Folders inside it
 * that a failed test left read-only get owner access first.
 */
export function removeTestOutput(root = REPO_ROOT) {
  const output = testOutputOf(root);
  if (!checkPhysical(root, output)) return;
  unlockFolders(output);
  rmSync(output, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Removes `dir`, a folder directly inside `parent`, where `parent` is
 * test-output/ or a folder below it. A missing `dir` is fine. Anything else,
 * or a symbolic link on the way, is refused with an error before anything is
 * removed. A folder that can't be removed (a process still writing into it)
 * is reported and left for the next `npm run ci`, which removes test-output/
 * first.
 */
export function removeOutputDir(parent, dir, root = REPO_ROOT) {
  const container = resolve(parent);
  const target = resolve(dir);
  if (below(testOutputOf(root), container) === null) {
    throw new Error(`refusing to remove ${dir}: ${parent} is not inside ${testOutputOf(root)}`);
  }
  if (dirname(target) !== container) {
    throw new Error(`refusing to remove ${dir}: not a folder directly inside ${parent}`);
  }
  if (!checkPhysical(root, target)) return;
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.warn(`could not remove ${target}: ${String(err)}`);
  }
}
