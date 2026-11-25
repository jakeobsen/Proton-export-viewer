// SPDX-License-Identifier: AGPL-3.0-or-later
// Main process entry: the broker. It never parses mail and holds no network code.

import { dirname, join, sep } from 'node:path';
import { app, protocol } from 'electron';
import { SHELL_CSP } from '../shared/constants';
import { errorData } from '../shared/log/schema';
import { LogWriter } from '../shared/log/writer';
import type { AppContext, Paths } from './context';
import { CoreHost } from './core-host';
import { registerIpc } from './ipc';
import { LinkDialog } from './link-dialog';
import { applySwitches } from './switches';
import { createAppWindow } from './windows';

process.umask(0o077);

if (__PEV_TEST_HOOKS__ && process.platform === 'darwin') {
  // Test runs stay in the background: no Dock icon and no activation.
  app.setActivationPolicy('accessory');
}

const mainDir = import.meta.dirname;
const outRoot = dirname(mainDir);
const paths: Paths = {
  mainDir,
  outRoot,
  rendererDir: join(outRoot, 'renderer'),
  preloadPath: join(outRoot, 'preload', 'index.cjs'),
  corePath: join(mainDir, 'core.js'),
};

if (__PEV_TEST_HOOKS__) {
  // Test runs keep every file they write inside a directory they choose.
  const arg = process.argv.find((a) => a.startsWith('--pev-user-data='));
  if (arg) {
    const dir = arg.slice('--pev-user-data='.length);
    app.setPath('userData', dir);
    app.setPath('sessionData', join(dir, 'session'));
    app.setPath('downloads', join(dir, 'downloads'));
    app.setPath('crashDumps', join(dir, 'crash'));
  }
}

applySwitches(app.commandLine);
app.enableSandbox();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true } },
  { scheme: 'mail-body', privileges: { standard: true, secure: true } },
  { scheme: 'mail-asset', privileges: { standard: true, secure: true } },
]);

const logsDir = join(app.getPath('userData'), 'logs');
const log = new LogWriter(logsDir, 'main', 'main');
const rendererLog = new LogWriter(logsDir, 'renderer', 'renderer');
const frameRoots: Array<[string, string]> = [
  [outRoot + sep, ''],
  ['app://shell/', 'renderer/'],
];

process.on('uncaughtException', (err) => log.error('main.uncaught', errorData(err, frameRoots)));
process.on('unhandledRejection', (reason) =>
  log.error('main.rejection', errorData(reason, frameRoots)),
);

app.on('child-process-gone', (_event, details) => {
  log.error('child.gone', {
    processType: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => app.quit());

log.info('app.start', {
  appVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
});

async function start(): Promise<void> {
  const ctx: AppContext = {
    paths,
    log,
    rendererLog,
    frameRoots,
    generation: 1,
    windows: new Map(),
    core: new CoreHost({ corePath: paths.corePath, logsDir, appRoot: outRoot, log }),
    linkDialog: new LinkDialog(log),
    shellCsp: SHELL_CSP,
  };
  registerIpc(ctx);
  if (__PEV_TEST_HOOKS__) {
    const hooks = await import('../testhooks/main');
    if (await hooks.install(ctx)) return;
  }
  createAppWindow(ctx);
  log.info('app.ready');
}

app
  .whenReady()
  .then(start, (err: unknown) => log.error('main.uncaught', errorData(err, frameRoots)));
