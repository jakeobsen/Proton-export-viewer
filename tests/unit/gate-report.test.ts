// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate runner's parts that run without the app: the gate mode's config,
// the lid and power-log checks, whether frames were prompt, the frame
// cadence and the missed frames of a scroll, a launch's validity, memory per
// phase, the numbers of each launch, the rows and their verdicts (a proxy
// never passes), the plan, and the refusals before anything is written. Also
// the shell's two waits: a scroll step's frame and the gap before a timed
// expansion.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetCheck, freeSpace } from '../../tools/bench/run-bench.mjs';
import {
  OPEN_GAP_MS,
  TARGETS,
  batchNumbers,
  cadenceOf,
  freshNumbers,
  intervalsOf,
  launchCadence,
  launchProblems,
  cardsRows,
  indexRows,
  markdown,
  memoryOf,
  missedIn,
  opensNumbers,
  parseClamshell,
  planOf,
  preflight,
  rafVerdict,
  reopenNumbers,
  scrollFrames,
  scrollRow,
  sleepsBetween,
  stressBatches,
  testLogSummary,
  verdictOf,
  type System,
} from '../../tools/bench/run-gate.mjs';
import { createWorkspace } from '../../tools/bench/workspace.mjs';
import { parseConfig, readConfig, type GateConfig } from '../../src/testhooks/gate-config';
import { stepStamp } from '../../src/testhooks/gate-step';
import type { TimedExpansion } from '../../src/testhooks/gate-types';
import { OPEN_PACE_MS, waitSince, type PaceClock } from '../../src/testhooks/open-pace';
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
    cadenceFrames: 120,
    scrollSteps: 240,
    scrollWaitMs: 2000,
    graceMs: 100,
    settleMs: 5000,
    idleMs: 10_000,
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
      { cadenceFrames: 1.5 },
      { scrollWaitMs: 0 },
      { graceMs: -1 },
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

/** Frame timestamps from these intervals, starting at `from`. */
function stampsOf(intervals: number[], from = 0): number[] {
  const out = [from];
  for (const d of intervals) out.push(out[out.length - 1]! + d);
  return out;
}

/** A record of the frame cadence: `count` frames this far apart. */
const steady = (ms: number, count = 120, timeouts = 0) => ({
  stamps: stampsOf(Array<number>(count - 1).fill(ms)),
  timeouts,
  timeoutMs: 250,
});

describe('frames after a DOM change', () => {
  const probe = (samples: number[], timeouts = 0) => ({ samples, timeouts, timeoutMs: 250 });
  const p95Of = (ms: number) => Array.from({ length: 50 }, (_, i) => (i < 45 ? 8 : ms));

  it("are prompt when p95 is within 1.5 frame intervals of the launch's cadence and none is missing", () => {
    expect(rafVerdict([probe(p95Of(15)), probe(p95Of(15))], 10)).toMatchObject({
      samples: 100,
      timeouts: 0,
      p95: 15,
      thresholdMs: 15,
      prompt: true,
    });
    // One frame interval would be too tight: each sample is about one by construction.
    expect(rafVerdict([probe(p95Of(12))], 10).prompt).toBe(true);
    // Not a fixed 60 Hz frame: on a 50 Hz cadence 25 ms is prompt.
    expect(rafVerdict([probe(p95Of(25))], 20).prompt).toBe(true);
  });

  it('are not prompt just over that, with a frame that never came, no samples or no cadence', () => {
    expect(rafVerdict([probe(p95Of(15.125))], 10)).toMatchObject({ p95: 15.1, prompt: false });
    expect(rafVerdict([probe(Array<number>(49).fill(8), 1)], 10).prompt).toBe(false);
    expect(rafVerdict([null, undefined], 10).prompt).toBe(false);
    expect(rafVerdict([probe(p95Of(8))], null)).toMatchObject({ thresholdMs: null, prompt: false });
  });
});

