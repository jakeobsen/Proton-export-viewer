// SPDX-License-Identifier: AGPL-3.0-or-later
// Turns the bench runner's result files into one JSON summary and a markdown
// report. Each number is mapped to its performance target and says whether it
// was measured at the bench corpus size or extrapolated linearly to 200k.
//
//   node tools/bench/report.mjs --primary <file> [--primary <file> …]
//        [--stress <file>] [--engine <file> [--engine-base <file>]] [--pool <file> …]
//        [--sandbox <file>] [--manifest <file>] [--size <file> …] [--export-messages <n>]
//        [--deferred <label>] --json <out.json> --md <out.md>
//
// --primary: runs of the chosen configuration (node:sqlite, the chosen pool);
// with several, each number is the median across runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const TARGET_MESSAGES = 200_000;

/**
 * The performance targets, in milliseconds or megabytes (MB = 10^6 bytes
 * throughout). `cold` targets need a purged OS file cache; a run with a warm
 * cache shows its value but leaves the verdict pending.
 */
export const TARGETS = {
  firstRows: {
    label: 'Cold: first rows visible',
    limit: 3000,
    unit: 'ms',
    basis: 'measured',
    cold: true,
  },
  phase1: {
    label: 'Cold: phase 1 complete (grouping included)',
    limit: 40_000,
    unit: 'ms',
    basis: 'extrapolated',
    cold: true,
  },
  phase2: { label: 'Phase 2 complete', limit: 20 * 60_000, unit: 'ms', basis: 'extrapolated' },
  reopen: { label: 'Warm reopen to a usable list', limit: 2000, unit: 'ms', basis: 'measured' },
  searchIdle: { label: 'Search p95, idle', limit: 100, unit: 'ms', basis: 'at bench size' },
  searchBusy: {
    label: 'Search p95, during phase 2',
    limit: 250,
    unit: 'ms',
    basis: 'at bench size',
  },
  openIdle: {
    label: 'Open message p95 (≤ 1 MB), idle',
    limit: 150,
    unit: 'ms',
    basis: 'at bench size',
  },
  openBusy: {
    label: 'Open message p95 (≤ 1 MB), during phase 2',
    limit: 250,
    unit: 'ms',
    basis: 'at bench size',
  },
  memoryIdle: {
    label: 'Memory, idle after indexing (all processes, summed physical footprint)',
    limit: 500,
    unit: 'MB',
    basis: 'at bench size',
  },
  memoryPeak: {
    label: 'Peak memory, phase 2 + reading (all processes, summed physical footprint)',
    limit: 1500,
    unit: 'MB',
    basis: 'at bench size',
  },
};

const median = (values) => {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const fmt = (x, unit) =>
  x === null || x === undefined ? 'n/a' : `${r1(x).toLocaleString('en-US')} ${unit}`;

function load(file) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (!doc.result?.ok)
    throw new Error(`${file}: the run did not finish (${doc.result?.error ?? 'no result'})`);
  return { file, ...doc };
}

const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** The settings that decide what a run measures; runs compared side by side share them. */
export const WORKLOAD = [
  'term',
  'searchRepeats',
  'opens',
  'reopens',
  'large',
  'window',
  'quarantine',
  'loadIntervalMs',
  'oldGenMb',
  'indexCapBytes',
];

/**
 * The settings that decide what a comparison row measures (indexing, search,
 * open and memory during indexing). Reopens, large parts and the quarantine
 * check all run after those are measured.
 */
export const COMPARISON_WORKLOAD = WORKLOAD.filter(
  (k) => !['reopens', 'large', 'quarantine'].includes(k),
);

/**
 * Throws unless every run measured the same thing: the same scenario, corpus
 * size, workload, label and (for the primary runs) engine and pool.
 */
