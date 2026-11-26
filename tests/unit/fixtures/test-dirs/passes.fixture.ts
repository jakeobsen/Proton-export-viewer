// SPDX-License-Identifier: AGPL-3.0-or-later
// Passes, with folders made while collecting, in a test and in the cleanup a
// beforeAll returns: all three are removed.

import { beforeAll, expect, it } from 'vitest';
import { testDir } from '../../../paths';
import { fixtureDirName } from './name';

testDir(fixtureDirName('passes', 'collect'));

beforeAll(() => () => {
  testDir(fixtureDirName('passes', 'cleanup'));
});

it('passes', () => {
  testDir(fixtureDirName('passes', 'test'));
  expect(true).toBe(true);
});
