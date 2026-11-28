// SPDX-License-Identifier: AGPL-3.0-or-later
// The index's lifecycle in the app: a damaged index is found by its check
// after a reopen and rebuilt; while the export is gone it is deleted and
// rebuilt once the export is located; Forget leaves no file of the index;
// Reset deletes the app's own data once the open export is torn down, after
// which the app starts afresh; and a close returns only once core has exited
// and left the index free. The exports are never changed, not even one put
// inside the app's data folder.

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/core/index/sql';
import type { SourceActionResult } from '../../src/shared/api';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import type { SourcesView, Stamp } from '../../src/shared/sources';
import { digest } from '../../tools/gen-export/tree.mjs';
import { writeExport } from '../exports';
import { damageTablePage } from '../index-helpers';
import { testDir } from '../paths';
import { CORE_EXIT_MS, expect, launch, test, type PevApp } from './app';
import { isGone, startTimeOf, waitGone } from './process-wait';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);
const view = (pev: PevApp) => pev.main<SourcesView>('sourcesView');

async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ phase: 'done', loaded: total, total });
}

async function checkHidden(pev: PevApp): Promise<void> {
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
  expect(await pev.main('windowEvents')).toEqual([]);
  expect(await pev.main('dialogCalls')).toEqual([]);
}

function registryUuid(file: string, sourceKey: string): string | null | undefined {
  const registry = JSON.parse(readFileSync(file, 'utf8')) as {
    sources: Array<{ sourceKey: string; dbUuid?: string | null }>;
  };
  return registry.sources.find((s) => s.sourceKey === sourceKey)?.dbUuid;
}

const familyOf = (indexDir: string, key: string) =>
  existsSync(indexDir) ? readdirSync(indexDir).filter((n) => n.startsWith(key)) : [];

/** Opens an export in a first launch, indexes it, and quits. */
async function indexedOnce(name: string, root: string, pairs: number) {
  const first = await launch(name);
  let once;
  try {
    await first.main('queuePick', root, 'bm1');
    await first.shell('chooseFolder', []);
    await phase1Done(first, pairs);
    const stamp = await first.main<Stamp>('sourceStamp');
    const indexDir = await first.main<string>('indexDir');
    const registry = await first.main<string>('registryFile');
    const uuid = registryUuid(registry, stamp.sourceKey)!;
    await checkHidden(first);
    once = { userData: first.userData, stamp, indexDir, registry, uuid };
  } finally {
    await first.close();
  }
  // Quitting restarted nothing.
  expect(first.logs('main').filter((l) => l.code === 'core.restart')).toEqual([]);
  return once;
}

test('a damaged index is found by its check after a reopen and rebuilt', async () => {
  const root = realpathSync(testDir('life-damaged'));
  const written = writeExport(root, { seed: 21, messages: 30 });
  const before = digest(root);
  const first = await indexedOnce('life-damaged-1', root, written.pairs);
  damageTablePage(join(first.indexDir, `${first.stamp.sourceKey}.sqlite`), 'messages');

  const again = await launch('life-damaged-2', { userData: first.userData });
  try {
    // Reopened, found damaged, torn down and deleted, and rebuilt as a new
    // index. (The logs folder is the first launch's too.)
    await expect
      .poll(() => again.logs('core').filter((l) => l.code === 'index.created').length, {
        timeout: 20_000,
      })
      .toBe(2);
    await phase1Done(again, written.pairs);
    const stamp = await again.main<Stamp>('sourceStamp');
    expect(stamp.sourceKey).toBe(first.stamp.sourceKey);
    const totals = (await ask<IndexTotals>(again, { op: 'totals' }))!.answer;
    expect(totals).toMatchObject({ messages: written.pairs, pairs: written.pairs });
    await expect.poll(async () => (await view(again)).active?.index).toBe('ok');
    const uuid = registryUuid(first.registry, stamp.sourceKey);
    expect(uuid).toEqual(expect.any(String));
    expect(uuid).not.toBe(first.uuid);
    const damaged = again.logs('core').filter((l) => l.code === 'index.damaged');
    expect(damaged).toHaveLength(1);
    expect(['quick_check', 'corrupt']).toContain(damaged[0]!.data.reason);
    expect(again.hasLog('index.deleted', { proc: 'core' })).toBe(true);
    expect(again.hasLog('index.rebuild', { proc: 'main' })).toBe(true);
    await checkHidden(again);
  } finally {
    await again.close();
  }
  expect(digest(root)).toBe(before);
});

