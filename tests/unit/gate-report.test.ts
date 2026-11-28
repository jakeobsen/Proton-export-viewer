// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate runner's parts that run without the app: the gate mode's config,
// the lid and power-log checks, whether frames were prompt, frames in a
// trace, a launch's validity, memory per phase, the numbers of each launch,
// the rows and their verdicts (a proxy never passes), the plan, and the
// refusals before anything is written.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROMPT_FRAME_MS,
  TARGETS,
  batchNumbers,
  frameStats,
  freshNumbers,
  launchProblems,
  cardsRows,
  indexRows,
  markdown,
  memoryOf,
  opensNumbers,
  parseClamshell,
  planOf,
  rafVerdict,
  reopenNumbers,
  scrollRow,
  sleepsBetween,
  testLogSummary,
  verdictOf,
} from '../../tools/bench/run-gate.mjs';
import { createWorkspace } from '../../tools/bench/workspace.mjs';
import { parseConfig, readConfig, type GateConfig } from '../../src/testhooks/gate-config';
import type { TimedExpansion } from '../../src/testhooks/gate-types';
import { REPO_ROOT, testDir } from '../paths';

const RUNNER = join(REPO_ROOT, 'tools', 'bench', 'run-gate.mjs');
const NONCE = '0123456789abcdef';

function config(over: Partial<GateConfig> = {}): GateConfig {
  return {
    nonce: NONCE,
    workspace: '/tmp/ws',
    mode: 'fresh',
    root: '/tmp/corpus',
    capBytes: 300_000_000,
    stepMs: 60_000,
    frameMs: 250,
    rafProbes: 50,
    scrollSteps: 240,
    settleMs: 5000,
    idleMs: 10_000,
    trace: true,
    sample: null,
    ...over,
  };
}

describe('the gate config', () => {
  it('takes each mode, with a sample for the opens alone', () => {
    for (const mode of ['probe', 'fresh', 'reopen'] as const) {
      expect(parseConfig(config({ mode })).mode).toBe(mode);
    }
    const sample = { seed: 1, count: 1000, maxBytes: 1_048_576, warmup: 20 };
    expect(parseConfig(config({ mode: 'opens', sample })).sample).toEqual(sample);
    expect(() => parseConfig(config({ mode: 'opens' }))).toThrow('invalid gate config');
    expect(() => parseConfig(config({ sample }))).toThrow('invalid gate config');
  });

  it('refuses a bad nonce, a relative path, an unknown mode or a bad number', () => {
    for (const bad of [
      { nonce: 'xyz' },
      { workspace: 'ws' },
      { root: 'corpus' },
      { mode: 'cold' as GateConfig['mode'] },
      { capBytes: 0 },
      { frameMs: 1.5 },
      { trace: 'yes' as unknown as boolean },
    ]) {
      expect(() => parseConfig(config(bad)), JSON.stringify(bad)).toThrow('invalid gate config');
    }
  });

  it("refuses a workspace in the export folder, or one that isn't the run's", () => {
    const parent = testDir('gate-config');
    const corpus = join(parent, 'corpus');
    mkdirSync(join(corpus, 'run'), { recursive: true });
    const nonce = randomBytes(8).toString('hex');
    const file = (workspace: string) => {
      const path = join(parent, `config-${randomBytes(4).toString('hex')}.json`);
      writeFileSync(path, JSON.stringify(config({ nonce, workspace, root: corpus })));
      return path;
    };
    const inside = createWorkspace(join(corpus, 'run', 'ws'), nonce, []);
    expect(() => readConfig(file(inside))).toThrow(`${inside} is inside ${corpus}`);
    const unmarked = join(parent, 'unmarked');
    mkdirSync(unmarked);
    expect(() => readConfig(file(unmarked))).toThrow();
    const outside = createWorkspace(join(parent, 'ws'), nonce, []);
    expect(readConfig(file(outside)).workspace).toBe(outside);
  });
});