describe('the frame cadence', () => {
  it('is the intervals between timestamps, with F their median', () => {
    expect(intervalsOf([0, 10, 25, 26])).toEqual([10, 15, 1]);
    expect(intervalsOf([5])).toEqual([]);
    // One long gap among 119 intervals moves neither F nor the p95.
    const run = {
      stamps: stampsOf([...Array<number>(118).fill(10), 200]),
      timeouts: 0,
      timeoutMs: 250,
    };
    expect(cadenceOf(run, 60)).toMatchObject({
      frameMs: 10,
      hz: 100,
      p95: 10,
      max: 200,
      trusted: true,
    });
  });

  it('is trusted at a frame every 18.4 ms or less, and not slower', () => {
    expect(cadenceOf(steady(18.375), null)).toMatchObject({ frameMs: 18.375, trusted: true });
    const slow = cadenceOf(steady(18.5), null);
    expect(slow.trusted).toBe(false);
    expect(slow.reasons.join()).toContain('a frame every 18.5 ms');
  });

  it("is trusted at the display's own rate, so a 50 Hz display isn't read as throttled", () => {
    expect(cadenceOf(steady(20), 50)).toMatchObject({ frameMs: 20, displayHz: 50, trusted: true });
    expect(cadenceOf(steady(20), 60).trusted).toBe(false);
    expect(cadenceOf(steady(20), 0).trusted).toBe(false);
  });

  it('is not trusted with a timeout, too few frames or gaps over 1.5 × F', () => {
    const timedOut = cadenceOf(steady(16, 120, 1), 60);
    expect(timedOut.trusted).toBe(false);
    expect(timedOut.reasons.join()).toContain('no frame within 250 ms, 1 times');
    expect(cadenceOf({ stamps: [3], timeouts: 0, timeoutMs: 250 }, 60).trusted).toBe(false);
    expect(cadenceOf(null, 60).trusted).toBe(false);
    // 90 intervals of 10 ms and 10 of 15: p95 is exactly 1.5 × F.
    const edge = (long: number) => ({
      stamps: stampsOf([...Array<number>(90).fill(10), ...Array<number>(10).fill(long)]),
      timeouts: 0,
      timeoutMs: 250,
    });
    expect(cadenceOf(edge(15), 60)).toMatchObject({ frameMs: 10, p95: 15, trusted: true });
    const gaps = cadenceOf(edge(15.125), 60);
    expect(gaps.trusted).toBe(false);
    expect(gaps.reasons.join()).toContain('gaps');
  });

  it('of a launch takes F from before the pick; the check after indexing only confirms it', () => {
    const c = launchCadence(
      [
        { name: 'baseline', ...steady(16) },
        { name: 'check', ...steady(17) },
      ],
      60,
    );
    expect(c).toMatchObject({ frameMs: 16, trusted: true });
    expect(c.check.frameMs).toBe(17);
  });

  it("of a launch is not trusted when the check differs by 10% or more, or isn't trusted, or is missing", () => {
    const at = (check: number) =>
      launchCadence(
        [
          { name: 'baseline', ...steady(10) },
          { name: 'check', ...steady(check) },
        ],
        null,
      );
    expect(at(10.9375).trusted).toBe(true);
    const changed = at(11);
    expect(changed.trusted).toBe(false);
    expect(changed.reasons.join()).toContain('the frame rate changed during the launch');
    expect(at(9).trusted).toBe(false);
    const timedOut = launchCadence(
      [
        { name: 'baseline', ...steady(16) },
        { name: 'check', ...steady(16, 120, 2) },
      ],
      60,
    );
    expect(timedOut.trusted).toBe(false);
    expect(timedOut.reasons.join()).toContain('after indexing: no frame within');
    expect(launchCadence([{ name: 'baseline', ...steady(16) }], 60).trusted).toBe(false);
    expect(launchCadence(undefined, 60).trusted).toBe(false);
  });
});

describe('missed frames', () => {
  it('count round(Δ / F) − 1 for each interval over 1.5 × F, and none at it', () => {
    expect(missedIn([10, 15], 10)).toEqual({ intervals: 2, long: 0, missed: 0 });
    expect(missedIn([15.125], 10)).toEqual({ intervals: 1, long: 1, missed: 1 });
    expect(missedIn([30, 10, 20], 10)).toEqual({ intervals: 3, long: 2, missed: 3 });
    // A frame that came late is a miss, however late.
    expect(missedIn([400], 16)).toEqual({ intervals: 1, long: 1, missed: 24 });
  });
});

