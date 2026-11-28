// SPDX-License-Identifier: AGPL-3.0-or-later
// The entitlement files packaging signs with hold exactly what check-sandbox
// expects of each flavor's signed app and helpers, and every flavor may make
// the outgoing connections the image fetcher needs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_ENTITLEMENTS_OF,
  APP_PLIST_OF,
  HELPER_ENTITLEMENTS,
  HELPER_PLIST,
  PROOF_FLAVORS,
  connectsOut,
  type Entitlements,
  type SandboxFlavor,
} from '../../scripts/entitlements.mjs';
import { REPO_ROOT } from '../../scripts/test-output.mjs';

/** The entries of an entitlements plist: true values and string arrays only. */
function readPlist(file: string): Entitlements {
  const xml = readFileSync(join(REPO_ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const dict = /<plist version="1\.0">\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>/.exec(xml)?.[1];
  if (dict === undefined) throw new Error(`${file}: no dict`);
  const out: Entitlements = {};
  const entry = /\s*<key>([^<]+)<\/key>\s*(?:<true\/>|<array>([\s\S]*?)<\/array>)/y;
  let at = 0;
  for (let m = entry.exec(dict); m; m = entry.exec(dict)) {
    const key = m[1]!;
    out[key] =
      m[2] === undefined
        ? true
        : [...m[2].matchAll(/<string>([^<]*)<\/string>/g)].map((s) => s[1]!);
    at = entry.lastIndex;
  }
  if (dict.slice(at).trim() !== '') throw new Error(`${file}: unexpected entry at ${at}`);
  return out;
}

const FLAVORS = Object.keys(APP_ENTITLEMENTS_OF) as SandboxFlavor[];

describe('entitlements', () => {
  it.each(FLAVORS)('signs the %s app with exactly the set check-sandbox expects', (flavor) => {
    expect(readPlist(APP_PLIST_OF[flavor])).toEqual(APP_ENTITLEMENTS_OF[flavor]);
  });

  it('signs every helper with exactly the inherited sandbox', () => {
    expect(readPlist(HELPER_PLIST)).toEqual(HELPER_ENTITLEMENTS);
  });

  it.each(FLAVORS)('lets the %s app connect out, for the image fetcher', (flavor) => {
    expect(APP_ENTITLEMENTS_OF[flavor]['com.apple.security.network.client']).toBe(true);
    expect(connectsOut(flavor)).toBe(true);
  });

  it('signs the folder-access proofs with the store set, outgoing connections included', () => {
    for (const flavor of PROOF_FLAVORS) {
      expect(APP_ENTITLEMENTS_OF[flavor]).toEqual(APP_ENTITLEMENTS_OF['mas-release']);
      expect(APP_PLIST_OF[flavor]).toBe(APP_PLIST_OF['mas-release']);
    }
    expect(PROOF_FLAVORS).toEqual(['mas-folderproof', 'mas-fetcherproof']);
  });

  it('keeps Downloads write access out of the local build', () => {
    expect(APP_ENTITLEMENTS_OF['mas-local']).not.toHaveProperty([
      'com.apple.security.files.downloads.read-write',
    ]);
  });

  it('refuses a file that is not an entitlements plist', () => {
    expect(() => readPlist('package.json')).toThrow(/no dict/);
  });
});
