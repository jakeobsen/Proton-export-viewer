// SPDX-License-Identifier: AGPL-3.0-or-later
// The index's lifecycle in the app: a damaged index is found by its check
// after a reopen and rebuilt; while the export is gone it is deleted and
// rebuilt once the export is located; Forget leaves no file of the index; and
// Reset deletes the app's data once the open export is torn down. The exports
// are never changed.

import { existsSync, readFileSync, readdirSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceActionResult } from '../../src/shared/api';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import type { SourcesView, Stamp } from '../../src/shared/sources';
import { digest } from '../../tools/gen-export/tree.mjs';
import { writeExport } from '../exports';
import { damageTablePage } from '../index-helpers';
import { testDir } from '../paths';
import { expect, launch, test, type PevApp } from './app';

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
  try {
    await first.main('queuePick', root, 'bm1');
    await first.shell('chooseFolder', []);
    await phase1Done(first, pairs);
    const stamp = await first.main<Stamp>('sourceStamp');
    const indexDir = await first.main<string>('indexDir');
    const registry = await first.main<string>('registryFile');
    const uuid = registryUuid(registry, stamp.sourceKey)!;
    await checkHidden(first);
    return { userData: first.userData, stamp, indexDir, registry, uuid };
  } finally {
    await first.close();
  }
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

test('Reset deletes the app data once the open export is torn down', async ({ pev }) => {
  const root = realpathSync(testDir('life-reset'));
  const written = writeExport(root, { seed: 25, messages: 20 });
  const before = digest(root);
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  const indexDir = await pev.main<string>('indexDir');
  const registry = await pev.main<string>('registryFile');
  expect(existsSync(registry)).toBe(true);

  await pev.main('resetApp');
  expect(existsSync(indexDir)).toBe(false);
  expect(existsSync(registry)).toBe(false);
  expect(await view(pev)).toEqual({ restoring: false, active: null, recent: [] });
  expect(await pev.main('liveScopes')).toEqual([]);
  // Nothing opens afterwards, and nothing comes back.
  await pev.main('queuePick', root, 'bm2');
  expect(await pev.shell<SourceActionResult>('chooseFolder', [])).toMatchObject({
    ok: true,
    outcome: 'closed',
  });
  await new Promise((r) => setTimeout(r, 1000));
  expect(existsSync(indexDir)).toBe(false);
  expect(existsSync(registry)).toBe(false);
  expect(digest(root)).toBe(before);
});
