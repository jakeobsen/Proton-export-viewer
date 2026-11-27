// SPDX-License-Identifier: AGPL-3.0-or-later
// The Chromium switches: all of them by default, and a named one left out.

import type { CommandLine } from 'electron';
import { describe, expect, it } from 'vitest';
import { PROD_SWITCHES, applySwitches } from '../../src/main/switches';

function recorder(): { line: CommandLine; appended: Array<[string, string | undefined]> } {
  const appended: Array<[string, string | undefined]> = [];
  const line = {
    appendSwitch: (name: string, value?: string) => appended.push([name, value]),
  } as unknown as CommandLine;
  return { line, appended };
}

describe('the Chromium switches', () => {
  it('applies every production switch', () => {
    const { line, appended } = recorder();
    applySwitches(line);
    expect(appended).toEqual(PROD_SWITCHES.map(([name, value]) => [name, value]));
  });

  it('leaves out only the switches it is asked to drop', () => {
    const { line, appended } = recorder();
    applySwitches(line, ['host-resolver-rules']);
    expect(appended).toEqual([['disable-features', 'Prerender2']]);
  });
});
