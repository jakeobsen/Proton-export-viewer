// SPDX-License-Identifier: AGPL-3.0-or-later
// Every source file under src/, tests/, scripts/ and .githooks/ must start with
// the license identifier (after a shebang, if any).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

export const SPDX_LINE = 'SPDX-License-Identifier: AGPL-3.0-or-later';
const ROOTS = ['src/', 'tests/', 'scripts/', '.githooks/'];
const SOURCE_EXT = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.sh',
]);

/** True when the first line after an optional shebang carries the identifier. */
export function hasSpdxHeader(text) {
  const lines = text.split('\n');
  const first = lines[0]?.startsWith('#!') ? lines[1] : lines[0];
  return typeof first === 'string' && first.includes(SPDX_LINE);
}

function isSource(path) {
  if (!ROOTS.some((root) => path.startsWith(root))) return false;
  const ext = extname(path);
  if (SOURCE_EXT.has(ext)) return true;
  return path.startsWith('.githooks/') && ext === '';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean)
    .filter(isSource)
    .filter((path) => existsSync(path));
  const missing = files.filter((path) => !hasSpdxHeader(readFileSync(path, 'utf8')));
  if (missing.length > 0) {
    console.error(`check-spdx: ${missing.length} file(s) without "${SPDX_LINE}"`);
    for (const path of missing) console.error(`  ${path}`);
    process.exit(1);
  }
  console.log(`check-spdx: ok (${files.length} files)`);
}
