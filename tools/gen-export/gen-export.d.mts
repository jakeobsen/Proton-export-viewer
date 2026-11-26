// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProfileName, Summary } from './generator.mjs';

export const CORPORA_CAP: number;
export const COPIES_RESERVE: number;
export const MIN_FREE: number;
export function project(
  profile: ProfileName,
  options: { seed: number; nonce?: string | null },
  blockSize?: number,
): { files: number; bytes: number; disk: number; summary: Summary };
export function checkBudget(sizes: {
  projected: number;
  corporaBytes: number;
  freeBytes: number;
}): {
  ok: boolean;
  total: number;
  reason: string | null;
};
