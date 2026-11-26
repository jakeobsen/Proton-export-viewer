// SPDX-License-Identifier: AGPL-3.0-or-later
// A failing test: the file keeps its folder.

import { expect, it } from 'vitest';
import { testDir } from '../../../paths';
import { fixtureDirName } from './name';

it('fails', () => {
  testDir(fixtureDirName('test-fails', 'test'));
  expect(true).toBe(false);
});
