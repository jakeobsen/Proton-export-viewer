// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hasSpdxHeader } from '../../scripts/check-spdx.mjs';
import { declaredLicense, isAllowedExpression } from '../../scripts/spdx.mjs';

describe('isAllowedExpression', () => {
  it.each([
    'MIT',
    'ISC',
    'Apache-2.0',
    '(MPL-2.0 OR Apache-2.0)',
    'MIT OR GPL-3.0-only',
    '(MIT AND BSD-3-Clause)',
    'BlueOak-1.0.0',
    'MIT-0',
  ])('allows %s', (expr) => {
    expect(isAllowedExpression(expr)).toBe(true);
  });

  it.each([
    'GPL-3.0-only',
    'MPL-2.0',
    '(MIT AND GPL-2.0-only)',
    'Apache-2.0 WITH LLVM-exception',
    'UNLICENSED',
    'SEE LICENSE IN LICENSE.md',
    '',
    '(MIT',
    'MIT OR',
  ])('rejects %s', (expr) => {
    expect(isAllowedExpression(expr)).toBe(false);
  });

  it('reads legacy license fields', () => {
    expect(declaredLicense({ license: 'MIT' })).toBe('MIT');
    expect(declaredLicense({ license: { type: 'ISC' } })).toBe('ISC');
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT OR Apache-2.0)',
    );
    expect(declaredLicense({})).toBeNull();
  });
});

describe('hasSpdxHeader', () => {
  it('accepts the identifier on the first line, or after a shebang', () => {
    expect(hasSpdxHeader('// SPDX-License-Identifier: AGPL-3.0-or-later\ncode')).toBe(true);
    expect(hasSpdxHeader('#!/bin/sh\n# SPDX-License-Identifier: AGPL-3.0-or-later\n')).toBe(true);
    expect(hasSpdxHeader('// other\n// SPDX-License-Identifier: AGPL-3.0-or-later')).toBe(false);
    expect(hasSpdxHeader('// SPDX-License-Identifier: MIT')).toBe(false);
  });
});
