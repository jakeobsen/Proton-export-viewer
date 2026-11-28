// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Buffer } from 'node:buffer';

export class Random {
  constructor(key: string);
  readonly key: string;
  fork(label: string): Random;
  next(): number;
  float(): number;
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  normal(): number;
  logNormal(median: number, p95: number): number;
  /** Shuffles the array in place and returns it. */
  shuffle<T>(items: T[]): T[];
  bytes(count: number): Buffer;
}
