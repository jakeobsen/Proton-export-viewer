// SPDX-License-Identifier: AGPL-3.0-or-later
// Export sources in the app: the folder pick (the picker is a test queue and
// scopes are recorded, since test builds run without the App Sandbox), the
// order of scope and core steps, switches, generations, the reopen at launch,
// unavailable exports and Locate.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SourceActionResult } from '../../src/shared/api';
import type { ScanSummary, SourcesView, Stamp } from '../../src/shared/sources';
import { writeExport } from '../exports';
import { MARKERS, findMarkers } from '../markers';
import { testDir } from '../paths';
import { expect, launch, test, type PevApp } from './app';

interface Step {
  step: string;
  pickId: string | null;
  sourceKey: string | null;
  generation: number;
}

interface CoreRecords {
  scans: number;
  summary: ScanSummary | null;
  stamp: Stamp | null;
  hasRoot: boolean;
}

const steps = (order: Step[]) => order.map((s) => s.step);

async function coreRecords(pev: PevApp): Promise<CoreRecords> {
  const result = await pev.main<{ ok: boolean; data: CoreRecords }>('core', 'source-records');
  return result.data;
}

const act = (pev: PevApp, name: string, ...args: unknown[]) =>
  pev.shell<SourceActionResult>(name, args);

const view = (pev: PevApp) => pev.main<SourcesView>('sourcesView');

/** Closes an app launched without the fixture, after the same background checks. */
async function closeChecked(pev: PevApp) {
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
  expect(await pev.main('windowEvents')).toEqual([]);
  expect(await pev.main('dialogCalls')).toEqual([]);
  await pev.close();
}

/** An export tool folder with one account and two runs: 20 messages in the newer, 7 in the older. */
function twoRuns(name: string, account?: string) {
  const root = realpathSync(testDir(name));
  const newer = writeExport(root, { seed: 1, account });
  const older = writeExport(root, {
    seed: 1,
    account,
    runName: 'mail_20250101_100000',
    messages: 7,
  });
  return { root, newer, older };
}

test('before an export is open core has no root; a pick starts the scope, then core with the newest run', async ({
  pev,
}) => {
  expect(await coreRecords(pev)).toMatchObject({ stamp: null, hasRoot: false });
  const { root, newer } = twoRuns('src-pick');
  await pev.main('clearSourceOrder');
  await pev.main('queuePick', root, 'bm1');

  expect(await act(pev, 'chooseFolder')).toMatchObject({ ok: true, outcome: 'opened' });
  // Core was running without a source (it answered above), so it stops first.
  expect(steps(await pev.main<Step[]>('sourceOrder'))).toEqual([
    'core.stop',
    'scope.start',
    'core.spawn',
  ]);
  const stamp = await pev.main<Stamp>('sourceStamp');
  expect(await coreRecords(pev)).toMatchObject({ stamp, hasRoot: true });
  await expect
    .poll(() => pev.main<ScanSummary | null>('scanSummary'))
    .toMatchObject({ pairs: 20, labels: true });
  expect(await pev.main('liveScopes')).toEqual(['bm1']);
  expect(await pev.main('pickerCalls')).toBe(1);

  const sources = await view(pev);
  expect(sources.active).toMatchObject({
    sourceKey: stamp.sourceKey,
    account: newer.account,
    runName: newer.runName,
    status: 'online',
  });
  expect(sources.active?.runs.map((r) => [r.runName, r.current])).toEqual([
    ['mail_20250630_120000', true],
    ['mail_20250101_100000', false],
  ]);

  // The registry: 0600 in a 0700 folder.
  const file = await pev.main<string>('registryFile');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(pev.userData).mode & 0o777).toBe(0o700);
  expect(readFileSync(file, 'utf8')).toContain(newer.account);

  // The shell shows the export and, with two runs, the run picker.
  await expect(pev.page.locator('.export-account')).toHaveText(newer.account);
  await expect(pev.page.locator('.run-picker option')).toHaveCount(2);
});

