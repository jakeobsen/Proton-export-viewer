// SPDX-License-Identifier: AGPL-3.0-or-later
// Release-build checks, on the standard release build and the Mac App Store
// release build (both without test hooks, so no debugging port):
// 1. the fuses read back from the packaged binary;
// 2. the packaged main bundle carries the production shell CSP literal and no
//    development CSP (the e2e suite checks that this same code serves it);
// 3. no test hook, probe, test page or local path is in the package.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { appPath } from './package.mjs';

const require = createRequire(join(process.cwd(), 'package.json'));
const asar = require('@electron/asar');

export const PROD_SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' mail-asset:; font-src 'self'; frame-src mail-body:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const EXPECTED_FUSES = {
  RunAsNode: FuseState.DISABLE,
  EnableCookieEncryption: FuseState.ENABLE,
  EnableNodeOptionsEnvironmentVariable: FuseState.DISABLE,
  EnableNodeCliInspectArguments: FuseState.DISABLE,
  EnableEmbeddedAsarIntegrityValidation: FuseState.ENABLE,
  OnlyLoadAppFromAsar: FuseState.ENABLE,
  GrantFileProtocolExtraPrivileges: FuseState.DISABLE,
};

// Strings that only exist in test hooks, test pages, test stubs or the dev server setup.
const FORBIDDEN_CONTENT = [
  'pev-testhooks-present',
  '__pevTest',
  'probe.png',
  'probe.css',
  '/__test/',
  'pev-selftest',
  'pev-script-marker',
  'pev-bench',
  'pev-open-bench',
  'pev-reader-test-source',
  'pev-reader-unsanitized',
  'pev-no-resolver-rule',
  'sessionPreconnects',
  'readByName',
  'openGapMs',
  'better-sqlite3',
  'ws://localhost',
  "style-src 'self' 'unsafe-inline'",
  '/Users/',
];
const FORBIDDEN_PATH = /testhooks|__test|bundled-|out-test|bench-worker/;

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

async function checkFlavor(flavor) {
  const app = appPath(flavor);

  const wire = await getCurrentFuseWire(app);
  for (const [name, expected] of Object.entries(EXPECTED_FUSES)) {
    const actual = wire[FuseV1Options[name]];
    check(
      actual === expected,
      `${flavor}: fuse ${name} = ${actual === FuseState.ENABLE ? 'on' : 'off'}`,
    );
  }

  const archive = join(app, 'Contents', 'Resources', 'app.asar');
  const files = asar
    .listPackage(archive, { isPack: false })
    .map((f) => f.replace(/^\//, ''))
    .filter((f) => {
      try {
        return !asar.statFile(archive, f).files;
      } catch {
        return false;
      }
    });
  check(files.includes('out/main/index.js'), `${flavor}: package holds out/main/index.js`);
  check(
    files.includes('out/renderer/index.html'),
    `${flavor}: package holds out/renderer/index.html`,
  );

  const text = (f) => asar.extractFile(archive, f).toString('utf8');
  const mainCode = files
    .filter((f) => f.startsWith('out/main/') && f.endsWith('.js'))
    .map(text)
    .join('\n');
  check(
    mainCode.split(PROD_SHELL_CSP).length - 1 === 1,
    `${flavor}: main bundle carries the production shell CSP once`,
  );

  const html = text('out/renderer/index.html');
  check(
    !/http-equiv\s*=\s*["']?content-security-policy/i.test(html),
    `${flavor}: shell HTML has no meta CSP`,
  );
  check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${flavor}: shell HTML has no inline script`);

  const badPaths = files.filter((f) => FORBIDDEN_PATH.test(f));
  check(badPaths.length === 0, `${flavor}: no test-only files (${badPaths.join(', ') || 'none'})`);
  for (const f of files) {
    const content = text(f);
    const hits = FORBIDDEN_CONTENT.filter((s) => content.includes(s));
    if (hits.length > 0) check(false, `${flavor}: ${f} contains ${hits.join(', ')}`);
  }
  check(true, `${flavor}: scanned ${files.length} packaged files for test-only content`);
}

for (const flavor of ['release', 'mas-release']) await checkFlavor(flavor);

if (failures.length > 0) {
  console.error(`check-release: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('check-release: ok');
