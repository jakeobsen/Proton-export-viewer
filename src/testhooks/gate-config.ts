// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate mode's config, as its runner writes it. It is checked before the
// app reads a message or writes anything: the run's workspace, where the
// result goes, must be outside the export folder and marked as this run's.

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { checkOutside, checkWorkspace } from '../../tools/bench/workspace.mjs';

/**
 * What one launch does:
 * - probe: frame delivery in the hidden window, scrolls during and after phase 1, and a
 *   conversation's scroll once indexing has ended;
 * - fresh: picks the export into a new profile and times first rows and phase 1, with the
 *   same scrolls, then stays idle;
 * - reopen: reopens the export the profile already knows, and times the first rows after it opens;
 * - opens: picks the export, waits until indexing has ended, scrolls a conversation and times
 *   expansions.
 *
 * A launch that scrolls records the frame cadence twice with nothing else
 * going on: before the pick, and once indexing has ended.
 */
export type GateMode = 'probe' | 'fresh' | 'reopen' | 'opens';

export const GATE_MODES: readonly GateMode[] = ['probe', 'fresh', 'reopen', 'opens'];

export interface GateSample {
  seed: number;
  /** Messages timed, each once. */
  count: number;
  /** Largest message file in the sample. */
  maxBytes: number;
  /** Expansions before the timed ones, untimed. */
  warmup: number;
}

export interface GateConfig {
  nonce: string;
  /** The run's workspace, created fresh and marked by the runner. The result goes inside. */
  workspace: string;
  mode: GateMode;
  /** The export folder the app picks and reads in place. */
  root: string;
  /** The cap on the index's size on disk, with its WAL and shared memory. */
  capBytes: number;
  /** The longest any one wait may take (a phase, a list, a load), in ms. */
  stepMs: number;
  /** The longest a wait for one animation frame may take, in ms. */
  frameMs: number;
  /** Consecutive frames in each record of the frame cadence. */
  cadenceFrames: number;
  /** The longest a scroll step waits for its frame, then the grace after it, in ms. */
  scrollWaitMs: number;
  graceMs: number;
  /** DOM changes the frame probe times. */
  rafProbes: number;
  /** Steps in each scroll. */
  scrollSteps: number;
  /** Once indexing has ended: the wait before the idle window, then the window, in ms. */
  settleMs: number;
  idleMs: number;
  /** For 'opens': the expansions to time. */
  sample: GateSample | null;
}

const whole = (v: unknown, min: number, max: number): boolean =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

function parseSample(value: unknown): GateSample | null | undefined {
  if (value === null) return null;
  const s = value as Partial<GateSample>;
  const ok =
    typeof s === 'object' &&
    whole(s.seed, 0, 2 ** 31) &&
    whole(s.count, 1, 100_000) &&
    whole(s.maxBytes, 1, 2 ** 40) &&
    whole(s.warmup, 0, 100_000);
  return ok ? (s as GateSample) : undefined;
}

export function parseConfig(value: unknown): GateConfig {
  const c = value as Partial<GateConfig>;
  const sample = typeof c === 'object' && c !== null ? parseSample(c.sample) : undefined;
  const ok =
    typeof c === 'object' &&
    c !== null &&
    typeof c.nonce === 'string' &&
    /^[0-9a-f]{16}$/.test(c.nonce) &&
    typeof c.workspace === 'string' &&
    isAbsolute(c.workspace) &&
    typeof c.mode === 'string' &&
    GATE_MODES.includes(c.mode) &&
    typeof c.root === 'string' &&
    isAbsolute(c.root) &&
    whole(c.capBytes, 1, 2 ** 40) &&
    whole(c.stepMs, 1, 3_600_000) &&
    whole(c.frameMs, 1, 60_000) &&
    whole(c.rafProbes, 0, 10_000) &&
    whole(c.cadenceFrames, 0, 10_000) &&
    whole(c.scrollWaitMs, 1, 60_000) &&
    whole(c.graceMs, 0, 60_000) &&
    whole(c.scrollSteps, 0, 100_000) &&
    whole(c.settleMs, 0, 600_000) &&
    whole(c.idleMs, 0, 600_000) &&
    sample !== undefined &&
    (c.mode === 'opens') === (sample !== null);
  if (!ok) throw new Error('invalid gate config');
  return c as GateConfig;
}

/** Reads the config file and checks the run's workspace. */
export function readConfig(file: string): GateConfig {
  const config = parseConfig(JSON.parse(readFileSync(file, 'utf8')));
  checkOutside(config.root, config.workspace);
  checkWorkspace(config.workspace, config.nonce);
  return config;
}
