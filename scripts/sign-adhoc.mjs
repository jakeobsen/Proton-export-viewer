// SPDX-License-Identifier: AGPL-3.0-or-later
// Ad-hoc code signing for local and CI builds (no certificate). Nested code is
// signed first; helper apps and the main app are then signed with their
// entitlements, if any.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { bundleContents } from './bundle-contents.mjs';

function codesign(target, entitlements) {
  const args = ['--force', '--sign', '-', '--timestamp=none'];
  if (entitlements) args.push('--entitlements', entitlements);
  execFileSync('codesign', [...args, target], { stdio: 'inherit' });
}

/** Every app bundle nested anywhere inside `app`, deepest first. */
export function helperApps(app) {
  return bundleContents(app)
    .bundles.filter((path) => path.endsWith('.app'))
    .sort((a, b) => b.split('/').length - a.split('/').length)
    .map((path) => join(app, path));
}

/**
 * Signs `app` ad hoc. With `entitlements` ({ app, helper }) every nested app
 * gets the helper entitlements and the app gets the app entitlements.
 */
export function signAdHoc(app, entitlements) {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], {
    stdio: 'inherit',
  });
  for (const helper of helperApps(app)) codesign(helper, entitlements?.helper ?? null);
  codesign(app, entitlements?.app ?? null);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}
