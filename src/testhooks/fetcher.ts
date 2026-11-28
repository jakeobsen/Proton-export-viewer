// SPDX-License-Identifier: AGPL-3.0-or-later
// Loaded into the fetcher in builds with test hooks only: the sandboxed
// self-test asks it to open a file of the open export, which must fail.

import { closeSync, openSync } from 'node:fs';
import { markLoaded } from './marker';

markLoaded();

/** Opens a file for reading and closes it again; the error code if the open fails. */
export function tryRead(path: string | undefined): { ok: boolean; code: string | null } {
  if (!path) return { ok: false, code: 'NO_TARGET' };
  try {
    closeSync(openSync(path, 'r'));
    return { ok: true, code: null };
  } catch (err) {
    return { ok: false, code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
  }
}