test('a damaged index of an export that is gone is deleted, and rebuilt once it is located', async () => {
  const root = realpathSync(testDir('life-offline'));
  const written = writeExport(root, { seed: 22, messages: 20 });
  const first = await indexedOnce('life-offline-1', root, written.pairs);
  const key = first.stamp.sourceKey;
  renameSync(join(root, written.account), join(root, 'moved-away'));
  const before = digest(root);
  damageTablePage(join(first.indexDir, `${key}.sqlite`), 'thread_labels');

  const gone = await launch('life-offline-2', { userData: first.userData });
  try {
    await expect
      .poll(async () => (await view(gone)).active, { timeout: 20_000 })
      .toMatchObject({ status: 'offline', index: 'damaged' });
    expect(familyOf(first.indexDir, key)).toEqual([]);
    expect(registryUuid(first.registry, key)).toBeNull();
    // Nothing was created while the export was gone (the first launch made one).
    expect(gone.logs('core').filter((l) => l.code === 'index.created')).toHaveLength(1);
    expect(digest(root)).toBe(before);

    renameSync(join(root, 'moved-away'), join(root, written.account));
    await gone.main('queuePick', root, 'bm2');
    expect(await gone.shell<SourceActionResult>('locateExport', [])).toMatchObject({
      ok: true,
      outcome: 'opened',
    });
    await phase1Done(gone, written.pairs);
    expect((await gone.main<Stamp>('sourceStamp')).sourceKey).toBe(key);
    await expect.poll(async () => (await view(gone)).active?.index).toBe('ok');
    expect(registryUuid(first.registry, key)).toEqual(expect.any(String));
    expect(gone.logs('core').filter((l) => l.code === 'index.created')).toHaveLength(2);
    await checkHidden(gone);
  } finally {
    await gone.close();
  }
});

test('Forget leaves no file of the index, and late work recreates none', async ({ pev }) => {
  const rootA = realpathSync(testDir('life-forget-a'));
  const a = writeExport(rootA, { seed: 23, messages: 15 });
  const rootB = realpathSync(testDir('life-forget-b'));
  writeExport(rootB, { seed: 24, messages: 600 });
  const digests = [digest(rootA), digest(rootB)];

  await pev.main('queuePick', rootA, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, a.pairs);
  const keyA = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  await pev.main('queuePick', rootB, 'bm2');
  await pev.shell('chooseFolder', []);
  const keyB = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  const indexDir = await pev.main<string>('indexDir');

  // An export that isn't open.
  expect(await pev.shell<SourceActionResult>('forgetExport', [keyA])).toMatchObject({
    ok: true,
    outcome: 'forgotten',
  });
  expect(familyOf(indexDir, keyA)).toEqual([]);
  expect((await view(pev)).recent.map((r) => r.sourceKey)).toEqual([keyB]);
  expect((await pev.main<Stamp>('sourceStamp')).sourceKey).toBe(keyB);

  // The open one, while phase 1 is still writing.
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress.loaded ?? 0)
    .toBeGreaterThan(0);
  expect(await pev.shell<SourceActionResult>('forgetExport', [keyB])).toMatchObject({
    ok: true,
    outcome: 'forgotten',
  });
  expect(familyOf(indexDir, keyB)).toEqual([]);
  expect(await view(pev)).toEqual({ restoring: false, active: null, recent: [] });
  await new Promise((r) => setTimeout(r, 1000));
  expect(readdirSync(indexDir)).toEqual([]);
  const registry = JSON.parse(readFileSync(await pev.main<string>('registryFile'), 'utf8')) as {
    sources: unknown[];
    picks: unknown[];
  };
  expect(registry).toMatchObject({ sources: [], picks: [] });
  expect(pev.hasLog('source.forgotten', { proc: 'main' })).toBe(true);
  expect(pev.logs('core').filter((l) => l.code === 'index.deleted')).toHaveLength(2);
  expect([digest(rootA), digest(rootB)]).toEqual(digests);
});

