// SPDX-License-Identifier: AGPL-3.0-or-later
export const TARGET_MESSAGES: number;
export const TARGETS: Record<string, { label: string; limit: number; unit: string; basis: string }>;
export function metricsOf(doc: unknown): Record<string, unknown>;
export function buildReport(files: {
  primary: string[];
  stress?: string;
  engine?: string;
  pools?: string[];
  sandbox?: string;
  engineBase?: string;
  manifest?: Record<string, unknown>;
  sizeRuns?: string[];
  exportMessages?: number;
}): Record<string, unknown>;
export function indexSize(
  totals: unknown,
  messages: number,
  at?: number[],
): Record<string, unknown> | null;
export function markdown(report: Record<string, unknown>, deferredLabel?: string): string;
