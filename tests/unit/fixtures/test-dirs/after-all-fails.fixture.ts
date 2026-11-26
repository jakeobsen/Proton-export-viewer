// SPDX-License-Identifier: AGPL-3.0-or-later
// The test passes, but an afterAll fails: the file keeps its folder.

import { afterAll, it } from 'vitest';
import { testDir } from '../../../paths';
import { fixtureDirName } from './name';

afterAll(() => {
  throw new Error('afterAll fails');
});

it('passes', () => {
  testDir(fixtureDirName('after-all-fails', 'test'));
});