describe('the lid and the power log', () => {
  it("reads the lid's state, and says when it can't", () => {
    expect(parseClamshell('  | |   "AppleClamshellState" = Yes\n')).toBe(true);
    expect(parseClamshell('"AppleClamshellState" = No')).toBe(false);
    expect(parseClamshell('nothing here')).toBeNull();
  });

  it('finds Sleep and DarkWake within the launch, and nothing else', () => {
    const log = [
      '2026-11-28 10:00:00 +0100 Sleep               \tEntering Sleep state due to Clamshell Sleep',
      '2026-11-28 10:05:00 +0100 Wake                \tWake from Normal Sleep',
      '2026-11-28 10:06:00 +0100 DarkWake            \tDarkWake from Deep Idle',
      '2026-11-28 12:00:00 +0100 Sleep               \tlater',
      'Time stamp                Domain              Message',
    ].join('\n');
    const from = Date.parse('2026-11-28T08:59:00Z');
    const to = Date.parse('2026-11-28T09:30:00Z');
    expect(sleepsBetween(log, from, to)).toEqual([
      { at: Date.parse('2026-11-28T09:00:00Z'), kind: 'Sleep' },
      { at: Date.parse('2026-11-28T09:06:00Z'), kind: 'DarkWake' },
    ]);
    expect(sleepsBetween(log, to, to + 1000)).toEqual([]);
  });
});

describe('frames in the hidden window', () => {
  const probe = (samples: number[], timeouts = 0) => ({ samples, timeouts, timeoutMs: 250 });

  it(`are prompt when p95 from a DOM change to the frame is within ${PROMPT_FRAME_MS} ms and none is missing`, () => {
    const fast = Array.from({ length: 50 }, (_, i) => (i < 45 ? 8 : 16));
    expect(rafVerdict([probe(fast), probe(fast)])).toMatchObject({
      samples: 100,
      timeouts: 0,
      p95: 16,
      thresholdMs: PROMPT_FRAME_MS,
      prompt: true,
    });
  });

  it('are not prompt with a slow p95, a frame that never came, or no samples', () => {
    const slow = Array.from({ length: 50 }, (_, i) => (i < 45 ? 8 : 40));
    expect(rafVerdict([probe(slow)]).prompt).toBe(false);
    // Just over one 60 Hz frame.
    const justOver = Array.from({ length: 50 }, (_, i) => (i < 45 ? 8 : 17));
    expect(rafVerdict([probe(justOver)])).toMatchObject({ p95: 17, prompt: false });
    expect(rafVerdict([probe(Array<number>(49).fill(8), 1)]).prompt).toBe(false);
    expect(rafVerdict([null, undefined]).prompt).toBe(false);
  });

  it('are counted from the trace: drawn, presented and dropped', () => {
    const reporter = (state: string) => ({
      name: 'PipelineReporter',
      ph: 'b',
      args: { chrome_frame_reporter: { state } },
    });
    const trace = {
      traceEvents: [
        { name: 'Display::DrawAndSwap', ph: 'X' },
        { name: 'Display::DrawAndSwap', ph: 'X' },
        reporter('STATE_PRESENTED_ALL'),
        reporter('STATE_PRESENTED_PARTIAL'),
        reporter('STATE_DROPPED'),
        reporter('STATE_NO_UPDATE_DESIRED'),
        { name: 'PipelineReporter', ph: 'e' },
        { name: 'Other', ph: 'X' },
      ],
    };
    expect(frameStats(trace)).toEqual({
      events: 8,
      drawn: 2,
      reported: 4,
      presented: 2,
      dropped: 1,
      noUpdate: 1,
      produced: true,
    });
    expect(frameStats([]).produced).toBe(false);
    expect(frameStats({ traceEvents: [reporter('STATE_NO_UPDATE_DESIRED')] }).produced).toBe(false);
  });
});