describe('a scroll', () => {
  const trusted = launchCadence(
    [
      { name: 'baseline', ...steady(16) },
      { name: 'check', ...steady(17) },
    ],
    60,
  );
  const scroll = (intervals: number[], over = {}) => ({
    name: 'list-phase1',
    steps: intervals.length + 1,
    stamps: stampsOf(intervals, 1000),
    stopped: false,
    waitMs: 2100,
    ...over,
  });

  it("counts its missed frames against the launch's F from before the pick", () => {
    // 24.5 ms is over 1.5 × 16, though not over 1.5 × the check's 17.
    const f = scrollFrames(scroll([16, 16, 24.5, 16, 400]), trusted);
    expect(f).toMatchObject({
      made: 6,
      frameMs: 16,
      trusted: true,
      available: true,
      intervals: 5,
      long: 2,
      missed: 25,
    });
  });

  it('janky while indexing, under a trusted cadence, is a MISS and not "not measurable"', () => {
    const janky = scrollFrames(scroll([16, 120, 16, 48, 33, 16, 250]), trusted, 1e9);
    expect(janky.trusted).toBe(true);
    expect(scrollRow('during', [janky]).verdict).toBe('MISS (proxy)');
  });

  it('counts for "during phase 1" only the intervals that end before it', () => {
    // Frames at 1000, 1016, 1032, 1100: phase 1 ends at 1040.
    const f = scrollFrames(scroll([16, 16, 68]), trusted, 1040);
    expect(f).toMatchObject({ available: true, intervals: 2, missed: 0 });
    expect(f.pastPhase1).toEqual({ intervals: 1, missed: 3, ranPastMs: 60 });
  });

  it('is unavailable for "during phase 1" when phase 1 ended before its second frame, never 0 missed', () => {
    const f = scrollFrames(scroll([16, 16]), trusted, 1010);
    expect(f).toMatchObject({
      available: false,
      unavailable: 'phase 1 ended before the scroll',
      missed: null,
    });
    const row = scrollRow('during', [f]);
    expect(row).toMatchObject({ verdict: 'unavailable', value: null });
    expect(row.reasons).toContain('phase 1 ended before the scroll');
  });

  it("that stopped, or under a cadence that isn't trusted, gives no number", () => {
    const stopped = scrollFrames(scroll([16, 16], { stopped: true }), trusted);
    expect(stopped).toMatchObject({ trusted: false, missed: null });
    expect(stopped.reasons).toContain('no frame within 2.1 s');
    const untrusted = launchCadence([{ name: 'baseline', ...steady(40) }], 60);
    const f = scrollFrames(scroll([16, 16]), untrusted);
    expect(f).toMatchObject({ trusted: false, missed: null });
    expect(scrollRow('x', [f])).toMatchObject({ verdict: 'not measurable hidden', value: null });
  });
});

describe('the scroll row', () => {
  const trusted = launchCadence(
    [
      { name: 'baseline', ...steady(16) },
      { name: 'check', ...steady(16) },
    ],
    60,
  );
  const frames = (intervals: number[], cadence = trusted) =>
    scrollFrames(
      { name: 'a', steps: 10, stamps: stampsOf(intervals), stopped: false, waitMs: 2100 },
      cadence,
    );

  it('is a proxy that never passes: no missed frames still needs a decision', () => {
    const row = scrollRow('x', [frames([16, 16, 16]), frames([16, 17])]);
    expect(row).toMatchObject({
      row: 'Scroll (renderer rAF-interval proxy)',
      value: 0,
      verdict: 'proxy: no missed frames seen, not a pass on its own',
    });
    expect(row.verdict).not.toBe('within');
    expect(row.kind).toContain('not compositor frames');
  });

  it('is a MISS when a trusted scroll missed frames, even beside one that is not measurable', () => {
    const untrusted = launchCadence([{ name: 'baseline', ...steady(40) }], 60);
    expect(scrollRow('x', [frames([16, 40]), frames([16], untrusted)]).verdict).toBe(
      'MISS (proxy)',
    );
    expect(scrollRow('x', [frames([16, 16]), frames([16], untrusted)]).verdict).toBe(
      'not measurable hidden',
    );
  });

  it('is invalid with no scrolls', () => {
    expect(scrollRow('x', []).verdict).toBe('INVALID');
  });
});

