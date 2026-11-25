// SPDX-License-Identifier: AGPL-3.0-or-later
// Fails if any tracked path breaks the repository rules, so a skipped hook
// cannot publish real mail or large files, and if any tracked text file turns
// the Chromium sandbox off.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { contentProblem, pathProblem, sizeProblem } from './repo-rules.mjs';

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
  if (!existsSync(path)) continue;
  const content = readFileSync(path);
  if (content.includes(0)) continue; // binary
  const byContent = contentProblem(content.toString('utf8'));
  if (byContent) problems.push(`${path}: ${byContent}`);
}

if (problems.length > 0) {
  console.error(`check-tree: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-tree: ok (${tracked.length} tracked paths)`);
