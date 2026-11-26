// SPDX-License-Identifier: AGPL-3.0-or-later
// The two exports the folder-proof build accepts. The build takes them from
// PEV_FOLDER_PROOF_EXPORTS="<first>:<second>": two folders made by the
// synthetic export generator, each with its manifest next to it
// (<folder>.manifest.json). Their physical paths and manifest digests are
// built into the app, which refuses any other folder before it changes
// anything.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** True if `a` and `b` are the same folder, or one of them lies inside the other. */
export function overlaps(a, b) {
  const within = (base, path) => {
    const steps = relative(base, path);
    return !(steps === '..' || steps.startsWith(`..${sep}`) || isAbsolute(steps));
  };
  return within(a, b) || within(b, a);
}

function expectedExport(folder) {
  if (!isAbsolute(folder)) throw new Error(`${folder} is not an absolute path`);
  const given = resolve(folder);
  const path = realpathSync(given);
  if (!statSync(path).isDirectory()) throw new Error(`${folder} is not a folder`);
  const manifest = JSON.parse(readFileSync(`${given}.manifest.json`, 'utf8'));
  if (typeof manifest.digest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.digest)) {
    throw new Error(`${given}.manifest.json has no digest`);
  }
  if (typeof manifest.destination !== 'string' || realpathSync(manifest.destination) !== path) {
    throw new Error(`${given}.manifest.json was written for another folder`);
  }
  return { path, digest: manifest.digest };
}

/**
 * Reads `value`, "<first>:<second>", and returns each export's physical path
 * and manifest digest. Refuses anything but two separate generated exports.
 */
export function expectedExports(value) {
  const folders = value ? value.split(':') : [];
  if (folders.length !== 2) {
    throw new Error('PEV_FOLDER_PROOF_EXPORTS must name two exports: "<first>:<second>"');
  }
  const list = folders.map(expectedExport);
  if (overlaps(list[0].path, list[1].path)) {
    throw new Error('the two exports must be separate folders, neither inside the other');
  }
  return list;
}
