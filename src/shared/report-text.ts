// SPDX-License-Identifier: AGPL-3.0-or-later
// The index report's words: each result and reason as the report screen shows
// it, and the whole report as plain text for "Copy report". File names are
// relative to the export's folder; no path or account name is ever added.

import type {
  CappedListName,
  FailedReason,
  IndexReport,
  ReportReason,
  ReportResult,
  ReportRow,
} from './index-types';
import type { RejectKind } from './sources';

const COUNT = new Intl.NumberFormat('en-US');

/** "20,000". */
export const count = (n: number): string => COUNT.format(n);

/** The most entries a message keeps per list; the rest are cut. */
export const LIST_LIMITS: Record<CappedListName, number> = {
  labels: 200,
  attachments: 1000,
  to: 1000,
  cc: 1000,
  bcc: 1000,
  replyTo: 1000,
};

const LIST_NAMES: Record<CappedListName, string> = {
  labels: 'labels',
  attachments: 'attachments',
  to: 'To addresses',
  cc: 'Cc addresses',
  bcc: 'Bcc addresses',
  replyTo: 'Reply-To addresses',
};

export const RESULT_TEXT: Record<ReportResult, string> = {
  skipped: 'Skipped',
  listed: 'Listed',
  truncated: 'Truncated',
};

const REASON_TEXT: Record<Exclude<ReportReason, 'capped'>, string> = {
  symlink: 'Symbolic link. Not read.',
  directory: 'Folder. Not read.',
  fifo: 'Named pipe. Not read.',
  socket: 'Socket. Not read.',
  device: 'Device file. Not read.',
  other_type: 'Not a regular file. Not read.',
  too_large: 'Too large. Not read.',
  changed: 'Changed while read. Not read.',
  unreadable: "Couldn't be read.",
  meta_missing: 'Metadata missing. Not listed.',
  eml_missing: 'Message file missing.',
  meta_json: 'Invalid JSON. Not listed.',
  meta_shape: 'Unexpected metadata. Not listed.',
  meta_id: "ID doesn't match the file name. Not listed.",
  timeout: 'Took too long to read. Not listed.',
  failed: "Couldn't be read. Not listed.",
  body_timeout: 'Timed out',
  body_failed: "Couldn't read text",
  body_truncated: 'Over the 1 MB search limit',
};

/** "Over 200 labels. First 200 kept." for each list that was cut. */
export function reasonText(row: Pick<ReportRow, 'reason' | 'lists'>): string {
  if (row.reason !== 'capped') return REASON_TEXT[row.reason];
  return (row.lists ?? [])
    .map((list) => {
      const limit = count(LIST_LIMITS[list]);
      return `Over ${limit} ${LIST_NAMES[list]}. First ${limit} kept.`;
    })
    .join(' ');
}

/** "1.2 s", "14 s", "3 min 05 s". */
export function tookText(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** "1 file needs attention", "3 files need attention". */
export function attentionText(n: number): string {
  return n === 1 ? '1 file needs attention' : `${count(n)} files need attention`;
}

const sum = (counts: Partial<Record<string, number>>): number =>
  Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);

/** "2 (fifo 1, symlink 1)", codes in name order; or "0". */
function byCode<K extends string>(counts: Partial<Record<K, number>>): string {
  const parts = (Object.entries(counts) as Array<[K, number]>)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([code, n]) => `${code} ${count(n)}`);
  const total = sum(counts);
  return parts.length > 0 ? `${count(total)} (${parts.join(', ')})` : count(total);
}

/**
 * A file name as one field of a tab-separated line: each C0 control (tab and
 * newline among them) and DEL as its Control Pictures symbol, and each C1
 * control and line or paragraph separator as U+FFFD, so a name can never
 * split its line or field.
 */
export function fieldText(name: string): string {
  let out = '';
  for (const c of name) {
    const code = c.charCodeAt(0);
    if (code < 0x20) out += String.fromCharCode(0x2400 + code);
    else if (code === 0x7f) out += '\u2421';
    else if ((code >= 0x80 && code <= 0x9f) || code === 0x2028 || code === 0x2029) out += '\ufffd';
    else out += c;
  }
  return out;
}

/** The report as plain text, with counts, codes and one line per file. */
export function reportText(report: IndexReport): string {
  const lines = [
    'Index report',
    `Messages: ${count(report.messages)}`,
    `Folders and labels: ${count(report.folders)}`,
  ];
  if (report.took !== null) lines.push(`Took: ${tookText(report.took)}`);
  lines.push(
    `Files refused: ${byCode<RejectKind>(report.rejected)}`,
    `Metadata missing: ${count(report.metaMissing)}`,
    `Message file missing: ${count(report.emlMissing)}`,
    `Metadata not usable: ${byCode<FailedReason>(report.failed)}`,
    `Timeouts: ${count(report.timeouts)}`,
    `Lists cut to their limit: ${byCode<CappedListName>(report.capped)}`,
    `Unknown label IDs hidden: ${count(report.hiddenLabelIds)}`,
    `Bodies indexed: ${count(report.fullText.indexed)} of ${count(report.fullText.total)}`,
    `Text not read: ${byCode(report.fullText.skippedBy)}`,
    `Text over the limit: ${count(report.fullText.truncated)}`,
    '',
    attentionText(report.attention),
  );
  for (const row of report.rows) {
    const code =
      row.reason === 'capped'
        ? `capped: ${(row.lists ?? []).join(', ')}`
        : (row.code ?? row.reason);
    lines.push(`${RESULT_TEXT[row.result]}\t${fieldText(row.file)}\t${reasonText(row)} (${code})`);
  }
  if (report.more > 0) lines.push(`and ${count(report.more)} more`);
  return `${lines.join('\n')}\n`;
}
