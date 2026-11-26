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
  reportName,
  treeBytes,
  watchTransient,
} from '../../tools/bench/run-bench.mjs';
import {
  checkEmptyFolder,
  checkNewFile,
  checkWorkspace,
  createFileFolder,
  createWorkspace,
  removeInside,
  removeWorkspace,
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

  it('names the kept report only from checked parts', () => {
    const n = '0123456789abcdef';
    expect(reportName('warm', 'perf', 'node:sqlite', 2, n)).toBe(
      `warm-perf-node-sqlite-pool2-${n}.json`,
    );
    for (const label of ['', '../x', 'a/b', 'Warm', '.hidden', '-x', 'a'.repeat(33), 'a b'])
      expect(() => reportName(label, 'perf', 'node:sqlite', 2, n), label).toThrow('--label');
    expect(() => reportName('warm', 'perf/..', 'node:sqlite', 2, n)).toThrow('scenario');
    expect(() => reportName('warm', 'perf', '../sqlite', 2, n)).toThrow('engine');
    expect(() => reportName('warm', 'perf', 'node:sqlite', 2.5, n)).toThrow('pool');
    expect(() => reportName('warm', 'perf', 'node:sqlite', 2, '../x')).toThrow('nonce');
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

  it('writes only new files, in real folders inside it', () => {
    const root = testDir('bench-ws-newfile');
    const ws = join(root, 'run');
    createWorkspace(ws, nonce);
    const download = join(ws, 'downloads', `quarantine-${nonce}.bin`);
    expect(checkNewFile(ws, nonce, download)).toBe(download);
    expect(checkNewFile(ws, nonce, join(ws, 'result.json'))).toBe(join(ws, 'result.json'));
    // An existing file, or a link where the file would go, is refused.
    writeFileSync(join(ws, 'result.json'), '{}');
    expect(() => checkNewFile(ws, nonce, join(ws, 'result.json'))).toThrow('already exists');
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside', 'x'), join(ws, 'dangling.json'));
    expect(() => checkNewFile(ws, nonce, join(ws, 'dangling.json'))).toThrow('already exists');
    // A download folder swapped for a link is refused before anything saves through it.
    rmSync(join(ws, 'downloads'), { recursive: true });
    symlinkSync(join(root, 'outside'), join(ws, 'downloads'));
    expect(() => checkNewFile(ws, nonce, download)).toThrow('not a real folder');
    expect(() => checkNewFile(ws, nonce, join(root, 'outside', 'x'))).toThrow('not inside');
    expect(() => checkNewFile(ws, 'fedcba9876543210', join(ws, 'r.json'))).toThrow(
      "not this run's workspace",
    );
    expect(readdirSync(join(root, 'outside'))).toEqual([]);
  });

  it('makes a new marked folder for one saved file, and refuses a link in its place', () => {
    const root = testDir('bench-ws-filefolder');
    const name = `quarantine-${nonce}.bin`;
    const folder = join(root, `bench-download-${nonce}`);
    expect(createFileFolder(folder, nonce, name)).toBe(join(folder, name));
    expect(readdirSync(folder)).toEqual(['.pev-bench-workspace']);
    // Made only once: a second run with the same folder is refused.
    expect(() => createFileFolder(folder, nonce, name)).toThrow('already exists');
    // A link where the folder would go is refused, and nothing is saved through it.
    mkdirSync(join(root, 'outside'));
    const linked = join(root, 'linked');
    symlinkSync(join(root, 'outside'), linked);
    expect(() => createFileFolder(linked, nonce, name)).toThrow('already exists');
    // So is a folder whose parent is reached through a link.
    expect(() => createFileFolder(join(linked, 'inner'), nonce, name)).toThrow('without links');
    for (const bad of ['../x', 'a/b', '', '.hidden'])
      expect(() => createFileFolder(join(root, 'other'), nonce, bad), bad).toThrow('plain file');
    expect(readdirSync(join(root, 'outside'))).toEqual([]);
    removeWorkspace(folder, nonce);
    expect(readdirSync(root).sort()).toEqual(['linked', 'outside']);
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
    // A sandboxed run's workspace holds no config, only the mark.
    createWorkspace(join(root, 'c/bench/run2'), '0123456789abcdef', []);
    mk('d/container');
    const found = findTestData([root], { containers: [join(root, 'd/container')] });
    expect(found.map((p) => p.slice(root.length + 1))).toEqual([
      'a/corpora/perf1',
      'b/clone/test-output',
      'c/bench/run1',
      'c/bench/run2',
      'd/container',
    ]);
  });

  it('measures a folder without following links or entering the folders it skips', () => {
    const root = testDir('bench-tree-bytes');
    mkdirSync(join(root, 'ws/index'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside/big.bin'), Buffer.alloc(1024 * 1024));
    writeFileSync(join(root, 'ws/index/pev-bench.db'), Buffer.alloc(1024 * 1024));
    symlinkSync(join(root, 'outside'), join(root, 'ws/link'));
    const empty = treeBytes(join(root, 'ws'), [join(root, 'ws/index')]);
    expect(empty).toBeLessThan(64 * 1024);
    writeFileSync(join(root, 'ws/result.json'), Buffer.alloc(256 * 1024));
    expect(treeBytes(join(root, 'ws'), [join(root, 'ws/index')]) - empty).toBeGreaterThanOrEqual(
      256 * 1024,
    );
    expect(treeBytes(join(root, 'ws'))).toBeGreaterThan(1024 * 1024);
    expect(treeBytes(join(root, 'missing'))).toBe(0);
  });

  it('stops the run once its other output passes the reserve, or cannot be measured', () => {
    const sizes = [10, 40e6, 20e6 + 5e6, 60e6];
    const watch = watchTransient(() => sizes.shift()!, { baseline: 5e6 });
    expect(watch.sample()).toBe(true);
    expect(watch.sample()).toBe(true);
    expect(watch.sample()).toBe(true);
    expect(watch.record.peakBytes).toBe(35e6);
    expect(watch.sample()).toBe(false);
    expect(watch.record.exceeded).toContain(`past the ${TRANSIENT_RESERVE} B reserved`);
    expect(watch.sample()).toBe(false);
    const failing = watchTransient(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(failing.sample()).toBe(false);
    expect(failing.record.exceeded).toContain('EACCES');
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
      expect(() => findTestData([root])).toThrow("can't read");
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
      footprint: { peakPhase2: 800, idle: 400, idlePoolAlive: 500, idleShrunk: 300, samples: 9 },
      footprintPeakByProcess: [{ name: 'Browser', peakMiB: 50 }],
      exit: { code: 0, signal: null, timedOut: false, stopped: null } as Record<string, unknown>,
      indexLeftover: [] as string[],
      transient: { samples: 5, peakBytes: 1000, exceeded: null as string | null },
    },
    result: {
      ok: true,
      scenario: 'perf',
      label: 'warm',
      build: { electron: '45.5.0', node: '24' },
      machine: { cpuModel: 'M', cpus: 10, totalMemGb: 32 },
      config: {
        poolSize: 4,
        oldGenMb: 512,
        term: 'check',
        searchRepeats: 20,
        opens: 200,
        reopens: 2,
        large: [{ kind: 'text', bytes: 1 }],
        window: true,
        quarantine: true,
        loadIntervalMs: 20,
        indexCapBytes: 300e6,
      } as Record<string, unknown>,
      engine: {
        engine: 'node:sqlite',
        sqliteVersion: '3',
        fts5: true,
        compileOptions: ['THREADSAFE=1'],
      },
      phase1: { pairs: 20000, phase1Ms, firstRowsMs: 400, batches: [] },
      phase2: { ms: 60000, writerMs: summary(5), jobMs: summary(2) },
      large: [
        { kind: 'text', bytes: 1, extract: { ms: 5000, rssGrowth: 1 }, generateOnly: { ms: 1 } },
      ] as unknown[],
      reopen: [{ mainMs: 300 }, { mainMs: 500 }] as unknown[],
      idle: {
        dateP1: summary(40),
        dateP2: summary(120),
        relevanceP1: summary(30),
        relevanceP2: summary(25),
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
      indexRemoved: true,
      cleanupError: undefined as string | undefined,
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
    expect(() => buildReport({ primary: [other] })).toThrow('reopen has 0 of 2');
    const md = markdown(report);
    expect(md).toContain('| deferred |');
    expect(md).toContain('×10 to 200k');
  });

  it('refuses runs with another workload, missing samples, a failed exit or a failed cleanup', () => {
    const root = testDir('bench-report-refuse');
    const good = join(root, 'good.json');
    writeFileSync(good, JSON.stringify(fakeRun(3000)));
    const bad = join(root, 'bad.json');
    const refuse = (change: (run: ReturnType<typeof fakeRun>) => void, message: string) => {
      const run = fakeRun(3000);
      change(run);
      writeFileSync(bad, JSON.stringify(run));
      expect(() => buildReport({ primary: [good, bad] }), message).toThrow(message);
    };
    expect(() => buildReport({ primary: [good, good] })).not.toThrow();
    // Another workload.
    refuse((r) => (r.result.config.term = 'other'), 'term "other"');
    refuse((r) => (r.result.config.opens = 10), 'opens 10');
    refuse((r) => (r.result.config.searchRepeats = 5), 'searchRepeats 5');
    refuse((r) => (r.result.config.reopens = 0), 'reopens 0');
    refuse((r) => (r.result.config.large = []), 'large []');
    refuse((r) => (r.result.config.window = false), 'window false');
    refuse((r) => (r.result.config.quarantine = false), 'quarantine false');
    refuse((r) => (r.result.config.loadIntervalMs = 0), 'loadIntervalMs 0');
    // Missing, empty or non-finite measurements.
    refuse((r) => (r.result.reopen = []), 'reopen has 0 of 2');
    refuse((r) => (r.result.large = []), 'large has 0 of 1');
    refuse(
      (r) => (r.result.large = [{ kind: 'text', bytes: 1, extract: { state: 'failed' } }]),
      'large part 0 was not measured',
    );
    refuse((r) => (r.result.reopen = [{ mainMs: null }, { mainMs: 1 }]), 'reopen time');
    refuse((r) => (r.result.idle.dateP1 = { n: 0, p50: 0, p95: 0, max: 0 }), 'no samples');
    // Page 2 counts towards the search targets, so a run without it is refused.
    refuse((r) => delete (r.result.idle as Record<string, unknown>).dateP2, 'idle.dateP2 has no');
    refuse(
      (r) => delete (r.result.idle as Record<string, unknown>).relevanceP2,
      'idle.relevanceP2 has no',
    );
    refuse(
      (r) => delete (r.result.duringPhase2 as Record<string, unknown>).searchDateP2,
      'duringPhase2.searchDateP2 has no',
    );
    refuse(
      (r) => (r.result.duringPhase2.list = { n: 3, p50: 1, p95: null, max: 1 } as never),
      'p95',
    );
    refuse((r) => (r.result.phase1.firstRowsMs = null as never), 'firstRowsMs');
    refuse((r) => (r.result.termMatches = undefined as never), 'termMatches');
    refuse((r) => (r.runner.footprint.samples = 0), 'no footprint samples');
    // A failed exit, a stop or a failed cleanup.
    refuse((r) => (r.runner.exit.code = 1), 'did not exit cleanly');
    refuse((r) => (r.runner.exit.timedOut = true), 'did not exit cleanly');
    refuse((r) => (r.runner.exit.stopped = 'past the reserve'), 'did not exit cleanly');
    refuse((r) => (r.result.indexRemoved = false), 'index was not removed');
    refuse((r) => (r.result.cleanupError = 'EBUSY'), 'cleanup failed (EBUSY)');
    refuse((r) => (r.runner.indexLeftover = ['pev-bench.db-wal']), 'not empty');
    refuse((r) => (r.runner.transient.exceeded = 'reached 60 MB'), 'reached 60 MB');
    refuse((r) => (r.runner.transient.samples = 0), 'not watched');
  });
});
