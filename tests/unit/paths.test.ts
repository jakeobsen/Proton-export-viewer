// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, TEST_OUTPUT, removeTestDirs, takeTestDirs, testDir } from '../paths';

describe('test directories', () => {
  it('are listed once and removed on request', () => {
    takeTestDirs();
    const first = testDir('paths-first');
    const second = testDir('paths-second');
    expect(takeTestDirs()).toEqual([first, second]);
    expect(takeTestDirs()).toEqual([]);
    removeTestDirs([first]);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    removeTestDirs([second]);
    expect(existsSync(second)).toBe(false);
  });

  it('are removed only under test-output/runs', () => {
    for (const path of [
      TEST_OUTPUT,
      join(TEST_OUTPUT, 'runs'),
      join(TEST_OUTPUT, 'runs', '..', '..', 'src'),
      REPO_ROOT,
    ]) {
      expect(() => removeTestDirs([path]), path).toThrow('not a test directory');
    }
    expect(existsSync(join(REPO_ROOT, 'src'))).toBe(true);
  });
});
