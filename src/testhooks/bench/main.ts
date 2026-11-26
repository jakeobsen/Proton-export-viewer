// SPDX-License-Identifier: AGPL-3.0-or-later
// The bench driver in main. With --pev-bench=<config.json> (or, where the
// sandbox can't read the config file, --pev-bench-inline=<base64url JSON>),
// a test build runs the index bench hidden, writes one JSON result and quits.
// Main never touches the index: every number below comes from core's threads,
// timed here end to end through the same channel the UI uses.

import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { BrowserWindow, app, session } from 'electron';
import type { AppContext } from '../../main/context';
import { createAppWindow } from '../../main/windows';
import {
  checkEmptyFolder,
  checkNewFile,
  checkWorkspace,
  createWorkspace,
  removeInside,
  removeWorkspace,
} from '../../../tools/bench/workspace.mjs';
import type { EngineName } from './sql';

const INDEX_FILE = 'pev-bench.db';
const INDEX_SUFFIXES = ['', '-wal', '-shm', '-journal'];

export interface LargePart {
  kind: 'text' | 'html' | 'attachment';
  bytes: number;
}

export interface BenchConfig {
  nonce: string;
  scenario: 'perf' | 'stress' | 'sandbox';
  label: string;
  /** The export run folder the bench reads (never written). */
  runDir?: string;
  /**
   * The run's workspace, which the runner created fresh and marked with the
   * nonce. The index, the result and the download all go inside it. The
   * sandboxed build makes its own inside its container instead.
   */
  workspace?: string;
  engine: EngineName;
  addonDir?: string;
  poolSize: number;
  oldGenMb: number;
  indexCapBytes: number;
  term: string;
  searchRepeats: number;
  opens: number;
  loadIntervalMs: number;
  large: LargePart[];
  reopens: number;
  quarantine: boolean;
  window: boolean;
  maxMessages?: number;
  ftsPrefix?: string;
  /** Stays idle this long after indexing, so the processes can be inspected from outside. */
  holdMs?: number;
}

interface Sample {
  t: number;
  phase: string;
  totalKb: number;
  byType: Record<string, number>;
}

const OPEN_MAX_BYTES = 1024 * 1024;

function configFrom(argv: string[]): BenchConfig | null {
  const file = argv.find((a) => a.startsWith('--pev-bench='))?.slice('--pev-bench='.length);
  if (file) return JSON.parse(readFileSync(file, 'utf8')) as BenchConfig;
  const inline = argv
    .find((a) => a.startsWith('--pev-bench-inline='))
    ?.slice('--pev-bench-inline='.length);
  if (inline) return JSON.parse(Buffer.from(inline, 'base64url').toString('utf8')) as BenchConfig;
  return null;
}

export const benchRequested = (argv: string[]): boolean =>
  argv.some((a) => a.startsWith('--pev-bench=') || a.startsWith('--pev-bench-inline='));

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function summary(values: number[]) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : null,
  };
}

class Sampler {
  readonly samples: Sample[] = [];
  /** When each phase began, by the wall clock, so outside samples can be matched to it. */
  readonly phaseLog: Array<{ phase: string; at: number }> = [{ phase: 'start', at: Date.now() }];
  private current = 'start';

  get phase(): string {
    return this.current;
  }

  set phase(name: string) {
    this.current = name;
    this.phaseLog.push({ phase: name, at: Date.now() });
  }

  private timer: NodeJS.Timeout | null = null;
  private readonly t0 = performance.now();

  start(): void {
    this.take();
    this.timer = setInterval(() => this.take(), 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Each process ID's type, so outside measurements can name the processes. */
  readonly types: Record<number, string> = {};

  take(): Sample {
    const byType: Record<string, number> = {};
    let totalKb = 0;
    for (const m of app.getAppMetrics()) {
      const kb = m.memory.workingSetSize;
      const key = m.type === 'Utility' ? `Utility:${m.serviceName ?? ''}` : m.type;
      this.types[m.pid] = key;
      byType[key] = (byType[key] ?? 0) + kb;
      totalKb += kb;
    }
    const sample = { t: performance.now() - this.t0, phase: this.phase, totalKb, byType };
    this.samples.push(sample);
    return sample;
  }

  peak(phases?: string[]) {
    const pool = phases ? this.samples.filter((s) => phases.includes(s.phase)) : this.samples;
    const top = pool.reduce<Sample | null>(
      (a, s) => (a === null || s.totalKb > a.totalKb ? s : a),
      null,
    );
    return top ? { mb: top.totalKb / 1024, phase: top.phase, byTypeMb: mb(top.byType) } : null;
  }

  median(phase: string) {
    const pool = this.samples.filter((s) => s.phase === phase).map((s) => s.totalKb);
    const m = percentile(pool, 50);
    return m === null ? null : { mb: m / 1024, n: pool.length };
  }
}

const mb = (byType: Record<string, number>) =>
  Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round((v / 1024) * 10) / 10]));