describe('a launch', () => {
  const clean = {
    nonce: NONCE,
    result: {
      nonce: NONCE,
      ok: true,
      windowEvents: [],
      window: { visible: false, focused: false },
      idle: { indexingDuring: 0 },
    },
    exit: { code: 0, signal: null, timedOut: false },
    lidClosedAfter: false,
    sleeps: [],
  };

  it('counts when it ended cleanly, hidden, with the lid open and no sleep', () => {
    expect(launchProblems(clean)).toEqual([]);
  });

  it('is invalid for each thing that went wrong, and says which', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ result: null }, 'no result'],
      [{ result: { ...clean.result, nonce: 'ffffffffffffffff' } }, 'result of another launch'],
      [
        { result: { ...clean.result, ok: false, error: 'timed out: phase 1 to end' } },
        'failed: timed out',
      ],
      [
        { result: { ...clean.result, windowEvents: [{ window: 1, event: 'show' }] } },
        'shown or focused',
      ],
      [
        { result: { ...clean.result, window: { visible: true, focused: false } } },
        'visible or focused',
      ],
      [
        { result: { ...clean.result, idle: { indexingDuring: 2 } } },
        'indexing during the idle window',
      ],
      [{ result: { ...clean.result, indexingDuringOpens: 1 } }, 'indexing during the opens'],
      [{ exit: { code: 0, signal: null, timedOut: true } }, 'did not exit cleanly'],
      [{ exit: { code: null, signal: 'SIGKILL', timedOut: false } }, 'did not exit cleanly'],
      [{ lidClosedAfter: true }, 'lid was closed'],
      [{ lidClosedAfter: null }, 'state is unknown'],
      [{ sleeps: [{ at: 1, kind: 'DarkWake' }] }, 'slept or dark-woke'],
    ];
    for (const [change, reason] of cases) {
      const problems = launchProblems({ ...clean, ...change } as typeof clean);
      expect(problems.join('; '), reason).toContain(reason);
    }
  });
});

describe('memory', () => {
  it('is the idle window’s median, and the peak over phase 1 and the scroll after it', () => {
    const t0 = 1_000_000;
    const phases = [
      { phase: 'start', atEpoch: t0 },
      { phase: 'phase1', atEpoch: t0 + 1000 },
      { phase: 'scroll-after', atEpoch: t0 + 5000 },
      { phase: 'phase2', atEpoch: t0 + 8000 },
      { phase: 'settle', atEpoch: t0 + 20_000 },
      { phase: 'idle', atEpoch: t0 + 25_000 },
    ];
    const MiB = 2 ** 20;
    const sample = (s: number, mib: number) => ({
      at: t0 + s * 1000,
      totalBytes: mib * MiB,
      rssBytes: 2 * mib * MiB,
    });
    const samples = [
      sample(0, 100),
      sample(2, 700),
      sample(6, 900),
      sample(10, 1200), // phase 2: not in the peak this row reports
      sample(26, 300),
      sample(27, 310),
      sample(28, 320),
      sample(40, 999), // after the idle window
    ];
    const m = memoryOf(samples, phases, { fromEpoch: t0 + 25_000, toEpoch: t0 + 35_000 });
    expect(m).toMatchObject({
      idleMiB: 310,
      idleRssMiB: 620,
      idleSamples: 3,
      peakMiB: 900,
      peakRssMiB: 1800,
    });
    expect(memoryOf(samples, phases, null).idleMiB).toBeNull();
  });
});

