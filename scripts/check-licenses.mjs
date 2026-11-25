// SPDX-License-Identifier: AGPL-3.0-or-later
// Checks the license of everything that ships: runtime dependencies, every npm
// package bundled into the main, preload or renderer output (devDependencies
// included), and the Electron runtime itself.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { declaredLicense, isAllowedExpression } from './spdx.mjs';

const OUT = process.argv[2] ?? 'out';
const BUNDLE_LISTS = ['bundled-main.json', 'bundled-preload.json', 'bundled-renderer.json'];
const require = createRequire(join(process.cwd(), 'package.json'));

const packages = new Map(); // dir -> reason

for (const list of BUNDLE_LISTS) {
  const file = join(OUT, list);
  if (!existsSync(file)) {
    console.error(`check-licenses: ${file} is missing; build first`);
    process.exit(1);
  }
  for (const entry of JSON.parse(readFileSync(file, 'utf8')))
    packages.set(entry.dir, `bundled (${list})`);
}

// Runtime dependencies that electron-builder would copy into the package.
const tree = JSON.parse(
  execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);
(function walk(node) {
  for (const dep of Object.values(node.dependencies ?? {})) {
    if (dep.path) packages.set(dep.path, 'runtime dependency');
    walk(dep);
  }
})(tree);

// The Electron runtime ships inside every package.
packages.set(dirname(require.resolve('electron/package.json')), 'runtime');

const failures = [];
for (const [dir, reason] of [...packages].sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = declaredLicense(pkg);
  const ok = isAllowedExpression(license);
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${pkg.name}@${pkg.version}  ${license ?? '(none)'}  [${reason}]`,
  );
  if (!ok) failures.push(`${pkg.name}@${pkg.version}: ${license ?? 'no license field'}`);
}

if (failures.length > 0) {
  console.error(`check-licenses: ${failures.length} package(s) not on the allowlist`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-licenses: ok (${packages.size} packages)`);
