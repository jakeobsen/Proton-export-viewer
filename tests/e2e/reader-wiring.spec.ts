// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader follows the list: a selected conversation opens its newest
// message from the open export, through the contained open. Fast selection
// renders only the newest open; a switch, Forget, a window close or a new
// generation leaves nothing of the old view; an export that isn't there sends
// nothing to core; and a message file that is missing, deleted or swapped
// shows a state and holds nothing up.

import { realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { RejectCode } from '../../src/shared/api';
import type {
  EmlFile,
  IndexProgress,
  IndexTotals,
  ListRow,
  ListWindow,
} from '../../src/shared/index-types';
import type { Stamp } from '../../src/shared/sources';
import { writeExport, type WrittenExport } from '../exports';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

interface Reader {
  rowid: number | null;
  pending: boolean;
  view: { url: string } | null;
  fallback: boolean;
  refused: RejectCode | null;
}

/** All Mail: every conversation of the export. */
const ALL = '5';

const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);
const reader = (pev: PevApp, page: Page = pev.page) => pev.shell<Reader>('reader', [], page);
const status = async (pev: PevApp, windowId: number, url: string) =>
  (await pev.main<{ status: number }>('fetchIn', windowId, url)).status;
const held = async (pev: PevApp) => (await pev.main<{ value: number }>('core', 'held')).value;
/** Message files core opened for the reader. */
const fileOpens = async (pev: PevApp) =>
  (await pev.main<{ value: number }>('core', 'file-opens')).value;
const count = (pev: PevApp, code: string, match: Record<string, unknown> = {}) =>
  pev
    .logs('main')
    .filter((l) => l.code === code && Object.entries(match).every(([k, v]) => l.data[k] === v))
    .length;

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');
const pressRow = (page: Page, row: ListRow) => press(page, `.conv[data-thread="${row.threadId}"]`);
const arrowDown = (page: Page) =>
  page.locator('.list-scroll').dispatchEvent('keydown', { key: 'ArrowDown' });

async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ phase: 'done', loaded: total, total });
}

async function openExport(
  pev: PevApp,
  name: string,
  seed: number,
  bookmark = 'bm1',
): Promise<WrittenExport> {
  const root = realpathSync(testDir(name));
  const written = writeExport(root, { seed, messages: 20 });
  await pev.main('queuePick', root, bookmark);
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  await showAll(pev);
  return written;
}

/** The conversations in All Mail; none while the index has no answer yet. */
async function inbox(pev: PevApp): Promise<ListRow[]> {
  const answer = await ask<ListWindow>(pev, {
    op: 'window',
    labelId: ALL,
    anchor: { index: 0 },
    before: 0,
    after: 50,
    selected: null,
  });
  return answer?.answer.rows ?? [];
}

/** Shows All Mail in the list. */
async function showAll(pev: PevApp, page: Page = pev.page): Promise<void> {
  await press(page, `[data-folder="${ALL}"]`);
  await expect(page.locator(`[data-folder="${ALL}"]`)).toHaveAttribute('aria-current', 'true');
}

/** The message file of a row's newest message, as the scan saw it. */
async function emlOf(pev: PevApp, written: WrittenExport, row: ListRow): Promise<string> {
  const file = (await ask<EmlFile>(pev, { op: 'eml', rowid: row.anchorRowid }))!.answer;
  if (file.rel === null) throw new Error('no message file');
  return join(written.run, file.rel);
}

/** Waits until the reader shows the given message in its frame, and returns the view's URL. */
async function shown(pev: PevApp, rowid: number, page: Page = pev.page): Promise<string> {
  await expect
    .poll(async () => {
      const r = await reader(pev, page);
      const src = await page.locator('.reader .rp-frame').getAttribute('src');
      return r.rowid === rowid && !r.pending && r.view !== null && src === r.view.url;
    })
    .toBe(true);
  const url = (await reader(pev, page)).view!.url;
  await pev.bodyFrame(url, page);
  return url;
}

async function checkHidden(pev: PevApp): Promise<void> {
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
  expect(await pev.main('windowEvents')).toEqual([]);
  expect(await pev.main('dialogCalls')).toEqual([]);
}

