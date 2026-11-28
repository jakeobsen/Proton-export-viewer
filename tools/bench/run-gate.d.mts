// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RafProbe, TimedExpansion } from '../../src/testhooks/gate-types';

export const TARGETS: {
  firstRowsMs: number;
  phase1At200kMs: number;
  reopenMs: number;
  idleMiB: number;
  peakMiB: number;
  openP95Ms: number;
};
export const PROMPT_FRAME_MS: number;
export const PHASE1_SCALE: number;
export const INDEX_CAP: number;

export function parseClamshell(text: string): boolean | null;
export function sleepsBetween(
  text: string,
  fromMs: number,
  toMs: number,
): Array<{ at: number; kind: 'Sleep' | 'DarkWake' }>;

export interface RafVerdict {
  samples: number;
  timeouts: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  thresholdMs: number;
  prompt: boolean;
}
export function rafVerdict(probes: Array<RafProbe | null | undefined>): RafVerdict;

export interface FrameStats {
  events: number;
  drawn: number;
  reported: number;
  presented: number;
  dropped: number;
  noUpdate: number;
  produced: boolean;
}
export function frameStats(trace: unknown): FrameStats;

export interface LaunchInput {
  nonce: string;
  result: Record<string, unknown> | null;
  exit: { code: number | null; signal: string | null; timedOut: boolean } | null;
  lidClosedAfter: boolean | null;
  sleeps?: Array<{ at: number; kind: string }>;
}
export function launchProblems(launch: LaunchInput): string[];

export interface Sample {
  at: number;
  totalBytes: number;
  rssBytes?: number | null;
  procs?: Array<{ name: string; pid: number; bytes: number }>;
}
export interface Memory {
  samples: number;
  peakByPhase: Record<string, number | null>;
  idleMiB: number | null;
  idleRssMiB: number | null;
  idleSamples: number;
  peakMiB: number | null;
  peakRssMiB: number | null;
}
export function memoryOf(
  samples: Sample[],
  phases: Array<{ phase: string; atEpoch: number }> | undefined,
  idleWindow: { fromEpoch: number; toEpoch: number } | null | undefined,
): Memory;

export interface FreshNumbers {
  firstRowsCommitMs: number | null;
  firstRowsFrameMs: number | null;
  phase1Ms: number | null;
  phase1Total: number | null;
  indexedMs: number | null;
}
export function freshNumbers(result: Record<string, unknown>): FreshNumbers;

export interface ReopenNumbers {
  rowsCommitMs: number | null;
  rowsFrameMs: number | null;
  rowsAfterOpened: boolean | null;
  openedMs: number | null;
  reconcileMs: number | null;
  reconcileApplyMs: number | null;
  verified: boolean;
  verifyMs: number | null;
}
export function reopenNumbers(result: Record<string, unknown>): ReopenNumbers;

export interface BatchNumbers {
  batches: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  repointedMessages: number;
  repointedKeys: number;
  repointedLabelRows: number;
  maxRepointed: number;
  indexBytes: number | null;
}
export function batchNumbers(batches: unknown): BatchNumbers;

export interface OpensNumbers {
  opens: number;
  views: number;
  timeouts: number;
  notHeld: number;
  notExpanded: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}
export function opensNumbers(opens: TimedExpansion[] | null | undefined): OpensNumbers;

export function verdictOf(
  value: number | null | undefined,
  target: number,
  options?: { proxy?: boolean; valid?: boolean },
): string;

export interface Row {
  row: string;
  name?: string;
  value: number | null;
  unit: string;
  target: number;
  kind: string;
  verdict: string;
  start?: string;
  end?: string;
  [key: string]: unknown;
}
export function scrollRow(
  name: string,
  scrolls: Array<{
    name: string;
    frames: FrameStats | null;
    run?: { byFrame: number; byTimer: number };
  }>,
): Row;
export function indexRows(report: unknown): Row[];
export function cardsRows(report: unknown): Row[];
export function testLogSummary(text: string): { counts: string[]; conversation: string[] };
export function markdown(report: unknown): string;
export function planOf(
  gate: 'index' | 'cards',
  runs: number,
): Array<{ name: string; mode: string; corpus: string; profile: string }>;
