// SPDX-License-Identifier: AGPL-3.0-or-later
// Times message opens in the packaged test build, hidden, and writes a JSON
// and a markdown report.
//
//   node tools/bench/run-open-bench.mjs --corpus <folder> --manifest <file> --out <dir> [options]
//
//   --corpus <folder>   a generated corpus, read in place and never written
//   --manifest <file>   its manifest: the corpus must match it before and after
//   --out <dir>         a new folder for this run's files
//   --seed <n>          picks the sample (default 1); the same seed picks the same messages
//   --count <n>         messages in the sample (default 1000)
//   --max-bytes <n>     largest message file in the sample (default 1048576)
//   --runs <n>          app launches, each timing every message once (default 4)
//   --warmup <n>        untimed opens at the start of each launch (default 20)
//   --app <path>        the packaged test build (default: the one `npm run package:test` makes)
//
// Each open is timed in the shell renderer, from just before the open request
// to the body frame's load. The result is the median of the launches' p95s.
// The app runs with no export open, so no index work runs during the opens.
// Before the run, every sampled file is read once so that it is in the OS
// file cache. The frontmost app is sampled once a second throughout.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PRODUCT_NAME, appPath } from '../../scripts/package.mjs';
import { Random } from '../gen-export/random.mjs';
import { digest, diskBytes, walk } from '../gen-export/tree.mjs';
import { freeSpace, frontmost } from './run-bench.mjs';
import { checkNewFile, createWorkspace, removeInside } from './workspace.mjs';

/** The open target, in ms, for the median of the p95s. */
export const OPEN_P95_TARGET_MS = 150;
/** A launch that takes longer than this is stopped. */
const RUN_TIMEOUT_MS = 10 * 60_000;

/** The value at percentile p (nearest rank), or null for no values. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (ms) => (ms === null ? null : Math.round(ms * 10) / 10);

/**
 * The sample: `count` message files of at most `maxBytes`, picked with the
 * seed from the corpus entries (in their walk order), and listed in the
 * order they open.
 */
export function pickSample(entries, { seed, count, maxBytes }) {
  const pool = entries
    .filter((e) => e.type === 'file' && e.path.endsWith('.eml') && e.size <= maxBytes)
    .map((e) => ({ path: e.path, size: e.size }));
  if (pool.length < count) throw new Error(`only ${pool.length} messages fit; ${count} needed`);
  return new Random(`open-sample/${seed}`).shuffle(pool).slice(0, count);
}

/**
 * The corpus as its manifest describes it: entry count, bytes of the files,
 * bytes on disk and the content digest.
 */
export function corpusState(root, manifest) {
  const entries = walk(root);
  const now = {
    entries: entries.length,
    bytes: entries.filter((e) => e.type === 'file').reduce((sum, e) => sum + e.size, 0),
    disk_bytes: diskBytes(root),
    digest: digest(root),
  };
  const differs = Object.keys(now).filter((k) => now[k] !== manifest[k]);
  return { ...now, matches: differs.length === 0, differs };
}

/** One launch's numbers, from the opens the app recorded. */
export function summarizeRun(opens) {
  const ms = opens.filter((o) => o.outcome === 'view' && typeof o.ms === 'number').map((o) => o.ms);
  return {
    opens: opens.length,
    views: ms.length,
    fallbacks: opens.filter((o) => o.outcome === 'fallback').length,
    rejected: opens.filter((o) => o.outcome === 'rejected').length,
    timeouts: opens.filter((o) => o.outcome === 'timeout').map((o) => o.rowid),
    html: opens.filter((o) => o.format === 'html').length,
    plain: opens.filter((o) => o.format === 'plain').length,
    p50: round(percentile(ms, 50)),
    p95: round(percentile(ms, 95)),
    max: round(ms.length ? Math.max(...ms) : null),
  };
}

/**
 * The verdict over all launches. Every launch must open every message as a
 * view, or the run is invalid.
 */
export function verdict(runs, target = OPEN_P95_TARGET_MS) {
  const complete = runs.every((r) => r.summary && r.summary.views === r.summary.opens);
  const p95s = runs.map((r) => r.summary?.p95 ?? null);
  const value = complete && p95s.every((p) => p !== null) ? round(median(p95s)) : null;
  return {
    valid: complete && value !== null,
    medianP95: value,
    p95s,
    target,
    within: value !== null && value <= target,
  };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function machine() {
  const read = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    model: read('sysctl', ['-n', 'hw.model']),
    cpu: cpus()[0]?.model ?? null,
    cores: cpus().length,
    memoryBytes: totalmem(),
    macos: read('sw_vers', ['-productVersion']),
  };
}

