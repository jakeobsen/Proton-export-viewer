// SPDX-License-Identifier: AGPL-3.0-or-later
// Evaluates SPDX license expressions against an allowlist.

export const ALLOWED_LICENSES = [
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Zlib',
  'CC0-1.0',
  'BlueOak-1.0.0',
];

function tokenize(expression) {
  return expression.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean);
}

/**
 * True if the expression is satisfied by allowed licenses: `A OR B` needs one
 * side, `A AND B` needs both. `WITH` exceptions and unknown syntax fail closed.
 */
export function isAllowedExpression(expression, allowed = ALLOWED_LICENSES) {
  if (typeof expression !== 'string' || expression.trim() === '') return false;
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let value = parseAnd();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }

  function parseAnd() {
    let value = parseAtom();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      const right = parseAtom();
      value = value && right;
    }
    return value;
  }

  function parseAtom() {
    const token = next();
    if (token === undefined) throw new Error('unexpected end');
    if (token === '(') {
      const value = parseOr();
      if (next() !== ')') throw new Error('missing )');
      return value;
    }
    if (token === ')' || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) {
      throw new Error(`unexpected ${token}`);
    }
    if (peek()?.toUpperCase() === 'WITH') {
      next();
      next();
      return false;
    }
    return allowed.includes(token.replace(/\+$/, ''));
  }

  try {
    const value = parseOr();
    return pos === tokens.length ? value : false;
  } catch {
    return false;
  }
}

/** The license expression declared by a package.json, or null. */
export function declaredLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    return types.length > 0 ? `(${types.join(' OR ')})` : null;
  }
  return null;
}
