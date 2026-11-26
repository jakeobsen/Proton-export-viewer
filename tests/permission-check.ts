// SPDX-License-Identifier: AGPL-3.0-or-later
// What ordinary file permissions allow in an export, for the positive control
// of the folder-access proof: where they already deny a change, a denial in
// the sandboxed build could not be told apart from a permission error.

import { accessSync, constants } from 'node:fs';
import { exportTargets, walk } from '../src/testhooks/proof/fs';

/**
 * Lists what ordinary permissions would deny the current user in the export
 * `root` for the proof's reads and changes: every folder must be listable and
 * writable (create, rename and delete), the read pair readable and the files
 * the write check appends to writable. Empty when nothing is denied.
 */
export function permissionDenials(root: string): string[] {
  const denied: string[] = [];
  const check = (what: string, path: string, mode: number) => {
    try {
      accessSync(path, mode);
    } catch (err) {
      denied.push(`${what} ${path}: ${(err as NodeJS.ErrnoException).code ?? 'denied'}`);
    }
  };
  const folder = constants.R_OK | constants.W_OK | constants.X_OK;
  check('folder', root, folder);
  for (const entry of walk(root)) {
    if (entry.type === 'dir') check('folder', entry.full, folder);
  }
  const targets = exportTargets(root, 'permissions');
  for (const file of targets.read) check('read', file, constants.R_OK);
  for (const side of [targets.main, targets.core]) check('write', side.write, constants.W_OK);
  return denied;
}
