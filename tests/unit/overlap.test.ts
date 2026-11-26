// SPDX-License-Identifier: AGPL-3.0-or-later
// Whether two places on disk overlap, with links resolved.

import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { overlaps, realPath } from '../../src/shared/overlap';
import { testDir } from '../paths';

describe('overlaps', () => {
  const root = realpathSync(testDir('overlap'));
  const a = join(root, 'a');
  mkdirSync(join(a, 'b', 'c'), { recursive: true });
  mkdirSync(join(root, 'ab'), { recursive: true });
  mkdirSync(join(root, '..x'), { recursive: true });
  symlinkSync(join(a, 'b'), join(root, 'link'));

  it('finds the same place, a place inside another, and one holding another', () => {
    expect(overlaps(a, a)).toBe(true);
    expect(overlaps(join(a, 'b', 'c'), a)).toBe(true);
    expect(overlaps(a, join(a, 'b', 'c'))).toBe(true);
    expect(overlaps(join(a, 'b', '..'), a)).toBe(true);
  });

  it('keeps siblings apart, also when one name starts with the other', () => {
    expect(overlaps(a, join(root, 'ab'))).toBe(false);
    expect(overlaps(join(root, '..x'), a)).toBe(false);
    expect(overlaps(join(a, 'b'), join(root, 'ab'))).toBe(false);
  });

  it('resolves links, also on the way to a place that does not exist', () => {
    expect(overlaps(join(root, 'link'), join(a, 'b'))).toBe(true);
    expect(overlaps(join(root, 'link', 'c'), a)).toBe(true);
    expect(overlaps(join(root, 'link', 'new', 'x.json'), join(a, 'b'))).toBe(true);
    expect(realPath(join(root, 'link', 'new'))).toBe(join(a, 'b', 'new'));
  });

  it('ignores case where the file system usually does', () => {
    expect(overlaps(join(root, 'A', 'B'), a)).toBe(process.platform !== 'linux');
  });
});
