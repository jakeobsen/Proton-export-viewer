// SPDX-License-Identifier: AGPL-3.0-or-later
// Export files for the bench: the scan pairs `<ID>.metadata.json` with
// `<ID>.eml`, and every read opens without following links or blocking, then
// checks that the open file is the regular file the scan saw.

import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { PairInfo } from './writer';

export const MAX_METADATA_BYTES = 4 * 1024 * 1024;

export interface FileRef {
  path: string;
  dev: number;
  ino: number;
}

export class FileError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function openChecked(ref: FileRef): number {
  let fd: number;
  try {
    fd = openSync(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    throw new FileError(`OPEN_${(err as NodeJS.ErrnoException).code ?? 'FAILED'}`);
  }
  const st = fstatSync(fd);
  if (!st.isFile() || st.dev !== ref.dev || st.ino !== ref.ino) {
    closeSync(fd);
    throw new FileError('FILE_CHANGED');
  }
  return fd;
}

export function readContained(ref: FileRef, maxBytes: number): Buffer {
  const fd = openChecked(ref);
  try {
    if (fstatSync(fd).size > maxBytes) throw new FileError('TOO_LARGE');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function streamContained(ref: FileRef): Readable {
  const fd = openChecked(ref);
  return createReadStream('', { fd, highWaterMark: 64 * 1024, autoClose: true });
}

export interface ScanResult {
  pairs: PairInfo[];
  rejected: number;
  labelsPath: string | null;
}

const METADATA = '.metadata.json';
const EML = '.eml';

/** Pairs the run folder's files by ID, in byte order of the file names. */
export function scanRun(runDir: string): ScanResult {
  const meta = new Map<string, FileRef & { size: number; mtimeNs: number }>();
  const eml = new Map<string, FileRef & { size: number; mtimeNs: number }>();
  let rejected = 0;
  let labelsPath: string | null = null;
  for (const name of readdirSync(runDir)) {
    const path = join(runDir, name);
    const st = lstatSync(path, { bigint: true });
    if (!st.isFile()) {
      rejected += 1;
      continue;
    }
    const info = {
      path,
      dev: Number(st.dev),
      ino: Number(st.ino),
      size: Number(st.size),
      mtimeNs: Number(st.mtimeNs),
    };
    if (name === 'labels.json') labelsPath = path;
    else if (name.endsWith(METADATA)) meta.set(name.slice(0, -METADATA.length), info);
    else if (name.endsWith(EML)) eml.set(name.slice(0, -EML.length), info);
    else rejected += 1;
  }
  const ids = [...meta.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pairs = ids.map((id): PairInfo => {
    const m = meta.get(id)!;
    const e = eml.get(id);
    return {
      protonId: id,
      metaRel: `${id}${METADATA}`,
      metaSize: m.size,
      metaMtimeNs: m.mtimeNs,
      metaDev: m.dev,
      metaIno: m.ino,
      emlRel: e ? `${id}${EML}` : null,
      emlSize: e?.size ?? null,
      emlMtimeNs: e?.mtimeNs ?? null,
      emlDev: e?.dev ?? null,
      emlIno: e?.ino ?? null,
    };
  });
  return { pairs, rejected, labelsPath };
}
