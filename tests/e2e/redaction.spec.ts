// SPDX-License-Identifier: AGPL-3.0-or-later
// Log redaction: markers are pushed through every logging path in main, core,
// the core worker and the renderer, including the crash and exit handlers.
// Each path must first prove it logged; then no marker may be in any log file.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageOpenResult } from '../../src/shared/api';
import { MARKER_TEXT, findMarkers } from '../markers';
import { testDir } from '../paths';
import { expect, test } from './app';

test('no marker reaches a log file through any path', async ({ pev }) => {
  const M = MARKER_TEXT;

  // Main.
  await pev.main('mainLog', M);
  await pev.main('mainError', M);
  await pev.main('mainThrow', M);
  await pev.main('mainReject', M);

  // Core.
  await pev.main('core', 'log', M);
  await pev.main('core', 'error', M);
  await pev.main('core', 'throw', M);
  await pev.main('core', 'reject', M);

  // Core worker: a normal log, a crash, and an unhandled rejection.
  await pev.main('core', 'worker-log', M);
  await pev.main('core', 'worker-crash', M);
  await expect.poll(() => pev.hasLog('core.worker_exit', { exitCode: 70 })).toBe(true);
  await pev.main('core', 'worker-reject', M);
  await expect
    .poll(() => pev.logs('core').filter((l) => l.code === 'core.worker_exit').length)
    .toBe(2);

  // Reader lane: a parse failure whose error carries the markers, a timeout
  // and a heap breach, each ending in the reader's fallback. Lower limits keep
  // it short; the paths are the same.
  const source = await pev.main<{ ok: boolean }>('readerSource', testDir('redaction-reader'), [
    [1, { test: { kind: 'throw', markers: M } }],
    [2, { test: { kind: 'spin' } }],
    [3, { test: { kind: 'heap' } }],
  ]);
  expect(source.ok).toBe(true);
  await pev.main('readerLimits', { heapMb: 64, timeoutMs: 500 });
  for (const rowid of [1, 2, 3]) {
    const opened = await pev.page.evaluate(async (r) => {
      const state = await window.pev.state();
      if (!state.ok) return state;
      return window.pev.open(r, 'plain', state.generation);
    }, rowid);
    expect((opened as MessageOpenResult & { outcome?: string }).outcome).toBe('fallback');
  }

  // Renderer.
  await pev.shell('log', [M]);
  await pev.shell('error', [M]);
  await pev.shell('throwUncaught', [M]);
  await pev.shell('reject', [M]);

  const expected: Array<[string, string]> = [
    ['main', 'test.log'],
    ['main', 'test.error'],
    ['main', 'main.uncaught'],
    ['main', 'main.rejection'],
    ['core', 'test.log'],
    ['core', 'test.error'],
    ['core', 'core.uncaught'],
    ['core', 'core.rejection'],
    ['worker', 'test.log'],
    ['worker', 'worker.uncaught'],
    ['worker', 'worker.rejection'],
    ['core', 'core.worker_exit'],
    ['worker', 'reader.parse_failed'],
    ['core', 'reader.timeout'],
    ['core', 'reader.limit'],
    ['main', 'open.fallback'],
    ['renderer', 'test.log'],
    ['renderer', 'renderer.error'],
    ['renderer', 'renderer.uncaught'],
    ['renderer', 'renderer.rejection'],
  ];
  for (const [proc, code] of expected) {
    await expect.poll(() => pev.hasLog(code, { proc }), { message: `${proc} ${code}` }).toBe(true);
  }

  // A renderer crash, then a core exit.
  await pev.page.evaluate((m) => {
    document.title = m;
  }, M);
  await pev.main('crashRenderer', 1);
  await expect
    .poll(() => pev.hasLog('renderer.gone', { proc: 'main' }))
    .toBe(true)
    .catch((err: unknown) => {
      console.log(
        'main log:',
        JSON.stringify(
          pev
            .logs('main')
            .slice(-10)
            .map((l) => l.code),
        ),
      );
      throw err;
    });
  await pev.main('core', 'exit');
  await expect.poll(() => pev.hasLog('core.exit', { exitCode: 3 })).toBe(true);
  await expect.poll(() => pev.hasLog('child.gone', { processType: 'Utility' })).toBe(true);

  // The error events carry classes and app frames only.
  const uncaught = pev.logs('main').find((l) => l.code === 'main.uncaught');
  expect(uncaught?.data.errorClass).toBe('Error');
  expect(Array.isArray(uncaught?.data.frames)).toBe(true);
  const dropped = pev.logs('main').find((l) => l.code === 'test.log');
  expect(dropped?.data).toEqual({ dropped: 4 });

  // No marker, in any form, and no home-folder path in any log file.
  const dir = pev.logsDir();
  const files = readdirSync(dir);
  expect(files.sort()).toEqual(['core.jsonl', 'main.jsonl', 'renderer.jsonl']);
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    expect(findMarkers(text), file).toEqual([]);
    expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
  }
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});
