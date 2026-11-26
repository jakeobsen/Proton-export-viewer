// SPDX-License-Identifier: AGPL-3.0-or-later
// Small synthetic exports for tests, written from the generator's "small"
// profile: the export tool's layout (account folder, then the run folder) with
// labels.json and message pairs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RUN_FOLDER, accountAddress, entries } from '../tools/gen-export/generator.mjs';

export interface WrittenExport {
  /** The export tool's folder: it holds the account folder. */
  root: string;
  account: string;
  runName: string;
  /** The run folder. */
  run: string;
  /** Message pairs written. */
  pairs: number;
}

export interface ExportOptions {
  seed: number;
  /** The account folder's name; the seed's own address by default. */
  account?: string;
  /** The run folder's name. */
  runName?: string;
  /** Take labels.json from this seed's export instead. */
  labelsSeed?: number;
  /** At most this many messages (both files each). */
  messages?: number;
}

function labelsOf(seed: number): Buffer {
  for (const entry of entries('small', { seed })) {
    if ('meta' in entry) continue;
    if (entry.path.endsWith('/labels.json') && entry.data) return entry.data;
  }
  throw new Error('no labels.json');
}

/** Writes a small export below `root` and returns where it went. */
export function writeExport(root: string, options: ExportOptions): WrittenExport {
  const generated = accountAddress('small', options.seed);
  const account = options.account ?? generated;
  const runName = options.runName ?? RUN_FOLDER;
  const run = join(root, account, runName);
  const limit = options.messages ?? 20;
  const labels = options.labelsSeed === undefined ? null : labelsOf(options.labelsSeed);
  mkdirSync(run, { recursive: true });
  const ids = new Set<string>();
  for (const entry of entries('small', { seed: options.seed })) {
    if ('meta' in entry || entry.type !== 'file' || !entry.data) continue;
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    if (name === 'labels.json') {
      writeFileSync(join(run, name), labels ?? entry.data);
      continue;
    }
    const id = name.replace(/\.(?:metadata\.json|eml)$/, '');
    if (!ids.has(id)) {
      if (ids.size >= limit) continue;
      ids.add(id);
    }
    mkdirSync(dirname(join(run, name)), { recursive: true });
    writeFileSync(join(run, name), entry.data);
  }
  return { root, account, runName, run, pairs: ids.size };
}
