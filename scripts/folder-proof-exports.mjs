// SPDX-License-Identifier: AGPL-3.0-or-later
// The two exports the folder-proof build accepts. The build takes them from
// PEV_FOLDER_PROOF_EXPORTS="<first>:<second>": two folders made by the
// synthetic export generator, each with its manifest next to it
// (<folder>.manifest.json). Each folder must still match its manifest's
// digest. Their physical paths and digests are built into the app, which
// refuses any other folder before it changes anything. The single account
// folder inside an export is recorded too, with its own digest: the folder
// dialog may hand it over instead of the export.

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest } from '../tools/gen-export/tree.mjs';

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
  if (digest(path) !== manifest.digest) {
    throw new Error(`${given} does not match its manifest digest`);
  }
  return { path, digest: manifest.digest, account: accountFolder(path) };
}

/** The export's only entry, when it is a folder (not a link): its path and digest. */
function accountFolder(root) {
  const names = readdirSync(root);
  if (names.length !== 1) return null;
  const path = join(root, names[0]);
  if (!lstatSync(path).isDirectory()) return null;
  return { path, digest: digest(path) };
}

/**
 * Reads `value`, "<first>:<second>", and returns each export's physical path
 * and manifest digest, and its account folder's. Refuses anything but two
 * separate generated exports that match their manifests.
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
