// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the index bench in a packaged test build, hidden, and keeps its result.
//
//   node tools/bench/run-bench.mjs --scenario perf|stress|sandbox --out <dir> [options]
//
//   --corpus <dir>      the export's run folder (mail_YYYYMMDD_HHMMSS), for perf and stress
//   --build test|mas-selftest   which packaged test build runs (default: test;
//                       sandbox always uses mas-selftest)
//   --engine node:sqlite|better-sqlite3   --addon <dir>  (better-sqlite3's package folder)
//   --pool <n>  --old-gen <MB>  --label <text>  --term <word>  --repeats <n>
//   --opens <n>  --reopens <n>  --large kind:bytes,…  --no-window  --no-quarantine
//   --warm-up           read every corpus file once first, so a warm run finds
//                       them in the OS file cache
//   --scan-data <dir>   a folder to search for generated test data (required, repeatable)
//   --index-cap <bytes> a lower index cap, to test the stop
//   --max-messages <n>  index only the first n messages (size analysis)
//   --fts-prefix "<list>"  the full-text prefix lengths (size analysis; "" for none)
//
// --out must be a new folder: the run creates it (a workspace marked with the
// run's nonce) and writes everything inside it, and removes only things inside
// it, never following links. Before the run it refuses when less than 20 GiB
// of disk is free, or when all generated test data it finds (under each
// --scan-data folder and in the app's containers; a folder it can't read
// fails the check) plus a full index and 50 MB for the run's
// other output would reach 1 GB. While the app runs, that other output is
// sampled once a second and the app is stopped once it passes its 50 MB. The
// app keeps the index (with -wal and -shm) under 300 MB and empties it when
// it's done; this script checks that it did.
// The frontmost app is sampled throughout, and the downloaded file's quarantine
// attribute is read here, outside the app.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { APP_ID, PRODUCT_NAME, appPath } from '../../scripts/package.mjs';
import {
  WORKSPACE_MARK,
  checkNewFile,
  createWorkspace,
  removeInside,
  removeWorkspace,
} from './workspace.mjs';

export const INDEX_CAP = 300 * 1000 * 1000;
/** Room kept for a run's other output: results, logs and the app's profile. */
export const TRANSIENT_RESERVE = 50 * 1000 * 1000;
/** All generated test data on this machine stays under this. */
export const TEST_DATA_LIMIT = 1000 * 1000 * 1000;
const PRUNE = new Set(['node_modules', '.git', 'dist', 'out', 'out-test', 'build']);
export const MIN_FREE = 20 * 2 ** 30;

const DEFAULT_LARGE = {
  perf: 'attachment:10000000,attachment:50000000,text:200000000,html:200000000',
  sandbox: '',
  stress: '',
};

export function parseLarge(spec) {
  if (!spec) return [];
  return spec.split(',').map((item) => {
    const [kind, bytes] = item.split(':');
    if (!['text', 'html', 'attachment'].includes(kind) || !/^\d+$/.test(bytes ?? ''))
      throw new Error(`bad --large item ${item}`);
    return { kind, bytes: Number(bytes) };
  });
}

/** A run label: lowercase letters, digits and dashes, so it can name a file. */
export const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function checkLabel(label) {
  if (typeof label !== 'string' || !LABEL.test(label))
    throw new Error('--label must be 1-32 lowercase letters, digits or dashes');
  return label;
}

/** The kept report's file name. Every part is checked, so it is a plain name. */
export function reportName(label, scenario, engine, pool, nonce) {
  checkLabel(label);
  if (!['perf', 'stress', 'sandbox'].includes(scenario))
    throw new Error(`bad scenario ${scenario}`);
  if (!['node:sqlite', 'better-sqlite3'].includes(engine)) throw new Error(`bad engine ${engine}`);
  if (!Number.isSafeInteger(pool) || pool < 1 || pool > 64) throw new Error(`bad pool ${pool}`);
  if (!/^[0-9a-f]{16}$/.test(nonce)) throw new Error('bad nonce');
  return `${label}-${scenario}-${engine.replace(':', '-')}-pool${pool}-${nonce}.json`;
}

/**
 * Every folder of generated test data under the scan roots: generator exports
 * (the folder next to each `<name>.manifest.json`), every `test-output/` folder
 * and every bench workspace (marked, or holding a run's config); plus the app's
 * container data. Nested finds are counted once.
 */