export function checkCompatible(
  docs,
  { sameEngine = true, sameLabel = true, workload = WORKLOAD } = {},
) {
  if (docs.length === 0) throw new Error('no runs');
  const base = docs[0].result;
  for (const doc of docs) {
    const r = doc.result;
    const name = doc.file ?? 'a run';
    if (r.scenario !== 'perf') throw new Error(`${name}: scenario ${r.scenario}, not perf`);
    if (r.phase1?.pairs !== base.phase1?.pairs)
      throw new Error(`${name}: ${r.phase1?.pairs} messages, not ${base.phase1?.pairs}`);
    if (r.config?.maxMessages || r.config?.ftsPrefix !== undefined)
      throw new Error(`${name}: a size-analysis run, not a full one`);
    for (const key of workload)
      if (JSON.stringify(r.config?.[key]) !== JSON.stringify(base.config?.[key]))
        throw new Error(
          `${name}: ${key} ${JSON.stringify(r.config?.[key])}, not ${JSON.stringify(base.config?.[key])}`,
        );
    if (sameLabel && r.label !== base.label)
      throw new Error(`${name}: label ${r.label}, not ${base.label}`);
    if (
      sameEngine &&
      (r.engine?.engine !== base.engine?.engine || r.config?.poolSize !== base.config?.poolSize)
    )
      throw new Error(`${name}: a different engine or pool`);
  }
  return docs;
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** Single measurements every full run has, each a finite number. */
const NUMBERS = [
  'phase1.firstRowsMs',
  'phase1.phase1Ms',
  'phase2.ms',
  'memoryIdle.mb',
  'totals.size.pages',
  'totals.size.pageSize',
];
/** Latency summaries every full run has, each with samples. */
const SUMMARIES = [
  'idle.dateP1',
  'idle.dateP2',
  'idle.relevanceP1',
  'idle.relevanceP2',
  'idle.open',
  'idle.list',
  'duringPhase2.searchDateP1',
  'duringPhase2.searchDateP2',
  'duringPhase2.open',
  'phase2.writerMs',
  'phase2.jobMs',
];
const RUNNER_NUMBERS = ['footprint.peakPhase2', 'footprint.idle', 'footprint.samples'];

function checkSummary(name, field, s) {
  if (!s || !finite(s.n) || s.n <= 0) throw new Error(`${name}: ${field} has no samples`);
  for (const k of ['p50', 'p95', 'max'])
    if (!finite(s[k])) throw new Error(`${name}: ${field}.${k} is not a finite number`);
}

/**
 * Throws unless the run finished cleanly: the runner saw the app exit 0
 * without a timeout or a stop, and the index was removed with no cleanup
 * error. `transient` also requires the record that the run's other output
 * stayed within its reserve.
 */
export function checkClean(doc, { transient = true } = {}) {
  const r = doc.result;
  const name = doc.file ?? 'a run';
  const exit = doc.runner?.exit;
  if (!exit || exit.code !== 0 || exit.timedOut || exit.stopped)
    throw new Error(`${name}: the app did not exit cleanly (${JSON.stringify(exit ?? null)})`);
  if (r.indexRemoved !== true) throw new Error(`${name}: the index was not removed`);
  if (r.cleanupError) throw new Error(`${name}: cleanup failed (${r.cleanupError})`);
  if ((doc.runner.indexLeftover ?? []).length > 0)
    throw new Error(`${name}: the index folder was not empty after the run`);
  if (transient) {
    const t = doc.runner.transient;
    if (!t || !finite(t.samples) || t.samples <= 0)
      throw new Error(`${name}: the run's other output was not watched`);
    if (t.exceeded) throw new Error(`${name}: ${t.exceeded}`);
  }
  return doc;
}

/**
 * Throws unless each run finished cleanly and measured everything the report
 * uses: every number is finite and every summary has samples; for a primary
 * run (`full`) also the term's match count, and every reopen and large part
 * configured.
 */
export function checkComplete(docs, { transient = true, full = true } = {}) {
  for (const doc of docs) {
    const r = doc.result;
    const name = doc.file ?? 'a run';
    checkClean(doc, { transient });
    for (const field of NUMBERS)
      if (!finite(at(r, field))) throw new Error(`${name}: ${field} is missing or not finite`);
    for (const field of RUNNER_NUMBERS)
      if (!finite(at(doc.runner, field)))
        throw new Error(`${name}: runner ${field} is missing or not finite`);
    if (doc.runner.footprint.samples <= 0) throw new Error(`${name}: no footprint samples`);
    for (const field of SUMMARIES) checkSummary(name, field, at(r, field));
    // Any other summary taken must have samples too.
    for (const group of ['idle', 'duringPhase2'])
      for (const [key, s] of Object.entries(r[group] ?? {}))
        checkSummary(name, `${group}.${key}`, s);
    if (!full) continue;
    if (!finite(r.termMatches)) throw new Error(`${name}: termMatches is missing or not finite`);
    const reopens = r.reopen ?? [];
    if (!Array.isArray(r.reopen) || reopens.length === 0 || reopens.length !== r.config?.reopens)
      throw new Error(`${name}: reopen has ${reopens.length} of ${r.config?.reopens} measurements`);
    for (const x of reopens)
      if (!finite(x?.mainMs)) throw new Error(`${name}: a reopen time is not finite`);
    const large = r.large ?? [];
    const planned = r.config?.large ?? [];
    if (!Array.isArray(r.large) || large.length === 0 || large.length !== planned.length)
      throw new Error(`${name}: large has ${large.length} of ${planned.length} parts`);
    for (const [i, l] of large.entries()) {
      if (l?.kind !== planned[i]?.kind || l?.bytes !== planned[i]?.bytes)
        throw new Error(`${name}: large part ${i} is not the one configured`);
      if (!finite(l.extract?.ms) || !finite(l.extract?.rssGrowth))
        throw new Error(`${name}: large part ${i} was not measured`);
    }
  }
  return docs;
}

/** The large parts' extraction time, which the phase 2 extrapolation adds once. */
function largeMs(result) {
  return (result.large ?? []).reduce((n, l) => n + (l.extract?.ms ?? 0), 0);
}

/** The numbers of one primary run. */
export function metricsOf(doc) {
  const r = doc.result;
  const messages = r.phase1.pairs;
  const scale = TARGET_MESSAGES / messages;
  const idle = r.idle ?? {};
  const busy = r.duringPhase2 ?? {};
  const p95 = (s) => s?.p95 ?? null;
  const worst = (...xs) => {
    const v = xs.filter((x) => typeof x === 'number');
    return v.length ? Math.max(...v) : null;
  };
  return {
    messages,
    firstRows: r.phase1.firstRowsMs,
    phase1Measured: r.phase1.phase1Ms,
    phase1: r.phase1.phase1Ms * scale,
    phase2Measured: r.phase2?.ms ?? null,
    largeMs: largeMs(r),
    phase2: r.phase2 ? r.phase2.ms * scale + largeMs(r) : null,
    reopen: worst(...(r.reopen ?? []).map((x) => x.mainMs)),
    searchIdle: worst(
      p95(idle.dateP1),
      p95(idle.dateP2),
      p95(idle.relevanceP1),
      p95(idle.relevanceP2),
    ),
    searchIdleParts: {
      dateP1: p95(idle.dateP1),
      dateP2: p95(idle.dateP2),
      dateDeep: p95(idle.dateP5 ?? idle.dateP4 ?? idle.dateP3),
      relevanceP1: p95(idle.relevanceP1),
      relevanceP2: p95(idle.relevanceP2),
      relevanceDeep: p95(idle.relevanceP5 ?? idle.relevanceP4 ?? idle.relevanceP3),
      list: p95(idle.list),
    },
    searchBusy: worst(p95(busy.searchDateP1), p95(busy.searchDateP2)),
    searchBusyParts: {
      dateP1: p95(busy.searchDateP1),
      dateP2: p95(busy.searchDateP2),
      list: p95(busy.list),
    },
    searchBusySamples: busy.searchDateP1?.n ?? 0,
    openIdle: p95(idle.open),
    openBusy: p95(busy.open),
    openBusySamples: busy.open?.n ?? 0,
    // Memory targets compare the summed physical footprint; summed RSS is
    // given too. MiB from the samplers become MB (10^6 bytes) here.
    memoryIdle: toMb(doc.runner.footprint?.idle),
    memoryIdlePoolAlive: toMb(doc.runner.footprint?.idlePoolAlive),
    memoryIdleShrunk: toMb(doc.runner.footprint?.idleShrunk),
    rssIdleShrunk: toMb(r.memoryIdleShrunk?.mb),
    memoryPeak: toMb(doc.runner.footprint?.peakPhase2),
    rssIdle: toMb(r.memoryIdle?.mb),
    rssPeak: toMb(r.memoryPeakPhase2?.mb),
    memoryPeakByType: r.memoryPeakPhase2?.byTypeMb ?? null,
    peakWalBytes: r.totals?.wal?.peakWalBytes ?? null,
    peakFamilyBytes: r.phase2?.peakFamilyBytes ?? r.phase1?.peakFamilyBytes ?? null,
  };
}

const toMb = (mib) => (typeof mib === 'number' ? (mib * 2 ** 20) / 1e6 : null);

/** The index's size per message, and the same rate at another message count. */
export function indexSize(totals, messages, at = []) {
  const s = totals?.size;
  if (!s) return null;
  const db = s.pages * s.pageSize;
  const per = db / messages;
  return {
    messages,
    dbBytes: db,
    walBytesAtEnd: s.walBytes,
    perMessage: {
      total: per,
      bodyText: s.bodyTextBytes / messages,
      fts: s.ftsDataBytes / messages,
      otherText: s.otherTextBytes / messages,
      rest: (db - s.bodyTextBytes - s.ftsDataBytes - s.otherTextBytes) / messages,
    },
    extrapolated: Object.fromEntries(at.map((n) => [n, per * n])),
  };
}

function combine(list) {
  const keys = Object.keys(list[0]);
  const out = {};
  for (const k of keys) {
    if (typeof list[0][k] === 'number' || list[0][k] === null)
      out[k] = median(list.map((m) => m[k]));
    else if (
      list[0][k] &&
      typeof list[0][k] === 'object' &&
      !Array.isArray(list[0][k]) &&
      k !== 'memoryPeakByType'
    )
      out[k] = combine(list.map((m) => m[k]));
    else out[k] = list[0][k];
  }
  return out;
}

function verdict(value, limit, { cold = false, label = '' } = {}) {
  if (value === null || value === undefined) return 'not measured';
  const result = value <= limit ? 'within' : 'OVER';
  // A cold target can't be decided by a warm run.
  if (cold && label !== 'cold') return `pending cold run (warm value ${result})`;
  return result;
}

function stressOf(doc) {
  const p = doc.result.phase1;
  const batches = [...p.batches].sort((a, b) => a.committedMs - b.committedMs);
  const ms = batches.map((b) => b.ms);
  const sorted = [...ms].sort((a, b) => a - b);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const last = batches.at(-1);
  return {
    messages: p.pairs,
    phase1Ms: p.phase1Ms,
    batches: batches.length,
    batchMs: { p50: pct(0.5), p95: pct(0.95), max: Math.max(...ms) },
    repointed: {
      messages: batches.reduce((n, b) => n + b.repointedMessages, 0),
      keys: batches.reduce((n, b) => n + b.repointedKeys, 0),
      labelRows: batches.reduce((n, b) => n + b.repointedLabelRows, 0),
      merges: batches.reduce((n, b) => n + b.merges, 0),
      maxMessagesInOneBatch: Math.max(...batches.map((b) => b.repointedMessages)),
    },
    lastBatch: last,
    lateMerge: last?.bigMerges?.at(-1) ?? null,
    totals: p.totals,
  };
}

function engineRow(doc) {
  const r = doc.result;
  const m = metricsOf(doc);
  return {
    engine: r.engine.engine,
    sqlite: r.engine.sqliteVersion,
    fts5: r.engine.fts5,
    threadsafe: r.engine.compileOptions.find((o) => o.startsWith('THREADSAFE')) ?? null,
    compileOptions: r.engine.compileOptions,
    addonSha256: doc.runner.addonSha256,
    appExecutableSha256: doc.runner.appExecutableSha256,
    phase1Ms: m.phase1Measured,
    phase2Ms: m.phase2Measured,
    writerBatchP95: r.phase2?.writerMs?.p95 ?? null,
    searchIdle: m.searchIdle,
    searchBusy: m.searchBusy,
    openIdle: m.openIdle,
  };
}

function poolRow(doc) {
  const r = doc.result;
  const m = metricsOf(doc);
  return {
    pool: r.config.poolSize,
    appExecutableSha256: doc.runner.appExecutableSha256,
    phase2Ms: m.phase2Measured,
    phase2JobP95: r.phase2?.jobMs?.p95 ?? null,
    peakMb: m.memoryPeak,
    searchBusy: m.searchBusy,
    openBusy: m.openBusy,
    workerHeapPeakMb: r.threads ? r.threads.heapPeaks.index / 2 ** 20 : null,
    respawns: r.threads?.respawns ?? null,
  };
}

export function buildReport({
  primary,
  stress,
  engine,
  pools,
  sandbox,
  engineBase,
  manifest,
  sizeRuns,
  exportMessages,
}) {
  const docs = checkComplete(checkCompatible(primary.map(load)));
  // Comparisons check the settings and measures their rows use. Runs from
  // before the reserve was watched during the run are accepted there; each
  // row is labelled with its executable digest.
  const comparison = (list) =>
    checkComplete(checkCompatible(list, { sameEngine: false, workload: COMPARISON_WORKLOAD }), {
      transient: false,
      full: false,
    });
  const metrics = combine(docs.map(metricsOf));
  const peaks = docs.map((d) => metricsOf(d).peakFamilyBytes).filter((x) => typeof x === 'number');
  const first = docs[0];
  const report = {
    label: first.result.label,
    runs: docs.length,
    build: first.result.build,
    machine: first.result.machine,
    flavor: first.runner.build,
    appExecutableSha256: first.runner.appExecutableSha256,
    engine: first.result.engine,
    config: first.result.config,
    metrics,
    targets: Object.fromEntries(
      Object.entries(TARGETS).map(([k, t]) => [
        k,
        {
          ...t,
          value: metrics[k],
          verdict: verdict(metrics[k], t.limit, { cold: t.cold, label: first.result.label }),
        },
      ]),
    ),
    phase1: first.result.phase1 && { ...first.result.phase1, batches: undefined },
    phase2: first.result.phase2,
    large: first.result.large,
    totals: first.result.totals,
    threads: first.result.threads,
    quarantine: { standard: first.runner.quarantine, saved: first.result.quarantine },
    indexLimits: first.result.indexLimits,
    peakFamily: { median: metrics.peakFamilyBytes, max: peaks.length ? Math.max(...peaks) : null },
    peakWalMax: Math.max(...docs.map((d) => d.result.totals?.wal?.peakWalBytes ?? 0)),
    termMatches: { term: first.result.config.term, messages: first.result.termMatches ?? null },
    perProcessPeakSumMiB: docs.map((d) =>
      (d.runner.footprintPeakByProcess ?? []).reduce((n, p) => n + p.peakMiB, 0),
    ),
    runFiles: docs.map((d) => ({
      file: d.file,
      appExecutableSha256: d.runner.appExecutableSha256,
    })),
    indexSize: indexSize(first.result.totals, first.result.phase1.pairs, [
      ...(exportMessages ? [exportMessages] : []),
      TARGET_MESSAGES,
    ]),
    sizeComparison: (sizeRuns ?? []).map((f) => {
      const d = load(f);
      return {
        ftsPrefix: d.result.config.ftsPrefix ?? '2 3',
        ...indexSize(d.result.totals, d.result.phase1.pairs),
      };
    }),
    grouping: {
      planned: manifest
        ? {
            conversations: manifest.counts?.conversations ?? null,
            largest: manifest.counts?.largest_conversation ?? null,
          }
        : null,
      actual: {
        conversations: first.result.totals?.conversations ?? null,
        largest: first.result.totals?.largest ?? null,
        singletons: first.result.totals?.singletons ?? null,
      },
    },
    footprintPeakByProcess: first.runner.footprintPeakByProcess,
    footprintIdleByProcess: first.runner.footprint?.idleByProcess ?? null,
    footprintByPhase: first.runner.footprint?.peakByPhase ?? null,
    frontmost: docs.map((d) => d.runner.frontmost),
  };
  if (stress) report.stress = stressOf(checkClean(load(stress)));
  if (engine) {
    const pair = comparison([load(engineBase ?? first.file), load(engine)]);
    if (pair[0].result.config.poolSize !== pair[1].result.config.poolSize)
      throw new Error('the engine comparison needs the same pool size on both sides');
    report.engines = pair.map(engineRow);
  }
  if (pools?.length) {
    const sweep = comparison(pools.map(load));
    if (new Set(sweep.map((d) => d.result.engine.engine)).size !== 1)
      throw new Error('the pool sweep needs one engine');
    report.pools = sweep.map(poolRow).sort((a, b) => a.pool - b.pool);
  }
  if (sandbox) {
    const s = checkClean(load(sandbox));
    if (s.result.corpusRemoved !== true || s.result.workspaceRemoved !== true)
      throw new Error(`${sandbox}: the sandboxed workspace was not removed`);
    report.sandbox = {
      flavor: s.runner.build,
      ok: s.result.ok,
      engine: s.result.engine.engine,
      sqlite: s.result.engine.sqliteVersion,
      fts5: s.result.engine.fts5,
      messages: s.result.phase1.pairs,
      phase2States: s.result.phase2?.states,
      searchIdle: metricsOf(s).searchIdle,
      corpusBytes: s.result.corpusBytes,
      corpusRemoved: s.result.corpusRemoved,
      indexRemoved: s.result.indexRemoved,
      quarantine: s.runner.quarantine,
      frontmost: s.runner.frontmost,
    };
  }
  return report;
}

function table(rows) {
  const head = Object.keys(rows[0]);
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${head.map((h) => r[h]).join(' | ')} |`),
  ].join('\n');
}

export function markdown(report, deferredLabel = 'deferred') {
  const m = report.metrics;
  const lines = [];
  lines.push(`# Index bench report (${report.label} runs)`);
  lines.push('');
  lines.push(
    `Machine: ${report.machine.cpuModel}, ${report.machine.cpus} cores, ${Math.round(report.machine.totalMemGb)} GB. ` +
      `Build: packaged \`${report.flavor}\` flavor, Electron ${report.build.electron} (Node ${report.build.node}), ` +
      `executable SHA-256 \`${report.appExecutableSha256}\`. Engine: ${report.engine.engine}, SQLite ${report.engine.sqliteVersion}. ` +
      `Corpus: ${m.messages.toLocaleString('en-US')} messages. Runs: ${report.runs} (medians). ` +
      `Index pool: ${report.config.poolSize} workers, old-generation limit ${report.config.oldGenMb} MB.`,
  );
  lines.push('');
  lines.push('## Targets');
  lines.push('');
  const rows = Object.entries(report.targets).map(([k, t]) => {
    let basis =
      t.basis === 'extrapolated'
        ? `measured ${fmt(k === 'phase1' ? m.phase1Measured : m.phase2Measured, 'ms')} at ${m.messages.toLocaleString('en-US')}, ×${TARGET_MESSAGES / m.messages} to 200k`
        : t.basis === 'at bench size'
          ? `measured at ${m.messages.toLocaleString('en-US')}`
          : 'measured';
    if (k === 'phase2') basis += `, plus ${fmt(m.largeMs, 'ms')} for the streamed large parts`;
    const warmOnly = t.cold && report.label !== 'cold';
    return {
      Metric: t.label,
      Target: `≤ ${t.limit.toLocaleString('en-US')} ${t.unit}`,
      Value: `${fmt(t.value, t.unit)}${warmOnly ? ` (${report.label})` : ''}`,
      Basis: basis,
      Result: t.verdict,
    };
  });
  rows.push({
    Metric: 'UI input latency p95 during phase 2',
    Target: '≤ 50 ms',
    Value: '-',
    Basis: 'needs the real UI',
    Result: deferredLabel,
  });
  rows.push({
    Metric: 'Scroll',
    Target: 'no dropped frames',
    Value: '-',
    Basis: 'needs the real UI',
    Result: deferredLabel,
  });
  lines.push(table(rows));
  lines.push('');
  lines.push(
    'MB is 10^6 bytes throughout. "First rows" runs from the start of phase 1 (the folder scan; core already started and the schema created) to the first conversation-list page with rows, read by the query thread; no UI is drawn.' +
      (report.termMatches?.messages != null
        ? ` The search term "${report.termMatches.term}" matches ${report.termMatches.messages.toLocaleString('en-US')} of ${m.messages.toLocaleString('en-US')} messages; every results page groups all matches, so a page's cost grows with the number of matches, and with the corpus for a term this broad.`
        : ''),
  );
  lines.push('');
  lines.push('## Search and open detail (p95, ms)');
  lines.push('');
  lines.push(
    table([
      {
        Query: 'date, page 1',
        Idle: r1(m.searchIdleParts.dateP1),
        'During phase 2': r1(m.searchBusyParts.dateP1),
      },
      {
        Query: 'date, page 2',
        Idle: r1(m.searchIdleParts.dateP2),
        'During phase 2': r1(m.searchBusyParts.dateP2),
      },
      { Query: 'date, deepest page', Idle: r1(m.searchIdleParts.dateDeep), 'During phase 2': '-' },
      {
        Query: 'relevance, page 1',
        Idle: r1(m.searchIdleParts.relevanceP1),
        'During phase 2': 'finished index only',
      },
      {
        Query: 'relevance, page 2',
        Idle: r1(m.searchIdleParts.relevanceP2),
        'During phase 2': 'finished index only',
      },
      {
        Query: 'relevance, deepest page',
        Idle: r1(m.searchIdleParts.relevanceDeep),
        'During phase 2': '-',
      },
      {
        Query: 'conversation list, page 1',
        Idle: r1(m.searchIdleParts.list),
        'During phase 2': r1(m.searchBusyParts.list),
      },
      {
        Query: 'open message (reader lane)',
        Idle: r1(m.openIdle),
        'During phase 2': r1(m.openBusy),
      },
    ]),
  );
  lines.push('');
  lines.push('## Memory');
  lines.push('');
  lines.push(
    table([
      {
        Measure: 'Summed physical footprint (compared with the targets)',
        Idle: fmt(m.memoryIdle, 'MB'),
        'Idle, index pool still running': fmt(m.memoryIdlePoolAlive, 'MB'),
        'Idle, SQLite caches released': fmt(m.memoryIdleShrunk, 'MB'),
        'Peak, phase 2 + reading': fmt(m.memoryPeak, 'MB'),
      },
      {
        Measure: 'Summed resident size (counts shared framework pages in every process)',
        Idle: fmt(m.rssIdle, 'MB'),
        'Idle, index pool still running': '-',
        'Idle, SQLite caches released': fmt(m.rssIdleShrunk, 'MB'),
        'Peak, phase 2 + reading': fmt(m.rssPeak, 'MB'),
      },
    ]),
  );
  if (report.footprintIdleByProcess?.length) {
    lines.push('');
    lines.push(
      `Idle footprint by process (pool stopped): ${report.footprintIdleByProcess
        .map((p) => `${p.name} ${p.mib} MiB`)
        .join('; ')}.`,
    );
  }
  if (report.perProcessPeakSumMiB?.length) {
    const sums = report.perProcessPeakSumMiB.map((v) => r1((v * 2 ** 20) / 1e6));
    lines.push('');
    lines.push(
      `The peak above is the highest sum of footprints sampled every 0.5 s. Adding each process's own peak over the whole run (which may not coincide) gives an upper bound: ${sums.join(', ')} MB for the ${sums.length} runs.`,
    );
  }
  if (report.footprintPeakByProcess) {
    lines.push('');
    lines.push(
      `Per-process footprint peaks over the whole run: ${report.footprintPeakByProcess
        .map((p) => `${p.name} ${p.peakMiB} MiB`)
        .join('; ')}.`,
    );
  }
  if (report.indexSize) {
    const z = report.indexSize;
    const kb = (b) => `${r1(b / 1000)} KB`;
    lines.push('');
    lines.push('## Index size');
    lines.push('');
    lines.push(
      `${(z.dbBytes / 1e6).toFixed(1)} MB for ${z.messages.toLocaleString('en-US')} messages after the final checkpoint: ` +
        `${kb(z.perMessage.total)} per message (body text ${kb(z.perMessage.bodyText)}, full-text index ${kb(z.perMessage.fts)}, ` +
        `other indexed text ${kb(z.perMessage.otherText)}, tables and indexes ${kb(z.perMessage.rest)}). ` +
        `At the same rate: ${Object.entries(z.extrapolated)
          .map(
            ([n, b]) =>
              `${Number(n).toLocaleString('en-US')} messages ≈ ${(b / 1e9).toFixed(2)} GB`,
          )
          .join(', ')}. ` +
        `Peak WAL ${fmt((report.peakWalMax ?? 0) / 1e6, 'MB')} (highest of the runs); peak index family ${fmt((report.peakFamily?.median ?? 0) / 1e6, 'MB')} (median of the runs), ${fmt((report.peakFamily?.max ?? 0) / 1e6, 'MB')} (highest) ` +
        `(cap ${fmt((report.indexLimits?.capBytes ?? 0) / 1e6, 'MB')}, main file limit ${fmt((report.indexLimits?.mainFileLimitBytes ?? 0) / 1e6, 'MB')}).`,
    );
    if (report.sizeComparison.length) {
      lines.push('');
      lines.push(
        table(
          report.sizeComparison.map((c) => ({
            'Prefix indexes': c.ftsPrefix || 'none',
            Messages: c.messages,
            'Index MB': r1(c.dbBytes / 1e6),
            'Per message KB': r1(c.perMessage.total / 1000),
            'Full-text index per message KB': r1(c.perMessage.fts / 1000),
          })),
        ),
      );
    }
  }
  if (report.grouping) {
    const g = report.grouping;
    lines.push('');
    lines.push(
      `Conversations: planned by the generator ${g.planned?.conversations ?? 'n/a'} (largest ${g.planned?.largest ?? 'n/a'}); ` +
        `grouped from the metadata ${g.actual.conversations} (largest ${g.actual.largest}, ${g.actual.singletons} single messages). Timings use the grouping as found.`,
    );
  }
  if (report.stress) {
    const s = report.stress;
    lines.push('');
    lines.push('## Threaded ingest, stress corpus');
    lines.push('');
    lines.push(
      table([
        { Item: 'Messages', Value: s.messages },
        { Item: 'Phase 1 time', Value: fmt(s.phase1Ms, 'ms') },
        { Item: 'Batches', Value: s.batches },
        {
          Item: 'Batch transaction p50 / p95 / max',
          Value: `${r1(s.batchMs.p50)} / ${r1(s.batchMs.p95)} / ${r1(s.batchMs.max)} ms`,
        },
        { Item: 'Merges', Value: s.repointed.merges },
        {
          Item: 'Re-pointed messages (total, most in one batch)',
          Value: `${s.repointed.messages}, ${s.repointed.maxMessagesInOneBatch}`,
        },
        { Item: 'Re-pointed keys', Value: s.repointed.keys },
        { Item: 'Re-pointed label rows', Value: s.repointed.labelRows },
        {
          Item: 'Last batch: ms, merges, re-pointed messages',
          Value: `${r1(s.lastBatch.ms)}, ${s.lastBatch.merges}, ${s.lastBatch.repointedMessages}`,
        },
        {
          Item: 'Late merge (the last message links the two sides)',
          Value: s.lateMerge
            ? `${s.lateMerge.fromSize} messages (ID ${s.lateMerge.from}) joined ${s.lateMerge.intoSize} (ID ${s.lateMerge.into}); ${s.lateMerge.repointed} re-pointed`
            : 'n/a',
        },
        {
          Item: 'Conversations / largest',
          Value: `${s.totals.conversations} / ${s.totals.largest}`,
        },
      ]),
    );
  }
  if (report.large?.length) {
    lines.push('');
    lines.push(
      '## Streamed large parts (measured on a fresh thread; generation time shown separately, not subtracted)',
    );
    lines.push('');
    lines.push(
      table(
        report.large.map((l) => ({
          Part: `${l.kind}, ${(l.bytes / 1e6).toLocaleString('en-US')} MB`,
          'Extract ms': r1(l.extract.ms),
          'Generate-only ms': r1(l.generateOnly.ms),
          body_state: l.extract.state,
          'Raw text consumed (B)': l.extract.rawTextBytes,
          'Core RSS growth, generation + extraction (MB)': r1(l.extract.rssGrowth / 1e6),
          'Worker heap peak (MB)': r1(l.extract.heapPeak / 2 ** 20),
        })),
      ),
    );
  }
  if (report.engines) {
    lines.push('');
    lines.push('## SQLite engines (same workload, same settings)');
    lines.push('');
    lines.push(
      table(
        report.engines.map((e) => ({
          Engine: e.engine,
          SQLite: e.sqlite,
          FTS5: e.fts5,
          Threadsafe: e.threadsafe,
          'Phase 1 ms': r1(e.phase1Ms),
          'Phase 2 ms': r1(e.phase2Ms),
          'Writer batch p95 ms': r1(e.writerBatchP95),
          'Search p95 idle / busy ms': `${r1(e.searchIdle)} / ${r1(e.searchBusy)}`,
          'Open p95 idle ms': r1(e.openIdle),
          'Addon SHA-256': e.addonSha256 ?? 'built in',
          'Executable SHA-256': e.appExecutableSha256,
        })),
      ),
    );
  }
  if (report.pools) {
    lines.push('');
    for (const e of report.engines) {
      lines.push(
        `Compile options, ${e.engine} (SQLite ${e.sqlite}): ${e.compileOptions.map((o) => `\`${o}\``).join(', ')}.`,
      );
      lines.push('');
    }
    lines.push('');
    lines.push('## Index pool size');
    lines.push('');
    lines.push(
      table(
        report.pools.map((p) => ({
          Pool: p.pool,
          'Phase 2 ms': r1(p.phase2Ms),
          'Body job p95 ms': r1(p.phase2JobP95),
          'Peak footprint MB': r1(p.peakMb),
          'Search p95 busy ms': r1(p.searchBusy),
          'Open p95 busy ms': r1(p.openBusy),
          'Worker heap peak MB': r1(p.workerHeapPeakMb),
          Respawns: p.respawns,
          'Executable SHA-256': p.appExecutableSha256,
        })),
      ),
    );
  }
  if (report.sandbox) {
    const s = report.sandbox;
    lines.push('');
    lines.push('## Sandboxed build (own container, small corpus)');
    lines.push('');
    lines.push(
      `\`${s.flavor}\`, ad hoc signed, run outside the App Store: ${s.ok ? 'ran' : 'FAILED'}. ` +
        `${s.engine} SQLite ${s.sqlite}, FTS5 ${s.fts5}; ${s.messages} messages through core's workers, body states ${JSON.stringify(s.phase2States)}; ` +
        `search p95 ${fmt(s.searchIdle, 'ms')}. Corpus ${s.corpusBytes} B, removed ${s.corpusRemoved}; index removed ${s.indexRemoved}. ` +
        `Quarantine on the saved file: ${s.quarantine.present ? `present (\`${s.quarantine.value}\`)` : 'absent'}.`,
    );
  }
  lines.push('');
  lines.push('## Quarantine, standard build');
  lines.push('');
  lines.push(
    `Saved by \`${report.quarantine.saved?.method}\` (${report.quarantine.saved?.state}): ` +
      `${report.quarantine.standard.present ? `present (\`${report.quarantine.standard.value}\`)` : 'absent'}.`,
  );
  lines.push('');
  lines.push(`Frontmost app during the runs: ${JSON.stringify(report.frontmost)}.`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      primary: { type: 'string', multiple: true },
      stress: { type: 'string' },
      engine: { type: 'string' },
      'engine-base': { type: 'string' },
      pool: { type: 'string', multiple: true },
      sandbox: { type: 'string' },
      manifest: { type: 'string' },
      size: { type: 'string', multiple: true },
      'export-messages': { type: 'string' },
      deferred: { type: 'string', default: 'deferred' },
      json: { type: 'string' },
      md: { type: 'string' },
    },
  });
  if (!values.primary?.length || !values.json || !values.md) {
    console.error(
      'usage: report.mjs --primary <file> … --json <out> --md <out> [--stress f] [--engine f] [--pool f …] [--sandbox f]',
    );
    process.exit(2);
  }
  const report = buildReport({
    primary: values.primary,
    stress: values.stress,
    engine: values.engine,
    pools: values.pool,
    sandbox: values.sandbox,
    engineBase: values['engine-base'],
    manifest: values.manifest ? JSON.parse(readFileSync(values.manifest, 'utf8')) : undefined,
    sizeRuns: values.size,
    exportMessages: values['export-messages'] ? Number(values['export-messages']) : undefined,
  });
  writeFileSync(values.json, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(values.md, markdown(report, values.deferred));
  console.log(`report: wrote ${values.json} and ${values.md}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`report: ${err.message}`);
    process.exit(1);
  });
}
