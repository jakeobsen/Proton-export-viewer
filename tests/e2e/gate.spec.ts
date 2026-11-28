// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate mode of test builds, on a small export: each launch (the probe, a
// fresh index, its reopen, and timed expansions) runs hidden, picks or
// reopens the export as a user does, writes its result into the run's
// workspace and quits. The export is only read. Timing values aren't judged
// here; what each launch records, and that every wait ends, is.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { GateConfig } from '../../src/testhooks/gate-config';
import type { FirstRows, RafProbe, TimedExpansion } from '../../src/testhooks/gate-types';
import {
  OPEN_GAP_MS,
  batchNumbers,
  freshNumbers,
  launchCadence,
  opensNumbers,
  rafVerdict,
  reopenNumbers,
} from '../../tools/bench/run-gate.mjs';
import { createWorkspace } from '../../tools/bench/workspace.mjs';
import { writeExport } from '../exports';
import { REPO_ROOT, testDir } from '../paths';
// This test's own folders are removed once it passes.
import { expect, test } from './app';

/** Every file and folder under the folder, files with the SHA-256 of their content. */
function snapshot(root: string, at = ''): Record<string, string> {
  return Object.fromEntries(
    readdirSync(join(root, at), { withFileTypes: true }).flatMap((entry) => {
      const rel = join(at, entry.name);
      if (entry.isDirectory())
        return [[`${rel}/`, 'folder'], ...Object.entries(snapshot(root, rel))];
      const hash = createHash('sha256')
        .update(readFileSync(join(root, rel)))
        .digest('hex');
      return [[rel, hash]];
    }),
  );
}

/** The Electron binary the app's dependencies installed. */
const ELECTRON = createRequire(join(REPO_ROOT, 'package.json'))('electron') as string;

interface Result {
  ok: boolean;
  error?: string;
  mode: string;
  inputs: { backgroundThrottling: boolean; framesWhileHidden: boolean; capBytes: number };
  display?: { frequency: number };
  cadences?: Array<{
    name: string;
    startedAt: number;
    endedAt: number;
    stamps: number[];
    timeouts: number;
    timeoutMs: number;
  }>;
  window: { visible: boolean; focused: boolean };
  windowEvents: unknown[];
  phases: Array<{ phase: string; atEpoch: number }>;
  progress: Array<{ at: number; phase: string; bodyPhase: string }>;
  rafBefore?: RafProbe;
  rafAfter?: RafProbe;
  firstRows?: FirstRows;
  pickedAt?: number;
  phase1DoneAt?: number;
  indexedAt?: number | null;
  scrolls?: Array<{
    name: string;
    startedAt: number;
    endedAt: number;
    steps: number;
    stamps: number[];
    stopped: boolean;
    waitMs: number;
  }>;
  idle?: { indexingDuring: number; fromEpoch: number; toEpoch: number } | null;
  openedAt?: number;
  verified?: { code: string } | null;
  batches?: unknown[] | null;
  sample?: Array<{ rel: string; size: number; rowid: number }>;
  warmup?: { requested: number; count: number; views: number };
  opens?: TimedExpansion[];
  indexingDuringOpens?: number;
  totals?: { messages: number } | null;
}

async function launch(
  name: string,
  root: string,
  userData: string,
  over: Partial<GateConfig>,
): Promise<{ result: Result; workspace: string }> {
  const nonce = randomBytes(8).toString('hex');
  const workspace = join(testDir(`gate-${name}`), 'ws');
  createWorkspace(workspace, nonce, []);
  const config = join(workspace, 'config.json');
  const full: GateConfig = {
    nonce,
    workspace,
    mode: 'fresh',
    root,
    capBytes: 300_000_000,
    stepMs: 60_000,
    frameMs: 250,
    rafProbes: 5,
    cadenceFrames: 5,
    scrollSteps: 6,
    scrollWaitMs: 2000,
    graceMs: 100,
    settleMs: 300,
    idleMs: 700,
    sample: null,
    ...over,
  };
  writeFileSync(config, JSON.stringify(full));
  // Started as the runner starts it: no driver attached, nothing read but the result.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  const exit = await new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>(
    (done) => {
      const child = spawn(
        ELECTRON,
        [join(REPO_ROOT, 'out-test'), `--pev-user-data=${userData}`, `--pev-gate=${config}`],
        { cwd: REPO_ROOT, env, stdio: 'ignore' },
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 180_000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        done({ code, signal, timedOut });
      });
    },
  );
  expect(exit, name).toEqual({ code: 0, signal: null, timedOut: false });
  const file = join(workspace, `gate-result-${nonce}.json`);
  expect(existsSync(file), name).toBe(true);
  return { result: JSON.parse(readFileSync(file, 'utf8')) as Result, workspace };
}

function hidden(result: Result): void {
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.window).toEqual({ visible: false, focused: false });
  expect(result.windowEvents).toEqual([]);
  expect(result.inputs.backgroundThrottling).toBe(false);
  expect(result.inputs.framesWhileHidden).toBe(true);
  expect(typeof result.display?.frequency).toBe('number');
}

/** When the gate noted a phase, on the epoch clock. */
function phaseAt(result: Result, phase: string): number {
  const at = result.phases.find((p) => p.phase === phase)?.atEpoch;
  expect(at, phase).toBeDefined();
  return at!;
}

/**
 * A launch that scrolls records the frame cadence twice, with nothing else
 * going on: before the pick, and after indexing (after `after`, a phase).
 * Its scrolls keep each step's frame timestamp. No trace is written.
 */
