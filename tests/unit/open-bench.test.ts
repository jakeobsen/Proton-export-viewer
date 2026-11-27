// SPDX-License-Identifier: AGPL-3.0-or-later
// The open bench runner: percentiles, the seeded sample, the corpus check
// against its manifest, output kept out of the corpus, and the verdict over
// the launches.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../../tools/gen-export/tree.mjs';
import {
  corpusState,
  exitedCleanly,
  markdown,
  median,
  percentile,
  pickSample,
  summarizeRun,
  stayedHidden,
  verdict,
  warmedUp,
} from '../../tools/bench/run-open-bench.mjs';
import { checkOutside, createWorkspace } from '../../tools/bench/workspace.mjs';
import { readConfig } from '../../src/testhooks/open-bench-config';
import type { TimedOpen } from '../../src/testhooks/open-bench-types';
import { REPO_ROOT, testDir } from '../paths';

const RUNNER = join(REPO_ROOT, 'tools', 'bench', 'run-open-bench.mjs');

/** Every entry under `root` with its content (files) or target (links), to show nothing changed. */
function tree(root: string, at = ''): string[] {
  return readdirSync(join(root, at))
    .sort()
    .flatMap((name) => {
      const rel = join(at, name);
      const full = join(root, rel);
      const stat = lstatSync(full);
      if (stat.isDirectory()) return [`${rel}/`, ...tree(root, rel)];
      return [`${rel}: ${stat.isSymbolicLink() ? 'link' : readFileSync(full, 'utf8')}`];
    });
}

/** A small corpus beside a folder for output, and a link to a folder inside the corpus. */
function corpusFolders(name: string) {
  const parent = testDir(name);
  const corpus = join(parent, 'corpus');
  mkdirSync(join(corpus, 'run', 'deeper'), { recursive: true });
  writeFileSync(join(corpus, 'run', 'a.eml'), 'one');
  writeFileSync(join(corpus, 'labels.json'), '{}');
  const link = join(parent, 'link');
  symlinkSync(join(corpus, 'run'), link);
  return { parent, corpus, link };
}

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

describe('the output folder', () => {
  it('is refused in the corpus, however the path reaches it, and nothing is written', () => {
    const { parent, corpus, link } = corpusFolders('open-bench-outside');
    const before = tree(corpus);
    for (const path of [
      corpus,
      join(corpus, 'out'),
      join(corpus, 'run', 'deeper', 'new', 'out'),
      join(link, 'out'),
      join(parent, 'elsewhere', '..', 'corpus', 'out'),
    ])
      expect(() => checkOutside(corpus, path), path).toThrow('is inside');
    // On a file system that ignores letter case, the same folder with other case.
    const upper = join(parent, 'CORPUS');
    if (existsSync(upper))
      expect(() => checkOutside(corpus, join(upper, 'out'))).toThrow('is inside');
    for (const path of [join(parent, 'out'), join(parent, 'new', 'out'), parent])
      expect(checkOutside(corpus, path)).toBe(path);
    expect(tree(corpus)).toEqual(before);
  });

  it('in the corpus stops the runner before it writes anything', () => {
    const { parent, corpus, link } = corpusFolders('open-bench-runner-out');
    const manifest = join(parent, 'manifest.json');
    writeFileSync(manifest, '{}');
    const before = tree(parent);
    const run = (out: string) =>
      spawnSync(
        process.execPath,
        [
          RUNNER,
          '--corpus',
          corpus,
          '--manifest',
          manifest,
          '--out',
          out,
          '--app',
          join(parent, 'none.app'),
        ],
        { encoding: 'utf8' },
      );
    for (const out of [join(corpus, 'out'), join(corpus, 'run', 'out'), join(link, 'out')]) {
      const result = run(out);
      expect(result.status, out).toBe(1);
      expect(result.stderr).toContain(`${out} is inside ${corpus}`);
    }
    // Outside the corpus, the runner gets as far as looking for the app.
    const outside = run(join(parent, 'out'));
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain('no packaged build');
    expect(tree(parent)).toEqual(before);
  });

  it('in the folder the app reads is refused by the app too, before it writes its result', () => {
    const { parent, corpus, link } = corpusFolders('open-bench-hook-out');
    const nonce = randomBytes(8).toString('hex');
    const config = (workspace: string) => {
      const file = join(parent, `config-${nonce}-${workspace.length}.json`);
      writeFileSync(
        file,
        JSON.stringify({ nonce, workspace, root: corpus, files: ['run/a.eml'], warmup: 0 }),
      );
      return file;
    };
    // A run's workspace, marked as the runner marks it, that happens to be in the corpus.
    const inside = createWorkspace(join(corpus, 'run', 'ws'), nonce, []);
    const before = tree(corpus);
    expect(() => readConfig(config(inside))).toThrow(`${inside} is inside ${corpus}`);
    expect(() => readConfig(config(join(link, 'ws')))).toThrow('is inside');
    expect(() => readConfig(config(join(corpus, 'new')))).toThrow('is inside');
    expect(tree(corpus)).toEqual(before);
    // A workspace beside the corpus is accepted.
    const outside = createWorkspace(join(parent, 'ws'), nonce, []);
    expect(readConfig(config(outside)).workspace).toBe(outside);
  });
});