export function markdown(report) {
  const v = report.verdict;
  const lines = [
    '# Open p95',
    '',
    `**Median of the p95s: ${v.medianP95 ?? 'n/a'} ms** (target ≤ ${v.target} ms): ${
      !v.valid ? 'INVALID RUN' : v.within ? 'within' : 'MISS'
    }.`,
    '',
    `- Start: ${report.events.start}.`,
    `- End: ${report.events.end}.`,
    `- Sample: ${report.sample.count} messages ≤ ${report.sample.maxBytes} B, seed ${report.sample.seed}, ` +
      `${report.sample.bytes} B in all (SHA-256 of the list ${report.sample.listSha256}).`,
    `- Launches: ${report.runs.length}, each with ${report.warmup} untimed opens first. ` +
      'No export was open, so no index work ran.',
    `- Opens start at least ${report.runs[0]?.paceMs ?? '?'} ms apart: Chromium drops a frame's ` +
      'navigations past 200 in 10 s.',
    `- Corpus before: ${report.corpus.before.matches ? 'matches' : 'DIFFERS FROM'} its manifest; ` +
      `after: ${report.corpus.after?.matches ? 'matches' : 'DIFFERS FROM'} it ` +
      `(digest ${report.corpus.after?.digest ?? 'n/a'}).`,
    `- Build: ${report.build.app}; executable SHA-256 ${report.build.executableSha256}, ` +
      `app.asar SHA-256 ${report.build.asarSha256}.`,
    `- Machine: ${report.machine.model}, ${report.machine.cpu}, ${report.machine.cores} cores, ` +
      `${Math.round(report.machine.memoryBytes / 2 ** 30)} GiB, macOS ${report.machine.macos}.`,
    `- Frontmost app, sampled once a second: ${Object.entries(report.frontmost)
      .map(([name, n]) => `${name} ${n}`)
      .join(', ')}.`,
    '',
    '| Launch | Views | Fallbacks | Refused | Timeouts | HTML | Plain | p50 ms | p95 ms | Max ms | Window hidden | Exit |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [i, r] of report.runs.entries()) {
    const s = r.summary;
    const hidden = r.window ? !r.window.visible && !r.window.focused : null;
    lines.push(
      `| ${i + 1} | ${s?.views ?? '-'}/${s?.opens ?? '-'} | ${s?.fallbacks ?? '-'} | ${
        s?.rejected ?? '-'
      } | ${s?.timeouts?.length ?? '-'} | ${s?.html ?? '-'} | ${s?.plain ?? '-'} | ${s?.p50 ?? '-'} | ${s?.p95 ?? '-'} | ${
        s?.max ?? '-'
      } | ${hidden ?? '-'} | ${r.exit.code ?? r.exit.signal ?? 'timeout'} |`,
    );
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const { values } = parseArgs({
    options: {
      corpus: { type: 'string' },
      manifest: { type: 'string' },
      out: { type: 'string' },
      seed: { type: 'string', default: '1' },
      count: { type: 'string', default: '1000' },
      'max-bytes': { type: 'string', default: '1048576' },
      runs: { type: 'string', default: '4' },
      warmup: { type: 'string', default: '20' },
      app: { type: 'string' },
    },
  });
  if (!values.corpus || !values.manifest || !values.out)
    throw new Error('--corpus, --manifest and --out are required');
  const int = (name) => {
    const n = Number(values[name]);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`);
    return n;
  };
  const seed = int('seed');
  const count = int('count');
  const maxBytes = int('max-bytes');
  const runCount = int('runs');
  const warmup = int('warmup');
  if (count < 1 || runCount < 1 || warmup > count) throw new Error('nothing to time');

  const corpus = realpathSync(resolve(values.corpus));
  const manifest = JSON.parse(readFileSync(resolve(values.manifest), 'utf8'));
  const out = resolve(values.out);
  if (!isAbsolute(out) || existsSync(out)) throw new Error(`${out} must be a new folder`);
  const app = resolve(values.app ?? appPath('test'));
  const executable = join(app, 'Contents', 'MacOS', PRODUCT_NAME);
  const asar = join(app, 'Contents', 'Resources', 'app.asar');
  if (!existsSync(executable) || !existsSync(asar)) throw new Error(`no packaged build at ${app}`);
  const disk = freeSpace(dirname(out));

  const before = corpusState(corpus, manifest);
  if (!before.matches) throw new Error(`the corpus differs from its manifest: ${before.differs}`);
  const sample = pickSample(walk(corpus), { seed, count, maxBytes });
  // Warm: each sampled file is read once, so the opens find it in the OS file cache.
  for (const { path } of sample) readFileSync(join(corpus, path));

  const nonce = randomBytes(8).toString('hex');
  createWorkspace(out, nonce, ['user-data']);
  const seen = new Map();
  const note = () => {
    const name = frontmost();
    seen.set(name, (seen.get(name) ?? 0) + 1);
  };
  note();
  const sampler = setInterval(note, 1000);
  const runs = [];
  try {
    for (let i = 1; i <= runCount; i++) {
      const runNonce = randomBytes(8).toString('hex');
      const workspace = join(out, `run-${i}`);
      createWorkspace(workspace, runNonce, []);
      const config = join(workspace, 'config.json');
      checkNewFile(workspace, runNonce, config);
      writeFileSync(
        config,
        JSON.stringify({
          nonce: runNonce,
          workspace,
          root: corpus,
          files: sample.map((s) => s.path),
          warmup,
        }) + '\n',
        { flag: 'wx' },
      );
      const userData = join(out, 'user-data', `run-${i}`);
      console.log(`open bench: launch ${i} of ${runCount}`);
      const started = Date.now();
      const exit = await new Promise((done) => {
        const child = spawn(
          executable,
          [`--pev-open-bench=${config}`, `--pev-user-data=${userData}`],
          { stdio: 'ignore' },
        );
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          done({ code: null, signal: null, timedOut: true });
        }, RUN_TIMEOUT_MS);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          done({ code, signal, timedOut: false });
        });
      });
      const resultFile = join(workspace, `open-result-${runNonce}.json`);
      const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
      const valid = result?.nonce === runNonce && result.ok === true;
      runs.push({
        wallMs: Date.now() - started,
        exit,
        ok: valid,
        error: valid ? null : (result?.error ?? 'no result'),
        idle: result?.idle ?? null,
        window: result?.window ?? null,
        app: result?.app ?? null,
        timedWallMs: result?.timedWallMs ?? null,
        paceMs: result?.paceMs ?? null,
        summary: valid ? summarizeRun(result.opens) : null,
        resultFile,
      });
      // The app's own profile (logs, caches) isn't kept; the result holds what counts.
      removeInside(out, nonce, userData);
    }
  } finally {
    clearInterval(sampler);
    note();
  }
  const after = corpusState(corpus, manifest);
  const list = sample.map((s) => s.path).join('\n') + '\n';
  const report = {
    nonce,
    events: {
      start: 'shell renderer, performance.now() just before window.pev.open(rowid, "html")',
      end: "the body frame's load event, after its src is set to the view's URL",
    },
    sample: {
      seed,
      count,
      maxBytes,
      bytes: sample.reduce((sum, s) => sum + s.size, 0),
      listSha256: createHash('sha256').update(list).digest('hex'),
    },
    warmup,
    corpus: { root: corpus, before, after },
    build: { app, executableSha256: sha256(executable), asarSha256: sha256(asar) },
    machine: machine(),
    disk,
    frontmost: Object.fromEntries(seen),
    runs,
    verdict: verdict(runs),
  };
  const jsonPath = join(out, `open-bench-${nonce}.json`);
  const mdPath = join(out, `open-bench-${nonce}.md`);
  checkNewFile(out, nonce, jsonPath);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  checkNewFile(out, nonce, mdPath);
  writeFileSync(mdPath, markdown(report), { flag: 'wx' });
  const listPath = join(out, `sample-${nonce}.txt`);
  checkNewFile(out, nonce, listPath);
  writeFileSync(listPath, list, { flag: 'wx' });
  console.log(`open bench: wrote ${jsonPath} and ${mdPath}`);
  console.log(
    `open bench: median p95 ${report.verdict.medianP95} ms (${report.verdict.p95s.join(', ')})`,
  );
  if (!after.matches) {
    console.error(`open bench: the corpus changed during the run: ${after.differs}`);
    process.exit(1);
  }
  if (!report.verdict.valid) {
    console.error('open bench: run invalid: a launch failed or a message did not open as a view');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`open bench: ${err.message}`);
    process.exit(1);
  });
}
