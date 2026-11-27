// SPDX-License-Identifier: AGPL-3.0-or-later
// The open bench of test builds: it opens every listed message from a folder
// it only reads, times each one, writes its result into the run's workspace
// and quits, all without showing a window.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { TimedOpen } from '../../src/testhooks/open-bench-types';
import { WORKSPACE_MARK, createWorkspace } from '../../tools/bench/workspace.mjs';
import { REPO_ROOT, testDir } from '../paths';
// This test's own folders are removed once it passes.
import { expect, test } from './app';

function message(subject: string, type: string, body: string): string {
  return [
    'From: Sender <sender@example.com>',
    'To: Owner <owner@example.com>',
    `Subject: ${subject}`,
    'Date: Wed, 25 Nov 2026 08:02:11 +0000',
    'MIME-Version: 1.0',
    `Content-Type: ${type}; charset=utf-8`,
    '',
    body,
    '',
  ].join('\r\n');
}

/** Every file and folder under the folder, files with the SHA-256 of their content. */
function snapshot(root: string, at = ''): Record<string, string> {
  return Object.fromEntries(
    readdirSync(join(root, at), { withFileTypes: true }).flatMap((entry) => {
      const rel = join(at, entry.name);
      if (entry.isDirectory())
        return [[`${rel}/`, 'folder'], ...Object.entries(snapshot(root, rel))];
      const hash = createHash('sha256')
        .update(readFileSync(join(root, rel)))
        .digest('hex');
      return [[rel, hash]];
    }),
  );
}

test('the open bench times every open in a hidden window, reads its folder only, and quits', async () => {
  const parent = testDir('open-bench-corpus');
  const root = join(parent, 'corpus');
  mkdirSync(root);
  writeFileSync(join(root, 'plain.eml'), message('Plain', 'text/plain', 'Hello.'));
  writeFileSync(
    join(root, 'html.eml'),
    message('HTML', 'text/html', '<p>Hi</p><img src="https://example.com/a.png">'),
  );
  // A real message beside the folder: the test source refuses it as outside, not as missing.
  const outside = join(parent, 'outside.eml');
  writeFileSync(outside, message('Outside', 'text/plain', 'Not in the folder.'));
  const before = snapshot(root);
  const outsideBefore = readFileSync(outside);

  const nonce = randomBytes(8).toString('hex');
  const workspace = join(testDir('open-bench-run'), 'ws');
  createWorkspace(workspace, nonce, []);
  const config = join(workspace, 'config.json');
  // Message 3 is the file beside the folder, so the test source refuses it.
  writeFileSync(
    config,
    JSON.stringify({
      nonce,
      workspace,
      root,
      files: ['plain.eml', 'html.eml', '../outside.eml'],
      warmup: 1,
    }),
  );
  const app = await electron.launch({
    args: [
      join(REPO_ROOT, 'out-test'),
      `--pev-user-data=${testDir('open-bench-profile')}`,
      `--pev-open-bench=${config}`,
    ],
    cwd: REPO_ROOT,
    chromiumSandbox: true,
  });
  await app.waitForEvent('close', { timeout: 60_000 });

  const result = JSON.parse(readFileSync(join(workspace, `open-result-${nonce}.json`), 'utf8')) as {
    ok: boolean;
    error?: string;
    opens: TimedOpen[];
    warmup: { count: number; views: number };
    idle: { exportOpen: boolean };
    window: { visible: boolean; focused: boolean };
    windowEvents: Array<{ window: number; event: string }>;
    events: { start: string; end: string };
  };
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.warmup).toEqual({ count: 1, views: 1 });
  expect(result.idle.exportOpen).toBe(false);
  expect(result.window).toEqual({ visible: false, focused: false });
  // No window was shown or focused during the run.
  expect(result.windowEvents).toEqual([]);
  expect(result.events.start).toContain('window.pev.open');
  expect(result.events.end).toContain('load');
  expect(result.opens.map((o) => [o.rowid, o.outcome, o.format ?? null])).toEqual([
    [1, 'view', 'plain'],
    [2, 'view', 'html'],
    [3, 'rejected', null],
  ]);
  for (const open of result.opens.slice(0, 2)) {
    expect(open.ms).toBeGreaterThan(0);
    expect(open.ms).toBeLessThan(10_000);
  }
  // The folder and the file beside it are only read.
  expect(snapshot(root)).toEqual(before);
  expect(readFileSync(outside)).toEqual(outsideBefore);
});

test('the open bench writes nothing when its workspace is in the folder it reads', async () => {
  const parent = testDir('open-bench-inside');
  const root = join(parent, 'corpus');
  mkdirSync(root);
  writeFileSync(join(root, 'plain.eml'), message('Plain', 'text/plain', 'Hello.'));
  const nonce = randomBytes(8).toString('hex');
  // A run's workspace, marked as the runner marks it, inside the folder.
  const workspace = createWorkspace(join(root, 'ws'), nonce, []);
  const before = snapshot(root);
  const config = join(parent, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({ nonce, workspace, root, files: ['plain.eml'], warmup: 0 }),
  );
  const app = await electron.launch({
    args: [
      join(REPO_ROOT, 'out-test'),
      `--pev-user-data=${testDir('open-bench-inside-profile')}`,
      `--pev-open-bench=${config}`,
    ],
    cwd: REPO_ROOT,
    chromiumSandbox: true,
  });
  await app.waitForEvent('close', { timeout: 60_000 });
  // The app quit without a result: the workspace holds only its mark.
  expect(readdirSync(workspace)).toEqual([WORKSPACE_MARK]);
  expect(snapshot(root)).toEqual(before);
});