describe('the numbers of a launch', () => {
  it('times a fresh index from the pick', () => {
    expect(
      freshNumbers({
        pickedAt: 100,
        firstRows: { commitAt: 900.04, rafAt: 905, settled: true, rows: 3 },
        phase1DoneAt: 4100,
        phase1Total: 20_000,
        indexedAt: 60_100,
      }),
    ).toEqual({
      firstRowsCommitMs: 800,
      firstRowsFrameMs: 805,
      phase1Ms: 4000,
      phase1Total: 20_000,
      indexedMs: 60_000,
    });
    expect(
      freshNumbers({ pickedAt: 100, firstRows: { commitAt: 900, rafAt: null } }).firstRowsFrameMs,
    ).toBeNull();
  });

  it('times a reopen from main’s ready, with reconcile and verification after it', () => {
    const r = reopenNumbers({
      readyAt: 50,
      openedAt: 400,
      firstRows: { commitAt: 650, rafAt: 660 },
      reconcileDoneAt: 900,
      reconciled: { at: 880, data: { count: 3, ms: 12 } },
      verified: { code: 'index.verified', at: 1500, data: { ms: 700 } },
    });
    expect(r).toEqual({
      rowsCommitMs: 600,
      rowsFrameMs: 610,
      rowsAfterOpened: true,
      openedMs: 350,
      reconcileMs: 500,
      reconcileApplyMs: 12,
      verified: true,
      verifyMs: 700,
    });
    // Nothing changed: no apply time. A check that couldn't run: not verified.
    const quiet = reopenNumbers({
      readyAt: 50,
      openedAt: 700,
      firstRows: { commitAt: 650 },
      reconcileDoneAt: 800,
      reconciled: null,
      verified: { code: 'index.unverified', at: 900, data: {} },
    });
    expect(quiet).toMatchObject({
      rowsAfterOpened: false,
      reconcileApplyMs: null,
      verified: false,
      verifyMs: null,
    });
  });

  it('gives phase 1’s write batches as p50, p95 and max, and sums what was re-pointed', () => {
    const batches = Array.from({ length: 20 }, (_, i) => ({
      ms: i + 1,
      messages: 500,
      repointedMessages: 2,
      repointedKeys: 3,
      repointedLabelRows: 1,
      maxRepointed: i,
      indexBytes: 1000 * (i + 1),
    }));
    expect(batchNumbers(batches)).toEqual({
      batches: 20,
      p50: 10,
      p95: 19,
      max: 20,
      repointedMessages: 40,
      repointedKeys: 60,
      repointedLabelRows: 20,
      maxRepointed: 19,
      indexBytes: 20_000,
    });
    expect(batchNumbers(null)).toMatchObject({ batches: 0, p95: null, indexBytes: null });
  });

  it('counts the expansions by outcome, with percentiles over the views', () => {
    const opens: TimedExpansion[] = [
      ...Array.from({ length: 19 }, (_, i) => ({
        rowid: i + 1,
        ms: 10 + i,
        outcome: 'view' as const,
      })),
      { rowid: 30, ms: null, outcome: 'timeout' },
      { rowid: 31, ms: null, outcome: 'not-held' },
      { rowid: 32, ms: null, outcome: 'not-expanded' },
    ];
    expect(opensNumbers(opens)).toEqual({
      opens: 22,
      views: 19,
      timeouts: 1,
      notHeld: 1,
      notExpanded: 1,
      p50: 19,
      p95: 28,
      max: 28,
    });
  });
});

/** An indexing gate report's launches, as the runner builds them. */
function indexReport({
  prompt,
  firstRows = 900,
  phase1 = 3000,
  reopen = 1500,
  valid = true,
}: {
  prompt: boolean;
  firstRows?: number;
  phase1?: number;
  reopen?: number;
  valid?: boolean;
}) {
  const frames = {
    events: 10,
    drawn: 5,
    reported: 5,
    presented: 5,
    dropped: 0,
    noUpdate: 0,
    produced: true,
  };
  const fresh = Array.from({ length: 4 }, (_, i) => ({
    name: `fresh-${i + 1}`,
    valid: valid || i > 0,
    numbers: {
      firstRowsCommitMs: firstRows - 50,
      firstRowsFrameMs: firstRows,
      phase1Ms: phase1,
      phase1Total: 20_000,
      indexedMs: 60_000,
    },
    memory: { idleMiB: 400, idleRssMiB: 900, peakMiB: 1200, peakRssMiB: 2500 },
    scrolls: [{ name: 'list-phase1', frames, run: { byFrame: 240, byTimer: 0 } }],
  }));
  const reopenLaunches = Array.from({ length: 4 }, (_, i) => ({
    name: `reopen-${i + 1}`,
    valid: true,
    numbers: {
      rowsCommitMs: reopen - 40,
      rowsFrameMs: reopen,
      rowsAfterOpened: true,
      verifyMs: 700,
      reconcileMs: 100,
    },
  }));
  return {
    probe: {
      raf: {
        prompt,
        samples: 100,
        timeouts: 0,
        p50: 8,
        p95: prompt ? 12 : 40,
        max: 60,
        thresholdMs: PROMPT_FRAME_MS,
      },
      scrolls: [],
    },
    fresh,
    reopen: reopenLaunches,
  };
}