describe("the shell's waits", () => {
  it('take a frame that comes late, after the time limit, within the grace', async () => {
    const waits: number[] = [];
    const answers = [null, 2345.5];
    const next = (ms: number) => {
      waits.push(ms);
      return Promise.resolve(answers.shift() ?? null);
    };
    expect(await stepStamp(next, 2000, 100)).toBe(2345.5);
    expect(waits).toEqual([2000, 100]);
    expect(await stepStamp(() => Promise.resolve(17), 2000, 100)).toBe(17);
    expect(await stepStamp(() => Promise.resolve(null), 2000, 100)).toBeNull();
  });

  it('start a timed expansion at least 60 ms after the shown body loaded', async () => {
    expect(OPEN_GAP_MS).toBe(OPEN_PACE_MS);
    let now = 130;
    const slept: number[] = [];
    const clock: PaceClock = {
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        // A timer may fire a little early: the wait reads the clock again.
        now += slept.length === 1 ? ms - 1 : ms;
        return Promise.resolve();
      },
    };
    expect(await waitSince(100, clock)).toBe(160);
    expect(slept).toEqual([30, 1]);
    slept.length = 0;
    now = 175;
    expect(await waitSince(100, clock)).toBe(175);
    expect(slept).toEqual([]);
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

  it('is invalid when an expansion started less than 60 ms after the shown body loaded', () => {
    const opens = (gaps: Array<number | null>) => ({
      ...clean,
      result: {
        ...clean.result,
        opens: gaps.map((gapMs, i) => ({ rowid: i + 1, ms: 9, gapMs, outcome: 'view' })),
      },
    });
    expect(launchProblems(opens([60, 61.5, null]))).toEqual([]);
    const early = launchProblems(opens([60, 59.9]));
    expect(early.join('; ')).toContain('1 expansions started less than 60 ms');
    expect(early.join('; ')).toContain('smallest 59.9 ms');
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
        gapMs: 61,
        outcome: 'view' as const,
      })),
      { rowid: 30, ms: null, gapMs: 61, outcome: 'timeout' },
      { rowid: 31, ms: null, gapMs: null, outcome: 'not-held' },
      { rowid: 32, ms: null, gapMs: 62, outcome: 'not-expanded' },
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
  const cadence = launchCadence(
    [
      { name: 'baseline', ...steady(16) },
      { name: 'check', ...steady(16) },
    ],
    60,
  );
  const scroll = (name: string, intervals: number[]) =>
    scrollFrames(
      { name, steps: 240, stamps: stampsOf(intervals), stopped: false, waitMs: 2100 },
      cadence,
      name === 'list-phase1' ? 1e9 : null,
    );
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
    scrolls: [scroll('list-phase1', [16, 16, 17]), scroll('list-after', [16, 16])],
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
        thresholdMs: 24,
      },
      cadence,
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
    const scrolls = rows.filter((r) => r.row === 'Scroll (renderer rAF-interval proxy)');
    expect(scrolls.map((r) => [r.name, r.value, r.verdict])).toEqual([
      ['All Mail list, during phase 1', 0, 'proxy: no missed frames seen, not a pass on its own'],
      ['All Mail list, after phase 1', 0, 'proxy: no missed frames seen, not a pass on its own'],
    ]);
    expect(byRow['Warm reopen to a usable list']?.start).toContain('An upper bound');
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
    gaps: [61, 75.5],
  });

  it('take the median of the launches’ p95s, and state the pacer and the sample rule', () => {
    const rows = cardsRows({
      probe: { scrolls: [] },
      opens: [launch(100), launch(120), { ...launch(140), gaps: [60.2] }, launch(200)],
      sampleRule: { seed: 1, maxBytes: 1_048_576, count: 1000 },
    });
    const open = rows.find((r) => r.row.startsWith('Open message p95'));
    expect(open).toMatchObject({ value: 130, p95s: [100, 120, 140, 200], verdict: 'within' });
    expect(open?.pacer).toContain('at least 60 ms after the shown message');
    expect(open?.pacer).toContain('never held it');
    expect(open?.pacer).toContain('Smallest gap: 60.2 ms');
    expect(open?.sample).toContain('at most 1048576 B in conversations of two or more');
    expect(open?.sample).toContain("never a conversation's newest");
    expect(open?.sample).toContain('seed 1');
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
    expect(md).toContain('p95 ≤ 24 ms (1.5 frame intervals');
    expect(md).toContain('NOT prompt');
    expect(md).toContain('before the pick a frame every 16 ms (62.5 Hz)');
    expect(md).toContain('Trusted: frames came unthrottled.');
    expect(md).toContain('## Scrolls');
    expect(md).toContain(
      "A frame the compositor or display drops after the renderer made it isn't seen",
    );
    expect(md).toContain(
      '- **All Mail list, during phase 1:** proxy: no missed frames seen, not a pass on its own.',
    );
    expect(md).toContain('An upper bound');
    expect(md).toContain('PROXY: needs a decision');
    expect(md).toContain('| Cold: first rows visible |');
    expect(md).toContain('without background throttling, set when it is created');
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

describe('the stress batches', () => {
  it('are the median over the valid launches of each launch’s number', () => {
    const launch = (p50: number, p95: number, max: number) => ({
      batches: { ...batchNumbers([]), p50, p95, max, repointedMessages: 7 },
    });
    expect(
      stressBatches([launch(10, 40, 90), launch(12, 44, 300), launch(11, 50, 100)]),
    ).toMatchObject({
      launches: 3,
      p50: 11,
      p95: 44,
      max: 100,
      repointedMessages: 7,
    });
    expect(stressBatches([]).p95).toBeNull();
    expect(stressBatches([{ batches: null }]).p95).toBeNull();
  });
});

describe('the preflight', () => {
  const parent = testDir('gate-preflight');
  const corpus = join(parent, 'perf');
  mkdirSync(corpus, { recursive: true });
  const app = join(parent, 'test.app');
  const args = {
    out: join(parent, 'out'),
    perf: corpus,
    stress: null,
    app,
    scanData: [parent],
  };
  const ok: System = {
    exists: (path) => path.startsWith(app),
    lidClosed: () => false,
    git: (a) => (a[0] === 'status' ? '' : 'c0ffee'),
    freeSpace: (dir) => freeSpace(dir, () => ({ bavail: 2 ** 30, bsize: 4096 })),
    containers: () => [],
    testData: () => [corpus],
    budget: (folders) => budgetCheck(folders, 300_000_000, () => 100_000_000),
    corpusOf: (name, folder) => ({ name, root: folder, manifestPath: `${folder}.m`, manifest: {} }),
    corpusState: () => ({ matches: true }),
  };

  it('passes a clean setup, and reads the checkout it runs from', () => {
    expect(preflight(args, ok)).toMatchObject({
      head: 'c0ffee',
      before: { perf: { matches: true } },
    });
  });

  it('refuses each thing before the run writes anything, and says which', () => {
    const cases: Array<[Partial<System> | null, Partial<typeof args>, string]> = [
      [{ exists: (p) => p === args.out || p.startsWith(app) }, {}, 'must be a new folder'],
      [null, { out: 'out' }, 'must be a new folder'],
      [null, { out: join(corpus, 'out') }, 'is inside'],
      [{ exists: () => false }, {}, 'no packaged build'],
      [{ lidClosed: () => true }, {}, 'the lid is closed'],
      [{ lidClosed: () => null }, {}, "can't read the lid's state"],
      [
        { git: (a) => (a[0] === 'status' ? ' M src/x.ts' : 'c0ffee') },
        {},
        'the checkout has changes',
      ],
      [{ git: () => null }, {}, 'the checkout has changes (or git failed)'],
      [
        { freeSpace: (dir) => freeSpace(dir, () => ({ bavail: 1000, bsize: 4096 })) },
        {},
        '20 GiB needed',
      ],
      [{ budget: (f) => budgetCheck(f, 300_000_000, () => 900_000_000) }, {}, 'would pass'],
      [
        { corpusState: () => ({ matches: false, differs: 'a.eml' }) },
        {},
        'differs from its manifest',
      ],
    ];
    for (const [sys, over, message] of cases) {
      expect(() => preflight({ ...args, ...over }, { ...ok, ...sys }), message).toThrow(message);
    }
    expect(readdirSync(parent)).toEqual(['perf']);
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
