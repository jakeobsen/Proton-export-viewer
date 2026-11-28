// SPDX-License-Identifier: AGPL-3.0-or-later
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../paths';

const eslint = new ESLint({ cwd: REPO_ROOT });

async function banned(code: string, file: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, file) });
  return (result?.messages ?? []).filter((m) =>
    [
      'no-restricted-imports',
      'no-restricted-globals',
      'no-restricted-properties',
      'no-restricted-syntax',
    ].includes(m.ruleId ?? ''),
  ).length;
}

const SAMPLES = [
  "import net from 'node:net';\nexport default net;",
  "import { request } from 'https';\nexport { request };",
  "import { lookup } from 'node:dns';\nexport { lookup };",
  "import { spawn } from 'child_process';\nexport { spawn };",
  "import { createSocket } from 'node:dgram';\nexport { createSocket };",
  "import { connect } from 'node:tls';\nexport { connect };",
  "import { net } from 'electron';\nexport { net };",
  "export const r = fetch('https://example.org/');",
  "export const r = globalThis.fetch('https://example.org/');",
  "export const m = import('node:http');",
  "export * from 'node:net';",
];

describe('network and process ban', () => {
  it.each(SAMPLES)('rejects in app code: %s', async (code) => {
    expect(await banned(code, 'src/main/probe.ts')).toBeGreaterThan(0);
    expect(await banned(code, 'src/core/probe.ts')).toBeGreaterThan(0);
  });

  it.each(SAMPLES)('allows in src/testhooks/: %s', async (code) => {
    expect(await banned(code, 'src/testhooks/probe.ts')).toBe(0);
  });
});

// The fetcher may import only Node's HTTP, HTTPS and DNS clients and its own
// pure modules; everything else, and every way around the list, is refused.
const FETCHER_ALLOWED = [
  "import { request } from 'node:http';\nexport { request };",
  "import { request } from 'node:https';\nexport { request };",
  "import { lookup } from 'node:dns';\nexport { lookup };",
  "import { parseTarget } from './address';\nexport { parseTarget };",
  "import { fetchImage } from './request';\nexport { fetchImage };",
  "import { ViewScheduler } from './views';\nexport { ViewScheduler };",
  "import { FETCH_REFUSALS } from '../shared/fetcher-protocol';\nexport { FETCH_REFUSALS };",
  "import { errorClassOf } from '../shared/log/schema';\nexport { errorClassOf };",
  "import { checkRaster } from '../core/reader/raster';\nexport { checkRaster };",
  "export const m = () => import('../testhooks/fetcher');",
];

const FETCHER_BANNED = [
  "import { readFileSync } from 'fs';\nexport { readFileSync };",
  "import { readFileSync } from 'node:fs';\nexport { readFileSync };",
  "import { readFile } from 'fs/promises';\nexport { readFile };",
  "import { readFile } from 'node:fs/promises';\nexport { readFile };",
  "import { spawn } from 'child_process';\nexport { spawn };",
  "import { spawn } from 'node:child_process';\nexport { spawn };",
  "import { connect } from 'node:net';\nexport { connect };",
  "import { connect } from 'node:tls';\nexport { connect };",
  "import { connect } from 'node:http2';\nexport { connect };",
  "import { createSocket } from 'node:dgram';\nexport { createSocket };",
  "import { Worker } from 'node:worker_threads';\nexport { Worker };",
  "import fs from 'original-fs';\nexport default fs;",
  "import { createRequire } from 'node:module';\nexport { createRequire };",
  "import { net } from 'electron';\nexport { net };",
  "import { app } from 'electron';\nexport { app };",
  "import { request } from 'http';\nexport { request };",
  "import { join } from 'node:path';\nexport { join };",
  "import { LogWriter } from '../shared/log/writer';\nexport { LogWriter };",
  "import { CoreHost } from '../main/core-host';\nexport { CoreHost };",
  "export * from 'node:fs';",
  "export { readFileSync } from 'node:fs';",
  "export const m = import('node:fs');",
  'export const m = (name: string) => import(name);',
  "export const m = require('fs');",
  "export const r = fetch('https://example.org/');",
  "export const r = globalThis.fetch('https://example.org/');",
  "export const s = new WebSocket('wss://example.org/');",
  "export const s = new EventSource('https://example.org/');",
  'export const x = new XMLHttpRequest();',
  "export const f = process.getBuiltinModule('fs');",
  "export const f = process.binding('fs');",
  'export const f = process.dlopen;',
  'export const p = globalThis.process;',
];

describe('the fetcher’s import list', () => {
  it.each(FETCHER_ALLOWED)('allows in src/fetcher/: %s', async (code) => {
    expect(await banned(code, 'src/fetcher/probe.ts')).toBe(0);
  });

  it.each(FETCHER_BANNED)('rejects in src/fetcher/: %s', async (code) => {
    expect(await banned(code, 'src/fetcher/probe.ts')).toBeGreaterThan(0);
  });

  it('the real fetcher passes its own rules', async () => {
    const results = await eslint.lintFiles([join(REPO_ROOT, 'src/fetcher')]);
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.ruleId}`))).toEqual([]);
  });
});