test('Reset deletes the app data once the open export is torn down, and nothing else; then the app starts afresh', async ({
  pev,
}) => {
  const root = realpathSync(testDir('life-reset'));
  const written = writeExport(root, { seed: 25, messages: 20 });
  const before = digest(root);
  // An export put inside the app's own index folder: it is never opened, and
  // Reset leaves it as it is.
  const indexDir = await pev.main<string>('indexDir');
  const nestedRoot = join(indexDir, 'nested');
  writeExport(nestedRoot, { seed: 26, messages: 5 });
  const nestedBefore = digest(nestedRoot);
  await pev.main('queuePick', nestedRoot, 'bm0');
  expect(await pev.shell<SourceActionResult>('chooseFolder', [])).toMatchObject({
    ok: true,
    outcome: 'app_data',
  });
  await expect(pev.page.locator('.notice')).toHaveText(
    "This folder is inside the app's data folder.",
  );
  expect(pev.hasLog('source.refused', { proc: 'main', reason: 'app_data' })).toBe(true);
  expect(await view(pev)).toMatchObject({ active: null, recent: [] });

  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  const registry = await pev.main<string>('registryFile');
  const settings = join(pev.userData, 'settings.json');
  writeFileSync(settings, '{}');
  expect(existsSync(registry)).toBe(true);
  // Main, core and the shell have each logged before the reset.
  await pev.shell('log', ['before-reset']);
  await expect.poll(() => pev.logs().some((l) => l.code === 'test.log')).toBe(true);
  const earlier = ['source.opened', 'index.created', 'test.log'];
  for (const code of earlier) expect(pev.hasLog(code)).toBe(true);

  await pev.main('resetApp');
  // The index folder keeps only what the app didn't make there.
  expect(readdirSync(indexDir)).toEqual(['nested']);
  expect(existsSync(registry)).toBe(false);
  expect(existsSync(settings)).toBe(false);
  // Every log from before is gone. Main and core log again at once, so new
  // files may already be there, with nothing in them from before.
  expect(pev.logs().filter((l) => [...earlier, 'app.reset'].includes(l.code))).toEqual([]);
  expect(await view(pev)).toEqual({ restoring: false, active: null, recent: [] });
  expect(await pev.main('liveScopes')).toEqual([]);
  // Nothing comes back on its own: not the index or the registry. The logs
  // start again in a new folder, with nothing from before the reset.
  await new Promise((r) => setTimeout(r, 1000));
  expect(readdirSync(indexDir)).toEqual(['nested']);
  expect(existsSync(registry)).toBe(false);
  await pev.shell('log', ['after-reset']);
  await expect.poll(() => pev.logs().filter((l) => l.code === 'test.log').length).toBe(1);
  expect(pev.logs().filter((l) => ['app.reset', 'source.opened'].includes(l.code))).toEqual([]);
  // Then the app starts afresh: an export opens as a new one.
  await pev.main('queuePick', root, 'bm2');
  expect(await pev.shell<SourceActionResult>('chooseFolder', [])).toMatchObject({
    ok: true,
    outcome: 'opened',
  });
  await phase1Done(pev, written.pairs);
  expect(existsSync(registry)).toBe(true);
  expect(digest(root)).toBe(before);
  expect(digest(nestedRoot)).toBe(nestedBefore);
});

