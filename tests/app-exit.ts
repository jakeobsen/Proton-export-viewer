// SPDX-License-Identifier: AGPL-3.0-or-later
// What a test run keeps of an app's stderr when the app closes under a test:
// Chromium's log lines by level and source position only. Their text, and
// every other line, is dropped, so the report holds codes and counts only.

import { StringDecoder } from 'node:string_decoder';

/** `[pid(:tid):MMDD/HHMMSS.frac:LEVEL:file.cc(line)]`, Chromium's log prefix. */
const CHROMIUM_LINE =
  /^\[\d+(?::\d+)?:\d{4}\/\d{6}\.\d+:(VERBOSE\d|INFO|WARNING|ERROR|FATAL):([\w.-]{1,80}\(\d{1,6}\))\]/;

/**
 * The last lines of a stream that arrives in chunks of any size. A chunk can
 * end inside a line, even inside a character, so text is kept as whole lines:
 * a prefix split over two chunks is matched once its line is complete, and a
 * chunk that starts inside a line is never taken for the start of one. At
 * most `max` lines are kept, each cut to its first `maxLine` characters,
 * the line still under way included.
 */
export class StderrTail {
  private readonly decoder = new StringDecoder('utf8');
  private readonly done: string[] = [];
  private pending = '';

  constructor(
    private readonly max = 400,
    private readonly maxLine = 4096,
  ) {}

  push(chunk: Buffer | string): void {
    const text = this.pending + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    const parts = text.split('\n');
    this.pending = parts.pop()!.slice(0, this.maxLine);
    for (const line of parts) this.done.push(line.slice(0, this.maxLine));
    this.done.splice(0, Math.max(0, this.done.length - this.max));
  }

  /** The kept lines, oldest first; the line under way last, since it starts a line too. */
  lines(): string[] {
    const lines = this.pending === '' ? [...this.done] : [...this.done, this.pending];
    return lines.slice(-this.max);
  }
}

/** The last `max` Chromium log lines as "LEVEL file.cc(123)", and how many lines were dropped. */
export function stderrCodes(
  lines: readonly string[],
  max = 40,
): { codes: string[]; dropped: number } {
  const codes: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    const match = CHROMIUM_LINE.exec(line);
    if (match) codes.push(`${match[1]} ${match[2]}`);
    else if (line.trim() !== '') dropped += 1;
  }
  return { codes: codes.slice(-max), dropped };
}
