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
