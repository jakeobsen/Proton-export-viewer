// SPDX-License-Identifier: AGPL-3.0-or-later
// The open bench runner: percentiles, the seeded sample, the corpus check
// against its manifest, and the verdict over the launches.

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../../tools/gen-export/tree.mjs';
import {
  corpusState,
  markdown,
  median,
  percentile,
  pickSample,
  summarizeRun,
  stayedHidden,
  verdict,
} from '../../tools/bench/run-open-bench.mjs';
import type { TimedOpen } from '../../src/testhooks/open-bench-types';
import { testDir } from '../paths';

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

function entry(path: string, size: number, type: TreeEntry['type'] = 'file'): TreeEntry {
  return { path, full: `/x/${path}`, type, size, blocks: 0, mtime: 0 };
}

const views = (ms: number[]): TimedOpen[] =>
  ms.map((m, i) => ({ rowid: i + 1, ms: m, outcome: 'view', format: 'html' }));

describe('percentiles', () => {
  it('takes the nearest rank', () => {
    expect(percentile(range(100), 95)).toBe(95);
    expect(percentile(range(1000).reverse(), 95)).toBe(950);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it('takes the middle, or the mean of the two middle values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('the sample', () => {
  const entries = [
    entry('a', 0, 'dir'),
    ...range(50).map((i) => entry(`a/m${i}.eml`, i * 100)),
    ...range(50).map((i) => entry(`a/m${i}.metadata.json`, 10)),
    entry('a/big.eml', 2_000_000),
  ];

  it('is the same for the same seed, and only messages up to the size limit', () => {
    const one = pickSample(entries, { seed: 1, count: 20, maxBytes: 4000 });
    expect(one).toHaveLength(20);
    expect(pickSample(entries, { seed: 1, count: 20, maxBytes: 4000 })).toEqual(one);
    expect(one.every((s) => s.path.endsWith('.eml') && s.size <= 4000)).toBe(true);
    expect(new Set(one.map((s) => s.path)).size).toBe(20);
    expect(pickSample(entries, { seed: 2, count: 20, maxBytes: 4000 })).not.toEqual(one);
  });

  it('refuses when too few messages fit', () => {
    expect(() => pickSample(entries, { seed: 1, count: 41, maxBytes: 4000 })).toThrow(
      'only 40 messages fit',
    );
  });
});

describe('the corpus check', () => {
  it('matches the manifest until anything in the corpus changes', () => {
    const root = testDir('open-bench-corpus');
    mkdirSync(join(root, 'run'));
    writeFileSync(join(root, 'run', 'a.eml'), 'one');
    writeFileSync(join(root, 'labels.json'), '{}');
    const first = corpusState(root, {});
    expect(first.matches).toBe(false);
    const { entries, bytes, disk_bytes, digest } = first;
    const manifest = { entries, bytes, disk_bytes, digest };
    expect(entries).toBe(3);
    expect(bytes).toBe(5);
    expect(corpusState(root, manifest)).toMatchObject({ matches: true, differs: [] });

    // Same size, other content.
    writeFileSync(join(root, 'run', 'a.eml'), 'two');
    utimesSync(join(root, 'run', 'a.eml'), new Date(0), new Date(0));
    expect(corpusState(root, manifest).differs).toEqual(['digest']);
    // A new file.
    writeFileSync(join(root, 'run', 'b.eml'), '');
    expect(corpusState(root, manifest).differs).toEqual(
      expect.arrayContaining(['entries', 'digest']),
    );
  });
});

describe('the verdict', () => {
  const HIDDEN = { visible: false, focused: false };
  const run = (opens: TimedOpen[]) => ({
    summary: summarizeRun(opens),
    window: HIDDEN,
    windowEvents: [],
  });

  it('is the median of the launches’ p95s', () => {
    const runs = [10, 20, 30, 40].map((base) => run(views(range(100).map((i) => base + i / 10))));
    expect(runs.map((r) => r.summary.p95)).toEqual([19.5, 29.5, 39.5, 49.5]);
    expect(verdict(runs)).toEqual({
      valid: true,
      medianP95: 34.5,
      p95s: [19.5, 29.5, 39.5, 49.5],
      target: 150,
      within: true,
      windowEvents: 0,
    });
    expect(verdict(runs, 30).within).toBe(false);
  });

  it('is invalid when any message did not open as a view in time, or a launch failed', () => {
    const fallback = run([
      ...views([5, 6]),
      { rowid: 3, ms: null, outcome: 'fallback' },
      { rowid: 4, ms: null, outcome: 'rejected', code: 'not_found' },
    ]);
    expect(fallback.summary).toMatchObject({ opens: 4, views: 2, fallbacks: 1, rejected: 1 });
    expect(verdict([fallback]).valid).toBe(false);
    const late = run([...views([5]), { rowid: 2, ms: null, outcome: 'timeout', format: 'html' }]);
    expect(late.summary).toMatchObject({ opens: 2, views: 1, timeouts: [2] });
    expect(verdict([late]).valid).toBe(false);
    expect(
      verdict([run(views([1])), { summary: null, window: null, windowEvents: null }]).valid,
    ).toBe(false);
  });

  it('is invalid when a window was shown or focused, or the launch recorded no events', () => {
    const ok = run(views([5, 6]));
    expect(stayedHidden(ok)).toBe(true);
    expect(verdict([ok]).valid).toBe(true);
    const shown = { ...ok, windowEvents: [{ window: 1, event: 'show' }] };
    expect(stayedHidden(shown)).toBe(false);
    expect(verdict([ok, shown])).toMatchObject({ valid: false, medianP95: 6, windowEvents: 1 });
    const focused = { ...ok, windowEvents: [{ window: 1, event: 'focus' }] };
    expect(verdict([focused]).valid).toBe(false);
    expect(verdict([{ ...ok, window: { visible: true, focused: false } }]).valid).toBe(false);
    expect(verdict([{ ...ok, window: { visible: false, focused: true } }]).valid).toBe(false);
    expect(verdict([{ ...ok, windowEvents: null }]).valid).toBe(false);
    expect(verdict([{ ...ok, window: null }]).valid).toBe(false);
  });

  it('writes a markdown report that names both events and the verdict', () => {
    const runs = [run(views([10, 12]))].map((r) => ({ ...r, exit: { code: 0 } }));
    const text = markdown({
      verdict: verdict(runs),
      events: { start: 'START', end: 'END' },
      sample: { count: 2, maxBytes: 100, seed: 1, bytes: 50, listSha256: 'ab' },
      runs,
      warmup: 0,
      corpus: { before: { matches: true }, after: { matches: true, digest: 'cd' } },
      build: { app: 'x.app', executableSha256: 'e', asarSha256: 'f' },
      machine: { model: 'M', cpu: 'C', cores: 8, memoryBytes: 2 ** 34, macos: '26' },
      frontmost: { loginwindow: 3 },
    });
    expect(text).toContain('**Median of the p95s: 12 ms** (target ≤ 150 ms): within.');
    expect(text).toContain('- Start: START.');
    expect(text).toContain('- End: END.');
    expect(text).toContain('| 1 | 2/2 | 0 | 0 | 0 | 2 | 0 | 10 | 12 | 12 | true | 0 | 0 |');
  });
});