test('a switch between sibling runs keeps the scope, restarts core, and drops results from before', async ({
  pev,
}) => {
  const { root } = twoRuns('src-sibling');
  // Results from core wait in main, so the first run's scan is still in
  // flight when the switch happens.
  await pev.main('holdSourceResults');
  await pev.main('queuePick', root, 'bm1');
  await act(pev, 'chooseFolder');
  const first = await pev.main<Stamp>('sourceStamp');
  const firstPid = await pev.main<number>('corePid');
  await expect.poll(() => pev.main<number>('heldSourceResults')).toBe(1);
  const older = (await view(pev)).active!.runs[1]!;

  await pev.main('clearSourceOrder');
  expect(await act(pev, 'switchRun', older.runId)).toMatchObject({
    ok: true,
    outcome: 'opened',
    generation: first.generation + 1,
  });
  expect(steps(await pev.main<Step[]>('sourceOrder'))).toEqual([
    'core.stop',
    'scope.keep',
    'core.spawn',
  ]);
  const second = await pev.main<Stamp>('sourceStamp');
  expect(second.generation).toBe(first.generation + 1);
  expect(second.sourceKey).not.toBe(first.sourceKey);
  expect(await pev.main<number>('corePid')).not.toBe(firstPid);
  expect(await pev.main('liveScopes')).toEqual(['bm1']);
  expect(await coreRecords(pev)).toMatchObject({ stamp: second, hasRoot: true });

  // A request made for the old generation is refused.
  expect(await pev.page.evaluate((g) => window.pev.ping(g), first.generation)).toEqual({
    ok: false,
    code: 'stale_generation',
  });

  // Main drops the first run's late scan and takes the second's.
  await expect.poll(() => pev.main<number>('heldSourceResults')).toBe(2);
  expect(await pev.main('releaseSourceResults')).toBe(2);
  expect(await pev.main<ScanSummary>('scanSummary')).toMatchObject({ pairs: 7 });
  expect(
    pev
      .logs('main')
      .some(
        (l) => l.code === 'source.stale_result' && (l as { src?: string }).src === first.sourceKey,
      ),
  ).toBe(true);
  // Core's writer took only the second run's scan.
  expect(await coreRecords(pev)).toMatchObject({ scans: 1, summary: { pairs: 7 } });
});

test('a switch between separate picks releases the old scope before it starts the new one', async ({
  pev,
}) => {
  const one = twoRuns('src-picks-1');
  const two = realpathSync(testDir('src-picks-2'));
  const other = writeExport(two, { seed: 2, messages: 5 });
  // Results from core wait in main, so the first pick's scan is still in
  // flight when the switch happens. The scan follows the index open, so
  // wait until it has reached main.
  await pev.main('holdSourceResults');
  await pev.main('queuePick', one.root, 'bm1');
  await act(pev, 'chooseFolder');
  await expect.poll(() => pev.main<number>('heldSourceResults')).toBe(1);
  const first = await pev.main<Stamp>('sourceStamp');
  const firstPick = (await pev.main<Step[]>('sourceOrder')).find(
    (s) => s.step === 'scope.start',
  )!.pickId;

  await pev.main('clearSourceOrder');
  await pev.main('queuePick', two, 'bm2');
  expect(await act(pev, 'chooseFolder')).toMatchObject({ ok: true, outcome: 'opened' });
  const order = await pev.main<Step[]>('sourceOrder');
  expect(steps(order)).toEqual(['core.stop', 'scope.release', 'scope.start', 'core.spawn']);
  expect(order[1]!.pickId).toBe(firstPick);
  expect(order[2]!.pickId).not.toBe(firstPick);
  expect(await pev.main('liveScopes')).toEqual(['bm2']);
  const second = await pev.main<Stamp>('sourceStamp');
  expect(second.generation).toBe(first.generation + 1);
  expect((await view(pev)).active).toMatchObject({ account: other.account, status: 'online' });
  expect((await view(pev)).recent).toHaveLength(2);

  await expect.poll(() => pev.main<number>('heldSourceResults')).toBe(2);
  await pev.main('releaseSourceResults');
  expect(await pev.main<ScanSummary>('scanSummary')).toMatchObject({ pairs: 5 });
  expect(await coreRecords(pev)).toMatchObject({ stamp: second, scans: 1, summary: { pairs: 5 } });
});

