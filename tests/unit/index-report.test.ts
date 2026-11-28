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
import { scanRun, type Rejection } from '../../src/core/containment';
import { MAX_ATTACHMENTS, MAX_LABELS, MAX_RECIPIENTS } from '../../src/core/index/metadata';
import { SYSTEM_IDS } from '../../src/core/index/ops';
import { indexReport, pairReason, withScan } from '../../src/core/index/report';
import { openDb } from '../../src/core/index/sql';
import { IndexService, type IndexOptions } from '../../src/core/index/service';
import type { ThreadRole } from '../../src/core/index/pool';
import type { IndexReport } from '../../src/shared/index-types';
import { REPORT_ROWS } from '../../src/shared/index-types';
import type { Logger } from '../../src/shared/log/writer';
import {
  LIST_LIMITS,
  fieldText,
  reasonText,
  reportText,
  tookText,
} from '../../src/shared/report-text';
import { writeExport } from '../exports';
import { InlineThread, STAMP } from '../index-helpers';
import { testDir } from '../paths';

const silent: Logger = { log: () => {}, error: () => {}, warn: () => {}, info: () => {} };

function service(
  root: string,
  indexDir: string,
  options: IndexOptions = {},
  hang: (role: ThreadRole, op: string, args: unknown) => boolean = () => false,
  onRejected?: (rejected: Rejection[]) => void,
): IndexService {
  return new IndexService({
    indexDir,
    stamp: STAMP,
    root,
    log: silent,
    thread: (role) => new InlineThread(role, (op, args) => hang(role, op, args)),
    isCurrent: () => true,
    options,
    ...(onRejected ? { onRejected } : {}),
  });
}

/** Rewrites one metadata file's payload. */
function editMeta(run: string, id: string, edit: (payload: Record<string, unknown>) => void) {
  const path = join(run, `${id}.metadata.json`);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { Payload: Record<string, unknown> };
  edit(doc.Payload);
  writeFileSync(path, JSON.stringify(doc));
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
    // Refused at its first look: a metadata file becomes a FIFO after the
    // listing. It is counted with the listing's refusals, and its message
    // has no metadata.
    rmSync(join(run, `${swapped}.metadata.json`));
    expect(spawnSync('/usr/bin/mkfifo', [join(run, `${swapped}.metadata.json`)]).status).toBe(0);

    const refused = [...scan.rejected];
    const s = service(
      run,
      join(dir, 'index'),
      { jobMs: 1000 },
      (role, op, args) => {
        if (role !== 'parse' || op !== 'meta') return false;
        return (args as { items: Array<{ protonId: string }> }).items.some(
          (i) => i.protonId === slow,
        );
      },
      (found) => refused.push(...found),
    );
    await s.open(null);
    await s.startIndexing(scan);
    expect(s.progress.phase).toBe('done');
    expect(s.took).toEqual(expect.any(Number));

    const part = (await s.ask({ op: 'report' })) as IndexReport;
    const report = withScan(part, refused, s.took);
    // 30 pairs, less the seven whose metadata is missing or couldn't be used.
    expect(report.messages).toBe(23);
    expect(refused).toHaveLength(4);
    expect(report.rejected).toEqual({ symlink: 1, directory: 1, fifo: 2 });
    expect(report.metaMissing).toBe(2);
    expect(report.emlMissing).toBe(2);
    expect(report.failed).toEqual({ meta_json: 2, meta_shape: 1, meta_id: 1 });
    expect(report.timeouts).toBe(1);
    expect(report.capped).toEqual({ to: 2 });
    expect(report.hiddenLabelIds).toBe(1);
    // 15 rows for 14 files: the message with no file and a cut list has two.
    expect(report.attention).toBe(14);
    expect(report.more).toBe(0);
    expect(report.took).toBe(s.took);

    const meta = (id: string) => `${id}.metadata.json`;
    // The listing's refusals first, by file name.
    const listed = [
      { result: 'skipped', file: 'zz-folder.eml', reason: 'directory' },
      { result: 'skipped', file: 'zz-link.metadata.json', reason: 'symlink' },
      { result: 'skipped', file: 'zz-pipe.metadata.json', reason: 'fifo' },
      { result: 'skipped', file: meta(swapped), reason: 'fifo' },
    ].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    expect(report.rows).toEqual([
      ...listed,
      { result: 'skipped', file: meta(badJson), reason: 'meta_json' },
      { result: 'skipped', file: meta(badShape), reason: 'meta_shape' },
      { result: 'skipped', file: meta(badId), reason: 'meta_id' },
      { result: 'skipped', file: meta(slow), reason: 'timeout' },
      { result: 'skipped', file: meta(jsonNoEml), reason: 'meta_json' },
      { result: 'skipped', file: `${metaGone}.eml`, reason: 'meta_missing' },
      { result: 'skipped', file: `${swapped}.eml`, reason: 'meta_missing' },
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
    expect(text).toContain('14 files need attention\n');
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
      const own = report.rows.slice(listed.length);
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
      hiddenLabelIds: 0,
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
      hiddenLabelIds: 0,
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
