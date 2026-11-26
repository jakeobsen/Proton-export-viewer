// SPDX-License-Identifier: AGPL-3.0-or-later
// The test passes, but the teardown of a file-scoped fixture fails: the file
// keeps its folder.

import { test as base } from 'vitest';
import { testDir } from '../../../paths';
import { fixtureDirName } from './name';

const test = base.extend<{ shared: string }>({
  shared: [
    // Vitest requires an object pattern as the first fixture argument.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(testDir(fixtureDirName('teardown-fails', 'fixture')));
      throw new Error('the fixture teardown fails');
    },
    { scope: 'file' },
  ],
});

test('passes', ({ shared }) => {
  void shared;
});