export function findTestData(scanRoots, { containers = [], maxDepth = 6 } = {}) {
  const found = new Set();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Fails closed: data that can't be counted could push the total over.
      throw new Error(`can't read ${dir} to count test data (${err.code ?? err.message})`, {
        cause: err,
      });
    }
    // A bench workspace: marked by the runner (every scenario), or an older
    // output folder holding a run's config.
    if (
      entries.some(
        (e) =>
          e.isFile() && (e.name === WORKSPACE_MARK || /^config-[0-9a-f]{16}\.json$/.test(e.name)),
      )
    ) {
      found.add(dir);
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.manifest.json')) {
        const exported = path.slice(0, -'.manifest.json'.length);
        if (existsSync(exported)) found.add(exported);
      } else if (e.isDirectory() && !e.isSymbolicLink()) {
        if (e.name === 'test-output') found.add(path);
        else if (!PRUNE.has(e.name) && depth < maxDepth) walk(path, depth + 1);
      }
    }
  };
  for (const root of scanRoots) walk(root, 0);
  for (const c of containers) if (existsSync(c)) found.add(c);
  const sorted = [...found].sort();
  return sorted.filter((p) => !sorted.some((q) => q !== p && p.startsWith(q + '/')));
}

/** Allocated bytes on disk of a folder, as du counts them; fails closed if it can't read it all. */
export function diskBytes(path) {
  const out = execFileSync('du', ['-sk', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return Number(out.split('\t')[0]) * 1024;
}

/**
 * Refuses to start unless all test data, plus a full index and the run's other
 * output (results, logs, the app's profile), stays under the limit.
 */
export function budgetCheck(folders, indexCap = INDEX_CAP, measure = diskBytes) {
  const parts = folders.map((path) => ({ path, bytes: measure(path) }));
  const total = parts.reduce((n, p) => n + p.bytes, 0);
  const reserved = indexCap + TRANSIENT_RESERVE;
  if (total + reserved >= TEST_DATA_LIMIT)
    throw new Error(
      `test data is ${total} B; with ${reserved} B reserved for this run it would pass ${TEST_DATA_LIMIT} B`,
    );
  return { total, reserved, withRun: total + reserved, limit: TEST_DATA_LIMIT, parts };
}

/**
 * Allocated bytes of everything under `root`, as the disk counts them, without
 * following links and leaving out the folders in `skip`. A file that goes away
 * while it's counted is left out; any other read error throws.
 */
export function treeBytes(root, skip = []) {
  let total = 0;
  const walk = (path) => {
    if (skip.includes(path)) return;
    let stat;
    let names = [];
    try {
      stat = lstatSync(path);
      if (stat.isDirectory()) names = readdirSync(path);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    total += stat.blocks * 512;
    for (const name of names) walk(join(path, name));
  };
  walk(root);
  return total;
}

/**
 * Samples a run's other output against its reserve: each sample measures it
 * (growth over `baseline`), and the first sample past `limit`, or one that
 * can't be measured, returns false so the runner stops the app. Between two
 * samples the output isn't watched.
 */
export function watchTransient(measure, { limit = TRANSIENT_RESERVE, baseline = 0 } = {}) {
  const record = {
    limitBytes: limit,
    baselineBytes: baseline,
    peakBytes: 0,
    samples: 0,
    exceeded: null,
  };
  const sample = () => {
    if (record.exceeded) return false;
    let grown;
    try {
      grown = measure() - baseline;
    } catch (err) {
      record.exceeded = `can't measure the run's other output (${err.code ?? err.message})`;
      return false;
    }
    record.samples += 1;
    record.peakBytes = Math.max(record.peakBytes, grown);
    if (grown > limit) {
      record.exceeded = `the run's other output reached ${grown} B, past the ${limit} B reserved`;
      return false;
    }
    return true;
  };
  return { record, sample };
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Refuses to start when less than 20 GiB of disk would stay free. */
export function freeSpace(dir) {
  const fs = statfsSync(dir);
  const free = fs.bavail * fs.bsize;
  if (free < MIN_FREE)
    throw new Error(`only ${(free / 2 ** 30).toFixed(1)} GiB free; 20 GiB needed`);
  return { freeBytes: free };
}

/** Removes one file of this run from the app's container: a regular file named with the nonce. */
export function removeContainerFile(folder, file, nonce) {
  if (dirname(file) !== folder || !basename(file).includes(nonce)) return false;
  if (realpathSync(folder) !== folder) throw new Error(`${folder} is reached through a link`);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  rmSync(file);
  return true;
}

/** The name of the frontmost app, or null if it can't be read. */
export function frontmost() {
  try {
    const front = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    const info = execFileSync('lsappinfo', ['info', '-only', 'name', front], { encoding: 'utf8' });
    return /"LSDisplayName"="(.*)"/.exec(info)?.[1] ?? info.trim();
  } catch {
    return null;
  }
}

/** The app's processes: the one the runner started and every process it started. */
function processTree(root) {
  const pids = [root];
  for (let i = 0; i < pids.length; i++) {
    try {
      const kids = execFileSync('pgrep', ['-P', String(pids[i])], { encoding: 'utf8' });
      for (const line of kids.split('\n'))
        if (/^\d+$/.test(line.trim())) pids.push(Number(line.trim()));
    } catch {
      // pgrep exits 1 when a process has no children.
    }
  }
  return pids;
}

/**
 * Each process's physical footprint (the memory Activity Monitor shows), in
 * bytes. Resident sizes count shared framework pages in every process, so
 * their sum overstates what the app uses.
 */
export function parseFootprint(text) {
  const out = [];
  for (const m of text.matchAll(
    /^(.+?) \[(\d+)\]: .*?Footprint: (\d+) B[\s\S]*?phys_footprint: (\d+) B\s+phys_footprint_peak: (\d+) B/gm,
  )) {
    out.push({ name: m[1], pid: Number(m[2]), bytes: Number(m[4]), peakBytes: Number(m[5]) });
  }
  return out;
}

function footprintOf(root) {
  try {
    const text = execFileSync(
      'footprint',
      ['-f', 'bytes', '--noCategories', ...processTree(root).map(String)],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const procs = parseFootprint(text);
    return { at: Date.now(), totalBytes: procs.reduce((n, p) => n + p.bytes, 0), procs };
  } catch {
    return null;
  }
}

/** Footprint samples matched to the app's phases: the peak of each phase, and the idle median. */
export function footprintByPhase(samples, phaseLog, types = {}) {
  const phaseAt = (at) => {
    let name = null;
    for (const p of phaseLog) if (p.at <= at) name = p.phase;
    return name;
  };
  const byPhase = {};
  for (const s of samples) {
    const name = phaseAt(s.at);
    if (name) (byPhase[name] ??= []).push(s.totalBytes);
  }
  const mib = (b) => Math.round((b / 2 ** 20) * 10) / 10;
  const peak = (names) => {
    const v = names.flatMap((n) => byPhase[n] ?? []);
    return v.length ? mib(Math.max(...v)) : null;
  };
  const median = (name) => {
    const v = [...(byPhase[name] ?? [])].sort((a, b) => a - b);
    return v.length ? mib(v[Math.floor(v.length / 2)]) : null;
  };
  /** Each process's median footprint in one phase, so idle memory can be attributed. */
  const byProcess = (phase) => {
    const per = new Map();
    for (const s of samples) {
      if (phaseAt(s.at) !== phase) continue;
      for (const p of s.procs ?? []) {
        const e = per.get(p.pid) ?? { name: types[p.pid] ?? p.name, values: [] };
        e.values.push(p.bytes);
        per.set(p.pid, e);
      }
    }
    return [...per.values()].map((e) => {
      const v = e.values.sort((a, b) => a - b);
      return { name: e.name, mib: mib(v[Math.floor(v.length / 2)]) };
    });
  };
  return {
    unit: 'MiB',
    samples: samples.length,
    idleByProcess: byProcess('idle-no-pool'),
    idleShrunkByProcess: byProcess('idle-shrunk'),
    peakByPhase: Object.fromEntries(Object.keys(byPhase).map((n) => [n, peak([n])])),
    peakPhase2: peak(['phase2']),
    peak: peak(Object.keys(byPhase)),
    idle: median('idle-no-pool'),
    idlePoolAlive: median('idle'),
    idleShrunk: median('idle-shrunk'),
  };
}

function quarantineOf(file) {
  if (!file || !existsSync(file)) return { present: false, value: null, file: Boolean(file) };
  try {
    const value = execFileSync('xattr', ['-p', 'com.apple.quarantine', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { present: true, value };
  } catch {
    return { present: false, value: null };
  }
}

function sha256(file) {
  return execFileSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).split(' ')[0];
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'perf' },
      corpus: { type: 'string' },
      out: { type: 'string' },
      build: { type: 'string', default: 'test' },
      engine: { type: 'string', default: 'node:sqlite' },
      addon: { type: 'string' },
      pool: { type: 'string', default: '4' },
      'old-gen': { type: 'string', default: '512' },
      label: { type: 'string', default: 'warm' },
      term: { type: 'string', default: 'check' },
      repeats: { type: 'string', default: '20' },
      opens: { type: 'string', default: '200' },
      reopens: { type: 'string', default: '3' },
      large: { type: 'string' },
      'interval-ms': { type: 'string', default: '20' },
      'max-messages': { type: 'string' },
      'fts-prefix': { type: 'string' },
      'hold-ms': { type: 'string' },
      'index-cap': { type: 'string' },
      'scan-data': { type: 'string', multiple: true },
      'timeout-min': { type: 'string', default: '40' },
      'no-window': { type: 'boolean', default: false },
      'no-quarantine': { type: 'boolean', default: false },
      'warm-up': { type: 'boolean', default: false },
    },
  });
  const scenario = values.scenario;
  if (!['perf', 'stress', 'sandbox'].includes(scenario))
    throw new Error('--scenario perf|stress|sandbox');
  if (!values.out || !isAbsolute(values.out)) throw new Error('--out needs an absolute folder');
  const sandbox = scenario === 'sandbox';
  if (!sandbox && (!values.corpus || !isAbsolute(values.corpus)))
    throw new Error('--corpus needs the absolute path of a run folder');
  if (values.engine === 'better-sqlite3' && (!values.addon || !isAbsolute(values.addon)))
    throw new Error('--addon needs the absolute path of the better-sqlite3 package');
  if (sandbox && values.engine !== 'node:sqlite')
    throw new Error('the sandboxed check runs node:sqlite');

  const out = values.out;
  if (resolve(out) !== out) throw new Error('--out must be a normalized absolute path');
  // The kept report's name is built from these, so they are checked before anything runs.
  reportName(values.label, scenario, values.engine, Number(values.pool), '0'.repeat(16));
  if (!values['scan-data']?.length)
    throw new Error('--scan-data is required: the folders where generated test data lives');
  const indexDir = join(out, 'index');
  const disk = freeSpace(dirname(out));
  const indexCap = values['index-cap'] ? Number(values['index-cap']) : INDEX_CAP;
  if (!Number.isSafeInteger(indexCap) || indexCap <= 0 || indexCap > INDEX_CAP)
    throw new Error(`--index-cap must be a whole number up to ${INDEX_CAP}`);
  const containersRoot = join(homedir(), 'Library', 'Containers');
  const containers = existsSync(containersRoot)
    ? readdirSync(containersRoot)
        .filter((name) => name === APP_ID || name.startsWith(`${APP_ID}.`))
        .map((name) =>
          join(containersRoot, name, 'Data', 'Library', 'Application Support', PRODUCT_NAME),
        )
    : [];
  const budget = budgetCheck(findTestData(values['scan-data'], { containers }), indexCap);

  const build = sandbox ? 'mas-selftest' : values.build;
  const app = appPath(build);
  const executable = join(app, 'Contents', 'MacOS', PRODUCT_NAME);
  if (!existsSync(executable)) throw new Error(`${app} is missing; package it first`);

  let warmUp = null;
  if (values['warm-up'] && !sandbox) {
    const t0 = Date.now();
    let bytes = 0;
    for (const name of readdirSync(values.corpus))
      bytes += readFileSync(join(values.corpus, name)).length;
    warmUp = { bytes, ms: Date.now() - t0 };
  }

  const nonce = randomBytes(8).toString('hex');
  // The run's own folder, made fresh: every file the run writes goes inside it.
  createWorkspace(out, nonce);
  const userData = join(out, 'user-data');
  const resultPath = join(out, `result-${nonce}.json`);
  const config = {
    nonce,
    scenario,
    label: values.label,
    engine: values.engine,
    addonDir: values.addon,
    poolSize: Number(values.pool),
    oldGenMb: Number(values['old-gen']),
    indexCapBytes: indexCap,
    term: values.term,
    searchRepeats: Number(values.repeats),
    opens: Number(values.opens),
    loadIntervalMs: Number(values['interval-ms']),
    large: parseLarge(values.large ?? DEFAULT_LARGE[scenario]),
    reopens: Number(values.reopens),
    quarantine: !values['no-quarantine'],
    window: !values['no-window'],
    ...(values['max-messages'] ? { maxMessages: Number(values['max-messages']) } : {}),
    ...(values['fts-prefix'] !== undefined ? { ftsPrefix: values['fts-prefix'] } : {}),
    ...(values['hold-ms'] ? { holdMs: Number(values['hold-ms']) } : {}),
    ...(sandbox ? {} : { runDir: values.corpus, workspace: out }),
  };
  const args = sandbox
    ? [`--pev-bench-inline=${Buffer.from(JSON.stringify(config)).toString('base64url')}`]
    : [`--pev-bench=${join(out, `config-${nonce}.json`)}`, `--pev-user-data=${userData}`];
  if (!sandbox)
    writeFileSync(
      checkNewFile(out, nonce, join(out, `config-${nonce}.json`)),
      JSON.stringify(config, null, 2) + '\n',
      { flag: 'wx' },
    );

  // The run's output other than the index is sampled once a second while the
  // app runs, and the app is stopped once it passes its reserve: the workspace
  // without index/, or, for the sandboxed build, what its container grows by,
  // without that workspace's index/.
  const containerData = join(homedir(), 'Library', 'Containers', APP_ID, 'Data');
  const appSupport = join(containerData, 'Library', 'Application Support', PRODUCT_NAME);
  const measureTransient = sandbox
    ? () => treeBytes(containerData, [join(appSupport, `bench-${nonce}`, 'index')])
    : () => treeBytes(out, [indexDir]);
  const transient = watchTransient(measureTransient, {
    baseline: sandbox ? measureTransient() : 0,
  });

  const seen = new Map();
  const note = () => {
    const name = frontmost();
    seen.set(name, (seen.get(name) ?? 0) + 1);
  };
  note();
  const sampler = setInterval(note, 1000);
  const footprints = [];
  let footprintTimer = null;
  let transientTimer = null;
  const started = Date.now();
  console.log(
    `bench: ${scenario} ${values.label} ${values.engine} pool ${config.poolSize} (${build}), nonce ${nonce}`,
  );
  const exit = await new Promise((done) => {
    const child = spawn(executable, args, { stdio: 'ignore' });
    footprintTimer = setInterval(() => {
      const s = footprintOf(child.pid);
      if (s) footprints.push(s);
    }, 500);
    transientTimer = setInterval(() => {
      if (!transient.sample()) child.kill('SIGKILL');
    }, 1000);
    const timer = setTimeout(
      () => {
        child.kill('SIGKILL');
        done({ code: null, timedOut: true });
      },
      Number(values['timeout-min']) * 60_000,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, timedOut: false, stopped: transient.record.exceeded });
    });
  });
  clearInterval(sampler);
  clearInterval(footprintTimer);
  clearInterval(transientTimer);
  note();
  // Once more after the app quit, for what it wrote last.
  transient.sample();

  const resultFile = sandbox ? join(appSupport, `bench-result-${nonce}.json`) : resultPath;
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
  // Anything left in the run's index folder is the run's own; links are removed, never followed.
  const leftover = sandbox ? [] : readdirSync(indexDir);
  for (const name of leftover) removeInside(out, nonce, join(indexDir, name));
  const downloaded = result?.quarantine?.path ?? null;
  const report = {
    runner: {
      nonce,
      scenario,
      build,
      app,
      appExecutableSha256: sha256(executable),
      addonSha256: values.addon
        ? sha256(join(values.addon, 'prebuilds', `${process.platform}-${process.arch}.node`))
        : null,
      wallMs: Date.now() - started,
      exit,
      frontmost: Object.fromEntries(seen),
      disk,
      budget,
      warmUp,
      indexLeftover: leftover,
      transient: transient.record,
      quarantine: quarantineOf(downloaded),
      footprint: result?.phaseLog
        ? footprintByPhase(footprints, result.phaseLog, result.processTypes ?? {})
        : null,
      footprintPeakByProcess: footprints.length
        ? Object.values(
            Object.fromEntries(
              footprints
                .flatMap((s) => s.procs)
                .map((p) => [
                  p.pid,
                  {
                    name: result?.processTypes?.[p.pid] ?? p.name,
                    peakMiB: Math.round(p.peakBytes / 2 ** 20),
                  },
                ]),
            ),
          )
        : null,
    },
    result: result?.nonce === nonce ? result : null,
  };
  // The app's own profile (logs, caches) isn't kept; the result holds what counts.
  if (!sandbox) removeInside(out, nonce, userData);
  if (sandbox) {
    // The result and the download's own folder (marked with the nonce, the
    // saved file inside) are this run's only things left in the container.
    removeContainerFile(appSupport, resultFile, nonce);
    const downloadFolder = join(appSupport, `bench-download-${nonce}`);
    if (lstatOrNull(downloadFolder)) removeWorkspace(downloadFolder, nonce);
  }
  const reportPath = join(
    out,
    reportName(values.label, scenario, values.engine, config.poolSize, nonce),
  );
  // A new file, directly inside this run's workspace: never one that already exists.
  checkNewFile(out, nonce, reportPath);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`bench: wrote ${reportPath}`);
  if (transient.record.exceeded) {
    console.error(`bench: run stopped: ${transient.record.exceeded}`);
    process.exit(1);
  }
  if (!report.result?.ok) {
    console.error(`bench: run failed: ${report.result?.error ?? 'no result'}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`bench: ${err.message}`);
    process.exit(1);
  });
}
