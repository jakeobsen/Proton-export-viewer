// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every check, in order, and stops at the first failure.
//
//   node scripts/ci.mjs          the full suite; needs macOS (packaging,
//                                code signing, the sandboxed build)
//   node scripts/ci.mjs linux    the checks that run on Linux: everything up to
//                                the license checks, without packaging
//
// Exit status: 0 when every step passed, 1 when one failed, 3 when a step
// that launches the app couldn't count: the lid was closed with no external
// display (the step doesn't start), or the Mac slept during it (invalid, not
// failed). Run those again with the lid open.

import { spawnSync } from 'node:child_process';
import {
  describePower,
  mayLaunch,
  readLidState,
  readPowerEvents,
  stepOutcome,
} from './power-state.mjs';
import { removeTestOutput } from './test-output.mjs';

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
  ['license check (test build)', 'node', ['scripts/check-licenses.mjs', 'out-test']],
  ['package release', 'node', ['scripts/package.mjs', 'release']],
  ['package mas-release', 'node', ['scripts/package.mjs', 'mas-release']],
  ['package mas-local', 'node', ['scripts/package.mjs', 'mas-local']],
  ['release checks (T10)', 'node', ['scripts/check-release.mjs']],
  ['package mas-selftest', 'node', ['scripts/package.mjs', 'mas-selftest']],
  ['sandbox checks (T11)', 'node', ['scripts/check-sandbox.mjs']],
];

// Steps that launch the app, hidden: a sleep of the Mac can cut them short.
const LAUNCHES_APP = new Set(['e2e tests', 'sandbox checks (T11)']);

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
  ? ALL_STEPS.slice(0, ALL_STEPS.findIndex(([name]) => name === 'license check (test build)') + 1)
  : ALL_STEPS;

// Test output from earlier runs, kept by failed tests as evidence, goes
// before each run, so the folder never grows from run to run.
removeTestOutput();

const results = [];
for (const [name, command, args, env] of STEPS) {
  console.log(`\n=== ${name}`);
  const launches = LAUNCHES_APP.has(name);
  if (launches && !mayLaunch(readLidState())) {
    console.error(
      'ci: the lid is closed and no external display is attached, so this Mac sleeps; ' +
        'the step would not count. Open the lid and run again.',
    );
    results.push([name, 'not run', '0.0']);
    break;
  }
  // pmset logs whole seconds.
  const started = new Date(Date.now() - 1000);
  const run = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  const seconds = ((Date.now() - started.getTime() - 1000) / 1000).toFixed(1);
  const events = launches ? readPowerEvents(started, new Date()) : [];
  const outcome = stepOutcome(run.status, events);
  if (outcome === 'INVALID') {
    console.error(
      `ci: the Mac slept during this step (${describePower(readLidState(), events)}); ` +
        'it is invalid, not failed. Run it again with the lid open.',
    );
  }
  results.push([name, outcome, seconds]);
  if (outcome !== 'pass') break;
}

console.log('\n=== summary');
for (const [name, outcome, seconds] of results) console.log(`${outcome}  ${name} (${seconds}s)`);
const outcomes = new Set(results.map(([, outcome]) => outcome));
if (outcomes.has('FAIL')) process.exit(1);
if (outcomes.has('INVALID') || outcomes.has('not run')) process.exit(3);
process.exit(results.length === STEPS.length ? 0 : 1);