describe('the indexing rows', () => {
  it('end on the frame when frames are prompt, and check each target', () => {
    const rows = indexRows(indexReport({ prompt: true }));
    const byRow = Object.fromEntries(rows.map((r) => [r.row, r]));
    expect(byRow['Cold: first rows visible']).toMatchObject({ value: 900, verdict: 'within' });
    expect(byRow['Cold: first rows visible']?.end).toContain('animation frame');
    expect(byRow['Cold: phase 1 complete (conversation grouping included)']).toMatchObject({
      value: 30_000,
      measured: 3000,
      verdict: 'within',
    });
    expect(byRow['Cold: phase 1 complete (conversation grouping included)']?.kind).toContain(
      'extrapolated',
    );
    expect(byRow['Warm reopen to a usable list']).toMatchObject({ value: 1500, verdict: 'within' });
    expect(byRow['Warm reopen to a usable list']?.after).toEqual({
      verifyMs: 700,
      reconcileMs: 100,
    });
    expect(byRow['Memory, idle after indexing (all processes)']).toMatchObject({
      value: 400,
      rss: 900,
      verdict: 'within',
    });
    expect(byRow['Peak memory, phase 1 and scrolling (all processes)']).toMatchObject({
      value: 1200,
      verdict: 'within',
    });
    expect(byRow['Scroll']).toMatchObject({ value: 0, verdict: 'within' });
  });

  it('report a miss as a miss', () => {
    const rows = indexRows(
      indexReport({ prompt: true, firstRows: TARGETS.firstRowsMs + 1, phase1: 4001 }),
    );
    expect(rows.find((r) => r.row === 'Cold: first rows visible')?.verdict).toBe('MISS');
    expect(rows.find((r) => r.row.startsWith('Cold: phase 1'))?.verdict).toBe('MISS');
  });

  it('end on the DOM change when frames are not prompt, and never pass on that proxy', () => {
    const rows = indexRows(indexReport({ prompt: false }));
    const first = rows.find((r) => r.row === 'Cold: first rows visible');
    const reopen = rows.find((r) => r.row === 'Warm reopen to a usable list');
    expect(first).toMatchObject({ value: 850, verdict: 'PROXY: needs a decision' });
    expect(first?.end).toContain('proxy');
    expect(reopen).toMatchObject({ value: 1460, verdict: 'PROXY: needs a decision' });
    // Rows that don't end on a frame keep their verdicts.
    expect(rows.find((r) => r.row.startsWith('Cold: phase 1'))?.verdict).toBe('within');
  });

  it('are invalid when a launch is', () => {
    const rows = indexRows(indexReport({ prompt: true, valid: false }));
    expect(rows.find((r) => r.row === 'Cold: first rows visible')?.verdict).toBe('INVALID');
    expect(verdictOf(null, 10)).toBe('INVALID');
  });
});

describe('the scroll row', () => {
  const frames = (over = {}) => ({
    events: 9,
    drawn: 4,
    reported: 4,
    presented: 4,
    dropped: 0,
    noUpdate: 0,
    produced: true,
    ...over,
  });

  it('counts dropped frames over every traced scroll', () => {
    expect(
      scrollRow('x', [
        { name: 'a', frames: frames() },
        { name: 'b', frames: frames({ dropped: 2 }) },
      ]),
    ).toMatchObject({
      value: 2,
      verdict: 'MISS',
    });
  });

  it('says when no frames were produced hidden, and is invalid without a trace', () => {
    expect(
      scrollRow('x', [{ name: 'a', frames: frames({ drawn: 0, presented: 0, produced: false }) }])
        .verdict,
    ).toBe('not measurable hidden: needs a decision');
    expect(
      scrollRow('x', [
        { name: 'a', frames: frames() },
        { name: 'b', frames: frames({ drawn: 0, presented: 0, produced: false }) },
      ]).verdict,
    ).toBe('not measurable hidden: needs a decision');
    expect(scrollRow('x', [{ name: 'a', frames: null }]).verdict).toBe('INVALID');
    expect(scrollRow('x', []).verdict).toBe('INVALID');
  });
});

describe('the cards rows', () => {
  const launch = (p95: number, views = 1000) => ({
    name: 'opens',
    valid: true,
    numbers: {
      opens: 1000,
      views,
      timeouts: 0,
      notHeld: 0,
      notExpanded: 0,
      p50: 60,
      p95,
      max: 200,
    },
    warmup: { requested: 20, count: 20, views: 20 },
    scrolls: [],
  });

  it('take the median of the launches’ p95s, and state the pacer', () => {
    const rows = cardsRows({
      probe: { scrolls: [] },
      opens: [launch(100), launch(120), launch(140), launch(200)],
    });
    const open = rows.find((r) => r.row.startsWith('Open message p95'));
    expect(open).toMatchObject({ value: 130, p95s: [100, 120, 140, 200], verdict: 'within' });
    expect(open?.pacer).toContain('60 ms');
  });

  it('are invalid when an expansion didn’t show its view', () => {
    const rows = cardsRows({ probe: { scrolls: [] }, opens: [launch(100), launch(100, 999)] });
    expect(rows.find((r) => r.row.startsWith('Open message p95'))?.verdict).toBe('INVALID');
  });
});

