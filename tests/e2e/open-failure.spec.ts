// SPDX-License-Identifier: AGPL-3.0-or-later
// What the shell shows while an export opens and when that stops short: the
// loading line from the moment the export opens, then the files read; on a
// reopen, the stored list and the reader while the run is still scanned; an
// index that can't be made as an export closed after an error with Reopen;
// and a throw while the shell renders as a line with Reopen instead of an
// empty window.

import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MessageOpenResult } from '../../src/shared/api';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import type { SourcesView, Stamp } from '../../src/shared/sources';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

const view = (pev: PevApp) => pev.main<SourcesView>('sourcesView');

async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(
      async () => (await pev.main<Answer<IndexTotals>>('indexQuery', { op: 'totals' }))?.progress,
      { timeout: 20_000 },
    )
    .toMatchObject({ phase: 'done', loaded: total, total });
}

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (pev: PevApp, selector: string) => pev.page.locator(selector).dispatchEvent('click');

/** Picks a new export of 6 pairs; the pick returns once the export is open. */
async function openExport(pev: PevApp, name: string, seed: number) {
  const root = realpathSync(testDir(name));
  const written = writeExport(root, { seed, messages: 6 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  return written;
}

test('the loading line shows from the moment the export opens, then the files read', async ({
  pev,
}) => {
  await pev.main('indexTestSettings', { holdScans: true });
  const written = await openExport(pev, 'fail-loading', 50);
  // The export is open and its index answered; core holds the scan before it lists the run.
  expect((await view(pev)).active).toMatchObject({ status: 'online', closed: false });
  await expect.poll(() => pev.main<number>('heldScans')).toBe(1);
  const foot = pev.page.locator('.sidebar .side-foot');
  await expect(foot.locator('.bar-track[role="progressbar"]')).toHaveCount(1);
  // Nothing is counted yet, so the bar shows without numbers.
  await expect(foot.locator('.loading-text')).toHaveCount(0);
  await expect(foot.locator('.bar-track')).not.toHaveAttribute('aria-valuenow');

  // The run listed and looked at; the scan holds again before phase 1 can start.
  await pev.main('releaseScans', 1);
  await expect.poll(() => pev.main<number>('heldScans')).toBe(1);
  await expect(foot.locator('.loading-text')).toHaveText(/^Reading export… (\d+) of \1 files$/);
  await expect(foot.locator('.bar-track')).toHaveAttribute('aria-valuenow', /^[1-9]\d*$/);

  await pev.main('releaseScans', null);
  await phase1Done(pev, written.pairs);
  await expect(foot).toHaveCount(0);
});

test('on reopen, the stored list and the reader work while the run is still being scanned', async ({
  pev,
}) => {
  const written = await openExport(pev, 'fail-reopen', 53);
  await phase1Done(pev, written.pairs);
  const { sourceKey } = await pev.main<Stamp>('sourceStamp');
  const indexDir = await pev.main<string>('indexDir');
  const db = new DatabaseSync(join(indexDir, `${sourceKey}.sqlite`), { readOnly: true });
  const rows = db
    .prepare('SELECT rowid, proton_id FROM messages ORDER BY rowid')
    .all()
    .map((r) => ({ rowid: Number(r.rowid), id: String(r.proton_id) }));
  db.close();
  expect(rows).toHaveLength(written.pairs);
  const [noMeta, noEml, kept] = rows as [(typeof rows)[0], (typeof rows)[0], (typeof rows)[0]];
  // Since the last scan, one message lost its metadata file, another its .eml.
  rmSync(join(written.run, `${noMeta.id}.metadata.json`));
  rmSync(join(written.run, `${noEml.id}.eml`));

  await pev.main('indexTestSettings', { holdScans: true });
  await pev.shell('openExport', [sourceKey]);
  await expect.poll(() => pev.main<number>('heldScans')).toBe(1);
  // The stored list shows while the scan is held.
  await expect(pev.page.locator('.list-head .cnt')).toHaveText(/conversation/);
  await expect(pev.page.locator('.list-scroll .conv:not(.placeholder)')).not.toHaveCount(0);
  // The reader opens stored rows: one whose metadata went (its .eml is there),
  // and one untouched; one whose .eml went shows that state, not an error.
  const open = (rowid: number) => pev.shell<MessageOpenResult>('openInReader', [rowid, 'plain']);
  expect(await open(noMeta.rowid)).toMatchObject({ ok: true, outcome: 'view' });
  expect(await open(kept.rowid)).toMatchObject({ ok: true, outcome: 'view' });
  expect(await open(noEml.rowid)).toMatchObject({ ok: false, code: 'eml_missing' });
  expect(await pev.main<number>('heldScans')).toBe(1);

  // Reconcile then removes the message without metadata.
  await pev.main('releaseScans', null);
  await phase1Done(pev, written.pairs - 1);
  expect(await open(noMeta.rowid)).toMatchObject({ ok: false, code: 'not_found' });
});

test('an index that can not be made closes the export after an error, and Reopen opens it again', async ({
  pev,
}) => {
  // A file where the index folder goes: core can't make the index there.
  const indexDir = join(pev.userData, 'index');
  rmSync(indexDir, { recursive: true, force: true });
  writeFileSync(indexDir, '');
  const written = await openExport(pev, 'fail-index', 51);

  const banner = pev.page.locator('.banner[role="alert"]');
  await expect(banner.locator('span')).toHaveText('Export closed after an error.');
  expect((await view(pev)).active).toMatchObject({ status: 'online', closed: true });
  // Main logs core's answer; core logs the error's class only.
  expect(pev.hasLog('index.open_failed', { proc: 'main', reason: 'unavailable' })).toBe(true);
  expect(pev.hasLog('source.request_failed', { proc: 'core', errorClass: 'Error' })).toBe(true);
  expect(pev.hasLog('index.opened')).toBe(false);
  // A closed export shows no loading line.
  await expect(pev.page.locator('.sidebar .side-foot')).toHaveCount(0);

  rmSync(indexDir);
  await press(pev, '.banner[role="alert"] button:text("Reopen")');
  await expect(banner).toHaveCount(0);
  await phase1Done(pev, written.pairs);
  expect((await view(pev)).active).toMatchObject({ status: 'online', closed: false });
  await expect(pev.page.locator('.list-scroll .conv:not(.placeholder)')).not.toHaveCount(0);
});

test('a throw while the shell renders shows a line with Reopen instead of an empty window', async ({
  pev,
}) => {
  const written = await openExport(pev, 'fail-render', 52);
  await phase1Done(pev, written.pairs);
  const { generation } = await pev.main<Stamp>('sourceStamp');

  await pev.shell('renderFault', [true]);
  const banner = pev.page.locator('.banner[role="alert"]');
  await expect(banner.locator('span')).toHaveText('Stopped after an error.');
  await expect(pev.page.locator('.bar .bar-title')).toHaveCount(1);
  await expect(pev.page.locator('.sidebar')).toHaveCount(0);
  // Reported like any uncaught error: its class, nothing of its message.
  const reports = () => pev.logs().filter((l) => l.code === 'renderer.uncaught');
  await expect.poll(() => reports().length).toBe(1);
  expect(reports()[0]?.data).toMatchObject({ errorClass: 'Error' });
  expect(JSON.stringify(reports())).not.toContain('render fault');

  await pev.shell('renderFault', [false]);
  await press(pev, '.banner[role="alert"] button:text("Reopen")');
  await expect(banner).toHaveCount(0);
  // The export opened again, under a new generation.
  await expect
    .poll(async () => (await pev.main<Stamp>('sourceStamp')).generation)
    .toBe(generation + 1);
  await phase1Done(pev, written.pairs);
  await expect(pev.page.locator('.sidebar')).toHaveCount(1);
  expect(reports()).toHaveLength(1);
});