describe('the verdict', () => {
  const HIDDEN = { visible: false, focused: false };
  const CLEAN = { code: 0, signal: null, timedOut: false };
  const run = (opens: TimedOpen[]) => ({
    summary: summarizeRun(opens),
    window: HIDDEN,
    windowEvents: [],
    exit: CLEAN,
    warmup: { requested: 2, count: 2, views: 2 },
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
      verdict([
        run(views([1])),
        { summary: null, window: null, windowEvents: null, exit: CLEAN, warmup: null },
      ]).valid,
    ).toBe(false);
  });

  it('is invalid when a launch timed out, was killed, exited with an error or failed a warm-up open', () => {
    const ok = run(views([5, 6]));
    expect(exitedCleanly(ok)).toBe(true);
    expect(warmedUp(ok)).toBe(true);
    for (const exit of [
      { code: null, signal: 'SIGKILL', timedOut: true },
      { code: 0, signal: null, timedOut: true },
      { code: null, signal: 'SIGTERM', timedOut: false },
      { code: 0, signal: 'SIGTERM', timedOut: false },
      { code: 1, signal: null, timedOut: false },
      null,
    ]) {
      const launch = { ...ok, exit };
      expect(exitedCleanly(launch), JSON.stringify(exit)).toBe(false);
      expect(verdict([ok, launch]), JSON.stringify(exit)).toMatchObject({
        valid: false,
        medianP95: 6,
      });
    }
    for (const warmup of [
      { requested: 2, count: 2, views: 1 },
      { requested: 2, count: 1, views: 1 },
      { requested: 2, count: null, views: null },
      null,
    ]) {
      const launch = { ...ok, warmup };
      expect(warmedUp(launch), JSON.stringify(warmup)).toBe(false);
      expect(verdict([ok, launch]), JSON.stringify(warmup)).toMatchObject({
        valid: false,
        medianP95: 6,
      });
    }
    expect(verdict([{ ...ok, warmup: { requested: 0, count: 0, views: 0 } }]).valid).toBe(true);
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
    const runs = [run(views([10, 12]))];
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
    expect(text).toContain('| 1 | 2/2 | 2/2 | 0 | 0 | 0 | 2 | 0 | 10 | 12 | 12 | true | 0 | 0 |');
    const failed = markdown({
      verdict: verdict(runs),
      events: { start: 'START', end: 'END' },
      sample: { count: 2, maxBytes: 100, seed: 1, bytes: 50, listSha256: 'ab' },
      runs: [
        { ...runs[0], exit: { code: null, signal: 'SIGKILL', timedOut: true } },
        { ...runs[0], exit: { code: null, signal: 'SIGTERM', timedOut: false } },
        { ...runs[0], exit: { code: 3, signal: null, timedOut: false } },
        { ...runs[0], warmup: { requested: 2, count: 2, views: 1 } },
      ],
      warmup: 2,
      corpus: { before: { matches: true }, after: { matches: true, digest: 'cd' } },
      build: { app: 'x.app', executableSha256: 'e', asarSha256: 'f' },
      machine: { model: 'M', cpu: 'C', cores: 8, memoryBytes: 2 ** 34, macos: '26' },
      frontmost: {},
    });
    expect(failed).toContain('| 1 | 2/2 | 2/2 |');
    expect(failed).toMatch(/\| 1 \|.* \| timeout \|\n/);
    expect(failed).toMatch(/\| 2 \|.* \| SIGTERM \|\n/);
    expect(failed).toMatch(/\| 3 \|.* \| 3 \|\n/);
    expect(failed).toContain('| 4 | 1/2 | 2/2 |');
  });
});
