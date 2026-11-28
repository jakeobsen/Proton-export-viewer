// SPDX-License-Identifier: AGPL-3.0-or-later
// The index report over a generated export with one file of each kind that
// needs attention: counts by reason, the rows in order, and the plain text.

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRun } from '../../src/core/containment';
import { MAX_ATTACHMENTS, MAX_LABELS, MAX_RECIPIENTS } from '../../src/core/index/metadata';
import { SYSTEM_IDS } from '../../src/core/index/ops';
import { bodyCode, indexReport, pairReason, withScan } from '../../src/core/index/report';
import { BODY_STATE } from '../../src/core/index/schema';
import { coverageOf } from '../../src/core/index/search';
import { openDb } from '../../src/core/index/sql';
import { IndexService, type IndexOptions } from '../../src/core/index/service';
import type { ThreadRole } from '../../src/core/index/pool';
import type { IndexReport } from '../../src/shared/index-types';
import { REPORT_ROWS } from '../../src/shared/index-types';
import type { Logger } from '../../src/shared/log/writer';
import {
  LIST_LIMITS,
  fieldText,
  fileCounts,
  filesText,
  reasonText,
  reportText,
  tookText,
} from '../../src/shared/report-text';
import { fullTextShare } from '../../src/renderer/format';
import { writeExport } from '../exports';
import { InlineThread, STAMP } from '../index-helpers';
import { testDir } from '../paths';

const silent: Logger = { log: () => {}, error: () => {}, warn: () => {}, info: () => {} };

function service(
  root: string,
  indexDir: string,
  options: IndexOptions = {},
  hang: (role: ThreadRole, op: string, args: unknown) => boolean = () => false,
): IndexService {
  return new IndexService({
    indexDir,
    stamp: STAMP,
    root,
    log: silent,
    thread: (role) => new InlineThread(role, (op, args) => hang(role, op, args)),
    isCurrent: () => true,
    options,
  });
}

/** Rewrites one metadata file's payload. */
function editMeta(run: string, id: string, edit: (payload: Record<string, unknown>) => void) {
  const path = join(run, `${id}.metadata.json`);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { Payload: Record<string, unknown> };
  edit(doc.Payload);
  writeFileSync(path, JSON.stringify(doc));
}