function cadences(result: Result, workspace: string, after: string): void {
  const [baseline, check] = result.cadences!;
  expect(result.cadences!.map((c) => c.name)).toEqual(['baseline', 'check']);
  for (const c of [baseline!, check!]) expect(c.stamps.length + c.timeouts).toBe(5);
  // The baseline ends before the pick reaches main, and before phase 1's mark.
  expect(baseline!.endedAt).toBeLessThan(result.pickedAt!);
  expect(phaseAt(result, 'cadence-baseline')).toBeLessThan(phaseAt(result, 'phase1'));
  // The check starts once indexing has ended, and after the given phase.
  expect(check!.startedAt).toBeGreaterThanOrEqual(result.indexedAt!);
  expect(phaseAt(result, 'cadence-check')).toBeGreaterThanOrEqual(phaseAt(result, after));
  // Timing isn't judged here; the log shows what this machine gave.
  const c = launchCadence(result.cadences, result.display?.frequency);
  console.log(
    `gate cadence (${result.mode}):`,
    JSON.stringify({
      frameMs: c.frameMs,
      displayHz: c.displayHz,
      trusted: c.trusted,
      reasons: c.reasons,
    }),
  );
  for (const s of result.scrolls!) {
    // A scroll ends early only when no frame came within its wait.
    if (s.stopped) expect(s.stamps.length, s.name).toBeLessThan(6);
    else expect(s.stamps, s.name).toHaveLength(6);
    expect(s.waitMs, s.name).toBe(2100);
    expect(
      [...s.stamps].sort((a, b) => a - b),
      s.name,
    ).toEqual(s.stamps);
  }
  expect(readdirSync(workspace).filter((f) => f.includes('trace'))).toEqual([]);
}

test('the gate mode runs each launch hidden, records what the report needs, and reads the export only', async () => {
  test.setTimeout(600_000);
  const root = realpathSync(testDir('gate-export'));
  writeExport(root, { seed: 7, messages: 120 });
  const before = snapshot(root);
  const profile = testDir('gate-profile');

  // The probe: the frame cadence, frames after DOM changes, and scrolls during
  // and after phase 1 and in a conversation.
  const probe = await launch('probe', root, testDir('gate-probe-profile'), { mode: 'probe' });
  hidden(probe.result);
  for (const p of [probe.result.rafBefore, probe.result.rafAfter]) {
    expect(p!.samples.length + p!.timeouts).toBe(5);
  }
  expect(
    rafVerdict([probe.result.rafBefore, probe.result.rafAfter], 16).samples,
  ).toBeGreaterThanOrEqual(0);
  expect(probe.result.scrolls!.map((s) => s.name)).toEqual([
    'list-phase1',
    'list-after',
    'conversation',
  ]);
  cadences(probe.result, probe.workspace, 'phase2');

  // A fresh index: first rows after the pick, phase 1, phase 2, then idle with nothing indexing.
  const fresh = await launch('fresh', root, profile, {});
  hidden(fresh.result);
  expect(fresh.result.scrolls!.map((s) => s.name)).toEqual(['list-phase1', 'list-after']);
  cadences(fresh.result, fresh.workspace, 'idle-end');
  const f = freshNumbers(fresh.result as unknown as Record<string, unknown>);
  expect(f.firstRowsCommitMs).toBeGreaterThan(0);
  // On an export this small, phase 1 can end before the shell draws its first
  // row, so the two aren't ordered here.
  expect(f.phase1Ms).toBeGreaterThan(0);
  expect(fresh.result.idle).toMatchObject({ indexingDuring: 0 });
  expect(fresh.result.phases.map((p) => p.phase)).toEqual(
    expect.arrayContaining(['phase1', 'scroll-after', 'phase2', 'settle', 'idle', 'idle-end']),
  );
  expect(fresh.result.inputs.capBytes).toBe(300_000_000);
  const batches = batchNumbers(fresh.result.batches);
  expect(batches.batches).toBeGreaterThan(0);
  expect(batches.p95).not.toBeNull();

  // Its reopen: the rows after index.opened, then reconcile and the check.
  const reopen = await launch('reopen', root, profile, { mode: 'reopen' });
  hidden(reopen.result);
  const r = reopenNumbers(reopen.result as unknown as Record<string, unknown>);
  expect(r.rowsAfterOpened).toBe(true);
  expect(r.reconcileMs).not.toBeNull();
  expect(r.verified).toBe(true);

  // Expansions on a fresh index once indexing has ended, through the cards model.
  const opens = await launch('opens', root, testDir('gate-opens-profile'), {
    mode: 'opens',
    sample: { seed: 1, count: 4, maxBytes: 1_048_576, warmup: 1 },
  });
  hidden(opens.result);
  expect(opens.result.sample).toHaveLength(4);
  expect(opens.result.warmup).toEqual({ requested: 1, count: 1, views: 1 });
  expect(opensNumbers(opens.result.opens)).toMatchObject({ opens: 4, views: 4 });
  expect(opens.result.indexingDuringOpens).toBe(0);
  // Each timed expand started at least the pacer's gap after the shown body loaded.
  for (const o of opens.result.opens!) expect(o.gapMs).toBeGreaterThanOrEqual(OPEN_GAP_MS);
  expect(opens.result.scrolls!.map((s) => s.name)).toEqual(['conversation']);
  cadences(opens.result, opens.workspace, 'sample');

  // The export was only read.
  expect(snapshot(root)).toEqual(before);
});
