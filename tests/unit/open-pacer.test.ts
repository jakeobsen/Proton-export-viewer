// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_GAP_MS, OpenPacer } from '../../src/main/open-pacer';

describe('the open pacer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pacer = () => new OpenPacer<object>(OPEN_GAP_MS, () => Date.now());

  it('starts an open at once when the gap since the last one has passed', async () => {
    const p = pacer();
    const win = {};
    expect(await p.turn(win)).toBe(true);
    vi.advanceTimersByTime(OPEN_GAP_MS);
    expect(await p.turn(win)).toBe(true);
  });

  it('holds an open until the gap has passed, and the newest waiting one wins', async () => {
    const p = pacer();
    const win = {};
    expect(await p.turn(win)).toBe(true);
    const outcomes: Array<[number, boolean]> = [];
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(5);
      void p.turn(win).then((go) => outcomes.push([i, go]));
    }
    await vi.advanceTimersByTimeAsync(0);
    // The four replaced ones end at once, before the gap is over.
    expect(outcomes).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, false],
    ]);
    await vi.advanceTimersByTimeAsync(OPEN_GAP_MS - 26);
    expect(outcomes).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcomes.at(-1)).toEqual([4, true]);
  });

  it('never starts two opens of a window closer than the gap, however fast they come', async () => {
    const p = pacer();
    const win = {};
    const starts: number[] = [];
    for (let i = 0; i < 2000; i += 1) {
      void p.turn(win).then((go) => {
        if (go) starts.push(Date.now());
      });
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(OPEN_GAP_MS);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(OPEN_GAP_MS);
    }
    // 10 s of selections: at most 167 opens, under the 200 a frame follows.
    expect(starts.length).toBeLessThanOrEqual(Math.ceil(10_000 / OPEN_GAP_MS) + 1);
    expect(starts.length).toBeGreaterThan(150);
    // The last selection always opens.
    expect(starts.at(-1)).toBeGreaterThanOrEqual(2000 * 5 - 5);
  });

  it('keeps windows apart', async () => {
    const p = pacer();
    const a = {};
    const b = {};
    expect(await p.turn(a)).toBe(true);
    expect(await p.turn(b)).toBe(true);
  });
});
