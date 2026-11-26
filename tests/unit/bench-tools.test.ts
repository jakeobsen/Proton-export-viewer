// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, markdown, metricsOf } from '../../tools/bench/report.mjs';
import {
  TEST_DATA_LIMIT,
  TRANSIENT_RESERVE,
  budgetCheck,
  findTestData,
  footprintByPhase,
  parseFootprint,
  parseLarge,
} from '../../tools/bench/run-bench.mjs';
import {
  checkEmptyFolder,
  checkWorkspace,
  createWorkspace,
  removeInside,
} from '../../tools/bench/workspace.mjs';
import { REPO_ROOT, testDir } from '../paths';

describe('the comparison engine', () => {
  it('is in neither package.json nor the lockfile', () => {
    for (const name of ['package.json', 'package-lock.json']) {
      expect(readFileSync(join(REPO_ROOT, name), 'utf8')).not.toContain('better-sqlite3');
    }
  });

  it('gets the same SQL: no numbered parameters, which only one engine binds from a list', () => {
    const dir = join(REPO_ROOT, 'src', 'testhooks', 'bench');
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/[?][0-9]/);
    }
  });
});

describe('bench runner checks', () => {
  it('parses large-part lists and refuses unknown kinds', () => {
    expect(parseLarge('text:200000000,html:5')).toEqual([
      { kind: 'text', bytes: 200000000 },
      { kind: 'html', bytes: 5 },
    ]);
    expect(parseLarge('')).toEqual([]);
    expect(() => parseLarge('video:1')).toThrow('bad --large');
    expect(() => parseLarge('text:1e9')).toThrow('bad --large');
  });
});

