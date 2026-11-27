// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { OpenTracker } from '../../src/core/reader/opens';

describe('the open tracker', () => {
  it('makes an open stale once a newer one of its window comes in, and only then', () => {
    const t = new OpenTracker();
    const older = t.begin(1, 3);
    expect(older.stale()).toBe(false);
    const other = t.begin(2, 9);
    expect(older.stale()).toBe(false);
    const newer = t.begin(1, 5);
    expect(older.stale()).toBe(true);
    expect(newer.stale()).toBe(false);
    expect(other.stale()).toBe(false);
  });

  it("drops a window's entry when its last open ends, and keeps it while one is under way", () => {
    const t = new OpenTracker();
    const older = t.begin(1, 3);
    const newer = t.begin(1, 5);
    newer.end();
    // The older one is still under way, and still stale.
    expect(t.size).toBe(1);
    expect(older.stale()).toBe(true);
    older.end();
    expect(t.size).toBe(0);
    // Ending twice counts once.
    older.end();
    const next = t.begin(1, 6);
    expect(t.size).toBe(1);
    next.end();
    expect(t.size).toBe(0);
  });
});
