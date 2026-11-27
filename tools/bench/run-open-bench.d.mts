// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TreeEntry } from '../gen-export/tree.mjs';
import type { TimedOpen } from '../../src/testhooks/open-bench-types';

export const OPEN_P95_TARGET_MS: number;
export function percentile(values: number[], p: number): number | null;
export function median(values: number[]): number | null;
export function pickSample(
  entries: TreeEntry[],
  options: { seed: number; count: number; maxBytes: number },
): Array<{ path: string; size: number }>;
export interface CorpusState {
  entries: number;
  bytes: number;
  disk_bytes: number;
  digest: string;
  matches: boolean;
  differs: string[];
}
export function corpusState(root: string, manifest: Record<string, unknown>): CorpusState;
export interface RunSummary {
  opens: number;
  views: number;
  fallbacks: number;
  rejected: number;
  /** Rowids whose frame didn't load in time. */
  timeouts: number[];
  html: number;
  plain: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}
export function summarizeRun(opens: TimedOpen[]): RunSummary;
export interface LaunchRecord {
  summary: RunSummary | null;
  window: { visible: boolean; focused: boolean } | null;
  /** The show and focus events the app recorded; null when it wrote no result. */
  windowEvents: Array<{ window: number; event: string }> | null;
  /** How the app ended; `timedOut` when it was killed at the launch's time limit. */
  exit: { code: number | null; signal: string | null; timedOut: boolean } | null;
  /** Warm-up opens asked for, run, and shown as a view; null counts when it wrote no result. */
  warmup: { requested: number; count: number | null; views: number | null } | null;
}
export function stayedHidden(run: Pick<LaunchRecord, 'window' | 'windowEvents'>): boolean;
export function exitedCleanly(run: Pick<LaunchRecord, 'exit'>): boolean;
export function warmedUp(run: Pick<LaunchRecord, 'warmup'>): boolean;
export function verdict(
  runs: LaunchRecord[],
  target?: number,
): {
  valid: boolean;
  medianP95: number | null;
  p95s: Array<number | null>;
  target: number;
  within: boolean;
  /** Show and focus events over all launches. */
  windowEvents: number;
};
export function markdown(report: unknown): string;
