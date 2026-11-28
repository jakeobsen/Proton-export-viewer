// SPDX-License-Identifier: AGPL-3.0-or-later
// Packages one build flavor as an unsigned app directory, then signs it ad hoc.
//
//   release       standard Electron, fuses applied, no test hooks      (from out/)
//   mas-release   Mac App Store flavor, sandboxed, no test hooks       (from out/)
//   mas-selftest  Mac App Store flavor, sandboxed, with test hooks     (from out-test/)
//   test          standard Electron, fuses applied, with test hooks    (from out-test/)
//   mas-folderproof  Mac App Store flavor, sandboxed, the folder-access proof
//                 (from out-proof/), with its own bundle ID. It shows the
//                 system folder picker, so tests never launch it.
//   mas-fetcherproof  the same, built with PEV_FOLDER_PROOF_STEP=fetcher: the
//                 fetcher's proof (one pick), with a bundle ID of its own.
//   mas-local     Mac App Store flavor, sandboxed, no test hooks       (from out/)
//                 The build to run on one's own Mac outside the App Store:
//                 its own bundle ID and app group, so its data never shares a
//                 container with a test build, and no Downloads write access.
//                 Tests never launch it.

import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { Arch, Platform, build } from 'electron-builder';
import { APP_ID, APP_PLIST, APP_PLIST_OF, HELPER_PLIST, LOCAL_APP_ID } from './entitlements.mjs';
import { signAdHoc } from './sign-adhoc.mjs';
import { appName } from './vite-plugins.mjs';

export { APP_ID, LOCAL_APP_ID };
// The app group in the entitlements, APP_ID, is a prefix of this bundle ID, as
// the Mac App Store build of Electron requires.
export const FOLDER_PROOF_APP_ID = `${APP_ID}.folderproof2`;
export const FETCHER_PROOF_APP_ID = `${APP_ID}.fetcherproof`;
export const PRODUCT_NAME = appName();

export const FUSES = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
  enableEmbeddedAsarIntegrityValidation: true,
  grantFileProtocolExtraPrivileges: false,
  enableCookieEncryption: true,
};

const FLAVORS = {
  release: { out: 'out', mas: false },
  'mas-release': { out: 'out', mas: true },
  'mas-selftest': { out: 'out-test', mas: true },
  test: { out: 'out-test', mas: false },
  'mas-folderproof': {
    out: 'out-proof',
    mas: true,
    appId: FOLDER_PROOF_APP_ID,
    entitlements: APP_PLIST_OF['mas-folderproof'],
  },
  'mas-fetcherproof': {
    out: 'out-proof',
    mas: true,
    appId: FETCHER_PROOF_APP_ID,
    entitlements: APP_PLIST_OF['mas-fetcherproof'],
  },
  'mas-local': {
    out: 'out',
    mas: true,
    appId: LOCAL_APP_ID,
    entitlements: APP_PLIST_OF['mas-local'],
  },
};

export function appPath(flavor) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const dir = FLAVORS[flavor].mas ? `mas-${arch}` : arch === 'arm64' ? 'mac-arm64' : 'mac';
  return join('dist', flavor, dir, `${PRODUCT_NAME}.app`);
}

/**
 * Electron's Mac App Store build includes a login-item helper app, used only by
 * app.setLoginItemSettings. This app registers no login items, so the helper is
 * removed instead of shipping an executable it never runs.
 */
function removeLoginHelper(app) {
  const library = join(app, 'Contents', 'Library');
  const loginItems = join(library, 'LoginItems');
  if (existsSync(loginItems)) rmSync(loginItems, { recursive: true });
  if (existsSync(library) && readdirSync(library).length === 0) rmdirSync(library);
}

export async function packageFlavor(flavor) {
  const spec = FLAVORS[flavor];
  if (!spec) throw new Error(`unknown flavor ${flavor}`);
  if (!existsSync(join(spec.out, 'main', 'index.js'))) {
    throw new Error(`${spec.out}/ is missing; build it first`);
  }
  const arch = process.arch === 'arm64' ? Arch.arm64 : Arch.x64;
  await build({
    targets: Platform.MAC.createTarget([spec.mas ? 'mas' : 'dir'], arch),
    publish: 'never',
    config: {
      appId: spec.appId ?? APP_ID,
      productName: PRODUCT_NAME,
      directories: { output: join('dist', flavor), buildResources: 'build' },
      files: [`${spec.out}/**/*`, `!${spec.out}/bundled-*.json`, `!${spec.out}/package.json`],
      extraMetadata: { main: `${spec.out}/main/index.js` },
      asar: true,
      npmRebuild: false,
      electronFuses: FUSES,
      mac: { identity: null, hardenedRuntime: false, gatekeeperAssess: false },
      mas: { identity: null, hardenedRuntime: false },
    },
  });
  const app = appPath(flavor);
  if (!existsSync(app)) throw new Error(`expected ${app}`);
  if (spec.mas) removeLoginHelper(app);
  signAdHoc(
    app,
    spec.mas
      ? {
          app: spec.entitlements ?? APP_PLIST,
          helper: HELPER_PLIST,
        }
      : null,
  );
  console.log(`package: ${flavor} -> ${app}`);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flavor = process.argv[2];
  packageFlavor(flavor).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
