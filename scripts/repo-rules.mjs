// SPDX-License-Identifier: AGPL-3.0-or-later
// Rules for what may be committed. Used by the pre-commit hook and by CI.

export const MAX_BLOB_BYTES = 5 * 1024 * 1024;

const SAMPLE_DIR_RE = /(?:^|\/)data-sample(?:\/|$)/;
const FIXTURES_RE = /(?:^|\/)fixtures\//;
const MAIL_FILE_RE = /\.(?:eml|metadata\.json)$/i;

/** Returns why a repository path may not be committed, or null. */
export function pathProblem(path) {
  if (SAMPLE_DIR_RE.test(path)) return 'path under data-sample/';
  if (MAIL_FILE_RE.test(path) && !FIXTURES_RE.test(path)) {
    return '.eml or .metadata.json outside fixtures/';
  }
  return null;
}

/** Returns why a blob of this size may not be committed, or null. */
export function sizeProblem(bytes) {
  return bytes > MAX_BLOB_BYTES ? `larger than ${MAX_BLOB_BYTES} bytes` : null;
}

// Command-line switches, environment variables and settings that turn
// Chromium's sandbox off, in any spelling. The patterns are written so that
// their own source text does not match them.
const SANDBOX_OFF_RES = [
  /no[-_](?:zygote[-_])?sandbox/i,
  /electron[-_]disable[-_]sandbox/i,
  /disable[-_](?:setuid|seccomp[-_]filter|gpu|renderer|namespace)[-_]sandbox/i,
  /sandbox['"]?\s*[:=]\s*false/i,
];

/** Returns why this file content may not be committed, or null. */
export function contentProblem(text) {
  for (const re of SANDBOX_OFF_RES) {
    const match = re.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      return `turns the Chromium sandbox off (line ${line}: ${match[0]})`;
    }
  }
  return null;
}