test('the export open at quit opens again at launch; the scope is released at quit', async () => {
  const { root, newer } = twoRuns('src-relaunch');
  const first = await launch('src-relaunch-1');
  let key: string;
  try {
    await first.main('queuePick', root, 'bm1');
    await act(first, 'chooseFolder');
    key = (await first.main<Stamp>('sourceStamp')).sourceKey;
  } finally {
    await closeChecked(first);
  }
  expect(first.hasLog('scope.released', { reason: 'quit' })).toBe(true);

  const again = await launch('src-relaunch-2', { userData: first.userData });
  try {
    await expect.poll(async () => (await view(again)).active?.sourceKey).toBe(key);
    expect(steps(await again.main<Step[]>('sourceOrder'))).toEqual(['scope.start', 'core.spawn']);
    expect((await view(again)).active).toMatchObject({ status: 'online', account: newer.account });
    expect(await again.main('liveScopes')).toEqual(['bm1']);
    expect(await again.main('pickerCalls')).toBe(0);
    await expect(again.page.locator('.export-account')).toHaveText(newer.account);
  } finally {
    await closeChecked(again);
  }
});

test('an unavailable export opens offline, and Locate takes the same run back', async () => {
  const { root, newer } = twoRuns('src-offline');
  const first = await launch('src-offline-1');
  let key: string;
  try {
    await first.main('queuePick', root, 'bm1');
    await act(first, 'chooseFolder');
    key = (await first.main<Stamp>('sourceStamp')).sourceKey;
  } finally {
    await closeChecked(first);
  }

  // The bookmark is stale at the next launch.
  const stale = await launch('src-offline-2', {
    userData: first.userData,
    args: ['--pev-fail-bookmark=bm1'],
  });
  try {
    await expect.poll(async () => (await view(stale)).active?.status).toBe('offline');
    expect(steps(await stale.main<Step[]>('sourceOrder'))).toEqual(['scope.failed', 'core.spawn']);
    expect(await coreRecords(stale)).toMatchObject({ hasRoot: false });
    expect(await stale.main('liveScopes')).toEqual([]);
    await expect(stale.page.locator('.banner')).toContainText('Export not found.');
    await expect(stale.page.locator('.banner button')).toHaveText('Locate export…');
  } finally {
    await closeChecked(stale);
  }

  // The export moved; the next launch finds its folder gone.
  const moved = realpathSync(testDir('src-offline-moved'));
  renameSync(join(root, newer.account), join(moved, newer.account));
  const gone = await launch('src-offline-3', { userData: first.userData });
  try {
    await expect.poll(async () => (await view(gone)).active?.status).toBe('offline');
    expect(await coreRecords(gone)).toMatchObject({ hasRoot: false });

    await gone.main('queuePick', moved, 'bm2');
    expect(await act(gone, 'locateExport')).toMatchObject({ ok: true, outcome: 'opened' });
    expect((await view(gone)).active).toMatchObject({ sourceKey: key, status: 'online' });
    expect((await view(gone)).recent).toHaveLength(1);
    expect(await gone.main('liveScopes')).toEqual(['bm2']);
    expect(await coreRecords(gone)).toMatchObject({ hasRoot: true });
    await expect(gone.page.locator('.banner')).toHaveCount(0);
  } finally {
    await closeChecked(gone);
  }
});

test('a link put on the way to the open export makes it unavailable at the next launch', async () => {
  const { root, newer } = twoRuns('src-linked');
  const first = await launch('src-linked-1');
  try {
    await first.main('queuePick', root, 'bm1');
    await act(first, 'chooseFolder');
  } finally {
    await closeChecked(first);
  }
  // The account folder becomes a link to a copy elsewhere.
  const elsewhere = realpathSync(testDir('src-linked-elsewhere'));
  const account = join(root, newer.account);
  cpSync(account, join(elsewhere, 'copy'), { recursive: true });
  rmSync(account, { recursive: true });
  symlinkSync(join(elsewhere, 'copy'), account);

  const again = await launch('src-linked-2', { userData: first.userData });
  try {
    await expect.poll(async () => (await view(again)).active?.status).toBe('offline');
    expect(steps(await again.main<Step[]>('sourceOrder'))).toEqual([
      'scope.start',
      'scope.release',
      'core.spawn',
    ]);
    expect(await coreRecords(again)).toMatchObject({ hasRoot: false, scans: 0 });
    expect(await again.main('liveScopes')).toEqual([]);
  } finally {
    await closeChecked(again);
  }
});

