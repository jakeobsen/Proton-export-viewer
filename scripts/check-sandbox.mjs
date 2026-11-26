// SPDX-License-Identifier: AGPL-3.0-or-later
// Sandboxed-build checks (no debugging port):
// 1. in the sandboxed self-test build and in the MAS release build, every
//    nested bundle and every Mach-O file is listed; the app's executable and
//    every other executable carry exactly the expected entitlements, and no
//    login-item helper is shipped;
// 2. the in-app self-test passes in the sandbox: core and its worker answer,
//    the protocols serve, and both a write outside the container and a
//    loopback connect fail with a sandbox denial;
// 3. positive control: the same self-test unsandboxed makes the write and the
//    connect succeed, and the listener sees the connection.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_ID, PRODUCT_NAME, appPath } from './package.mjs';
import { bundleContents } from './bundle-contents.mjs';

const require = createRequire(join(process.cwd(), 'package.json'));

// The application group is required by Electron's Mac App Store build: Chromium
// registers the Mach service `<group>.MachPortRendezvousServer.<pid>`, and the
// sandbox only allows names prefixed by one of the app's groups.
export const APP_ENTITLEMENTS = {
  'com.apple.security.app-sandbox': true,
  'com.apple.security.application-groups': [APP_ID],
  'com.apple.security.files.bookmarks.app-scope': true,
  'com.apple.security.files.downloads.read-write': true,
  'com.apple.security.files.user-selected.read-only': true,
};
export const HELPER_ENTITLEMENTS = {
  'com.apple.security.app-sandbox': true,
  'com.apple.security.inherit': true,
};

const DENIED = new Set(['EPERM', 'EACCES']);
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

/** The signed entitlements of one bundle, as a plain object. */
export function entitlementsOf(bundle) {
  const xml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', bundle], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (xml.length === 0) return {};
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml });
  return JSON.parse(json.toString('utf8'));
}

function canonical(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function checkEntitlements(flavor) {
  const app = appPath(flavor);
  const { bundles, machO } = bundleContents(app);
  const mainExecutable = `Contents/MacOS/${PRODUCT_NAME}`;
  const executables = machO.filter((m) => m.executable).map((m) => m.path);
  const libraries = machO.filter((m) => !m.executable).map((m) => m.path);
  console.log(`     ${flavor}: nested bundles ${JSON.stringify(bundles)}`);
  console.log(`     ${flavor}: Mach-O executables ${JSON.stringify(executables)}`);
  console.log(`     ${flavor}: Mach-O libraries ${JSON.stringify(libraries)}`);

  check(
    !existsSync(join(app, 'Contents', 'Library', 'LoginItems')),
    `${flavor}: no login-item helper`,
  );
  // Nested code is only helper apps and frameworks directly in Contents/Frameworks.
  for (const bundle of bundles) {
    check(
      /^Contents\/Frameworks\/[^/]+\.(app|framework)$/.test(bundle),
      `${flavor}: nested bundle ${bundle} is a helper app or a framework`,
    );
  }
  // Every app bundle's own executable was found by the Mach-O scan.
  for (const bundle of bundles.filter((b) => b.endsWith('.app'))) {
    const name = bundle.slice(bundle.lastIndexOf('/') + 1, -'.app'.length);
    check(
      executables.includes(`${bundle}/Contents/MacOS/${name}`),
      `${flavor}: ${bundle} has its executable in the scan`,
    );
  }
  check(executables.includes(mainExecutable), `${flavor}: the app executable is in the scan`);
  check(executables.length >= 2, `${flavor}: ${executables.length} executables found`);

  for (const executable of executables) {
    const expected = executable === mainExecutable ? APP_ENTITLEMENTS : HELPER_ENTITLEMENTS;
    const actual = entitlementsOf(join(app, executable));
    check(
      canonical(actual) === canonical(expected),
      `${flavor}: ${executable} entitlements ${canonical(actual)}`,
    );
  }
}

async function startListener() {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  // Confirm it accepts before any app is launched.
  await new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.end();
      done();
    });
    socket.once('error', fail);
  });
  await new Promise((done) => setTimeout(done, 100));
  const accepted = connections === 1;
  connections = 0;
  return { server, port, accepted, count: () => connections };
}

function run(executable, args, timeoutMs = 60_000) {
  return new Promise((done) => {
    const child = spawn(executable, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, timedOut: true });
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      done({ code, timedOut: false });
    });
  });
}

