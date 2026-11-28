// SPDX-License-Identifier: AGPL-3.0-or-later
// hardenSession() applies to every window: checked on a second window.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './app';
import { SAMPLE, paneSource } from './pane-messages';

interface SandboxEvidence {
  pid: number;
  sandboxed: boolean | null;
  seccomp: string | null;
}

interface SandboxState {
  platform: string;
  windowPids: number[];
  main: SandboxEvidence | null;
  renderers: SandboxEvidence[];
}

test('every renderer runs in the OS sandbox @pane', async ({ pev }) => {
  // A second window and a body open in the reader pane, so every kind of
  // renderer process exists.
  await pev.openWindow('shell');
  await paneSource(pev, SAMPLE);
  await pev.showInPane(1, 'html');

  const state = await pev.main<SandboxState>('rendererSandbox');
  // Chromium's Linux sandbox installs a seccomp-bpf filter (mode 2) in each
  // renderer; on macOS and Windows the process metric reports the OS sandbox.
  const sandboxed = (e: SandboxEvidence) =>
    state.platform === 'linux' ? e.seccomp === '2' : e.sandboxed === true;

  // Control: the main process is not sandboxed, so the evidence can say no.
  expect(state.main).not.toBeNull();
  expect(sandboxed(state.main as SandboxEvidence)).toBe(false);

  expect(state.windowPids).toHaveLength(2);
  const pids = state.renderers.map((r) => r.pid);
  for (const pid of state.windowPids) expect(pids).toContain(pid);
  for (const renderer of state.renderers) {
    expect(sandboxed(renderer), `renderer ${JSON.stringify(renderer)}`).toBe(true);
  }
});

test('a second window gets the same session policy @pane', async ({ pev }) => {
  const second = await pev.openWindow('shell');
  await paneSource(pev, SAMPLE);
  const page = second.page;

  const permissions = await page.evaluate(async () => {
    const geo = await navigator.permissions.query({ name: 'geolocation' });
    const notify = await Notification.requestPermission();
    const media = await navigator.mediaDevices.getUserMedia({ audio: true }).then(
      () => 'granted',
      (err: Error) => err.name,
    );
    return { geo: geo.state, notify, media };
  });
  expect(permissions.geo).toBe('denied');
  expect(permissions.notify).toBe('denied');
  expect(permissions.media).not.toBe('granted');
  await expect.poll(() => pev.hasLog('perm.denied', { windowId: second.windowId })).toBe(true);

  // Spellchecker off on both sessions.
  expect(await pev.main('spellcheck', 1)).toBe(false);
  expect(await pev.main('spellcheck', second.windowId)).toBe(false);

  // Protocols are scoped: each session serves only its own views.
  const own = await pev.showInPane(1, 'html', page);
  expect((await pev.main<{ status: number }>('fetchIn', second.windowId, own.url)).status).toBe(
    200,
  );
  expect((await pev.main<{ status: number }>('fetchIn', 1, own.url)).status).toBe(404);

  // Downloads are cancelled and logged; nothing is written.
  await pev.main('download', second.windowId, 'app://shell/probe.png');
  await expect
    .poll(() => pev.hasLog('download.cancelled', { windowId: second.windowId }))
    .toBe(true);
  const downloads = join(pev.userData, 'downloads');
  expect(existsSync(downloads) ? readdirSync(downloads) : []).toEqual([]);
});