describe('the run workspace', () => {
  const nonce = '0123456789abcdef';

  it('is made fresh: an existing folder or a linked parent is refused', () => {
    const root = testDir('bench-ws-fresh');
    const ws = join(root, 'run');
    createWorkspace(ws, nonce);
    expect(readdirSync(ws).sort()).toEqual([
      '.pev-bench-workspace',
      'downloads',
      'index',
      'user-data',
    ]);
    expect(() => createWorkspace(ws, nonce)).toThrow('already exists');
    symlinkSync(root, join(root, 'link'));
    expect(() => createWorkspace(join(root, 'link', 'other'), nonce)).toThrow('without links');
    expect(() => checkWorkspace(ws, 'fedcba9876543210')).toThrow("not this run's workspace");
  });

  it('removes only what is inside, and never follows a link out', () => {
    const root = testDir('bench-ws-outside');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside data');
    const ws = join(root, 'run');
    createWorkspace(ws, nonce);
    // A link in the index folder to an outside file: removing it removes the link only.
    symlinkSync(join(outside, 'keep.txt'), join(ws, 'index', 'pev-bench.db-wal'));
    expect(removeInside(ws, nonce, join(ws, 'index', 'pev-bench.db-wal'))).toBe(true);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('outside data');
    // A profile folder swapped for a link to an outside folder: the link goes, the folder stays.
    rmSync(join(ws, 'user-data'), { recursive: true });
    symlinkSync(outside, join(ws, 'user-data'));
    removeInside(ws, nonce, join(ws, 'user-data'));
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('outside data');
    // A path through a linked folder is refused outright.
    symlinkSync(outside, join(ws, 'via'));
    expect(() => removeInside(ws, nonce, join(ws, 'via', 'keep.txt'))).toThrow('not a real folder');
    expect(() => removeInside(ws, nonce, outside)).toThrow('not inside');
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('outside data');
  });

  it('refuses an index folder that already holds anything, or is a link', () => {
    const root = testDir('bench-ws-index');
    const ws = join(root, 'run');
    createWorkspace(ws, nonce);
    checkEmptyFolder(ws, join(ws, 'index'));
    writeFileSync(join(ws, 'index', 'pev-bench.db'), 'not ours');
    expect(() => checkEmptyFolder(ws, join(ws, 'index'))).toThrow('not empty');
    rmSync(join(ws, 'index'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(ws, 'index'));
    expect(() => checkEmptyFolder(ws, join(ws, 'index'))).toThrow('not a real folder');
  });
});

describe('the test data budget', () => {
  it('finds exports, test output and bench folders, each counted once', () => {
    const root = testDir('bench-budget');
    const mk = (p: string) => mkdirSync(join(root, p), { recursive: true });
    mk('a/corpora/perf1/acct');
    writeFileSync(join(root, 'a/corpora/perf1.manifest.json'), '{}');
    writeFileSync(join(root, 'a/corpora/gone.manifest.json'), '{}');
    mk('b/clone/test-output/runs/x');
    mk('b/clone/node_modules/pkg/test-output');
    mk('c/bench/run1/index');
    writeFileSync(join(root, 'c/bench/run1/config-0123456789abcdef.json'), '{}');
    mk('d/container');
    const found = findTestData([root], {
      containers: [join(root, 'd/container')],
      captureDir: null,
    });
    expect(found.map((p) => p.slice(root.length + 1))).toEqual([
      'a/corpora/perf1',
      'b/clone/test-output',
      'c/bench/run1',
      'd/container',
    ]);
  });

  it('refuses when the data plus a full index and the run output would reach the limit', () => {
    const sizes: Record<string, number> = { x: 400e6, y: 200e6 };
    const ok = budgetCheck(['x', 'y'], 300e6, (p) => sizes[p]!);
    expect(ok.reserved).toBe(300e6 + TRANSIENT_RESERVE);
    expect(ok.withRun).toBe(600e6 + 300e6 + TRANSIENT_RESERVE);
    sizes.y = 250e6;
    expect(() => budgetCheck(['x', 'y'], 300e6, (p) => sizes[p]!)).toThrow(String(TEST_DATA_LIMIT));
  });

  it('fails closed on a folder it cannot read', () => {
    const root = testDir('bench-budget-unreadable');
    const locked = join(root, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      expect(() => findTestData([root], { captureDir: null })).toThrow("can't read");
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe('process footprints', () => {
  const block = (name: string, pid: number, now: number, peak: number) =>
    [
      '='.repeat(20),
      `${name} [${pid}]: 64-bit    Footprint: ${now - 1} B (16384 bytes per page)`,
      '='.repeat(20),
      '',
      'Auxiliary data:',
      `    phys_footprint: ${now} B`,
      `    phys_footprint_peak: ${peak} B`,
      '',
    ].join('\n');

  it('reads every process of the footprint output', () => {
    const text = block('App', 10, 4096, 8192) + block('App Helper (Renderer)', 11, 100, 200);
    expect(parseFootprint(text)).toEqual([
      { name: 'App', pid: 10, bytes: 4096, peakBytes: 8192 },
      { name: 'App Helper (Renderer)', pid: 11, bytes: 100, peakBytes: 200 },
    ]);
  });

  it('matches samples to the phase that was running', () => {
    const MiB = 2 ** 20;
    const r = footprintByPhase(
      [
        { at: 5, totalBytes: 10 * MiB },
        { at: 15, totalBytes: 30 * MiB },
        { at: 25, totalBytes: 8 * MiB },
        { at: 26, totalBytes: 6 * MiB },
        { at: 27, totalBytes: 7 * MiB },
      ],
      [
        { phase: 'phase2', at: 0 },
        { phase: 'idle-no-pool', at: 20 },
      ],
    );
    expect(r.peakPhase2).toBe(30);
    expect(r.idle).toBe(7);
    expect(r.peak).toBe(30);
  });
});

const summary = (p95: number) => ({ n: 10, p50: p95 / 2, p95, max: p95 });

function fakeRun(phase1Ms: number) {
  return {
    runner: {
      build: 'test',
      appExecutableSha256: 'a'.repeat(64),
      addonSha256: null,
      frontmost: { loginwindow: 3 },
      quarantine: { present: false, value: null },
      footprint: { peakPhase2: 800, idle: 400, idlePoolAlive: 500, idleShrunk: 300 },
      footprintPeakByProcess: [{ name: 'Browser', peakMiB: 50 }],
    },
    result: {
      ok: true,
      scenario: 'perf',
      label: 'warm',
      build: { electron: '45.5.0', node: '24' },
      machine: { cpuModel: 'M', cpus: 10, totalMemGb: 32 },
      config: { poolSize: 4, oldGenMb: 512 },
      engine: {
        engine: 'node:sqlite',
        sqliteVersion: '3',
        fts5: true,
        compileOptions: ['THREADSAFE=1'],
      },
      phase1: { pairs: 20000, phase1Ms, firstRowsMs: 400, batches: [] },
      phase2: { ms: 60000, writerMs: summary(5), jobMs: summary(2) },
      large: [{ kind: 'text', bytes: 1, extract: { ms: 5000 }, generateOnly: { ms: 1 } }],
      reopen: [{ mainMs: 300 }, { mainMs: 500 }],
      idle: {
        dateP1: summary(40),
        dateP2: summary(120),
        relevanceP1: summary(30),
        open: summary(20),
        list: summary(3),
      },
      duringPhase2: {
        searchDateP1: summary(90),
        searchDateP2: summary(80),
        open: summary(60),
        list: summary(4),
      },
      memoryIdle: { mb: 450 },
      totals: { size: { pages: 1, pageSize: 4096 }, wal: { peakWalBytes: 1 } },
      termMatches: 9000,
      memoryIdlePoolAlive: { mb: 600 },
      memoryPeakPhase2: { mb: 900, byTypeMb: {} },
      quarantine: { method: 'webContents.downloadURL', state: 'completed' },
    },
  };
}

describe('bench report', () => {
  it('extrapolates throughput to 200k and compares latencies as measured', () => {
    const m = metricsOf(fakeRun(3000));
    expect(m.phase1).toBe(30000);
    expect(m.phase2).toBe(60000 * 10 + 5000);
    expect(m.searchIdle).toBe(120);
    expect(m.reopen).toBe(500);
  });

  it('takes medians across runs, marks targets and defers the UI ones', () => {
    const root = testDir('bench-report');
    const files = [3000, 5000, 4000].map((ms, i) => {
      const f = join(root, `run${i}.json`);
      writeFileSync(f, JSON.stringify(fakeRun(ms)));
      return f;
    });
    const report = buildReport({ primary: files }) as {
      metrics: { phase1Measured: number };
      targets: Record<string, { verdict: string }>;
    };
    expect(report.metrics.phase1Measured).toBe(4000);
    expect(report.targets.searchIdle!.verdict).toBe('OVER');
    // A warm run can't decide a cold target.
    expect(report.targets.firstRows!.verdict).toBe('pending cold run (warm value within)');
    expect(report.targets.memoryPeak!.verdict).toBe('within');
    // Runs that measured something else are refused.
    const other = join(root, 'other.json');
    const mismatched = fakeRun(3000);
    mismatched.result.phase1.pairs = 5000;
    writeFileSync(other, JSON.stringify(mismatched));
    expect(() => buildReport({ primary: [files[0]!, other] })).toThrow('5000 messages');
    const missing = fakeRun(3000) as { result: Record<string, unknown> };
    delete missing.result.reopen;
    writeFileSync(other, JSON.stringify(missing));
    expect(() => buildReport({ primary: [other] })).toThrow('reopen is missing');
    const md = markdown(report);
    expect(md).toContain('| deferred |');
    expect(md).toContain('×10 to 200k');
  });
});
