// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every check, in order, and stops at the first failure.
//
//   node scripts/ci.mjs          the full suite; needs macOS (packaging,
//                                code signing, the sandboxed build)
//   node scripts/ci.mjs linux    the checks that run on Linux: everything up to
//                                the license check, without packaging

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Test output from earlier runs, kept by failed tests as evidence, goes
// before each run, so the folder never grows from run to run.
const TEST_OUTPUT = fileURLToPath(new URL('../test-output', import.meta.url));

const ALL_STEPS = [
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

const linux = process.argv[2] === 'linux';
if (process.argv.length > 3 || (process.argv[2] !== undefined && !linux)) {
  console.error('usage: node scripts/ci.mjs [linux]');
  process.exit(2);
}
if (!linux && process.platform !== 'darwin') {
  console.error('ci: the full suite needs macOS; run `npm run ci:linux` here');
  process.exit(2);
}
const STEPS = linux
  ? ALL_STEPS.slice(0, ALL_STEPS.findIndex(([name]) => name === 'license check') + 1)
  : ALL_STEPS;

rmSync(TEST_OUTPUT, { recursive: true, force: true });

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
