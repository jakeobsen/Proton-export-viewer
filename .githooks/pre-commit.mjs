// SPDX-License-Identifier: AGPL-3.0-or-later
// Checks every staged path and staged blob size against the repository rules.

import { execFileSync } from 'node:child_process';
import { pathProblem, sizeProblem } from '../scripts/repo-rules.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

// Added, copied, modified or renamed entries, by their new path.
const staged = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
  .toString('utf8')
  .split('\0')
  .filter(Boolean);

const problems = [];
for (const path of staged) {
  const byPath = pathProblem(path);
  if (byPath) {
    problems.push(`${path}: ${byPath}`);
    continue;
  }
  // `:path` is the blob in the index, not the file in the working tree.
  const size = Number(
    git(['cat-file', '-s', `:${path}`])
      .toString('utf8')
      .trim(),
  );
  const bySize = sizeProblem(size);
  if (bySize) problems.push(`${path}: ${bySize}`);
}

if (problems.length > 0) {
  process.stderr.write(`pre-commit: blocked\n${problems.map((p) => `  ${p}\n`).join('')}`);
  process.exit(1);
}
