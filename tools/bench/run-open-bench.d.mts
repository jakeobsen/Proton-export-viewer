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
export function verdict(
  runs: Array<{ summary: RunSummary | null }>,
  target?: number,
): {
  valid: boolean;
  medianP95: number | null;
  p95s: Array<number | null>;
  target: number;
  within: boolean;
};
export function markdown(report: unknown): string;