test('actions made for the same generation run one at a time, and the later ones are refused', async ({
  pev,
}) => {
  const { root } = twoRuns('src-queue');
  const other = realpathSync(testDir('src-queue-other'));
  writeExport(other, { seed: 2, messages: 3 });
  await pev.main('queuePick', root, 'bm1');
  await act(pev, 'chooseFolder');
  const older = (await view(pev)).active!.runs[1]!;
  await pev.main('queuePick', other, 'bm2');
  await pev.main('clearSourceOrder');
  const generation = (await pev.main<Stamp>('sourceStamp')).generation;

  const results = await pev.page.evaluate(
    ([g, runId]) =>
      Promise.all([
        window.pev.chooseFolder(g),
        window.pev.switchRun(runId, g),
        window.pev.locateExport(g),
      ]),
    [generation, older.runId] as const,
  );
  expect(results).toEqual([
    { ok: true, outcome: 'opened', generation: generation + 1 },
    { ok: false, code: 'stale_generation' },
    { ok: false, code: 'stale_generation' },
  ]);
  expect(await pev.main('pickerCalls')).toBe(2);
  expect(steps(await pev.main<Step[]>('sourceOrder'))).toEqual([
    'core.stop',
    'scope.release',
    'scope.start',
    'core.spawn',
  ]);
  expect((await pev.main<Stamp>('sourceStamp')).generation).toBe(generation + 1);
});

test('Locate: another run with the same run name, account and labels is a new source, and the first index is untouched', async ({
  pev,
}) => {
  const firstRoot = realpathSync(testDir('src-same-1'));
  const a = writeExport(firstRoot, { seed: 1 });
  await pev.main('queuePick', firstRoot, 'bm1');
  await act(pev, 'chooseFolder');
  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  // Stands in for the first export's index.
  const index = join(pev.userData, 'index');
  mkdirSync(index, { recursive: true });
  writeFileSync(join(index, `${key}.sqlite`), 'index of the first export');

  // The first export goes away: its account folder moves to another folder.
  const away = realpathSync(testDir('src-same-away'));
  renameSync(join(firstRoot, a.account), join(away, a.account));
  expect(await act(pev, 'openExport', key)).toMatchObject({ outcome: 'offline' });
  const registryBefore = JSON.parse(
    readFileSync(await pev.main<string>('registryFile'), 'utf8'),
  ) as {
    sources: Array<{ sourceKey: string }>;
  };
  const recordBefore = registryBefore.sources.find((s) => s.sourceKey === key);

  // Same run folder name, account folder name and labels.json; other messages.
  const secondRoot = realpathSync(testDir('src-same-2'));
  const b = writeExport(secondRoot, { seed: 2, account: a.account, labelsSeed: 1 });
  expect(b.runName).toBe(a.runName);
  expect(readFileSync(join(b.run, 'labels.json'))).toEqual(
    readFileSync(join(away, a.account, a.runName, 'labels.json')),
  );
  await pev.main('queuePick', secondRoot, 'bm2');
  expect(await act(pev, 'locateExport')).toMatchObject({ ok: true, outcome: 'new_source' });

  const now = await pev.main<Stamp>('sourceStamp');
  expect(now.sourceKey).not.toBe(key);
  const registryAfter = JSON.parse(
    readFileSync(await pev.main<string>('registryFile'), 'utf8'),
  ) as {
    sources: Array<{ sourceKey: string }>;
  };
  expect(registryAfter.sources.find((s) => s.sourceKey === key)).toEqual(recordBefore);
  expect(readFileSync(join(index, `${key}.sqlite`), 'utf8')).toBe('index of the first export');
  expect((await view(pev)).recent.map((r) => r.sourceKey).sort()).toEqual(
    [key, now.sourceKey].sort(),
  );
});

