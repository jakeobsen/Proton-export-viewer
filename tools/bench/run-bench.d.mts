// SPDX-License-Identifier: AGPL-3.0-or-later
export const INDEX_CAP: number;
export const TRANSIENT_RESERVE: number;
export const MIN_FREE: number;
export function parseLarge(spec: string | undefined): Array<{ kind: string; bytes: number }>;
export function freeSpace(dir: string): { freeBytes: number };
export function removeContainerFile(folder: string, file: string, nonce: string): boolean;
export function parseFootprint(
  text: string,
): Array<{ name: string; pid: number; bytes: number; peakBytes: number }>;
export function footprintByPhase(
  samples: Array<{ at: number; totalBytes: number }>,
  phaseLog: Array<{ phase: string; at: number }>,
  types?: Record<number, string>,
): {
  unit: string;
  samples: number;
  peakByPhase: Record<string, number | null>;
  peakPhase2: number | null;
  peak: number | null;
  idle: number | null;
  idlePoolAlive: number | null;
  idleShrunk: number | null;
  idleByProcess: Array<{ name: string; mib: number }>;
  idleShrunkByProcess: Array<{ name: string; mib: number }>;
};
export const TEST_DATA_LIMIT: number;
export const CAPTURE_DIR: string;
export function findTestData(
  scanRoots: string[],
  options?: { containers?: string[]; captureDir?: string | null; maxDepth?: number },
): string[];
export function diskBytes(path: string): number;
export function budgetCheck(
  folders: string[],
  indexCap?: number,
  measure?: (path: string) => number,
): {
  total: number;
  reserved: number;
  withRun: number;
  limit: number;
  parts: Array<{ path: string; bytes: number }>;
};
