// SPDX-License-Identifier: AGPL-3.0-or-later
// The bench's workspace: one folder a run creates fresh and owns. Every file
// a run writes goes inside it, and nothing outside it is ever removed. Each
// write or removal first checks the path physically: every step from the
// workspace down is a real folder (not a link), and the real path matches.

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const WORKSPACE_MARK = '.pev-bench-workspace';
export const WORKSPACE_DIRS = ['index', 'downloads', 'user-data'];

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** True if `path` is a real, normalized absolute path with no link on the way. */
function isPhysical(path) {
  return isAbsolute(path) && resolve(path) === path && realpathSync(path) === path;
}

/**
 * Creates the workspace: `path` must not exist yet and its parent must be a
 * real folder reached without links. Writes the run's mark and the subfolders.
 */
export function createWorkspace(path, nonce, dirs = WORKSPACE_DIRS) {
  if (!/^[0-9a-f]{16}$/.test(nonce)) throw new Error('the workspace needs a 16-hex-digit nonce');
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error(`${path} is not a normalized absolute path`);
  const parent = dirname(path);
  const stat = lstatOrNull(parent);
  if (!stat || !stat.isDirectory() || !isPhysical(parent))
    throw new Error(`${parent} is not a real folder reached without links`);
  try {
    mkdirSync(path);
  } catch (err) {
    if (err.code === 'EEXIST')
      throw new Error(`${path} already exists; each run needs a new folder`, { cause: err });
    throw err;
  }
  writeFileSync(join(path, WORKSPACE_MARK), `${nonce}\n`, { flag: 'wx', mode: 0o600 });
  for (const dir of dirs) mkdirSync(join(path, dir));
  return path;
}

/** Throws unless `path` is this run's workspace: a real folder holding its mark. */
export function checkWorkspace(path, nonce) {
  const stat = lstatOrNull(path);
  if (!stat || !stat.isDirectory() || !isPhysical(path))
    throw new Error(`${path} is not a real workspace folder`);
  const mark = join(path, WORKSPACE_MARK);
  const markStat = lstatOrNull(mark);
  if (!markStat || !markStat.isFile() || readFileSync(mark, 'utf8').trim() !== nonce)
    throw new Error(`${path} is not this run's workspace`);
  return path;
}

/**
 * Checks that `path` is inside the workspace with every folder on the way real
 * (not a link). Returns its lstat, or null if it doesn't exist.
 */
export function checkInside(workspace, path) {
  const rel = relative(workspace, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`${path} is not inside ${workspace}`);
  const steps = rel.split(sep);
  let current = workspace;
  for (const [i, step] of steps.entries()) {
    current = join(current, step);
    const stat = lstatOrNull(current);
    if (stat === null) return null;
    if (i < steps.length - 1 && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new Error(`${current} is not a real folder`);
    if (i === steps.length - 1) {
      if (stat.isDirectory() && realpathSync(current) !== current)
        throw new Error(`${current} is not a real folder`);
      return stat;
    }
  }
  return null;
}

/** Throws unless the folder exists inside the workspace as a real folder and holds nothing. */
export function checkEmptyFolder(workspace, path) {
  const stat = checkInside(workspace, path);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${path} is not a real folder`);
  const entries = readdirSync(path);
  if (entries.length > 0) throw new Error(`${path} is not empty: ${entries.join(', ')}`);
}

/**
 * Throws unless `file` can be created as a new file inside this run's
 * workspace: every folder on the way, its own folder included, is real (not a
 * link), and nothing is at `file` yet.
 */
export function checkNewFile(workspace, nonce, file) {
  checkWorkspace(workspace, nonce);
  const folder = dirname(file);
  if (folder !== workspace) {
    const stat = checkInside(workspace, folder);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`${folder} is not a real folder`);
  }
  if (checkInside(workspace, file) !== null) throw new Error(`${file} already exists`);
  return file;
}

/**
 * Removes `path` inside this run's workspace. A link is removed itself, never
 * followed; a folder must be a real folder.
 */
export function removeInside(workspace, nonce, path) {
  checkWorkspace(workspace, nonce);
  const stat = checkInside(workspace, path);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) rmSync(path, { force: true });
  else rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  return true;
}

/** Removes the whole workspace, after checking it is this run's. */
export function removeWorkspace(workspace, nonce) {
  checkWorkspace(workspace, nonce);
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
}
