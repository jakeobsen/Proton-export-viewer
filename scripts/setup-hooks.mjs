// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs from npm's `prepare` script: points git at the versioned hooks.
// Outside a git checkout (for example an unpacked tarball) it does nothing.

import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function insideWorkTree() {
  try {
    return git(['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

if (insideWorkTree()) {
  git(['config', 'core.hooksPath', '.githooks']);
}