function readResult(file, nonce) {
  if (!existsSync(file)) return null;
  const result = JSON.parse(readFileSync(file, 'utf8'));
  return result.nonce === nonce ? result : null;
}

async function main() {
  checkEntitlements('mas-selftest');
  checkEntitlements('mas-release');

  const outDir = resolve('test-output', 'sandbox', `${Date.now()}`);
  mkdirSync(outDir, { recursive: true });
  const listener = await startListener();
  check(listener.accepted, `harness listener on 127.0.0.1:${listener.port} accepts connections`);

  // Sandboxed self-test.
  const app = appPath('mas-selftest');
  const sandboxNonce = randomBytes(8).toString('hex');
  const sandboxTarget = join(outDir, 'sandboxed-write.txt');
  const sandboxRun = await run(join(app, 'Contents', 'MacOS', PRODUCT_NAME), [
    '--pev-selftest',
    `--pev-selftest-write=${sandboxTarget}`,
    `--pev-selftest-port=${listener.port}`,
    `--pev-selftest-nonce=${sandboxNonce}`,
  ]);
  const container = join(homedir(), 'Library', 'Containers', APP_ID);
  const sandboxResultFile = join(
    container,
    'Data',
    'Library',
    'Application Support',
    PRODUCT_NAME,
    `selftest-result-${sandboxNonce}.json`,
  );
  const sandboxed = readResult(sandboxResultFile, sandboxNonce);
  check(
    !sandboxRun.timedOut && sandboxRun.code === 0,
    `sandboxed self-test exited 0 (${JSON.stringify(sandboxRun)})`,
  );
  check(sandboxed !== null, `sandboxed self-test result written into the container (${container})`);
  if (sandboxed) {
    check(sandboxed.sandboxed === true, 'sandboxed: running the MAS build');
    check(
      sandboxed.core === true && sandboxed.worker === true,
      'sandboxed: core and its worker answer',
    );
    check(
      sandboxed.body === 200 && sandboxed.asset === 200,
      'sandboxed: mail-body: and mail-asset: serve',
    );
    check(
      !sandboxed.write.ok && DENIED.has(sandboxed.write.code),
      `sandboxed: write denied (${sandboxed.write.code})`,
    );
    check(
      !sandboxed.connect.ok && DENIED.has(sandboxed.connect.code),
      `sandboxed: connect denied (${sandboxed.connect.code})`,
    );
    check(sandboxed.error === null, `sandboxed: no self-test error (${sandboxed.error})`);
    check(sandboxed.shownWindows === 0, 'sandboxed: no window was shown or focused');
  }
  check(!existsSync(sandboxTarget), 'sandboxed: the write target does not exist');
  check(listener.count() === 0, `sandboxed: the listener saw ${listener.count()} connections`);

  // Positive control: the same self-test, unsandboxed, from the e2e build.
  const userData = join(outDir, 'control-user-data');
  const controlNonce = randomBytes(8).toString('hex');
  const controlTarget = join(outDir, 'control-write.txt');
  const controlRun = await run(require('electron'), [
    resolve('out-test'),
    `--pev-user-data=${userData}`,
    '--pev-selftest',
    `--pev-selftest-write=${controlTarget}`,
    `--pev-selftest-port=${listener.port}`,
    `--pev-selftest-nonce=${controlNonce}`,
  ]);
  const control = readResult(join(userData, `selftest-result-${controlNonce}.json`), controlNonce);
  check(
    !controlRun.timedOut && controlRun.code === 0,
    `control self-test exited 0 (${JSON.stringify(controlRun)})`,
  );
  check(control !== null, 'control: result written');
  if (control) {
    check(control.sandboxed === false, 'control: running unsandboxed');
    check(control.core === true && control.worker === true, 'control: core and its worker answer');
    check(control.body === 200 && control.asset === 200, 'control: protocols serve');
    check(control.write.ok === true, 'control: write succeeds');
    check(control.connect.ok === true, 'control: connect succeeds');
    check(control.shownWindows === 0, 'control: no window was shown or focused');
  }
  check(existsSync(controlTarget), 'control: the write target exists');
  check(listener.count() >= 1, `control: the listener saw ${listener.count()} connection(s)`);
  listener.server.close();

  if (failures.length > 0) {
    console.error(`check-sandbox: ${failures.length} failure(s); evidence in ${outDir}`);
    process.exit(1);
  }
  // A passing run leaves nothing behind; a failing one keeps its folder.
  rmSync(outDir, { recursive: true, force: true });
  console.log('check-sandbox: ok');
}

await main();