const sleep = (msec: number) => new Promise((r) => setTimeout(r, msec));

async function waitCoreExit(ctx: AppContext): Promise<void> {
  for (let i = 0; i < 200 && ctx.core.pid !== undefined; i++) await sleep(25);
}

/** Writes the small synthetic export into a folder the sandboxed build owns. */
async function writeSmallCorpus(root: string): Promise<string> {
  const { entries } = await import('../../../tools/gen-export/generator.mjs');
  let run = '';
  const dirs: Array<[string, number]> = [];
  for (const e of entries('small', { seed: 1 })) {
    if ('meta' in e) {
      run = e.run;
      continue;
    }
    const path = join(root, e.path);
    if (e.type === 'dir') {
      mkdirSync(path, { recursive: true });
      dirs.push([path, e.mtime]);
    } else if (e.type === 'file' && e.data) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, e.data);
      utimesSync(path, e.mtime, e.mtime);
    }
  }
  for (const [path, mtime] of dirs.reverse()) utimesSync(path, mtime, mtime);
  return join(root, run);
}

/**
 * Saves a file the way the app will: a download of a URL its own protocol
 * handler serves, in a custom partition, through Chromium's download path with
 * the save path set (so no dialog). The runner then reads the file's
 * quarantine attribute from outside the app.
 */
async function quarantineCheck(dir: string, nonce: string): Promise<Record<string, unknown>> {
  const ses = session.fromPartition(`bench-download-${nonce}`);
  ses.protocol.handle(
    'mail-asset',
    () =>
      new Response('quarantine check\n', {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="check.bin"',
        },
      }),
  );
  // A download needs a WebContents in that partition. The window is never shown.
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true } });
  const target = join(dir, `quarantine-${nonce}.bin`);
  try {
    const done = new Promise<string>((resolve) => {
      ses.once('will-download', (_event, item) => {
        item.setSavePath(target);
        item.once('done', (_e, state) => resolve(state));
      });
    });
    win.webContents.downloadURL('mail-asset://v/check.bin');
    const state = await Promise.race([done, sleep(10_000).then(() => 'timeout')]);
    return { path: target, state, saved: existsSync(target), method: 'webContents.downloadURL' };
  } finally {
    win.destroy();
  }
}

