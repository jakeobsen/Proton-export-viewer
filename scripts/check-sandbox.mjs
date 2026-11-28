// SPDX-License-Identifier: AGPL-3.0-or-later
// Sandboxed-build checks (no debugging port):
// 1. in the sandboxed self-test build, the MAS release build and the local
//    build, every nested bundle and every Mach-O file is listed; the app's
//    executable and every other executable carry exactly the entitlements
//    expected for that flavor, and no login-item helper is shipped;
// 2. the in-app self-test passes in the sandbox: core and its worker answer,
//    the protocols serve, a write outside the container fails with a sandbox
//    denial, and a loopback connect does what the build's entitlements say:
//    it succeeds with outgoing connections allowed, and is denied without;
// 3. positive control: the same self-test unsandboxed makes the write and the
//    connect succeed, and the listener sees the connection;
// 4. smoke: the sandboxed self-test opens a small generated export from its
//    container through the shell and the production source, opens messages,
//    switches to plain text, clicks a link, opens a message whose file is
//    missing and forgets the export. Nothing is logged as an error, and the
//    export is removed afterwards.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RUN_FOLDER, accountAddress, entries } from '../tools/gen-export/generator.mjs';
import {
  APP_ENTITLEMENTS_OF,
  HELPER_ENTITLEMENTS,
  PROOF_FLAVORS,
  connectsOut,
} from './entitlements.mjs';
import { APP_ID, PRODUCT_NAME, appPath } from './package.mjs';
import { bundleContents } from './bundle-contents.mjs';
import { removeOutputDir, testOutputOf } from './test-output.mjs';

const require = createRequire(join(process.cwd(), 'package.json'));

const DENIED = new Set(['EPERM', 'EACCES']);

/** The smoke's export: at most this many messages, and at most 20 MB. */
const SMOKE_MESSAGES = 20;
const SMOKE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Writes a small generated export under `root`, in the export tool's layout,
 * with the first message's .eml left out. Returns the message count and size.
 */
function writeSmokeExport(root) {
  const run = join(root, accountAddress('small', 7), RUN_FOLDER);
  mkdirSync(run, { recursive: true });
  const ids = new Set();
  let bytes = 0;
  for (const entry of entries('small', { seed: 7 })) {
    if ('meta' in entry || entry.type !== 'file' || !entry.data) continue;
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    const id = name === 'labels.json' ? null : name.replace(/\.(?:metadata\.json|eml)$/, '');
    if (id !== null && !ids.has(id)) {
      if (ids.size >= SMOKE_MESSAGES) continue;
      ids.add(id);
    }
    mkdirSync(dirname(join(run, name)), { recursive: true });
    writeFileSync(join(run, name), entry.data);
    bytes += entry.data.length;
  }
  const missing = [...ids].sort()[0];
  rmSync(join(run, `${missing}.eml`));
  return { messages: ids.size, bytes };
}

/** The size of each log file, to read only what a run appends. */
function logSizes(dir) {
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir).map((f) => [f, statSync(join(dir, f)).size]));
}

/** The log lines appended since `before`. */
function newLogLines(dir, before) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(dir, f))
        .subarray(before.get(f) ?? 0)
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l)),
    );
}
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
    const expected =
      executable === mainExecutable ? APP_ENTITLEMENTS_OF[flavor] : HELPER_ENTITLEMENTS;
    const actual = entitlementsOf(join(app, executable));
    check(
      canonical(actual) === canonical(expected),
      `${flavor}: ${executable} entitlements ${canonical(actual)}`,
    );
    if (flavor === 'mas-local') {
      check(
        !('com.apple.security.files.downloads.read-write' in actual),
        `${flavor}: ${executable} has no Downloads write access`,
      );
    }
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
  return {
    server,
    port,
    accepted,
    count: () => connections,
    reset: () => {
      connections = 0;
    },
  };
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

/** True when the self-test's probe saw one show, then one focus, of one window. */
function recorderConnected(result) {
  const probe = result.recorderProbe;
  return (
    Array.isArray(probe) &&
    probe.length === 2 &&
    probe[0]?.event === 'show' &&
    probe[1]?.event === 'focus' &&
    Number.isSafeInteger(probe[0]?.window) &&
    probe[0].window > 0 &&
    probe[1].window === probe[0].window
  );
}

/** The self-test's record of show and focus events, which must be empty. */
function noWindowEvents(result) {
  return Array.isArray(result.windowEvents) && result.windowEvents.length === 0;
}

