// SPDX-License-Identifier: AGPL-3.0-or-later
// Ad-hoc code signing for local and CI builds (no certificate). Nested code is
// signed first; helper apps and the main app are then signed with their
// entitlements, if any.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function codesign(target, entitlements) {
  const args = ['--force', '--sign', '-', '--timestamp=none'];
  if (entitlements) args.push('--entitlements', entitlements);
  execFileSync('codesign', [...args, target], { stdio: 'inherit' });
}

/** Helper app bundles inside Contents/Frameworks. */
export function helperApps(app) {
  const frameworks = join(app, 'Contents', 'Frameworks');
  return readdirSync(frameworks)
    .filter((name) => name.endsWith('.app'))
    .map((name) => join(frameworks, name));
}

/**
 * Signs `app` ad hoc. With `entitlements` ({ app, helper }) the helpers get the
 * helper entitlements and the app gets the app entitlements.
 */
export function signAdHoc(app, entitlements) {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], {
    stdio: 'inherit',
  });
  for (const helper of helperApps(app)) codesign(helper, entitlements?.helper ?? null);
  codesign(app, entitlements?.app ?? null);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}