test('core that exits on its own is restarted for the open export, and a switch restarts nothing', async ({
  pev,
}) => {
  const root = realpathSync(testDir('life-restart'));
  const written = writeExport(root, { seed: 25, messages: 12 });
  const other = realpathSync(testDir('life-restart-other'));
  writeExport(other, { seed: 26, messages: 4 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  const before = await pev.main<Stamp>('sourceStamp');
  // The reader shows a message when core goes.
  type Reader = { rowid: number | null; view: { url: string } | null };
  const reader = () => pev.shell<Reader>('reader');
  await pev.page.locator('[data-folder="5"]').dispatchEvent('click');
  await pev.page.locator('.conv[role="option"]').first().dispatchEvent('click');
  await expect.poll(async () => (await reader()).view?.url ?? null).not.toBeNull();
  const shown = (await reader()).view!.url;
  expect((await pev.main<{ status: number }>('fetchIn', 1, shown)).status).toBe(200);

  await pev.main('core', 'exit');
  await expect.poll(() => pev.hasLog('core.restart')).toBe(true);
  await expect
    .poll(async () => (await pev.main<Stamp>('sourceStamp')).generation)
    .toBe(before.generation + 1);
  expect((await pev.main<Stamp>('sourceStamp')).sourceKey).toBe(before.sourceKey);
  // Its view went with the old generation, and the pane closed.
  expect(pev.hasLog('view.revoked', { reason: 'generation' })).toBe(true);
  expect((await pev.main<{ status: number }>('fetchIn', 1, shown)).status).toBe(404);
  await expect.poll(async () => (await reader()).rowid).toBeNull();
  await expect(pev.page.locator('.reader .rp')).toHaveCount(0);
  // The same index is opened again, and the list reads from it.
  await phase1Done(pev, written.pairs);
  expect((await view(pev)).active).toMatchObject({ status: 'online', closed: false });
  await expect(pev.page.locator('.conv[role="option"]').first()).toBeVisible();

  // A switch stops core on purpose: no restart.
  await pev.main('queuePick', other, 'bm2');
  await pev.shell('chooseFolder', []);
  await expect.poll(async () => (await view(pev)).active?.sourceKey).not.toBe(before.sourceKey);
  await pev.page.waitForTimeout(500);
  expect(pev.logs('main').filter((l) => l.code === 'core.restart')).toHaveLength(1);
  await checkHidden(pev);
});

test('after 3 restarts within a minute the export is closed, and Reopen opens it again', async ({
  pev,
}) => {
  const root = realpathSync(testDir('life-restart-limit'));
  const written = writeExport(root, { seed: 27, messages: 6 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  for (let i = 0; i < 3; i += 1) {
    const { generation } = await pev.main<Stamp>('sourceStamp');
    await pev.main('core', 'exit');
    await expect
      .poll(async () => (await pev.main<Stamp>('sourceStamp')).generation)
      .toBe(generation + 1);
    await phase1Done(pev, written.pairs);
  }
  const { generation } = await pev.main<Stamp>('sourceStamp');
  // A body view is open when core goes for the fourth time.
  const opened = await pev.open('sample');
  expect(opened).toMatchObject({ ok: true });
  expect((await pev.main<{ status: number }>('fetchIn', 1, opened.url!)).status).toBe(200);
  await pev.main('core', 'exit');
  await expect.poll(() => pev.hasLog('core.restart_gave_up')).toBe(true);
  const banner = pev.page.locator('.banner[role="alert"]');
  await expect(banner.locator('span')).toHaveText('Export closed after an error.');
  // The open view went with it: a new generation, and its token is gone.
  expect((await pev.main<Stamp>('sourceStamp')).generation).toBe(generation + 1);
  expect(pev.hasLog('view.revoked', { reason: 'generation' })).toBe(true);
  expect((await pev.main<{ status: number }>('fetchIn', 1, opened.url!)).status).toBe(404);
  expect(pev.logs('main').filter((l) => l.code === 'core.restart')).toHaveLength(3);

  await banner.locator('button:text("Reopen")').dispatchEvent('click');
  await expect(banner).toHaveCount(0);
  await phase1Done(pev, written.pairs);
  expect((await view(pev)).active).toMatchObject({ status: 'online', closed: false });
  await checkHidden(pev);
});

test('close returns only once core has exited, and the index is free', async () => {
  const root = realpathSync(testDir('life-close-wait'));
  const written = writeExport(root, { seed: 28, messages: 8 });
  const pev = await launch('life-close-wait');
  let pid: number | undefined;
  let startTime: string | null = null;
  let stopped = false;
  try {
    await pev.main('queuePick', root, 'bm1');
    await pev.shell('chooseFolder', []);
    await phase1Done(pev, written.pairs);
    const stamp = await pev.main<Stamp>('sourceStamp');
    const indexDir = await pev.main<string>('indexDir');
    await checkHidden(pev);
    pid = await pev.main<number>('corePid');
    expect(pid).toBeGreaterThan(0);
    startTime = startTimeOf(pid);
    expect(startTime).not.toBeNull();

    // A stopped process can't exit by itself. On Linux, main leaves core to
    // exit on its own, so a stopped core outlives main for sure: it is let go
    // only once main has exited, and a while after. That is where the close
    // wait is proven. On macOS, Electron ends its utility process at quit,
    // before main exits, even a stopped one. That is the platform's behaviour,
    // checked as such, so a change to it fails here rather than passing.
    const mainExited = new Promise<void>((resolve) =>
      pev.app.process().once('exit', () => resolve()),
    );
    process.kill(pid, 'SIGSTOP');
    stopped = true;
    let closedAt = 0;
    const closing = pev.close().then(() => {
      closedAt = Date.now();
    });
    await mainExited;
    if (process.platform === 'darwin') {
      expect(isGone(pid)).toBe(true);
      stopped = false;
      await closing;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(isGone(pid)).toBe(false);
      const contAt = Date.now();
      process.kill(pid, 'SIGCONT');
      stopped = false;
      await closing;
      // close came back after core was let go.
      expect(closedAt).toBeGreaterThanOrEqual(contAt);
    }

    // The close waited for core, which is gone.
    expect(['gone', 'zombie']).toContain(pev.closeWait?.state);
    expect(isGone(pid)).toBe(true);
    // Nothing holds the index: it opens with no busy timeout, checkpoints and takes a write lock.
    const db = openDb(join(indexDir, `${stamp.sourceKey}.sqlite`));
    try {
      // A reader still there would leave the checkpoint busy, without an error.
      expect(db.stmt('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({ busy: 0 });
      db.exec('BEGIN IMMEDIATE');
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  } finally {
    // Whatever failed, no stopped core is left behind.
    if (pid !== undefined && stopped) {
      try {
        process.kill(pid, 'SIGCONT');
      } catch {
        // Already gone.
      }
    }
    await pev.close().catch(() => undefined);
    if (pid !== undefined) {
      await waitGone(pid, { timeoutMs: CORE_EXIT_MS, startTime }).catch(() => undefined);
    }
  }
});
