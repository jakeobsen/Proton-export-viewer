// SPDX-License-Identifier: AGPL-3.0-or-later
// The open bench's config, as its runner writes it. It is checked before the
// app reads a message or writes anything: the run's workspace, where the
// result goes, must be outside the folder the messages are read from, and
// marked as this run's.

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { checkOutside, checkWorkspace } from '../../tools/bench/workspace.mjs';

export interface OpenBenchConfig {
  nonce: string;
  /** The run's workspace, created fresh and marked by the runner. The result goes inside. */
  workspace: string;
  /** The folder the messages are read from. */
  root: string;
  /** Message files, relative to `root`. File i is rowid i + 1. */
  files: string[];
  /** How many of the first files open once before the timed opens, untimed. */
  warmup: number;
}

export function parseConfig(value: unknown): OpenBenchConfig {
  const c = value as Partial<OpenBenchConfig>;
  const ok =
    typeof c === 'object' &&
    c !== null &&
    typeof c.nonce === 'string' &&
    /^[0-9a-f]{16}$/.test(c.nonce) &&
    typeof c.workspace === 'string' &&
    isAbsolute(c.workspace) &&
    typeof c.root === 'string' &&
    isAbsolute(c.root) &&
    Array.isArray(c.files) &&
    c.files.length > 0 &&
    c.files.every((f) => typeof f === 'string' && f.length > 0) &&
    Number.isSafeInteger(c.warmup) &&
    (c.warmup as number) >= 0 &&
    (c.warmup as number) <= c.files.length;
  if (!ok) throw new Error('invalid open bench config');
  return c as OpenBenchConfig;
}

/** Reads the config file and checks the run's workspace. */
export function readConfig(file: string): OpenBenchConfig {
  const config = parseConfig(JSON.parse(readFileSync(file, 'utf8')));
  checkOutside(config.root, config.workspace);
  checkWorkspace(config.workspace, config.nonce);
  return config;
}
