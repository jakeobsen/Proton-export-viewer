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

  it.each(SAMPLES)('allows in src/fetcher/ and src/testhooks/: %s', async (code) => {
    expect(await banned(code, 'src/fetcher/probe.ts')).toBe(0);
    expect(await banned(code, 'src/testhooks/probe.ts')).toBe(0);
  });
});