describe('the report', () => {
  const inputs = {
    checkout: { head: 'abc', clean: true },
    build: { app: '/x.app', executableSha256: 'e', asarSha256: 'a' },
    versions: { electron: '1', chrome: '2', node: '3' },
    machine: { model: 'M', cpu: 'C', cores: 10, memoryBytes: 32 * 2 ** 30, macos: '26' },
    runs: 4,
    seed: 1,
    corpora: [{ name: 'perf', before: { matches: true }, after: { matches: true, digest: 'd' } }],
  };

  it('states the frame threshold, the proxy, the rows, the inputs and each launch', () => {
    const report = {
      ...indexReport({ prompt: false }),
      gate: 'index',
      inputs,
      frontmost: { Terminal: 9 },
      capHeld: true,
      indexPeakMiB: 120,
      launches: [{ name: 'probe', mode: 'probe', valid: true, problems: [] }],
      stress: null,
    } as Record<string, unknown>;
    report.rows = indexRows(report);
    const md = markdown(report);
    expect(md).toContain(`p95 ≤ ${PROMPT_FRAME_MS} ms`);
    expect(md).toContain('NOT prompt');
    expect(md).toContain('PROXY: needs a decision');
    expect(md).toContain('| Cold: first rows visible |');
    expect(md).toContain('without background throttling');
    expect(md).toContain('Frontmost app, sampled once a second: Terminal 9');
    expect(md).toContain('| probe | probe | true | - |');
  });

  it('reads test counts and the conversation specs from a log', () => {
    const log = [
      ' Test Files  99 passed (99)',
      '      Tests  1406 passed (1406)',
      '  ✓  12 [electron] › tests/e2e/conversation.spec.ts:298:1 › expanding another card (1.2s)',
      '  188 passed (10.1m)',
      'other line',
    ].join('\n');
    const s = testLogSummary(log);
    expect(s.counts).toHaveLength(3);
    expect(s.conversation).toHaveLength(1);
  });
});

describe('the plan', () => {
  it('starts with the probe; the indexing gate pairs each fresh index with its reopen, then the stress runs', () => {
    expect(planOf('index', 2).map((s) => `${s.name}:${s.profile}`)).toEqual([
      'probe:probe',
      'fresh-1:perf-1',
      'reopen-1:perf-1',
      'fresh-2:perf-2',
      'reopen-2:perf-2',
      'stress-1:stress-1',
      'stress-2:stress-2',
    ]);
    expect(planOf('cards', 2).map((s) => s.name)).toEqual(['probe', 'opens-1', 'opens-2']);
  });
});

describe('the runner', () => {
  it('refuses bad arguments and an output folder in a corpus before it writes anything', () => {
    const parent = testDir('gate-runner');
    const corpus = join(parent, 'perf');
    mkdirSync(join(corpus, 'run'), { recursive: true });
    writeFileSync(join(corpus, 'run', 'a.eml'), 'one');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8' });
    const base = ['--out', join(parent, 'out'), '--perf', corpus, '--scan-data', parent];
    expect(run(...base).stderr).toContain('--gate index|cards');
    expect(run('--gate', 'index', ...base).stderr).toContain('--stress is required');
    expect(run('--gate', 'cards', '--out', join(parent, 'out'), '--perf', corpus).stderr).toContain(
      '--scan-data is required',
    );
    expect(run('--gate', 'cards', ...base).stderr).toContain('no manifest beside');
    writeFileSync(`${corpus}.manifest.json`, '{}');
    const inside = run(
      '--gate',
      'cards',
      '--out',
      join(corpus, 'out'),
      '--perf',
      corpus,
      '--scan-data',
      parent,
    );
    expect(inside.status).toBe(1);
    expect(inside.stderr).toContain('is inside');
    const noApp = run('--gate', 'cards', ...base, '--app', join(parent, 'none.app'));
    expect(noApp.stderr).toContain('no packaged build');
    expect(readdirSync(parent).sort()).toEqual(['perf', 'perf.manifest.json']);
  });
});
