// SPDX-License-Identifier: AGPL-3.0-or-later
// A failing beforeAll: its tests never run, and the file keeps its folder.

import { beforeAll, it } from 'vitest';
import { testDir } from '../../../paths';
import { fixtureDirName } from './name';

beforeAll(() => {
  testDir(fixtureDirName('before-all-fails', 'hook'));
  throw new Error('beforeAll fails');
});

it('does not run', () => {});
