// SPDX-License-Identifier: AGPL-3.0-or-later
// Checks the built fetcher: out/main/fetcher.js and every chunk it imports,
// followed through the bundle. Lint sees only src/fetcher/, not what the
// modules it imports pull in, so this checks what actually ships. The only
// modules from outside the bundle it may load are Node's HTTP, HTTPS and DNS
// clients: no file system, process, worker, Electron or other network module,
// and no require, getBuiltinModule or process.binding.
//
//   node scripts/check-fetcher-bundle.mjs [outRoot]   (default: out)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_MODULES = ['node:http', 'node:https', 'node:dns'];

const SPECIFIER_RES = [
  /\bimport\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"']+)["']/g,
  /\bexport\s*[\w*{}\s,$]*?\s*from\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const FORBIDDEN_CALLS = [
  /\bimport\s*\(\s*[^"'\s)]/, // a dynamic import of a computed name
  /\brequire\s*\(/,
  /\bgetBuiltinModule\b/,
  /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\b/,
  /\bcreateRequire\b/,
];

/** The module specifiers a bundle file names. */
export function specifiers(source) {
  const found = new Set();
  for (const re of SPECIFIER_RES) {
    for (const m of source.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

/** Follows `entry` through the bundle in `dir`; returns the files read and every failure. */
export function checkBundle(dir, entry = 'fetcher.js') {
  const failures = [];
  const files = [];
  const pending = [resolve(dir, entry)];
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const name = relative(dir, file);
    if (!existsSync(file)) {
      failures.push(`${name}: missing`);
      continue;
    }
    files.push(name);
    const source = readFileSync(file, 'utf8');
    for (const re of FORBIDDEN_CALLS) {
      if (re.test(source)) failures.push(`${name}: uses ${re.source}`);
    }
    if (source.includes('pev-testhooks-present')) failures.push(`${name}: holds test hooks`);
    for (const spec of specifiers(source)) {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        pending.push(resolve(dirname(file), spec));
      } else if (!ALLOWED_MODULES.includes(spec)) {
        failures.push(`${name}: imports ${spec}`);
      }
    }
  }
  return { files: files.sort(), failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outRoot = process.argv[2] ?? 'out';
  const { files, failures } = checkBundle(join(outRoot, 'main'));
  for (const f of files) console.log(`checked ${f}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`check-fetcher-bundle: ${f}`);
    process.exit(1);
  }
  console.log(`check-fetcher-bundle: ok (${files.length} files)`);
}
