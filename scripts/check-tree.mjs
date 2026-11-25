// SPDX-License-Identifier: AGPL-3.0-or-later
// Fails if any tracked path breaks the repository rules, so a skipped hook
// cannot publish real mail or large files.

import { execFileSync } from 'node:child_process';
import { pathProblem, sizeProblem } from './repo-rules.mjs';

// Each line: <mode> <type> <object> <size>\t<path>
const listing = execFileSync('git', ['ls-tree', '-r', '-l', '-z', 'HEAD'], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const problems = [];
for (const entry of listing.split('\0').filter(Boolean)) {
  const tab = entry.indexOf('\t');
  const [, type, , size] = entry.slice(0, tab).split(/\s+/);
  const path = entry.slice(tab + 1);
  if (type !== 'blob') continue;
  const bySize = sizeProblem(Number(size));
  if (bySize) problems.push(`${path}: ${bySize}`);
}
for (const path of tracked) {
  const byPath = pathProblem(path);
  if (byPath) problems.push(`${path}: ${byPath}`);
}

if (problems.length > 0) {
  console.error(`check-tree: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-tree: ok (${tracked.length} tracked paths)`);
