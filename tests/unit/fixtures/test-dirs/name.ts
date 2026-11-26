// SPDX-License-Identifier: AGPL-3.0-or-later
// The fixtures name their folders after the tag the test passes in, so the
// test finds exactly the folders of its own run.

export function fixtureDirName(fixture: string, step: string): string {
  return `${process.env.PEV_FIXTURE_TAG ?? 'untagged'}-${fixture}-${step}`;
}
