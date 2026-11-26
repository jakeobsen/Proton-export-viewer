// SPDX-License-Identifier: AGPL-3.0-or-later
// What tells one export run from another at the same place: the SHA-256 of
// its labels.json, and the SHA-256 of the sorted names of its metadata files.
// The names come from one readdir, as raw bytes, so no name is changed by
// decoding. Nothing else in the folder is read.

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import {
  ContainmentError,
  LABELS_FILE,
  METADATA_SUFFIX,
  examine,
  readContained,
  limitFor,
  realFs,
  type ScanFs,
} from './containment';
import type { RunIdentity } from '../shared/sources';

export type { RunIdentity };

const SUFFIX = Buffer.from(METADATA_SUFFIX);
const LABELS = Buffer.from(LABELS_FILE);

function endsWith(name: Buffer, suffix: Buffer): boolean {
  return name.length > suffix.length && name.subarray(name.length - suffix.length).equals(suffix);
}

/** The digest of a list of file names, in byte order. */
export function namesDigest(names: Buffer[]): string {
  const sorted = [...names].sort(Buffer.compare);
  const hash = createHash('sha256');
  const nul = Buffer.alloc(1);
  for (const name of sorted) {
    hash.update(name);
    hash.update(nul);
  }
  return hash.digest('hex');
}

/** The identity of the run folder at `root` (its canonical path). */
export async function runIdentity(root: string, fs: ScanFs = realFs): Promise<RunIdentity> {
  const names = await readdir(root, { encoding: 'buffer' });
  const metadata = names.filter((name) => endsWith(name, SUFFIX));
  let labelsSha256: string | null = null;
  if (names.some((name) => name.equals(LABELS))) {
    const found = examine(root, LABELS_FILE, fs);
    if (found && 'ref' in found) {
      try {
        const bytes = readContained(root, found.ref, limitFor('labels'));
        labelsSha256 = createHash('sha256').update(bytes).digest('hex');
      } catch (err) {
        if (!(err instanceof ContainmentError)) throw err;
      }
    }
  }
  return { labelsSha256, namesSha256: namesDigest(metadata), metadataNames: metadata.length };
}
