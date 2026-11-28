// SPDX-License-Identifier: AGPL-3.0-or-later
// Each view's images: at most 100 started, six at once, the rest in order;
// an abort drops what waits and reports nothing more for that view.

import { describe, expect, it } from 'vitest';
import type { ImageOutcome } from '../../src/fetcher/request';
import { ViewScheduler } from '../../src/fetcher/views';
import {
  VIEW_MAX_CONCURRENT,
  VIEW_MAX_IMAGES,
  type FetchRequest,
} from '../../src/shared/fetcher-protocol';

const OK: ImageOutcome = {
  ok: true,
  bytes: new Uint8Array(1),
  format: 'png',
  insecure: false,
  status: 200,
  ms: 1,
};

function harness() {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const done: Array<[string, string]> = [];
  let active = 0;
  let peak = 0;
  const scheduler = new ViewScheduler(
    (url, _view, signal) =>
      new Promise<ImageOutcome>((resolve) => {
        started.push(url);
        active += 1;
        peak = Math.max(peak, active);
        const finish = (outcome: ImageOutcome) => {
          active -= 1;
          resolve(outcome);
        };
        release.set(url, () => finish(OK));
        signal.addEventListener('abort', () =>
          finish({ ok: false, reason: 'aborted', insecure: false, status: null, ms: 0 }),
        );
      }),
    (request, outcome) => done.push([request.ref, outcome.ok ? 'ok' : outcome.reason]),
  );
  const fetch = (viewKey: string, ref: string) =>
    scheduler.fetch({
      type: 'fetch',
      viewKey,
      ref,
      url: `${viewKey}/${ref}`,
    } satisfies FetchRequest);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const released = new Set<string>();
  /** Ends every started image not ended yet. */
  const releaseAll = () => {
    for (const url of started) {
      if (released.has(url)) continue;
      released.add(url);
      release.get(url)!();
    }
  };
  const releaseOne = (url: string) => {
    released.add(url);
    release.get(url)!();
  };
  return { scheduler, started, done, fetch, flush, releaseAll, releaseOne, peak: () => peak };
}

describe('view scheduler', () => {
  it('starts 100 images per view and refuses the 101st without a request', async () => {
    const h = harness();
    for (let i = 1; i <= VIEW_MAX_IMAGES + 1; i += 1) h.fetch('v', `r${i}`);
    expect(h.done).toEqual([[`r${VIEW_MAX_IMAGES + 1}`, 'too_many']]);
    while (h.done.length < VIEW_MAX_IMAGES + 1) {
      h.releaseAll();
      await h.flush();
    }
    expect(h.started).toHaveLength(VIEW_MAX_IMAGES);
    expect(h.done.filter(([, r]) => r === 'ok')).toHaveLength(VIEW_MAX_IMAGES);
    // Another view has its own count.
    h.fetch('w', 'r1');
    expect(h.started.at(-1)).toBe('w/r1');
  });

  it('runs six at once and starts the rest in order as each ends', async () => {
    const h = harness();
    for (let i = 1; i <= 10; i += 1) h.fetch('v', `r${i}`);
    expect(VIEW_MAX_CONCURRENT).toBe(6);
    expect(h.started).toEqual(['v/r1', 'v/r2', 'v/r3', 'v/r4', 'v/r5', 'v/r6']);
    h.releaseOne('v/r3');
    await h.flush();
    expect(h.started.at(-1)).toBe('v/r7');
    while (h.done.length < 10) {
      h.releaseAll();
      await h.flush();
    }
    expect(h.started).toEqual(Array.from({ length: 10 }, (_, i) => `v/r${i + 1}`));
    expect(h.peak()).toBe(6);
    expect(h.done).toHaveLength(10);
  });

  it('an abort ends the running ones, drops the waiting ones, and reports none', async () => {
    const h = harness();
    for (let i = 1; i <= 9; i += 1) h.fetch('v', `r${i}`);
    h.fetch('w', 'r1');
    expect(h.scheduler.pending('v')).toBe(9);
    h.scheduler.abort('v');
    expect(h.scheduler.pending('v')).toBe(0);
    await h.flush();
    expect(h.started.filter((u) => u.startsWith('v/'))).toHaveLength(6);
    expect(h.done).toEqual([]);
    h.releaseOne('w/r1');
    await h.flush();
    expect(h.done).toEqual([['r1', 'ok']]);
    // The view key starts afresh after an abort.
    h.fetch('v', 'again');
    expect(h.started.at(-1)).toBe('v/again');
  });
});
