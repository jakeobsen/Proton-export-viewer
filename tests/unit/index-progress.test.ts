// SPDX-License-Identifier: AGPL-3.0-or-later
// How often the index reports its progress: at once for a change that must
// show now, else at most every PROGRESS_MS with one report after the last
// change, timed on the monotonic clock so a wall clock set back never holds
// it up.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexService, PROGRESS_MS } from '../../src/core/index/service';
import type { Logger } from '../../src/shared/log/writer';
import { InlineThread, STAMP } from '../index-helpers';

const silent: Logger = { log: () => {}, error: () => {}, warn: () => {}, info: () => {} };

function service(onChange: () => void) {
  const s = new IndexService({
    indexDir: '/nonexistent',
    stamp: STAMP,
    root: '',
    log: silent,
    thread: (role) => new InlineThread(role),
    isCurrent: () => true,
    onChange,
  });
  // The progress report, as phase 1 calls it after each batch.
  const report = (now = false) => (s as unknown as { report(now?: boolean): void }).report(now);
  return { s, report };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('progress reports', () => {
  it('come at most every PROGRESS_MS, with one more after the last change', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    let reports = 0;
    const { report } = service(() => (reports += 1));
    report();
    expect(reports).toBe(1);
    report();
    report();
    expect(reports).toBe(1);
    vi.advanceTimersByTime(PROGRESS_MS - 1);
    expect(reports).toBe(1);
    // The changes since the last report are reported once their time is up.
    vi.advanceTimersByTime(1);
    expect(reports).toBe(2);
    vi.advanceTimersByTime(10 * PROGRESS_MS);
    expect(reports).toBe(2);
    // A change that must show now (a phase or condition) doesn't wait.
    report(true);
    expect(reports).toBe(3);
  });

  it('are not held up when the wall clock is set back', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    let reports = 0;
    const { report } = service(() => (reports += 1));
    report();
    vi.setSystemTime(Date.now() - 3_600_000);
    report();
    vi.advanceTimersByTime(PROGRESS_MS);
    expect(reports).toBe(2);
  });

  it('stop once the index is closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    let reports = 0;
    const { s, report } = service(() => (reports += 1));
    report();
    report();
    await s.close();
    vi.advanceTimersByTime(PROGRESS_MS);
    expect(reports).toBe(1);
  });
});