async function main() {
  checkEntitlements('mas-selftest');
  checkEntitlements('mas-release');
  checkEntitlements('mas-local');
  // The proofs, with the store set and outgoing connections, when packaged.
  for (const flavor of PROOF_FLAVORS) {
    if (existsSync(appPath(flavor))) checkEntitlements(flavor);
    else console.log(`skip ${flavor}: not packaged`);
  }

  const sandboxOutput = join(testOutputOf(), 'sandbox');
  const outDir = join(sandboxOutput, `${Date.now()}`);
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
  const appData = join(container, 'Data', 'Library', 'Application Support', PRODUCT_NAME);
  const resultIn = (nonce) => join(appData, `selftest-result-${nonce}.json`);
  const sandboxed = readResult(resultIn(sandboxNonce), sandboxNonce);
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
    if (connectsOut('mas-selftest')) {
      check(sandboxed.connect.ok === true, 'sandboxed: connect allowed, as the entitlements say');
    } else {
      check(
        !sandboxed.connect.ok && DENIED.has(sandboxed.connect.code),
        `sandboxed: connect denied (${sandboxed.connect.code})`,
      );
    }
    check(sandboxed.error === null, `sandboxed: no self-test error (${sandboxed.error})`);
    check(sandboxed.shownWindows === 0, 'sandboxed: no window was shown or focused');
    check(
      noWindowEvents(sandboxed),
      `sandboxed: no show or focus event recorded (${JSON.stringify(sandboxed.windowEvents)})`,
    );
    check(
      recorderConnected(sandboxed),
      `sandboxed: the event recorder is connected (${JSON.stringify(sandboxed.recorderProbe)})`,
    );
  }
  check(!existsSync(sandboxTarget), 'sandboxed: the write target does not exist');
  const expected = connectsOut('mas-selftest') ? 1 : 0;
  check(
    listener.count() === expected,
    `sandboxed: the listener saw ${listener.count()} connections (expected ${expected})`,
  );
  listener.reset();

  // Smoke: a generated export in the container, opened as a user would.
  const smokeNonce = randomBytes(8).toString('hex');
  const smokeRoot = join(container, 'Data', `smoke-export-${smokeNonce}`);
  const written = writeSmokeExport(smokeRoot);
  // The export goes afterwards, whatever happened.
  try {
    check(written.bytes <= SMOKE_MAX_BYTES, `smoke: the export is ${written.bytes} bytes`);
    const logsDir = join(appData, 'logs');
    const logsBefore = logSizes(logsDir);
    const smokeRun = await run(
      join(app, 'Contents', 'MacOS', PRODUCT_NAME),
      ['--pev-selftest', `--pev-selftest-nonce=${smokeNonce}`, `--pev-selftest-smoke=${smokeRoot}`],
      120_000,
    );
    const smokeResult = readResult(resultIn(smokeNonce), smokeNonce);
    const smoke = smokeResult?.smoke ?? null;
    check(
      !smokeRun.timedOut && smokeRun.code === 0,
      `smoke: self-test exited 0 (${JSON.stringify(smokeRun)})`,
    );
    check(smoke !== null && smoke.error === null, `smoke: ran to the end (${smoke?.error})`);
    if (smoke) {
      check(smoke.chosen === 'opened', `smoke: the export opened (${smoke.chosen})`);
      check(
        smoke.totals?.pairs === written.messages && smoke.totals?.messages === written.messages,
        `smoke: phase 1 indexed ${written.messages} messages (${JSON.stringify(smoke.totals)})`,
      );
      check(
        smoke.newest?.body === 200,
        `smoke: the newest message opens (${JSON.stringify(smoke.newest)})`,
      );
      check(
        smoke.plain?.format === 'plain' && smoke.plain.body === 200 && smoke.plain.oldBody === 404,
        `smoke: plain text opens with a new token (${JSON.stringify(smoke.plain)})`,
      );
      check(
        smoke.link?.dialogs === 1,
        `smoke: a link click adds one dialog record (${JSON.stringify(smoke.link)})`,
      );
      check(
        smoke.missing?.code === 'eml_missing' && smoke.missing.text === 'Message file missing',
        `smoke: the missing message file shows its state (${JSON.stringify(smoke.missing)})`,
      );
      const fetcher = smoke.fetcher;
      check(
        fetcher?.ready === true,
        `smoke: the fetcher starts sandboxed (${JSON.stringify(fetcher)})`,
      );
      check(
        JSON.stringify(fetcher?.order) ===
          JSON.stringify(['scope.release', 'fetcher.spawn', 'scope.start']),
        `smoke: the fetcher is spawned with the folder access released (${JSON.stringify(fetcher?.order)})`,
      );
      // The smoke's export is in the container, which every helper can read:
      // the limit, documented. The folder proof shows the release itself.
      check(
        fetcher?.read?.ok === true,
        `smoke: the fetcher reads a file in the container (${JSON.stringify(fetcher?.read)})`,
      );
      check(smoke.forgotten === 'forgotten', `smoke: the export is forgotten (${smoke.forgotten})`);
      check(
        smokeResult.shownWindows === 0 && noWindowEvents(smokeResult),
        'smoke: no window was shown or focused',
      );
    }
    const errors = newLogLines(logsDir, logsBefore).filter((l) => l.level === 'error');
    check(
      errors.length === 0,
      `smoke: nothing logged as an error (${errors.map((e) => e.code).join(', ') || 'none'})`,
    );
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
  check(!existsSync(smokeRoot), 'smoke: the export is removed');

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
    check(
      noWindowEvents(control),
      `control: no show or focus event recorded (${JSON.stringify(control.windowEvents)})`,
    );
    check(
      recorderConnected(control),
      `control: the event recorder is connected (${JSON.stringify(control.recorderProbe)})`,
    );
  }
  check(existsSync(controlTarget), 'control: the write target exists');
  check(listener.count() >= 1, `control: the listener saw ${listener.count()} connection(s)`);
  listener.server.close();

  if (failures.length > 0) {
    console.error(`check-sandbox: ${failures.length} failure(s); evidence in ${outDir}`);
    process.exit(1);
  }
  // A passing run leaves nothing behind; a failing one keeps its folder.
  removeOutputDir(sandboxOutput, outDir);
  console.log('check-sandbox: ok');
}

await main();