test('the welcome screen: Choose folder…, a cancelled pick and a folder without an export', async ({
  pev,
}) => {
  await expect(pev.page.locator('.welcome-title')).toHaveText('Open a Proton Mail export');
  const choose = pev.page.locator('.welcome-pick button');
  await expect(choose).toHaveText('Choose folder…');

  // Cancelled: nothing changes.
  await choose.dispatchEvent('click');
  await expect.poll(() => pev.main('pickerCalls')).toBe(1);
  await expect(pev.page.locator('.welcome')).toHaveCount(1);

  // A folder without an export.
  await pev.main('queuePick', realpathSync(testDir('src-welcome-empty')), 'bm0');
  await choose.dispatchEvent('click');
  await expect(pev.page.locator('.notice')).toHaveText('No export found');

  const { root, newer } = twoRuns('src-welcome');
  await pev.main('queuePick', root, 'bm1');
  await choose.dispatchEvent('click');
  await expect(pev.page.locator('.export-account')).toHaveText(newer.account);
  await expect(pev.page.locator('.welcome')).toHaveCount(0);
  expect(await pev.main('liveScopes')).toEqual(['bm1']);
});

test('the source channels check their arguments, the generation and what they name', async ({
  pev,
}) => {
  const invoke = (channel: string, ...args: unknown[]) =>
    pev.page.evaluate(([c, a]) => window.__pevTestIpc.invoke(c, ...a), [channel, args] as const);
  const invalid = { ok: false, code: 'invalid' };
  const key = '01234567-89ab-4def-8123-456789abcdef';

  expect(await invoke('pev:sources', { generation: 1 })).toEqual({
    ok: true,
    generation: 1,
    sources: { restoring: false, active: null, recent: [] },
  });
  expect(await invoke('pev:sources')).toEqual(invalid);
  expect(await invoke('pev:sources', { generation: 0 })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  expect(await invoke('pev:choose-folder', { generation: 1, path: '/tmp' })).toEqual(invalid);
  expect(await invoke('pev:open-export', { generation: 1, sourceKey: '../x' })).toEqual(invalid);
  expect(await invoke('pev:open-export', { generation: 1, sourceKey: key })).toEqual({
    ok: false,
    code: 'unknown_source',
  });
  expect(await invoke('pev:switch-run', { generation: 1, runId: '0123456789abcdef' })).toEqual({
    ok: false,
    code: 'unknown_run',
  });
  expect(await invoke('pev:switch-run', { generation: 1, runId: 'mail_x' })).toEqual(invalid);
  expect(await invoke('pev:locate-export', { generation: 1 })).toEqual({
    ok: false,
    code: 'no_source',
  });
  expect(await invoke('pev:choose-folder', { generation: 2 })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  expect(await pev.main('pickerCalls')).toBe(0);
  expect(await pev.main('sourceOrder')).toEqual([]);
});

test('no path or account name reaches a log file through the source paths', async ({ pev }) => {
  const account = MARKERS[0];
  const { root } = twoRuns('src-redaction', account);
  await pev.main('queuePick', root, 'bm1');
  await act(pev, 'chooseFolder');
  await expect.poll(() => pev.main('scanSummary')).not.toBeNull();
  const older = (await view(pev)).active!.runs[1]!;
  await act(pev, 'switchRun', older.runId);
  const away = realpathSync(testDir('src-redaction-away'));
  renameSync(join(root, account), join(away, account));
  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  await act(pev, 'openExport', key);
  expect((await view(pev)).active?.status).toBe('offline');
  await pev.main('queuePick', realpathSync(testDir('src-redaction-empty')), 'bm2');
  expect(await act(pev, 'locateExport')).toMatchObject({ outcome: 'no_export' });
  await pev.main('queuePick', away, 'bm3');
  expect(await act(pev, 'locateExport')).toMatchObject({ outcome: 'opened' });
  await expect.poll(() => pev.hasLog('scan.done', { proc: 'core' })).toBe(true);

  for (const code of ['source.opened', 'source.offline', 'source.no_runs', 'scope.released']) {
    expect(pev.hasLog(code), code).toBe(true);
  }
  const dir = pev.logsDir();
  for (const file of ['main.jsonl', 'core.jsonl']) {
    const text = existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : '';
    expect(findMarkers(text), file).toEqual([]);
    expect(text, file).not.toContain(root);
    expect(text, file).not.toContain(away);
    expect(text, file).not.toContain('mail_2025');
  }
});
