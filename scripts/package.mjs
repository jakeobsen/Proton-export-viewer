// SPDX-License-Identifier: AGPL-3.0-or-later
// Packages one build flavor as an unsigned app directory, then signs it ad hoc.
//
//   release       standard Electron, fuses applied, no test hooks      (from out/)
//   mas-release   Mac App Store flavor, sandboxed, no test hooks       (from out/)
//   mas-selftest  Mac App Store flavor, sandboxed, with test hooks     (from out-test/)

import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { Arch, Platform, build } from 'electron-builder';
import { signAdHoc } from './sign-adhoc.mjs';

export const APP_ID = 'com.example.pev';
export const PRODUCT_NAME = 'Proton Export Viewer';

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
      appId: APP_ID,
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
      ? { app: 'build/entitlements.mas.plist', helper: 'build/entitlements.mas.inherit.plist' }
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
