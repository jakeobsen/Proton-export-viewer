// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FrameRun, RafProbe, TimedExpansion } from '../../src/testhooks/gate-types';

export const TARGETS: {
  firstRowsMs: number;
  phase1At200kMs: number;
  reopenMs: number;
  idleMiB: number;
  peakMiB: number;
  openP95Ms: number;
};
export const MAX_FRAME_MS: number;
export const DISPLAY_SHARE: number;
export const LONG_INTERVAL: number;
export const CHECK_SHARE: number;
export const OPEN_GAP_MS: number;
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
  thresholdMs: number | null;
  prompt: boolean;
}
export function rafVerdict(
  probes: Array<RafProbe | null | undefined>,
  frameMs: number | null | undefined,
): RafVerdict;

export function intervalsOf(stamps: number[]): number[];

export interface Cadence {
  frames: number;
  timeouts: number;
  frameMs: number | null;
  hz: number | null;
  p95: number | null;
  max: number | null;
  displayHz: number | null;
  trusted: boolean;
  reasons: string[];
}
export function cadenceOf(
  run: (Pick<FrameRun, 'stamps' | 'timeouts' | 'timeoutMs'> & { name?: string }) | null,
  displayHz: number | null | undefined,
): Cadence;

export interface LaunchCadence {
  frameMs: number | null;
  hz: number | null;
  displayHz: number | null;
  baseline: Cadence;
  check: Cadence;
  trusted: boolean;
  reasons: string[];
}
export function launchCadence(
  cadences:
    | Array<{ name: string; stamps: number[]; timeouts: number; timeoutMs: number }>
    | null
    | undefined,
  displayHz: number | null | undefined,
): LaunchCadence;

export function missedIn(
  intervals: number[],
  frameMs: number,
): { intervals: number; long: number; missed: number };

export interface ScrollFrames {
  name: string | null;
  steps: number | null;
  made: number;
  frameMs: number | null;
  hz: number | null;
  trusted: boolean;
  reasons: string[];
  available: boolean;
  unavailable: string | null;
  intervals: number;
  long: number | null;
  missed: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  pastPhase1: { intervals: number; missed: number | null; ranPastMs: number | null } | null;
}
export function scrollFrames(
  scroll: {
    name: string;
    steps: number;
    stamps: number[];
    stopped: boolean;
    waitMs: number;
  } | null,
  cadence: Pick<LaunchCadence, 'frameMs' | 'hz' | 'trusted' | 'reasons'> | null,
  phase1DoneAt?: number | null,
): ScrollFrames;

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
export function stressBatches(launches: Array<{ batches: BatchNumbers | null }>): {
  launches: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  repointedMessages: number | null;
  repointedKeys: number | null;
  repointedLabelRows: number | null;
  maxRepointed: number | null;
};

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
export function scrollRow(name: string, frames: ScrollFrames[]): Row;
export function indexRows(report: unknown): Row[];
export function cardsRows(report: unknown): Row[];
export function testLogSummary(text: string): { counts: string[]; conversation: string[] };
export function markdown(report: unknown): string;
export function planOf(
  gate: 'index' | 'cards',
  runs: number,
): Array<{ name: string; mode: string; corpus: string; profile: string }>;

export interface PreflightArgs {
  out: string;
  perf: string;
  stress?: string | null;
  app: string;
  scanData: string[];
}
export interface Corpus {
  name: string;
  root: string;
  manifestPath: string;
  manifest: unknown;
}
export interface System {
  exists: (path: string) => boolean;
  lidClosed: () => boolean | null;
  git: (args: string[]) => string | null;
  freeSpace: (dir: string) => { freeBytes: number };
  containers: () => string[];
  testData: (scanData: string[], containers: string[]) => string[];
  budget: (folders: string[]) => unknown;
  corpusOf: (name: string, folder: string) => Corpus;
  corpusState: (root: string, manifest: unknown) => { matches: boolean; differs?: unknown };
}
export const SYSTEM: System;
export function preflight(
  args: PreflightArgs,
  sys?: System,
): {
  corpora: Record<string, Corpus>;
  executable: string;
  asar: string;
  head: string | null;
  disk: { freeBytes: number };
  budget: unknown;
  before: Record<string, { matches: boolean }>;
};