test("a click or a key opens the conversation's newest message from the export", async ({
  pev,
}) => {
  await openExport(pev, 'wire-select', 61);
  const rows = await inbox(pev);
  expect(rows.length).toBeGreaterThan(2);

  await pressRow(pev.page, rows[1]!);
  const first = await shown(pev, rows[1]!.anchorRowid);
  expect(await status(pev, 1, first)).toBe(200);
  // The pane has the message's own header.
  await expect(pev.page.locator('.rp-subject')).not.toHaveText('');

  // The next row by key: the reader follows, and the old view is gone.
  await arrowDown(pev.page);
  await expect(pev.page.locator(`.conv[data-thread="${rows[2]!.threadId}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const second = await shown(pev, rows[2]!.anchorRowid);
  expect(second).not.toBe(first);
  expect(await status(pev, 1, first)).toBe(404);

  // A click on the row already open opens nothing again.
  const installed = count(pev, 'view.installed');
  const opens = await fileOpens(pev);
  await pressRow(pev.page, rows[2]!);
  await pev.page.waitForTimeout(300);
  expect(count(pev, 'view.installed')).toBe(installed);
  expect(await fileOpens(pev)).toBe(opens);
  expect(await status(pev, 1, second)).toBe(200);

  // Another folder: nothing is selected there, so the pane closes.
  await press(pev.page, '[data-folder="0"]');
  await expect.poll(async () => (await reader(pev)).rowid).toBeNull();
  await expect(pev.page.locator('.reader .rp')).toHaveCount(0);
  await checkHidden(pev);
});

test('fast selection renders only the newest open, and opens no file for the others', async ({
  pev,
}) => {
  await openExport(pev, 'wire-fast', 62);
  const rows = await inbox(pev);
  expect(rows.length).toBeGreaterThan(5);
  await pressRow(pev.page, rows[0]!);
  const first = await shown(pev, rows[0]!.anchorRowid);

  // Five key presses while core holds every open. The first goes to core at
  // once; of the four that wait their turn, only the newest follows it.
  const superseded = count(pev, 'ipc.rejected', { reason: 'superseded' });
  await pev.main('core', 'hold');
  for (let i = 0; i < 5; i += 1) await arrowDown(pev.page);
  await expect.poll(() => held(pev)).toBe(2);
  // The three that a newer one replaced while they waited never reached core.
  expect(count(pev, 'ipc.rejected', { reason: 'superseded' })).toBe(superseded + 3);
  // Each open was accepted at once: the old view is gone before any parse.
  expect(await status(pev, 1, first)).toBe(404);
  const installed = count(pev, 'view.installed');
  const opens = await fileOpens(pev);
  await pev.main('core', 'release');

  const last = await shown(pev, rows[5]!.anchorRowid);
  expect(count(pev, 'view.installed')).toBe(installed + 1);
  await expect
    .poll(() => count(pev, 'ipc.rejected', { reason: 'superseded' }))
    .toBe(superseded + 4);
  // Only the newest open's message file was opened.
  expect(await fileOpens(pev)).toBe(opens + 1);
  expect(await pev.main('liveViews', 1)).toBe(1);
  expect(await pev.main('authorizedUrl', 1)).toBe(last);
  await checkHidden(pev);
});

/** The most body requests of a window in any 10 s span. */
function busiestTenSeconds(times: number[]): number {
  let most = 0;
  let start = 0;
  for (let end = 0; end < times.length; end += 1) {
    while (times[end]! - times[start]! >= 10_000) start += 1;
    most = Math.max(most, end - start + 1);
  }
  return most;
}

/** The reader's header and body text, once the reader shows `rowid`. */
async function readerText(pev: PevApp, rowid: number): Promise<{ header: string; body: string }> {
  const url = await shown(pev, rowid);
  const frame = await pev.bodyFrame(url);
  return {
    header: (await pev.page.locator('.reader .rp-subject').textContent()) ?? '',
    body: await frame.locator('body').innerText(),
  };
}

test('selection faster than the frame may navigate: the frame keeps up, the last one shows', async ({
  pev,
}) => {
  await openExport(pev, 'wire-burst', 63);
  const rows = await inbox(pev);
  expect(rows.length).toBeGreaterThan(2);
  await pressRow(pev.page, rows[0]!);
  await shown(pev, rows[0]!.anchorRowid);
  await pev.main('clearRequests');

  // 300 selections a few milliseconds apart, between the first two rows: far
  // more than the 200 frame navigations Chromium follows in 10 s.
  const started = Date.now();
  for (let i = 0; i < 300; i += 1) {
    await pev.page
      .locator('.list-scroll')
      .dispatchEvent('keydown', { key: i % 2 === 0 ? 'ArrowDown' : 'ArrowUp' });
    await pev.page.waitForTimeout(5);
  }
  const elapsed = Date.now() - started;
  const last = rows[0]!;
  await expect(pev.page.locator(`.conv[data-thread="${last.threadId}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // The last selection loads, in the one body frame there is.
  const burst = await readerText(pev, last.anchorRowid);
  await expect(pev.page.locator('.reader .rp-frame')).toHaveCount(1);
  expect(await pev.main('liveViews', 1)).toBe(1);
  const times = await pev.main<number[]>('bodyRequestTimes', 1);
  // Far fewer navigations than selections, at most one per gap.
  expect(busiestTenSeconds(times)).toBeLessThan(200);
  expect(times.length).toBeLessThanOrEqual(Math.ceil(elapsed / 60) + 2);

  // Header and body are the message's own: the same as a calm open of it.
  await pressRow(pev.page, rows[1]!);
  await shown(pev, rows[1]!.anchorRowid);
  await pressRow(pev.page, last);
  expect(await readerText(pev, last.anchorRowid)).toEqual(burst);
  await checkHidden(pev);
});

test('a switch, Forget, a window close or a new generation leaves nothing of the old view', async ({
  pev,
}) => {
  await openExport(pev, 'wire-gen', 63);

  // A switch to another export.
  const rows = await inbox(pev);
  await pressRow(pev.page, rows[0]!);
  const beforeSwitch = await shown(pev, rows[0]!.anchorRowid);
  await openExport(pev, 'wire-gen-other', 64, 'bm2');
  expect(await status(pev, 1, beforeSwitch)).toBe(404);
  await expect.poll(async () => (await reader(pev)).rowid).toBeNull();

  // Forget of the open export.
  const otherRows = await inbox(pev);
  await pressRow(pev.page, otherRows[0]!);
  const beforeForget = await shown(pev, otherRows[0]!.anchorRowid);
  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  await pev.shell('forgetExport', [key]);
  expect(await status(pev, 1, beforeForget)).toBe(404);
  await expect.poll(async () => (await reader(pev)).rowid).toBeNull();

  // A second window's view goes with the window.
  await openExport(pev, 'wire-gen-window', 65, 'bm3');
  const b = await pev.openWindow('shell');
  await showAll(pev, b.page);
  const windowRows = await inbox(pev);
  await expect(b.page.locator(`.conv[data-thread="${windowRows[0]!.threadId}"]`)).toHaveCount(1);
  await pressRow(b.page, windowRows[0]!);
  const inB = await shown(pev, windowRows[0]!.anchorRowid, b.page);
  expect(await status(pev, b.windowId, inB)).toBe(200);
  await b.page.close();
  await expect
    .poll(() => pev.hasLog('view.revoked', { reason: 'window_closed', windowId: b.windowId }))
    .toBe(true);

  // A result that comes back after the generation moved installs nothing.
  await pressRow(pev.page, windowRows[0]!);
  const first = await shown(pev, windowRows[0]!.anchorRowid);
  await pev.main('core', 'hold');
  await pressRow(pev.page, windowRows[1]!);
  await expect.poll(() => held(pev)).toBe(1);
  await pev.main('bumpGeneration');
  await pev.main('notifySources');
  await pev.main('core', 'release');
  await expect.poll(() => pev.hasLog('open.stale', { reason: 'generation' })).toBe(true);
  expect(await pev.main('liveViews', 1)).toBe(0);
  await expect.poll(async () => (await reader(pev)).rowid).toBeNull();
  expect(await status(pev, 1, first)).toBe(404);
  await checkHidden(pev);
});

test('while the export is not there, an open shows that and sends nothing to core', async ({
  pev,
}) => {
  const written = await openExport(pev, 'wire-offline', 66);
  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  const away = realpathSync(testDir('wire-offline-away'));
  renameSync(join(written.root, written.account), join(away, written.account));
  expect(await pev.shell('openExport', [key])).toMatchObject({ outcome: 'offline' });
  // Still browsed from its index.
  await expect.poll(async () => (await inbox(pev)).length).toBeGreaterThan(0);
  const rows = await inbox(pev);
  await expect(pev.page.locator(`.conv[data-thread="${rows[0]!.threadId}"]`)).toHaveCount(1);

  await pev.main('core', 'hold');
  await pressRow(pev.page, rows[0]!);
  await expect.poll(async () => (await reader(pev)).refused).toBe('offline');
  await expect(pev.page.locator('.rp-state')).toHaveText('Export not found.');
  expect(await held(pev)).toBe(0);
  await pev.main('core', 'release');
  expect(pev.hasLog('ipc.rejected', { reason: 'offline' })).toBe(true);
  await checkHidden(pev);
});

test('a message file that is missing, deleted or swapped shows a state and holds nothing up', async ({
  pev,
}) => {
  const root = realpathSync(testDir('wire-files'));
  const written = writeExport(root, { seed: 67, messages: 20 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  await showAll(pev);
  const rows = await inbox(pev);
  expect(rows.length).toBeGreaterThan(5);
  const [missing, deleted, linked, piped, fine] = rows as [
    ListRow,
    ListRow,
    ListRow,
    ListRow,
    ListRow,
  ];
  // Opened again, the reconcile finds the first one's message file gone.
  rmSync(await emlOf(pev, written, missing));
  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  await pev.shell('openExport', [key]);
  await expect
    .poll(async () => (await ask<EmlFile>(pev, { op: 'eml', rowid: missing.anchorRowid }))?.answer)
    .toMatchObject({ bodyState: 4 });

  // The others change after the scan.
  rmSync(await emlOf(pev, written, deleted));
  const linkPath = await emlOf(pev, written, linked);
  rmSync(linkPath);
  symlinkSync(await emlOf(pev, written, fine), linkPath);
  const pipePath = await emlOf(pev, written, piped);
  rmSync(pipePath);
  expect(spawnSync('/usr/bin/mkfifo', [pipePath]).status).toBe(0);

  await pressRow(pev.page, missing);
  await expect.poll(async () => (await reader(pev)).refused).toBe('eml_missing');
  await expect(pev.page.locator('.rp-state')).toHaveText('Message file missing');

  await pressRow(pev.page, deleted);
  await expect
    .poll(async () => (await reader(pev)) as Reader)
    .toMatchObject({ rowid: deleted.anchorRowid, refused: 'eml_missing' });
  await expect(pev.page.locator('.rp-state')).toHaveText('Message file missing');

  for (const row of [linked, piped]) {
    await pressRow(pev.page, row);
    await expect
      .poll(async () => (await reader(pev)) as Reader)
      .toMatchObject({ rowid: row.anchorRowid, pending: false, fallback: true, view: null });
    await expect(pev.page.locator('.rp-fallback b')).toHaveText("Couldn't render this message");
  }
  expect(count(pev, 'open.fallback', { reason: 'file' })).toBe(2);
  expect(
    pev.logs('core').some((l) => l.code === 'open.file_refused' && l.data.reason === 'symlink'),
  ).toBe(true);
  expect(
    pev.logs('core').some((l) => l.code === 'open.file_refused' && l.data.reason === 'fifo'),
  ).toBe(true);

  // Nothing was held up: the next message opens.
  await pressRow(pev.page, fine);
  await shown(pev, fine.anchorRowid);
  await checkHidden(pev);
});

test("the test hooks' stub frame has the attributes of the reader's body frame", async ({
  pev,
}) => {
  await openExport(pev, 'wire-frames', 68);
  const rows = await inbox(pev);
  await pressRow(pev.page, rows[0]!);
  await shown(pev, rows[0]!.anchorRowid);
  await pev.open('sample');
  const attributes = (selector: string) =>
    pev.page.locator(selector).evaluate((el) => {
      const names = [
        'sandbox',
        'referrerpolicy',
        'allow',
        'allowfullscreen',
        'csp',
        'credentialless',
        'srcdoc',
        'loading',
        'name',
      ];
      return Object.fromEntries(names.map((n) => [n, el.getAttribute(n)]));
    });
  const pane = await attributes('.reader iframe.rp-frame');
  const stub = await attributes('iframe.body-frame');
  expect(pane.sandbox).toBe('allow-popups');
  expect(pane.referrerpolicy).toBe('no-referrer');
  expect(stub).toEqual(pane);
  await checkHidden(pev);
});
