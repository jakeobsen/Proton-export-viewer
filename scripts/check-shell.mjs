// SPDX-License-Identifier: AGPL-3.0-or-later
// Checks every tracked shell script: `sh -n` (syntax) everywhere, and with
// --shellcheck also ShellCheck, which must be installed (the Linux CI job
// installs it).
//
//   node scripts/check-shell.mjs [--shellcheck]

import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const withShellCheck = args.length === 1 && args[0] === '--shellcheck';
if (args.length > 1 || (args.length === 1 && !withShellCheck)) {
  console.error('usage: node scripts/check-shell.mjs [--shellcheck]');
  process.exit(2);
}

const scripts = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.sh'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

const problems = [];
for (const path of scripts) {
  const run = spawnSync('/bin/sh', ['-n', path], { encoding: 'utf8' });
  if (run.status !== 0) problems.push(`${path}: sh -n failed\n${run.stderr}`);
}

if (withShellCheck) {
  const version = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    console.error('check-shell: shellcheck is not installed');
    process.exit(1);
  }
  process.stdout.write(version.stdout);
  if (scripts.length > 0) {
    const run = spawnSync('shellcheck', ['--shell=sh', '--severity=style', ...scripts], {
      encoding: 'utf8',
    });
    if (run.status !== 0) problems.push(`shellcheck:\n${run.stdout}${run.stderr}`);
  }
}

if (problems.length > 0) {
  console.error(`check-shell: ${problems.length} problem(s)`);
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(
  `check-shell: ok (${scripts.length} scripts${withShellCheck ? ', sh -n and shellcheck' : ', sh -n'})`,
);
