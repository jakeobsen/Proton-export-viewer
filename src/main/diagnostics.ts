// SPDX-License-Identifier: AGPL-3.0-or-later
// The diagnostics summary that Settings copies. It is built from a fixed set
// of fields: versions, the kind of build, counts, sizes, and the codes of
// recent errors and warnings. Nothing from a log line reaches it but a code
// from the fixed list, so no path, name or address can.

import { closeSync, fstatSync, openSync, readSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { byteSize } from '../shared/bytes';
import { isLogCode } from '../shared/log/codes';

/** The log files read for recent codes: each process's live file. */
const LOG_FILES = ['main.jsonl', 'core.jsonl', 'renderer.jsonl'] as const;

/** How much of the end of each log file is read. */
export const TAIL_BYTES = 1024 * 1024;

/** How far back "recent" goes. */
export const RECENT_MS = 24 * 60 * 60 * 1000;

/** The most distinct codes listed; the rest are summed into one line. */
const MAX_CODES = 20;

export interface BuildKind {
  /** A Mac App Store build of Electron. */
  mas: boolean;
  packaged: boolean;
  sandboxed: boolean;
  testHooks: boolean;
}

export interface DiagnosticsInput {
  appName: string;
  appVersion: string;
  platform: string;
  osVersion: string;
  arch: string;
  build: BuildKind;
  exports: number;
  /** Each known export's index size in bytes. */
  indexBytes: number[];
  /** Recent error and warning codes with their counts. */
  codes: Map<string, number>;
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

/** Only characters a version string has. */
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
const safeVersion = (v: string): string => (VERSION_RE.test(v) ? v : 'unknown');

export function diagnosticsText(input: DiagnosticsInput): string {
  const { build } = input;
  const kind = [
    build.mas ? 'App Store' : 'standard',
    build.sandboxed ? 'sandboxed' : 'not sandboxed',
    build.packaged ? 'packaged' : 'not packaged',
    ...(build.testHooks ? ['test hooks'] : []),
  ].join(', ');
  const platform = PLATFORM_NAMES[input.platform] ?? 'unknown';
  const arch = input.arch === 'arm64' || input.arch === 'x64' ? input.arch : 'unknown';
  const lines = [
    `${input.appName} ${safeVersion(input.appVersion)}`,
    `${platform} ${safeVersion(input.osVersion)} (${arch})`,
    `Build: ${kind}`,
    `Exports: ${input.exports}`,
    `Index sizes: ${input.indexBytes.length > 0 ? input.indexBytes.map(byteSize).join(', ') : 'none'}`,
  ];
  const sorted = [...input.codes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sorted.length === 0) {
    lines.push('Errors and warnings, last 24 h: none');
  } else {
    lines.push('Errors and warnings, last 24 h:');
    for (const [code, count] of sorted.slice(0, MAX_CODES)) lines.push(`  ${code} ×${count}`);
    const rest = sorted.slice(MAX_CODES).reduce((sum, [, count]) => sum + count, 0);
    if (rest > 0) lines.push(`  more ×${rest}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * The whole lines in the last `bytes` of a regular file, never through a
 * link. When the file is longer, the byte before the tail is read too: it
 * says whether the tail's first line is whole, or cut and dropped. '' if the
 * file can't be read.
 */
function readTail(path: string, bytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return '';
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return '';
    const cut = stat.size > bytes;
    const length = cut ? bytes + 1 : stat.size;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, stat.size - length + read);
      if (n === 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString('utf8');
    if (!cut) return text;
    // Up to and with the first line end: the byte before the tail, then the
    // rest of a line the cut fell in.
    const firstEnd = text.indexOf('\n');
    return firstEnd < 0 ? '' : text.slice(firstEnd + 1);
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/**
 * Counts the error and warning codes logged in the last RECENT_MS, from the
 * end of each process's live log file. A code not in the fixed list counts as
 * `other`; a line that isn't a whole event is skipped.
 */
export function recentCodes(logsDir: string, now: number = Date.now()): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of LOG_FILES) {
    for (const line of readTail(join(logsDir, name), TAIL_BYTES).split('\n')) {
      if (line === '') continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof event !== 'object' || event === null) continue;
      const { level, ts, code } = event as Record<string, unknown>;
      if (level !== 'error' && level !== 'warn') continue;
      const time = typeof ts === 'string' ? Date.parse(ts) : NaN;
      if (!Number.isFinite(time) || time > now || now - time > RECENT_MS) continue;
      const key = isLogCode(code) ? code : 'other';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}
