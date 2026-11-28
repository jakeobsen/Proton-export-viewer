// SPDX-License-Identifier: AGPL-3.0-or-later
// Release-build checks, on the standard release build, the Mac App Store
// release build and the local build (all without test hooks, so no debugging
// port):
// 1. the fuses read back from the packaged binary;
// 2. the packaged main bundle carries the production shell CSP literal and no
//    development CSP (the e2e suite checks that this same code serves it);
// 3. no test hook, probe, test page or local path is in the package; the test
//    build, as a control, holds the self-test's own strings and those of the
//    test hooks' stub open (its channel and the bodies it builds).

import { readFileSync, readdirSync } from 'node:fs';
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

// Strings only the self-test's smoke has; the test build must hold them (a control).
const SELFTEST_ONLY = ['debugger.attach', 'Page.createIsolatedWorld'];

// Strings only the test hooks' stub open has: its IPC channel, its name, and
// the body the stub builder makes. The test build must hold them too (a
// control), the channel in each of its main, preload and renderer bundles.
const STUB_CHANNEL = 'pev:open-stub';
const STUB_ONLY = [STUB_CHANNEL, 'openStub', 'stub-title', 'Placeholder body.'];

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
  // The self-test's smoke drives the body frame through the DevTools protocol.
  ...SELFTEST_ONLY,
  ...STUB_ONLY,
  // The stub open's old refusal code, gone with it from the release code.
  'unknown_stub',
  // Core's hold of a read once its message file is open.
  'holdingOpened',
  'hold-opened',
  // Core's hold of the shell's cards queries.
  'holdCardsAt',
  'hold-cards',
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

for (const flavor of ['release', 'mas-release', 'mas-local']) await checkFlavor(flavor);

// Control: the test build holds the self-test's and the stub open's strings, so
// the scan above would find them if they ever reached a release package.
const testCode = Object.fromEntries(
  ['main', 'preload', 'renderer'].map((dir) => [
    dir,
    readdirSync(join('out-test', dir), { recursive: true })
      .filter((f) => /\.c?js$/.test(String(f)))
      .map((f) => readFileSync(join('out-test', dir, String(f)), 'utf8'))
      .join('\n'),
  ]),
);
for (const s of SELFTEST_ONLY) {
  check(testCode.main.includes(s), `control: the test build holds ${s}`);
}
for (const s of STUB_ONLY) {
  check(
    Object.values(testCode).some((code) => code.includes(s)),
    `control: the test build holds ${s}`,
  );
}
for (const [dir, code] of Object.entries(testCode)) {
  check(code.includes(STUB_CHANNEL), `control: the test build's ${dir} holds ${STUB_CHANNEL}`);
}

if (failures.length > 0) {
  console.error(`check-release: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('check-release: ok');