/** Rewrites one message file as a plain-text message whose body is `bytes` long. */
function bigEml(run: string, id: string, bytes: number): void {
  const line = 'lorem ipsum dolor sit amet consectetur adipiscing elit\r\n';
  const body = line.repeat(Math.ceil(bytes / line.length));
  writeFileSync(
    join(run, `${id}.eml`),
    `From: a@example.com\r\nTo: b@example.com\r\nSubject: Long\r\nDate: Tue, 24 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
  );
}

/** Hangs the body job of these messages, so each runs past its time limit. */
const hangBodies =
  (...ids: string[]) =>
  (role: ThreadRole, op: string, args: unknown): boolean =>
    role === 'parse' &&
    op === 'body' &&
    ids.includes((args as { item: { protonId: string } }).item.protonId);

/** The message files' IDs, in name order. */
const emlIds = (run: string) =>
  readdirSync(run)
    .filter((n) => n.endsWith('.eml'))
    .map((n) => n.slice(0, -'.eml'.length))
    .sort();

/** Opens the index in a folder read-only, for reads outside the service. */
function readIndex(indexDir: string) {
  const file = readdirSync(indexDir).find((n) => n.endsWith('.sqlite'));
  return openDb(join(indexDir, file!), true);
}

describe('the index report', () => {
  it('counts and lists one file of each kind that needs attention', async () => {
    const dir = testDir('report');
    const written = writeExport(join(dir, 'export'), { seed: 7, messages: 30 });
    const run = realpathSync(written.run);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.eml'))
      .map((n) => n.slice(0, -'.eml'.length))
      .sort();
    expect(ids).toHaveLength(30);
    const [metaGone, emlGone, badJson, badShape, badId, swapped, slow, wide, unknown, jsonNoEml] =
      ids as [string, string, string, string, string, string, string, string, string, string];
    const wideNoEml = ids[11]!;
    rmSync(join(run, `${metaGone}.metadata.json`));
    rmSync(join(run, `${emlGone}.eml`));
    writeFileSync(join(run, `${badJson}.metadata.json`), '{"Version": 1, "Payload": {');
    writeFileSync(join(run, `${badShape}.metadata.json`), '{"Version": 1, "Payload": 5}');
    // Metadata that can't be used and no message file: counted and listed once, as the metadata.
    writeFileSync(join(run, `${jsonNoEml}.metadata.json`), '{"Version": 1, "Payload": [');
    rmSync(join(run, `${jsonNoEml}.eml`));
    editMeta(run, badId, (p) => (p.ID = 'another-id'));
    editMeta(run, wide, (p) => {
      p.ToList = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({
        Name: '',
        Address: `t${i}@example.com`,
      }));
    });
    // A cut list and no message file: one file with two rows.
    editMeta(run, wideNoEml, (p) => {
      p.ToList = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({
        Name: '',
        Address: `w${i}@example.com`,
      }));
    });
    rmSync(join(run, `${wideNoEml}.eml`));
    editMeta(run, unknown, (p) => {
      p.LabelIDs = [...(p.LabelIDs as string[]), 'not-in-labels-json'];
    });
    // Refused by the scan: a link, a folder and a FIFO with names it would read.
    symlinkSync(join(run, `${ids[10]}.eml`), join(run, 'zz-link.metadata.json'));
    mkdirSync(join(run, 'zz-folder.eml'));
    expect(spawnSync('/usr/bin/mkfifo', [join(run, 'zz-pipe.metadata.json')]).status).toBe(0);
    const scan = scanRun(run);
    // Refused when read: a metadata file becomes a FIFO after the scan.
    rmSync(join(run, `${swapped}.metadata.json`));
    expect(spawnSync('/usr/bin/mkfifo', [join(run, `${swapped}.metadata.json`)]).status).toBe(0);

    const s = service(run, join(dir, 'index'), { jobMs: 1000 }, (role, op, args) => {
      if (role !== 'parse' || op !== 'meta') return false;
      return (args as { items: Array<{ protonId: string }> }).items.some(
        (i) => i.protonId === slow,
      );
    });
    await s.open(null);
    await s.startIndexing(scan);
    expect(s.progress.phase).toBe('done');
    expect(s.took).toEqual(expect.any(Number));

    const part = (await s.ask({ op: 'report' })) as IndexReport;
    const report = withScan(part, scan.rejected, s.took);
    // 30 pairs, less the seven whose metadata is missing or couldn't be used.
    expect(report.messages).toBe(23);
    expect(report.rejected).toEqual({ symlink: 1, directory: 1, fifo: 2 });
    expect(report.metaMissing).toBe(1);
    expect(report.emlMissing).toBe(2);
    expect(report.failed).toEqual({ meta_json: 2, meta_shape: 1, meta_id: 1 });
    expect(report.timeouts).toBe(1);
    expect(report.capped).toEqual({ to: 2 });
    expect(report.cappedMessages).toBe(2);
    expect(report.hiddenLabelIds).toBe(1);
    // By result: the 13 files less the one listed with no message file only.
    expect(fileCounts(report)).toEqual({ skipped: 10, truncated: 2 });
    // 14 rows for 13 files: the message with no file and a cut list has two.
    expect(report.attention).toBe(13);
    expect(report.more).toBe(0);
    expect(report.took).toBe(s.took);

    const meta = (id: string) => `${id}.metadata.json`;
    expect(report.rows).toEqual([
      { result: 'skipped', file: 'zz-folder.eml', reason: 'directory' },
      { result: 'skipped', file: 'zz-link.metadata.json', reason: 'symlink' },
      { result: 'skipped', file: 'zz-pipe.metadata.json', reason: 'fifo' },
      { result: 'skipped', file: meta(badJson), reason: 'meta_json' },
      { result: 'skipped', file: meta(badShape), reason: 'meta_shape' },
      { result: 'skipped', file: meta(badId), reason: 'meta_id' },
      { result: 'skipped', file: meta(swapped), reason: 'fifo' },
      { result: 'skipped', file: meta(slow), reason: 'timeout' },
      { result: 'skipped', file: meta(jsonNoEml), reason: 'meta_json' },
      { result: 'skipped', file: `${metaGone}.eml`, reason: 'meta_missing' },
      { result: 'listed', file: meta(emlGone), reason: 'eml_missing' },
      { result: 'listed', file: meta(wideNoEml), reason: 'eml_missing' },
      { result: 'truncated', file: meta(wide), reason: 'capped', lists: ['to'] },
      { result: 'truncated', file: meta(wideNoEml), reason: 'capped', lists: ['to'] },
    ]);

    // The text names files relative to the run: no path, no account.
    const text = reportText(report);
    expect(text).not.toContain(run);
    expect(text).not.toContain(dir);
    expect(text).not.toContain(written.account);
    expect(text).toContain('Messages: 23\n');
    expect(text).toContain('Files refused: 4 (directory 1, fifo 2, symlink 1)\n');
    expect(text).toContain('Metadata not usable: 4 (meta_id 1, meta_json 2, meta_shape 1)\n');
    expect(text).toContain('Message file missing: 2\n');
    expect(text).toContain('Lists cut to their limit: 2 (to 2)\n');
    expect(text).toContain('Unknown label IDs hidden: 1\n');
    expect(text).toContain('13 files need attention\n');
    expect(text).not.toContain(' more\n');
    expect(text).toContain(
      `Truncated\t${meta(wide)}\tOver 1,000 To addresses. First 1,000 kept. (capped: to)\n`,
    );
    expect(text).toContain(`Listed\t${meta(emlGone)}\tMessage file missing. (eml_missing)\n`);
    await s.close();

    // Core's part keeps at most `limit` rows of its own, in the same order.
    const file = readdirSync(join(dir, 'index')).find((n) => n.endsWith('.sqlite'));
    const db = openDb(join(dir, 'index', file!), true);
    try {
      const own = report.rows.slice(3);
      expect(indexReport(db, SYSTEM_IDS, 3)).toMatchObject({
        rows: own.slice(0, 3),
        attention: 10,
        more: own.length - 3,
      });
      expect(indexReport(db, SYSTEM_IDS, own.length)).toMatchObject({ rows: own, more: 0 });
      // Cut where the file's second row would come, the rest is still counted in rows.
      expect(indexReport(db, SYSTEM_IDS, own.length - 1)).toMatchObject({
        rows: own.slice(0, -1),
        attention: 10,
        more: 1,
      });
    } finally {
      db.close();
    }
  });

  it("counts and lists text cut to the limit, timed out or not read, after the metadata's rows", async () => {
    const dir = testDir('report-text');
    const written = writeExport(join(dir, 'export'), { seed: 8, messages: 12 });
    const run = realpathSync(written.run);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.eml'))
      .map((n) => n.slice(0, -'.eml'.length))
      .sort();
    const [big, slow, swapped, emlGone, badJson] = ids as [string, string, string, string, string];
    // Over the 1 MB that is kept for search.
    bigEml(run, big, 1_100_000);
    rmSync(join(run, `${emlGone}.eml`));
    writeFileSync(join(run, `${badJson}.metadata.json`), '{"Version": 1, "Payload": {');
    const scan = scanRun(run);
    // Refused when phase 2 opens it: the message file becomes a FIFO after the scan.
    rmSync(join(run, `${swapped}.eml`));
    expect(spawnSync('/usr/bin/mkfifo', [join(run, `${swapped}.eml`)]).status).toBe(0);

    const indexDir = join(dir, 'index');
    const s = service(run, indexDir, { jobMs: 1000 }, hangBodies(slow));
    await s.open(null);
    await s.startIndexing(scan);
    expect(s.progress).toMatchObject({
      phase: 'done',
      bodyPhase: 'done',
      bodiesBefore: 0,
      // Every listed message with its file, failed ones included.
      bodiesTotal: 10,
      bodiesDone: 10,
      bodiesFailed: 2,
      bodiesTruncated: 1,
    });
    expect(fullTextShare(s.progress)).toBe(100);

    const report = withScan((await s.ask({ op: 'report' })) as IndexReport, scan.rejected, s.took);
    expect(report.fullText).toEqual({
      indexed: 8,
      total: 11,
      truncated: 1,
      skipped: 2,
      skippedBy: { fifo: 1, timeout: 1 },
    });
    const eml = (id: string) => `${id}.eml`;
    const meta = (id: string) => `${id}.metadata.json`;
    // Text rows come after the metadata's in their result, by name; each names a new file.
    const skippedText = [
      { result: 'skipped', file: eml(slow), reason: 'body_timeout', code: 'timeout' },
      { result: 'skipped', file: eml(swapped), reason: 'body_failed', code: 'fifo' },
    ].sort((a, b) => (a.file < b.file ? -1 : 1));
    expect(report.rows).toEqual([
      { result: 'skipped', file: meta(badJson), reason: 'meta_json' },
      ...skippedText,
      { result: 'listed', file: meta(emlGone), reason: 'eml_missing' },
      { result: 'truncated', file: eml(big), reason: 'body_truncated', code: 'truncated' },
    ]);
    expect(report.attention).toBe(5);
    expect(report.more).toBe(0);
    expect(report.rows.map(reasonText)).toEqual(
      expect.arrayContaining(['Timed out', "Couldn't read text", 'Over the 1 MB search limit']),
    );

    const text = reportText(report);
    expect(text).toContain('Bodies indexed: 8 of 11\n');
    expect(text).toContain('Text not read: 2 (fifo 1, timeout 1)\n');
    expect(text).toContain('Text over the limit: 1\n');
    expect(text).toContain(`Skipped\t${eml(slow)}\tTimed out (timeout)\n`);
    expect(text).toContain(`Skipped\t${eml(swapped)}\tCouldn't read text (fifo)\n`);
    expect(text).toContain(`Truncated\t${eml(big)}\tOver the 1 MB search limit (truncated)\n`);
    expect(text).toContain('5 files need attention\n');
    expect(text).not.toContain(run);
    await s.close();

    const db = readIndex(indexDir);
    try {
      // The report counts bodies as search does.
      const coverage = coverageOf(db);
      expect([coverage.indexed, coverage.total]).toEqual([8, 11]);
      // At the limit, the metadata's row stays and the text rows are counted.
      expect(indexReport(db, SYSTEM_IDS, 1)).toMatchObject({
        rows: [{ result: 'skipped', file: meta(badJson), reason: 'meta_json' }],
        attention: 5,
        more: 4,
      });
      expect(indexReport(db, SYSTEM_IDS, 2).rows).toEqual(report.rows.slice(0, 2));
    } finally {
      db.close();
    }
  });

  it('gives a text row its code: truncated, or the reason of a failed read', () => {
    expect(bodyCode(BODY_STATE.truncated, null)).toBe('truncated');
    expect(bodyCode(BODY_STATE.failed, null)).toBe('worker_failed');
    expect(bodyCode(BODY_STATE.failed, 'BODY_FAILED')).toBe('worker_failed');
    expect(bodyCode(BODY_STATE.failed, 'BODY_TIMEOUT')).toBe('timeout');
    expect(bodyCode(BODY_STATE.failed, 'BODY_TOO_LARGE')).toBe('too_large');
    expect(bodyCode(BODY_STATE.failed, 'FILE_FIFO')).toBe('fifo');
  });

  it('after a reopen, counts what phase 2 handled before, failures included, apart from the bodies indexed', async () => {
    const dir = testDir('report-reopen');
    const written = writeExport(join(dir, 'export'), { seed: 9, messages: 10 });
    const run = realpathSync(written.run);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.eml'))
      .map((n) => n.slice(0, -'.eml'.length))
      .sort();
    const later = ids.slice(0, 2);
    const slow = ids[2]!;
    // Two messages come only after the first run.
    const aside = join(dir, 'aside');
    mkdirSync(aside);
    const move = (id: string, from: string, to: string) => {
      for (const ext of ['.eml', '.metadata.json']) {
        writeFileSync(join(to, id + ext), readFileSync(join(from, id + ext)));
        rmSync(join(from, id + ext));
      }
    };
    for (const id of later) move(id, run, aside);
    const indexDir = join(dir, 'index');
    const first = service(run, indexDir, { jobMs: 1000 }, hangBodies(slow));
    const { dbUuid } = await first.open(null);
    await first.startIndexing(scanRun(run));
    expect(first.progress).toMatchObject({ bodiesBefore: 0, bodiesTotal: 8, bodiesDone: 8 });
    await first.close();

    for (const id of later) move(id, aside, run);
    let seen: { share: number | null; indexed: number; total: number } | null = null;
    const second: IndexService = service(run, indexDir, {
      // Phase 2's first write: what the sidebar and the report show before it.
      beforeWrite: async () => {
        if (seen !== null || second.progress.bodyPhase !== 'indexing') return;
        const part = (await second.ask({ op: 'report' })) as IndexReport;
        seen = {
          share: fullTextShare(second.progress),
          indexed: part.fullText.indexed,
          total: part.fullText.total,
        };
      },
    });
    await second.open(dbUuid);
    await second.startIndexing(scanRun(run));
    expect(second.progress).toMatchObject({
      bodyPhase: 'done',
      // Seven indexed and the one that timed out.
      bodiesBefore: 8,
      bodiesTotal: 2,
      bodiesDone: 2,
      bodiesFailed: 0,
    });
    // The share counts the failed file as handled; the report counts it as not indexed.
    expect(seen).toEqual({ share: 80, indexed: 7, total: 10 });
    const part = (await second.ask({ op: 'report' })) as IndexReport;
    expect(part.fullText).toMatchObject({ indexed: 9, total: 10, skipped: 1 });
    await second.close();
  });

  it('with no file failed or missing, the share and the bodies indexed agree', async () => {
    const dir = testDir('report-agree');
    const written = writeExport(join(dir, 'export'), { seed: 10, messages: 10 });
    const run = realpathSync(written.run);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.eml'))
      .map((n) => n.slice(0, -'.eml'.length))
      .sort();
    const aside = join(dir, 'aside');
    mkdirSync(aside);
    for (const id of ids.slice(0, 3)) {
      for (const ext of ['.eml', '.metadata.json']) {
        writeFileSync(join(aside, id + ext), readFileSync(join(run, id + ext)));
        rmSync(join(run, id + ext));
      }
    }
    const indexDir = join(dir, 'index');
    const first = service(run, indexDir);
    const { dbUuid } = await first.open(null);
    await first.startIndexing(scanRun(run));
    await first.close();
    for (const name of readdirSync(aside)) {
      writeFileSync(join(run, name), readFileSync(join(aside, name)));
    }
    let seen: [number | null, number] | null = null;
    const second: IndexService = service(run, indexDir, {
      beforeWrite: async () => {
        if (seen !== null || second.progress.bodyPhase !== 'indexing') return;
        const { fullText } = (await second.ask({ op: 'report' })) as IndexReport;
        seen = [
          fullTextShare(second.progress),
          Math.floor((fullText.indexed * 100) / fullText.total),
        ];
      },
    });
    await second.open(dbUuid);
    await second.startIndexing(scanRun(run));
    expect(seen).toEqual([70, 70]);
    await second.close();
  });

  it("a second run on the same index starts this run's counts again", async () => {
    const dir = testDir('report-second-run');
    const written = writeExport(join(dir, 'export'), { seed: 11, messages: 6 });
    const run = realpathSync(written.run);
    const [late, slow] = emlIds(run) as [string, string];
    const aside = join(dir, 'aside');
    mkdirSync(aside);
    for (const ext of ['.eml', '.metadata.json']) {
      writeFileSync(join(aside, late + ext), readFileSync(join(run, late + ext)));
      rmSync(join(run, late + ext));
    }
    const s = service(run, join(dir, 'index'), { jobMs: 1000 }, hangBodies(slow));
    await s.open(null);
    await s.startIndexing(scanRun(run));
    expect(s.progress).toMatchObject({ bodiesTotal: 5, bodiesDone: 5, bodiesFailed: 1 });
    for (const ext of ['.eml', '.metadata.json']) {
      writeFileSync(join(run, late + ext), readFileSync(join(aside, late + ext)));
    }
    await s.startIndexing(scanRun(run));
    expect(s.progress).toMatchObject({
      bodyPhase: 'done',
      bodiesBefore: 5,
      bodiesTotal: 1,
      bodiesDone: 1,
      bodiesFailed: 0,
    });
    expect(fullTextShare(s.progress)).toBe(100);
    await s.close();
  });

  it('counts a message with several lists cut once among the truncated files', async () => {
    const dir = testDir('report-capped');
    const written = writeExport(join(dir, 'export'), { seed: 8, messages: 6 });
    const run = realpathSync(written.run);
    const ids = readdirSync(run)
      .filter((n) => n.endsWith('.eml'))
      .map((n) => n.slice(0, -'.eml'.length))
      .sort();
    const many = (tag: string) =>
      Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({
        Name: '',
        Address: `${tag}${i}@example.com`,
      }));
    editMeta(run, ids[0]!, (p) => {
      p.ToList = many('t');
      p.CCList = many('c');
    });
    editMeta(run, ids[1]!, (p) => (p.ToList = many('u')));
    rmSync(join(run, `${ids[2]}.metadata.json`));
    const scan = scanRun(run);
    const s = service(run, join(dir, 'index'));
    await s.open(null);
    await s.startIndexing(scan);
    const report = withScan((await s.ask({ op: 'report' })) as IndexReport, scan.rejected, s.took);
    expect(report.capped).toEqual({ to: 2, cc: 1 });
    expect(report.cappedMessages).toBe(2);
    expect(fileCounts(report)).toEqual({ skipped: 1, truncated: 2 });
    expect(filesText(report)).toBe('1 skipped, 2 truncated');
  });

  it('carries at most a fixed number of rows, and counts the rest', () => {
    const refused = Array.from({ length: REPORT_ROWS + 5 }, (_, i) => ({
      rel: `l${String(i).padStart(4, '0')}.eml`,
      kind: 'symlink' as const,
    }));
    const part = {
      messages: 0,
      folders: 0,
      rejected: { fifo: 1 },
      metaMissing: 0,
      emlMissing: 0,
      failed: {},
      timeouts: 0,
      capped: {},
      cappedMessages: 0,
      hiddenLabelIds: 0,
      fullText: { indexed: 0, total: 0, truncated: 0, skipped: 0, skippedBy: {} },
      attention: 1,
      rows: [{ result: 'skipped' as const, file: 'p.metadata.json', reason: 'fifo' as const }],
      // Core's own rows: one shown and one left out, both for the same file.
      more: 1,
    };
    // The scan's order isn't the rows' order: they go by name.
    const report = withScan(part, [...refused].reverse(), null);
    expect(report.rows).toHaveLength(REPORT_ROWS);
    expect(report.rows.map((r) => r.file)).toEqual(refused.slice(0, REPORT_ROWS).map((r) => r.rel));
    expect(report.attention).toBe(REPORT_ROWS + 6);
    expect(report.more).toBe(7);
    expect(report.rejected).toEqual({ symlink: REPORT_ROWS + 5, fifo: 1 });
    const text = reportText(report);
    expect(text).not.toContain('Took:');
    expect(text.trimEnd().split('\n').at(-1)).toBe('and 7 more');
  });

  it('keeps each copied row on one line, with control characters shown as symbols', () => {
    expect(fieldText('a\tb\nc\rd\u0000e\u007ff\u0085g\u2028h\u2029i.eml')).toBe(
      'a\u2409b\u240ac\u240dd\u2400e\u2421f\ufffdg\ufffdh\ufffdi.eml',
    );
    // Other names, bidi controls among them, are copied as they are.
    expect(fieldText('Grüße \u202eabc.eml')).toBe('Grüße \u202eabc.eml');
    const report: IndexReport = {
      messages: 0,
      folders: 0,
      took: null,
      rejected: { symlink: 1 },
      metaMissing: 0,
      emlMissing: 0,
      failed: {},
      timeouts: 0,
      capped: {},
      cappedMessages: 0,
      hiddenLabelIds: 0,
      fullText: { indexed: 0, total: 0, truncated: 0, skipped: 0, skippedBy: {} },
      attention: 1,
      rows: [{ result: 'skipped', file: 'tab\there\nnew line.eml', reason: 'symlink' }],
      more: 0,
    };
    const lines = reportText(report).trimEnd().split('\n');
    expect(lines.at(-1)).toBe(
      'Skipped\ttab\u2409here\u240anew line.eml\tSymbolic link. Not read. (symlink)',
    );
    expect(lines.at(-1)!.split('\t')).toHaveLength(3);
  });

  it('maps every pair code to a reason', () => {
    expect(pairReason('META_JSON')).toEqual({ kind: 'failed', reason: 'meta_json' });
    expect(pairReason('META_SHAPE')).toEqual({ kind: 'failed', reason: 'meta_shape' });
    expect(pairReason('META_ID')).toEqual({ kind: 'failed', reason: 'meta_id' });
    expect(pairReason('META_TIMEOUT')).toBe('timeout');
    expect(pairReason('META_FAILED')).toEqual({ kind: 'failed', reason: 'failed' });
    expect(pairReason('FILE_CHANGED')).toEqual({ kind: 'rejected', reason: 'changed' });
    expect(pairReason('FILE_TOO_LARGE')).toEqual({ kind: 'rejected', reason: 'too_large' });
    expect(pairReason('FILE_OTHER_TYPE')).toEqual({ kind: 'rejected', reason: 'other_type' });
    expect(pairReason('FILE_NOPE')).toEqual({ kind: 'failed', reason: 'failed' });
  });

  it("states each list's limit as the index applies it", () => {
    expect(LIST_LIMITS).toEqual({
      labels: MAX_LABELS,
      attachments: MAX_ATTACHMENTS,
      to: MAX_RECIPIENTS,
      cc: MAX_RECIPIENTS,
      bcc: MAX_RECIPIENTS,
      replyTo: MAX_RECIPIENTS,
    });
    expect(reasonText({ reason: 'capped', lists: ['labels', 'cc'] })).toBe(
      'Over 200 labels. First 200 kept. Over 1,000 Cc addresses. First 1,000 kept.',
    );
    expect(tookText(1234)).toBe('1.2 s');
    expect(tookText(14_400)).toBe('14 s');
    expect(tookText(185_000)).toBe('3 min 05 s');
  });
});
