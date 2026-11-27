// SPDX-License-Identifier: AGPL-3.0-or-later
// The index's part of the index report: what was indexed, and the pairs that
// need attention (metadata that couldn't be used or is missing, a missing
// message file, a list cut to its limit), counted and listed by file name.
// Files the scan refused are added by the source, which holds the scan.

import { CAPPED_LIST_NAMES } from '../../shared/log/codes';
import { REJECT_KINDS, type RejectKind } from '../../shared/sources';
import {
  REPORT_ROWS,
  type CappedListName,
  type FailedReason,
  type IndexReport,
  type ReportRow,
} from '../../shared/index-types';
import { CAPPED, META_STATE, BODY_STATE } from './schema';
import { sidebar } from './queries';
import { asNumber, scalar, type Db } from './sql';

/** The report as the index alone knows it: no scan and no timing yet. */
export type IndexPart = Omit<IndexReport, 'took'>;

/** How a pair's error code is reported. */
export function pairReason(
  code: string,
): { kind: 'rejected'; reason: RejectKind } | { kind: 'failed'; reason: FailedReason } | 'timeout' {
  if (code.startsWith('FILE_')) {
    const kind = code.slice('FILE_'.length).toLowerCase();
    if ((REJECT_KINDS as readonly string[]).includes(kind)) {
      return { kind: 'rejected', reason: kind as RejectKind };
    }
    return { kind: 'failed', reason: 'failed' };
  }
  switch (code) {
    case 'META_JSON':
      return { kind: 'failed', reason: 'meta_json' };
    case 'META_SHAPE':
      return { kind: 'failed', reason: 'meta_shape' };
    case 'META_ID':
      return { kind: 'failed', reason: 'meta_id' };
    case 'META_TIMEOUT':
      return 'timeout';
    default:
      return { kind: 'failed', reason: 'failed' };
  }
}

const bump = <K extends string>(counts: Partial<Record<K, number>>, key: K, by: number) => {
  counts[key] = (counts[key] ?? 0) + by;
};

/** The lists a `capped` value names, in a fixed order. */
export function cappedLists(capped: number): CappedListName[] {
  return CAPPED_LIST_NAMES.filter((list) => (capped & CAPPED[list]) !== 0);
}

/**
 * The index's part of the report, from one snapshot. `systemIds` are the
 * system folders the shell shows; `limit` bounds the rows.
 */
export function indexReport(db: Db, systemIds: readonly string[], limit = REPORT_ROWS): IndexPart {
  const side = sidebar(db, systemIds);
  const report: IndexPart = {
    messages: scalar(db, 'SELECT count(*) FROM messages'),
    folders: side.folders.filter((f) => f.kind !== 'system').length,
    rejected: {},
    metaMissing: 0,
    emlMissing: 0,
    failed: {},
    timeouts: 0,
    capped: {},
    hiddenLabelIds: side.hiddenIds,
    attention: 0,
    rows: [],
  };

  // Metadata that couldn't be used or is missing; a listed (or still to be
  // read) message without its message file.
  const broken = `(meta_state IN (${META_STATE.failed}, ${META_STATE.missing})
    OR (body_state = ${BODY_STATE.emlMissing} AND meta_state IN (${META_STATE.pending}, ${META_STATE.indexed})))`;
  for (const r of db
    .stmt(
      `SELECT meta_state, error_code, count(*) AS n FROM pairs WHERE ${broken}
       GROUP BY meta_state, error_code`,
    )
    .all()) {
    const n = asNumber(r.n);
    const state = asNumber(r.meta_state);
    if (state === META_STATE.missing) report.metaMissing += n;
    else if (state !== META_STATE.failed) report.emlMissing += n;
    else {
      const how = pairReason(String(r.error_code ?? ''));
      if (how === 'timeout') report.timeouts += n;
      else if (how.kind === 'rejected') bump(report.rejected, how.reason, n);
      else bump(report.failed, how.reason, n);
    }
    report.attention += n;
  }

  let cappedMessages = 0;
  const cappedSums = CAPPED_LIST_NAMES.map(
    // Quoted: some list names (to) are SQL keywords.
    (list) => `sum((capped & ${CAPPED[list]}) != 0) AS "${list}"`,
  ).join(', ');
  const sums = db.stmt(`SELECT count(*) AS n, ${cappedSums} FROM messages WHERE capped != 0`).get();
  if (sums) {
    cappedMessages = asNumber(sums.n);
    for (const list of CAPPED_LIST_NAMES) {
      const n = asNumber(sums[list]);
      if (n > 0) report.capped[list] = n;
    }
  }
  report.attention += cappedMessages;

  // The rows: metadata that couldn't be used, then missing metadata, then
  // missing message files, then cut lists; each by file name.
  const rows = report.rows;
  const room = () => limit - rows.length;
  if (room() > 0) {
    for (const r of db
      .stmt(
        `SELECT meta_rel, error_code FROM pairs WHERE meta_state = ${META_STATE.failed}
         ORDER BY meta_rel LIMIT ?`,
      )
      .all(room())) {
      const how = pairReason(String(r.error_code ?? ''));
      rows.push({
        result: 'skipped',
        file: String(r.meta_rel ?? ''),
        reason: how === 'timeout' ? 'timeout' : how.reason,
      });
    }
  }
  if (room() > 0) {
    for (const r of db
      .stmt(
        `SELECT eml_rel FROM pairs WHERE meta_state = ${META_STATE.missing}
         ORDER BY eml_rel LIMIT ?`,
      )
      .all(room())) {
      rows.push({ result: 'skipped', file: String(r.eml_rel ?? ''), reason: 'meta_missing' });
    }
  }
  if (room() > 0) {
    for (const r of db
      .stmt(
        `SELECT meta_rel FROM pairs WHERE body_state = ${BODY_STATE.emlMissing}
           AND meta_state IN (${META_STATE.pending}, ${META_STATE.indexed})
         ORDER BY meta_rel LIMIT ?`,
      )
      .all(room())) {
      rows.push({ result: 'listed', file: String(r.meta_rel ?? ''), reason: 'eml_missing' });
    }
  }
  if (room() > 0 && cappedMessages > 0) {
    for (const r of db
      .stmt(
        `SELECT p.meta_rel AS meta_rel, m.capped AS capped
         FROM messages m JOIN pairs p ON p.proton_id = m.proton_id
         WHERE m.capped != 0 ORDER BY p.meta_rel LIMIT ?`,
      )
      .all(room())) {
      rows.push({
        result: 'truncated',
        file: String(r.meta_rel ?? ''),
        reason: 'capped',
        lists: cappedLists(asNumber(r.capped)),
      });
    }
  }
  return report;
}

/**
 * The whole report: the files the scan refused come first, then the index's
 * part. `took` is how long phase 1 took, if it is done.
 */
export function withScan(
  part: IndexPart,
  refused: ReadonlyArray<{ rel: string; kind: RejectKind }>,
  took: number | null,
  limit = REPORT_ROWS,
): IndexReport {
  const rejected: Partial<Record<RejectKind, number>> = {};
  for (const r of refused) bump(rejected, r.kind, 1);
  for (const [kind, n] of Object.entries(part.rejected) as Array<[RejectKind, number]>) {
    bump(rejected, kind, n);
  }
  const scanRows: ReportRow[] = [...refused]
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .slice(0, limit)
    .map((r) => ({ result: 'skipped', file: r.rel, reason: r.kind }));
  return {
    ...part,
    took,
    rejected,
    attention: part.attention + refused.length,
    rows: [...scanRows, ...part.rows].slice(0, limit),
  };
}
