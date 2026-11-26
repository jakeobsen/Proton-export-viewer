// SPDX-License-Identifier: AGPL-3.0-or-later
// The test passes, but the cleanup its beforeAll returned throws. Vitest runs
// that cleanup after the file's afterAll hooks; the file keeps its folder.

import { beforeAll, it } from 'vitest';
import { testDir } from '../../../paths';
import { fixtureDirName } from './name';

beforeAll(() => {
  testDir(fixtureDirName('cleanup-throws', 'hook'));
  return () => {
    throw new Error('the returned cleanup fails');
  };
});

it('passes', () => {});