export async function runBench(ctx: AppContext, argv: string[]): Promise<void> {
  const config = configFrom(argv)!;
  const result: Record<string, unknown> = {
    nonce: config.nonce,
    scenario: config.scenario,
    label: config.label,
    startedAt: new Date().toISOString(),
    build: {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      sqliteBuiltIn: process.versions.sqlite ?? null,
      mas: Boolean(process.mas),
      packaged: app.isPackaged,
    },
    machine: {
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? null,
      totalMemGb: totalmem() / 2 ** 30,
    },
    config: { ...config, addonDir: config.addonDir ? '(given)' : null },
  };
  const userData = app.getPath('userData');
  // The sandboxed build can't reach the runner's folder: its workspace is a new
  // folder in its container, and the result goes next to it.
  const sandboxed = config.scenario === 'sandbox';
  const workspace = sandboxed ? join(userData, `bench-${config.nonce}`) : (config.workspace ?? '');
  const resultPath = sandboxed
    ? join(userData, `bench-result-${config.nonce}.json`)
    : join(workspace, `result-${config.nonce}.json`);
  const sampler = new Sampler();
  sampler.start();
  const core = async <T>(payload: Record<string, unknown>): Promise<T> => {
    const r = await ctx.core.request({ type: 'test', action: 'bench', payload });
    if (!r.ok) throw new Error(`core ${String(payload.op)}: ${r.detail ?? r.code}`);
    return r.data as T;
  };
  const timed = async <T>(payload: Record<string, unknown>): Promise<{ ms: number; data: T }> => {
    const t0 = performance.now();
    const data = await core<T>(payload);
    return { ms: performance.now() - t0, data };
  };

  let corpusRoot: string | null = null;
  let runDir = config.runDir ?? '';
  let dbPath = '';
  let ownWorkspace = false;
  try {
    if (sandboxed) {
      createWorkspace(workspace, config.nonce, ['index', 'corpus']);
      ownWorkspace = true;
      corpusRoot = join(workspace, 'corpus');
      runDir = await writeSmallCorpus(corpusRoot);
    }
    checkWorkspace(workspace, config.nonce);
    // A fresh, empty index folder: nothing already there is ever opened or removed.
    checkEmptyFolder(workspace, join(workspace, 'index'));
    dbPath = join(workspace, 'index', INDEX_FILE);
    if (config.window) {
      const win = createAppWindow(ctx);
      if (win.win.webContents.isLoading()) await once(win.win.webContents, 'did-finish-load');
    }
    const target = {
      dbPath,
      engine: config.engine,
      addonDir: config.addonDir,
      ftsPrefix: config.ftsPrefix,
      capBytes: config.indexCapBytes,
    };
    sampler.phase = 'init';
    const init = await core<{ uuid: string; info: unknown; limits: unknown }>({
      op: 'init',
      args: {
        runDir,
        target,
        poolSize: config.poolSize,
        oldGenMb: config.oldGenMb,
        indexCapBytes: config.indexCapBytes,
        phase1Batch: 1000,
        phase2Batch: 500,
        metaJob: 50,
        indexJobMs: 10_000,
        readerJobMs: 3_000,
        maxMessages: config.maxMessages,
      },
    });
    result.engine = init.info;
    result.indexLimits = init.limits;

    sampler.phase = 'phase1';
    const p1 = await timed<Record<string, unknown>>({ op: 'phase1' });
    result.phase1 = { ...p1.data, mainMs: p1.ms };
    if (p1.data.invalid) throw new Error(`invalid run: ${String(p1.data.invalid)}`);

    if (config.scenario !== 'stress') {
      const sample = await core<string[]>({
        op: 'sample',
        count: config.opens,
        maxBytes: OPEN_MAX_BYTES,
      });
      const search = async (mode: 'date' | 'relevance', pages: number) => {
        const out: number[][] = [];
        let after: unknown = null;
        for (let page = 0; page < pages; page++) {
          const r = await timed<{ next: unknown; rows: number }>({
            op: 'search',
            mode,
            term: config.term,
            after,
          });
          (out[page] ??= []).push(r.ms);
          after = r.data.next;
          if (after === null) break;
        }
        return out;
      };

      sampler.phase = 'phase2';
      const during = {
        searchDateP1: [] as number[],
        searchDateP2: [] as number[],
        open: [] as number[],
        list: [] as number[],
      };
      await core({ op: 'phase2-start' });
      let finished = false;
      const wait = timed<Record<string, unknown>>({ op: 'phase2-wait' }).then((r) => {
        finished = true;
        return r;
      });
      let k = 0;
      while (!finished) {
        const pages = await search('date', 2);
        if (pages[0]) during.searchDateP1.push(...pages[0]);
        if (pages[1]) during.searchDateP2.push(...pages[1]);
        const id = sample[k++ % Math.max(1, sample.length)];
        if (id) during.open.push((await timed({ op: 'open', protonId: id })).ms);
        during.list.push((await timed({ op: 'search', list: true, labelId: '5', after: null })).ms);
        await sleep(config.loadIntervalMs);
      }
      const p2 = await wait;
      if (p2.data.invalid) {
        result.phase2 = { invalid: p2.data.invalid, maxIndexBytes: p2.data.maxIndexBytes };
        result.totals = await core({ op: 'totals' });
        throw new Error(`invalid run: ${String(p2.data.invalid)}`);
      }
      result.phase2 = {
        ...p2.data,
        jobMs: summary(p2.data.jobMs as number[]),
        writerMs: summary(p2.data.writerMs as number[]),
        mainMs: p2.ms,
      };
      result.duringPhase2 = Object.fromEntries(
        Object.entries(during).map(([k2, v]) => [k2, summary(v)]),
      );
      result.mergeAll = await timed({ op: 'merge-all' });
      result.checkpoint = await core({ op: 'checkpoint' });
      result.totals = await core({ op: 'totals' });
      result.termMatches = await core({ op: 'search', count: true, term: config.term });

      sampler.phase = 'idle';
      await sleep(5000);
      result.memoryIdlePoolAlive = sampler.median('idle');
      result.threads = await core({ op: 'threads' });
      await core({ op: 'pool-stop' });
      sampler.phase = 'idle-settle';
      await sleep(3000);
      sampler.phase = 'idle-no-pool';
      await sleep(5000);
      result.memoryIdle = sampler.median('idle-no-pool');
      result.coreMemory = await core({ op: 'memory' });
      await core({ op: 'shrink' });
      sampler.phase = 'idle-shrink-settle';
      await sleep(3000);
      sampler.phase = 'idle-shrunk';
      await sleep(5000);
      result.memoryIdleShrunk = sampler.median('idle-shrunk');
      if (config.holdMs) {
        sampler.phase = 'hold';
        await sleep(config.holdMs);
      }

      sampler.phase = 'idle-queries';
      const idle: Record<string, number[]> = {};
      for (let rep = 0; rep < config.searchRepeats; rep++) {
        for (const mode of ['date', 'relevance'] as const) {
          const pages = await search(mode, 5);
          pages.forEach((ms, i) => {
            const key = `${mode}P${i === 0 ? '1' : i === 1 ? '2' : `${i + 1}`}`;
            (idle[key] ??= []).push(...ms);
          });
        }
        idle.list = [
          ...(idle.list ?? []),
          (await timed({ op: 'search', list: true, labelId: '5', after: null })).ms,
        ];
      }
      const opens: number[] = [];
      const openInWorker: number[] = [];
      for (const id of sample) {
        const r = await timed<{ ms: number }>({ op: 'open', protonId: id });
        opens.push(r.ms);
        openInWorker.push(r.data.ms);
      }
      result.idle = {
        ...Object.fromEntries(Object.entries(idle).map(([k2, v]) => [k2, summary(v)])),
        open: summary(opens),
        openInWorker: summary(openInWorker),
      };

      sampler.phase = 'large';
      const large: unknown[] = [];
      for (const part of config.large) {
        // Extraction first, on a fresh thread: its growth includes generating the
        // stream, with nothing measured before it in this core.
        const ext = await core({
          op: 'large',
          ...part,
          mode: 'extract',
          oldGenMb: config.oldGenMb,
        });
        const gen = await core({
          op: 'large',
          ...part,
          mode: 'generate',
          oldGenMb: config.oldGenMb,
        });
        large.push({ ...part, generateOnly: gen, extract: ext });
      }
      result.large = large;
    } else {
      result.totals = await core({ op: 'totals' });
      result.threads = await core({ op: 'threads' });
    }

    await core({ op: 'close' });
    if (config.reopens > 0) {
      sampler.phase = 'reopen';
      const reopens: unknown[] = [];
      for (let i = 0; i < config.reopens; i++) {
        ctx.core.stop();
        await waitCoreExit(ctx);
        const r = await timed<Record<string, unknown>>({ op: 'reopen', target, uuid: init.uuid });
        reopens.push({ ...r.data, mainMs: r.ms });
      }
      result.reopen = reopens;
    }

    if (config.quarantine) {
      sampler.phase = 'quarantine';
      // The runner reads the saved file's attribute afterwards, so it stays
      // outside the sandboxed build's workspace, which is removed at the end.
      const downloads = sandboxed ? join(userData, 'downloads') : join(workspace, 'downloads');
      if (sandboxed) mkdirSync(downloads, { recursive: true });
      else checkNewFile(workspace, config.nonce, join(downloads, `quarantine-${config.nonce}.bin`));
      result.quarantine = await quarantineCheck(downloads, config.nonce);
    }
    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = (err as Error).message;
  } finally {
    // An invalid or failed run leaves no index either.
    await core({ op: 'close' }).catch(() => undefined);
    if (dbPath) {
      for (const suffix of INDEX_SUFFIXES) {
        try {
          removeInside(workspace, config.nonce, dbPath + suffix);
        } catch (err) {
          result.cleanupError = (err as Error).message;
        }
      }
    }
    result.indexRemoved = dbPath !== '' && !INDEX_SUFFIXES.some((s) => existsSync(dbPath + s));
    sampler.stop();
    if (corpusRoot && ownWorkspace) {
      result.corpusBytes = dirBytes(corpusRoot);
      try {
        removeWorkspace(workspace, config.nonce);
      } catch (err) {
        result.cleanupError = (err as Error).message;
      }
      result.corpusRemoved = !existsSync(corpusRoot);
      result.workspaceRemoved = !existsSync(workspace);
    }
    result.memoryPeak = sampler.peak();
    result.memoryPeakPhase2 = sampler.peak(['phase2']);
    result.memoryPeakByPhase = Object.fromEntries(
      [...new Set(sampler.samples.map((s) => s.phase))].map((p) => [
        p,
        sampler.peak([p])?.mb ?? null,
      ]),
    );
    result.phaseLog = sampler.phaseLog;
    result.processTypes = sampler.types;
    result.finishedAt = new Date().toISOString();
    try {
      if (!sandboxed) checkNewFile(workspace, config.nonce, resultPath);
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    } catch {
      // No place for the result: the runner reports the run as failed.
    }
    app.quit();
  }
}

function dirBytes(root: string): number {
  let total = 0;
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
    } else total += st.size;
  };
  if (existsSync(root)) walk(root);
  return total;
}
