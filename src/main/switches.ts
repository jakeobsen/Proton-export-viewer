// SPDX-License-Identifier: AGPL-3.0-or-later
// Chromium switches applied before the app is ready.

import type { CommandLine } from 'electron';

/**
 * Production switches:
 * - every host name resolves to NOTFOUND, so no DNS query leaves the app;
 * - speculative prerendering is off.
 */
export const PROD_SWITCHES: ReadonlyArray<readonly [string, string]> = [
  ['host-resolver-rules', 'MAP * ~NOTFOUND'],
  ['disable-features', 'Prerender2'],
];

export function applySwitches(commandLine: CommandLine): void {
  for (const [name, value] of PROD_SWITCHES) {
    // The dev server is reached by host name, so the resolver rule stays off in dev.
    if (__PEV_DEV__ && name === 'host-resolver-rules') continue;
    commandLine.appendSwitch(name, value);
  }
}
