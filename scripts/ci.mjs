// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every check, in order, and stops at the first failure.

import { spawnSync } from 'node:child_process';

const STEPS = [
  ['lint', 'npx', ['eslint', '.', '--max-warnings', '0']],
  ['format', 'npx', ['prettier', '--check', '.']],
  ['typecheck', 'npm', ['run', '--silent', 'typecheck']],
  ['spdx headers', 'node', ['scripts/check-spdx.mjs']],
  ['tree check', 'node', ['scripts/check-tree.mjs']],
  ['unit tests', 'npx', ['vitest', 'run']],
  ['e2e build', 'npx', ['electron-vite', 'build'], { PEV_TEST_HOOKS: '1' }],
  ['e2e tests', 'npx', ['playwright', 'test']],
  ['release build', 'npx', ['electron-vite', 'build']],
  ['license check', 'node', ['scripts/check-licenses.mjs', 'out']],
  ['package release', 'node', ['scripts/package.mjs', 'release']],
  ['package mas-release', 'node', ['scripts/package.mjs', 'mas-release']],
  ['release checks (T10)', 'node', ['scripts/check-release.mjs']],
  ['package mas-selftest', 'node', ['scripts/package.mjs', 'mas-selftest']],
  ['sandbox checks (T11)', 'node', ['scripts/check-sandbox.mjs']],
];

const results = [];
for (const [name, command, args, env] of STEPS) {
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const run = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push([name, run.status === 0, seconds]);
  if (run.status !== 0) break;
}

console.log('\n=== summary');
for (const [name, ok, seconds] of results)
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name} (${seconds}s)`);
const failed = results.some(([, ok]) => !ok) || results.length !== STEPS.length;
process.exit(failed ? 1 : 0);
