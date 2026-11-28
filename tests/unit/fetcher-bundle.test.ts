// SPDX-License-Identifier: AGPL-3.0-or-later
// The check of the built fetcher bundle follows every chunk the entry imports
// and refuses any module from outside the bundle but Node's HTTP, HTTPS and
// DNS clients, and any way to load one by name.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBundle, specifiers } from '../../scripts/check-fetcher-bundle.mjs';
import { testDir } from '../paths';

function bundle(files: Record<string, string>): string {
  const dir = testDir('fetcher-bundle');
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), source);
  }
  return dir;
}

describe('fetcher bundle check', () => {
  it('reads every import form', () => {
    expect(
      specifiers(
        [
          'import { l as A, t as b } from "./chunks/schema-1.js";',
          "import { request } from 'node:http';",
          'import fs from "node:fs";',
          'import "./side.js";',
          'export { x } from "./re.js";',
          'export * from "node:net";',
          'const m = import("./lazy.js");',
          'const r = require("child_process");',
          'const d = import.meta.dirname;',
        ].join('\n'),
      ).sort(),
    ).toEqual(
      [
        './chunks/schema-1.js',
        './lazy.js',
        './re.js',
        './side.js',
        'child_process',
        'node:fs',
        'node:http',
        'node:net',
      ].sort(),
    );
  });

  it('passes a bundle that loads only HTTP, HTTPS and DNS, following its chunks', () => {
    const dir = bundle({
      'fetcher.js':
        'import { a } from "./chunks/raster-1.js";\nimport { request } from "node:https";\nimport { lookup } from "node:dns";\n',
      'chunks/raster-1.js':
        'import { b } from "./schema-1.js";\nimport { request } from "node:http";\nexport const a = 1;\n',
      'chunks/schema-1.js': 'export const b = 2;\n',
    });
    expect(checkBundle(dir)).toEqual({
      files: ['chunks/raster-1.js', 'chunks/schema-1.js', 'fetcher.js'],
      failures: [],
    });
  });

  it('refuses a forbidden module anywhere in the chunks it reaches', () => {
    for (const bad of [
      'node:fs',
      'fs',
      'original-fs',
      'child_process',
      'electron',
      'node:worker_threads',
      'node:net',
      'node:tls',
      'node:module',
      'node:path',
    ]) {
      const dir = bundle({
        'fetcher.js': 'import { a } from "./chunks/a.js";\n',
        'chunks/a.js': `import x from "${bad}";\nexport const a = x;\n`,
      });
      expect(checkBundle(dir).failures).toEqual([`chunks/a.js: imports ${bad}`]);
    }
  });

  it('passes a method named fetch, a call of it, and the word as a message type', () => {
    const dir = bundle({
      'fetcher.js': [
        'class Views { fetch(request) { return request; } async fetchAll(r) { return r; } }',
        'const views = new Views();',
        'views.fetch({ type: "fetch" });',
        "if (message.type === 'fetch') views.fetch(message);",
        'const fetchImage = (u) => u; fetchImage("x");',
      ].join('\n'),
    });
    expect(checkBundle(dir).failures).toEqual([]);
  });

  it('refuses loading by name, test hooks, and a missing chunk', () => {
    const cases: Array<[string, string]> = [
      ['const f = require("fs");', 'uses'],
      ['const f = (n) => import(n);', 'uses'],
      ['const f = process.getBuiltinModule("fs");', 'uses'],
      ['const f = process.binding("fs");', 'uses'],
      ['const f = process["binding"]("fs");', 'uses'],
      ["const f = process['getBuiltinModule'];", 'uses'],
      ['const r = fetch("https://example.com/");', 'uses'],
      ['const r = await fetch(url, { method: "GET" });', 'uses'],
      ['const r = globalThis.fetch;', 'uses'],
      ['const r = globalThis["fetch"];', 'uses'],
      ['const s = new WebSocket("wss://example.com/");', 'uses'],
      ['const s = new EventSource("https://example.com/");', 'uses'],
      ['const s = new XMLHttpRequest();', 'uses'],
      ['const { request } = undici;', 'uses'],
      ['globalThis.__pevTestMarker = "pev-testhooks-present";', 'holds test hooks'],
    ];
    for (const [source, expected] of cases) {
      const dir = bundle({ 'fetcher.js': `${source}\n` });
      expect(checkBundle(dir).failures.join('\n')).toContain(expected);
    }
    const missing = bundle({ 'fetcher.js': 'import "./chunks/gone.js";\n' });
    expect(checkBundle(missing).failures).toEqual(['chunks/gone.js: missing']);
  });
});
