// SPDX-License-Identifier: AGPL-3.0-or-later
// What a test run keeps of an app's stderr when the app closes under a test:
// Chromium's log lines by level and source position only. Their text, and
// every other line, is dropped, so the report holds codes and counts only.

/** `[pid(:tid):MMDD/HHMMSS.frac:LEVEL:file.cc(line)]`, Chromium's log prefix. */
const CHROMIUM_LINE =
  /^\[\d+(?::\d+)?:\d{4}\/\d{6}\.\d+:(VERBOSE\d|INFO|WARNING|ERROR|FATAL):([\w.-]{1,80}\(\d{1,6}\))\]/;

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
