// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings: what it shows for the open export, Back to mail, the mail kept
// under it, Files and its Report link, the menu item, Rebuild, Forget and
// Reset with their confirmations, actions offered for one export refused
// once another is open, the logs actions and the diagnostics summary, and
// the settings file.

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { DoneResult, SettingsResult, SourceActionResult } from '../../src/shared/api';
import { IPC } from '../../src/shared/api';
import { byteSize } from '../../src/shared/bytes';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import type { SourcesView, Stamp } from '../../src/shared/sources';
import { homeRelative } from '../../src/main/settings-info';
import { changedAt } from '../../src/renderer/format';
import { digest } from '../../tools/gen-export/tree.mjs';
import { writeExport, type WrittenExport } from '../exports';
import { findMarkers, MARKER_TEXT, MARKERS } from '../markers';
import { testDir } from '../paths';
import { expect, launch, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

/** All Mail: every conversation of the export. */
const ALL = '5';

const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);
const view = (pev: PevApp) => pev.main<SourcesView>('sourcesView');

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');
const pressButton = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).dispatchEvent('click');

async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ phase: 'done', loaded: total, total });
}

async function openExport(pev: PevApp, written: WrittenExport, bookmark = 'bm1'): Promise<Stamp> {
  await pev.main('queuePick', written.root, bookmark);
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  return pev.main<Stamp>('sourceStamp');
}

function registryUuid(file: string, sourceKey: string): string | null | undefined {
  const registry = JSON.parse(readFileSync(file, 'utf8')) as {
    sources: Array<{ sourceKey: string; dbUuid?: string | null }>;
  };
  return registry.sources.find((s) => s.sourceKey === sourceKey)?.dbUuid;
}

const familyOf = (indexDir: string, key: string) =>
  existsSync(indexDir) ? readdirSync(indexDir).filter((n) => n.startsWith(key)) : [];

/** The family's size as Settings adds it up: regular files only. */
function familyBytes(indexDir: string, key: string): number {
  let bytes = 0;
  for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-journal']) {
    try {
      const stat = lstatSync(join(indexDir, `${key}${suffix}`));
      if (stat.isFile()) bytes += stat.size;
    } catch {
      // Not there.
    }
  }
  return bytes;
}

/** What Settings reads from main, for the shell's current generation. */
const settingsRead = (page: Page) =>
  page.evaluate(async () => {
    const api = (window as unknown as { __pevTest: { state(): { generation: number | null } } })
      .__pevTest;
    const pev = (window as unknown as { pev: { settings(g: number): Promise<SettingsResult> } })
      .pev;
    return pev.settings(api.state().generation ?? 0);
  });

const settingsMain = (page: Page) => page.locator('main.settings');
const mailScreen = (page: Page) => page.locator('.mail-screen');
const welcome = (page: Page) => page.getByRole('heading', { name: 'Open a Proton Mail export' });

async function openSettings(page: Page): Promise<void> {
  await pressButton(page, 'Settings');
  await expect(settingsMain(page)).toBeVisible();
  await expect(mailScreen(page)).toBeHidden();
}

async function showTab(page: Page, name: 'Index' | 'Logs' | 'Appearance'): Promise<void> {
  await page.getByRole('tab', { name }).dispatchEvent('click');
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

/** The value next to a label in the open tab. */
const field = (page: Page, label: string) =>
  page.locator('.settings dl.kv dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');

/** An element's box in the window. */
const rectOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  });

/** The conversation list's scroll offset; hidden windows get no wheel, so it is set directly. */
const listTop = (page: Page) =>
  page.locator('.list-scroll').evaluate((el) => (el as HTMLElement).scrollTop);
const scrollList = (page: Page, top: number) =>
  page.locator('.list-scroll').evaluate((el, y) => {
    el.scrollTop = y;
    el.dispatchEvent(new Event('scroll'));
  }, top);

async function checkHidden(pev: PevApp): Promise<void> {
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
  expect(await pev.main('windowEvents')).toEqual([]);
  expect(await pev.main('dialogCalls')).toEqual([]);
}

test('Settings shows the open export, and Back to mail keeps the folder and the open message', async ({
  pev,
}) => {
  const root = realpathSync(testDir('settings-fields'));
  const written = writeExport(root, { seed: 41, messages: 12 });
  const stamp = await openExport(pev, written);
  const indexDir = await pev.main<string>('indexDir');

  // A folder and a message are open.
  await press(pev.page, `[data-folder="${ALL}"]`);
  const rows = (await ask<{ rows: Array<{ threadId: number; newestRowid: number }> }>(pev, {
    op: 'window',
    labelId: ALL,
    anchor: { index: 0 },
    before: 0,
    after: 50,
    selected: null,
  }))!.answer.rows;
  const row = rows[2]!;
  await press(pev.page, `.conv[data-thread="${row.threadId}"]`);
  await expect
    .poll(async () => {
      const r = await pev.shell<{ rowid: number | null; pending: boolean; view: unknown }>(
        'reader',
      );
      return r.rowid === row.newestRowid && !r.pending && r.view !== null;
    })
    .toBe(true);
  const installed = pev.logs('main').filter((l) => l.code === 'view.installed').length;
  const opened = await pev.shell<{ view: { openId: number } }>('reader');

  await openSettings(pev.page);
  await expect(pev.page.locator('.settings .sec h3').first()).toHaveText(
    `${written.account} · Export 30 Jun 2025, 12:00`,
  );
  const location = homeRelative(join(indexDir, `${stamp.sourceKey}.sqlite`), userInfo().homedir);
  expect(location.startsWith('~/')).toBe(true);
  const where = field(pev.page, 'Location');
  await expect(where).toHaveAttribute('title', location);
  await expect(where).toHaveAttribute('aria-label', location);
  // Shown whole, or clipped in the middle: the start and the file name stay.
  const clippedText = (await where.textContent())!;
  if (clippedText !== location) {
    const [head, tail] = clippedText.split('…');
    expect(location.startsWith(head!)).toBe(true);
    expect(location.endsWith(tail!)).toBe(true);
  }
  // In full while it has focus.
  await where.focus();
  await expect(where).toHaveText(location);
  await where.blur();

  await expect
    .poll(
      async () =>
        (await field(pev.page, 'Size').textContent()) ===
        byteSize(familyBytes(indexDir, stamp.sourceKey)),
    )
    .toBe(true);
  // Every message file's text is indexed by now.
  await expect(field(pev.page, 'Status')).toHaveText('Complete');
  const read = await settingsRead(pev.page);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.view.index).toMatchObject({
    sourceKey: stamp.sourceKey,
    account: written.account,
    runName: written.runName,
    location,
  });
  const db = statSync(join(indexDir, `${stamp.sourceKey}.sqlite`)).mtimeMs;
  expect(read.view.index!.updatedAt).toBeGreaterThanOrEqual(Math.floor(db));
  // Last updated shows that time as the shell words it.
  await expect
    .poll(async () => {
      const now = await settingsRead(pev.page);
      const updatedAt = now.ok ? now.view.index?.updatedAt : null;
      if (updatedAt === null || updatedAt === undefined) return 'no time';
      return (await field(pev.page, 'Last updated').textContent()) === changedAt(updatedAt);
    })
    .toBe(true);
  expect(read.view.logsLocation).toBe(homeRelative(pev.logsDir(), userInfo().homedir) + '/');

  // Back to the same folder, conversation and message, with no new open.
  await pressButton(pev.page, 'Back to mail');
  await expect(settingsMain(pev.page)).toHaveCount(0);
  await expect(mailScreen(pev.page)).toBeVisible();
  await expect(pev.page.locator(`[data-folder="${ALL}"]`)).toHaveAttribute('aria-current', 'true');
  await expect(pev.page.locator(`.conv[data-thread="${row.threadId}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect((await pev.shell<{ view: { openId: number } }>('reader')).view.openId).toBe(
    opened.view.openId,
  );
  expect(pev.logs('main').filter((l) => l.code === 'view.installed')).toHaveLength(installed);

  // The header's button opens and closes it too.
  await openSettings(pev.page);
  await pressButton(pev.page, 'Settings');
  await expect(mailScreen(pev.page)).toBeVisible();
  await checkHidden(pev);
});

test('under Settings the mail stays mounted, unseen and inert, and comes back scrolled as it was', async ({
  pev,
}) => {
  const root = realpathSync(testDir('settings-cover'));
  const written = writeExport(root, { seed: 42, messages: 120 });
  await openExport(pev, written);
  await press(pev.page, `[data-folder="${ALL}"]`);
  await press(pev.page, '.list-scroll .conv >> nth=1');
  await expect
    .poll(async () => (await pev.shell<{ view: { url: string } | null }>('reader')).view?.url)
    .toBeTruthy();
  const shown = await pev.shell<{ rowid: number; view: { url: string; openId: number } }>('reader');
  const frame = pev.page.locator('.reader iframe.rp-frame');
  await expect(frame).toHaveAttribute('src', shown.view.url);
  // The list scrolled away from its top.
  await expect
    .poll(() =>
      pev.page.locator('.list-scroll').evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBeGreaterThan(300);
  await scrollList(pev.page, 300);
  await expect.poll(() => listTop(pev.page)).toBe(300);

  await openSettings(pev.page);
  // The mail is still there under Settings, laid out but unseen and inert,
  // and Settings takes exactly its place.
  const mail = mailScreen(pev.page);
  await expect(mail).toHaveCount(1);
  await expect(mail).toHaveAttribute('inert', '');
  await expect(pev.page.locator('.list-scroll')).toBeHidden();
  await expect(frame).toBeHidden();
  await expect(frame).toHaveAttribute('src', shown.view.url);
  expect(await rectOf(pev.page, 'main.settings')).toEqual(await rectOf(pev.page, '.mail-screen'));
  expect(await listTop(pev.page)).toBe(300);

  // Back to mail: the list where it was, the same message and frame.
  await pressButton(pev.page, 'Back to mail');
  await expect(settingsMain(pev.page)).toHaveCount(0);
  await expect(mail).not.toHaveAttribute('inert', '');
  await expect(pev.page.locator('.list-scroll')).toBeVisible();
  expect(await listTop(pev.page)).toBe(300);
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('src', shown.view.url);
  expect(await pev.shell('reader')).toMatchObject({
    rowid: shown.rowid,
    view: { openId: shown.view.openId },
  });
  await checkHidden(pev);
});

test('Files counts the skipped and truncated files, and Report shows the index report in its place', async ({
  pev,
}) => {
  const root = realpathSync(testDir('settings-files'));
  const written = writeExport(root, { seed: 43, messages: 12 });
  const names = readdirSync(written.run)
    .filter((n) => n.endsWith('.metadata.json'))
    .sort();
  // Skipped: a message file without its metadata, and a link the scan refuses.
  rmSync(join(written.run, names[0]!));
  symlinkSync(join(written.run, names[1]!), join(written.run, 'zz-link.metadata.json'));
  // Truncated: one message with two lists over their limit, counted once.
  const wide = join(written.run, names[2]!);
  const doc = JSON.parse(readFileSync(wide, 'utf8')) as { Payload: Record<string, unknown> };
  const many = (tag: string) =>
    Array.from({ length: 1001 }, (_, i) => ({ Name: '', Address: `${tag}${i}@example.org` }));
  Object.assign(doc.Payload, { ToList: many('t'), CCList: many('c') });
  writeFileSync(wide, JSON.stringify(doc));
  await pev.main('queuePick', written.root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress.phase, {
      timeout: 20_000,
    })
    .toBe('done');
  const attention = pev.page.locator('.list-head .attention');
  await expect(attention).toHaveText('3 files need attention');

  await openSettings(pev.page);
  const files = field(pev.page, 'Files');
  await expect(files).toHaveText('2 skipped, 1 truncated · Report');
  await files.getByRole('button', { name: 'Report' }).dispatchEvent('click');
  // Settings closes, and the report shows over the mail.
  await expect(settingsMain(pev.page)).toHaveCount(0);
  const card = pev.page.locator('.ix-card');
  await expect(card.locator('h1')).toHaveText('Index report');
  await expect(card.locator('h1')).toBeFocused();
  await expect(card.locator('.report h2')).toHaveText('3 files need attention');
  await expect(card.locator('.report tbody tr')).toHaveCount(3);
  await expect(mailScreen(pev.page)).not.toHaveAttribute('inert', '');
  await expect(pev.page.locator('main.content')).toHaveAttribute('inert', '');
  // Closed, focus goes to the list header's link: the one that opened it is gone.
  await press(pev.page, '.ix-foot button:text("Start browsing")');
  await expect(card).toHaveCount(0);
  await expect(attention).toBeFocused();
  await checkHidden(pev);
});

test("the app menu's Settings… opens Settings in that window only, and the menu has no reload", async ({
  pev,
}) => {
  const second = await pev.openWindow('shell');
  const windows = await pev.main<number[]>('windows');
  await pev.main('clickMenuItem', 'settings', windows[0]);
  await expect(settingsMain(pev.page)).toBeVisible();
  await expect(settingsMain(second.page)).toHaveCount(0);
  // Without an export open: no Index section, and Reset is still there.
  await expect(pev.page.locator('.settings .sec h3')).toHaveCount(0);
  await expect(pev.page.getByRole('button', { name: 'Reset app…' })).toBeVisible();

  const menu = await pev.main<
    Array<{
      label: string;
      items: Array<{
        id: string;
        label: string;
        role: string | null;
        accelerator: string | null;
      }>;
    }>
  >('appMenu');
  expect(menu.map((m) => m.label)).toEqual([expect.any(String), 'Edit', 'Window']);
  expect(menu[0]!.items.find((i) => i.id === 'settings')).toMatchObject({
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
  });
  const roles = menu.flatMap((m) => m.items.map((i) => i.role?.toLowerCase())).filter(Boolean);
  for (const role of ['reload', 'forcereload', 'toggledevtools', 'viewmenu']) {
    expect(roles).not.toContain(role);
  }
  await checkHidden(pev);
});

test('Rebuild index makes a fresh index with the same counts', async ({ pev }) => {
  const root = realpathSync(testDir('settings-rebuild'));
  const written = writeExport(root, { seed: 42, messages: 15 });
  const before = digest(written.root);
  const stamp = await openExport(pev, written);
  const registry = await pev.main<string>('registryFile');
  const oldUuid = registryUuid(registry, stamp.sourceKey);
  const totals = (await ask<IndexTotals>(pev, { op: 'totals' }))!.answer;

  await openSettings(pev.page);
  await pressButton(pev.page, 'Rebuild index');
  await expect
    .poll(async () => (await pev.main<Stamp | null>('sourceStamp'))?.generation ?? 0)
    .toBeGreaterThan(stamp.generation);
  await phase1Done(pev, written.pairs);
  const after = await pev.main<Stamp>('sourceStamp');
  expect(after.sourceKey).toBe(stamp.sourceKey);
  expect((await ask<IndexTotals>(pev, { op: 'totals' }))!.answer).toEqual(totals);
  await expect.poll(() => registryUuid(registry, stamp.sourceKey)).not.toBe(oldUuid);
  expect(registryUuid(registry, stamp.sourceKey)).toEqual(expect.any(String));
  expect(pev.hasLog('index.rebuild', { proc: 'main', reason: 'manual' })).toBe(true);
  // A Rebuild by hand isn't a recovery.
  expect((await view(pev)).active!.index).not.toBe('rebuilding');
  // Settings stays open, for the same export.
  await expect(settingsMain(pev.page)).toBeVisible();
  await expect(pev.page.locator('.settings-notice')).toHaveCount(0);
  expect(digest(written.root)).toBe(before);
  await checkHidden(pev);
});

test('Forget from Settings: Cancel changes nothing; confirmed, no index file is left and the welcome screen shows', async ({
  pev,
}) => {
  const root = realpathSync(testDir('settings-forget'));
  const written = writeExport(root, { seed: 43, messages: 10 });
  const before = digest(written.root);
  const stamp = await openExport(pev, written);
  const indexDir = await pev.main<string>('indexDir');
  const registry = await pev.main<string>('registryFile');

  await openSettings(pev.page);
  await pressButton(pev.page, 'Forget this export…');
  const box = pev.page.getByRole('group', { name: 'Forget this export' });
  await expect(box).toContainText(
    'Removes this export from the app and deletes its index. Export files stay intact.',
  );
  await box.getByRole('button', { name: 'Cancel' }).dispatchEvent('click');
  await expect(box).toHaveCount(0);
  expect(registryUuid(registry, stamp.sourceKey)).toEqual(expect.any(String));
  expect(familyOf(indexDir, stamp.sourceKey)).not.toEqual([]);
  expect((await view(pev)).active?.sourceKey).toBe(stamp.sourceKey);

  await pressButton(pev.page, 'Forget this export…');
  await box.getByRole('button', { name: 'Forget this export' }).dispatchEvent('click');
  await expect(welcome(pev.page)).toBeVisible();
  await expect(settingsMain(pev.page)).toHaveCount(0);
  expect(familyOf(indexDir, stamp.sourceKey)).toEqual([]);
  expect(registryUuid(registry, stamp.sourceKey)).toBeUndefined();
  expect(await view(pev)).toEqual({ restoring: false, active: null, recent: [] });
  expect(digest(written.root)).toBe(before);
  await checkHidden(pev);
});

test('Reset from Settings: Cancel and Esc change nothing; confirmed, every window shows the welcome screen and the app starts afresh', async ({
  pev,
}) => {
  const root = realpathSync(testDir('settings-reset'));
  const written = writeExport(root, { seed: 44, messages: 10 });
  const before = digest(written.root);
  const stamp = await openExport(pev, written);
  const indexDir = await pev.main<string>('indexDir');
  const registry = await pev.main<string>('registryFile');
  const settingsFile = join(pev.userData, 'settings.json');
  const second = await pev.openWindow('shell');

  await openSettings(pev.page);
  await showTab(pev.page, 'Appearance');
  await pev.page.getByRole('radio', { name: 'Dark' }).dispatchEvent('click');
  await expect.poll(() => existsSync(settingsFile)).toBe(true);
  await openSettings(second.page);
  await showTab(pev.page, 'Index');

  const dialog = pev.page.getByRole('dialog', { name: 'Reset app?' });
  await pressButton(pev.page, 'Reset app…');
  await expect(dialog).toContainText('Deletes all app data. Export files stay intact.');
  await dialog.getByRole('button', { name: 'Cancel' }).dispatchEvent('click');
  await expect(dialog).toHaveCount(0);
  await pressButton(pev.page, 'Reset app…');
  await pev.page.locator('body').dispatchEvent('keydown', { key: 'Escape' });
  await expect(dialog).toHaveCount(0);
  expect(existsSync(registry)).toBe(true);
  expect(existsSync(settingsFile)).toBe(true);
  expect((await view(pev)).active?.sourceKey).toBe(stamp.sourceKey);

  await pressButton(pev.page, 'Reset app…');
  await dialog.getByRole('button', { name: 'Reset app' }).dispatchEvent('click');
  for (const page of [pev.page, second.page]) {
    await expect(welcome(page)).toBeVisible();
    await expect(settingsMain(page)).toHaveCount(0);
  }
  expect(familyOf(indexDir, stamp.sourceKey)).toEqual([]);
  expect(existsSync(registry)).toBe(false);
  expect(existsSync(settingsFile)).toBe(false);
  expect(await view(pev)).toEqual({ restoring: false, active: null, recent: [] });
  // The settings are back to their defaults, in every window.
  for (const page of [pev.page, second.page]) {
    await expect
      .poll(async () => (await pev.shell<{ settings: unknown }>('state', [], page)).settings)
      .toEqual({ theme: 'system', messageView: 'html' });
  }

  // Logging goes on, in a fresh folder with private permissions.
  await pev.shell('log', ['after-reset']);
  await expect.poll(() => existsSync(pev.logsDir())).toBe(true);
  expect(pev.logs().filter((l) => ['app.reset', 'source.opened'].includes(l.code))).toEqual([]);
  expect(statSync(pev.logsDir()).mode & 0o777).toBe(0o700);
  for (const file of readdirSync(pev.logsDir())) {
    expect(statSync(join(pev.logsDir(), file)).mode & 0o777).toBe(0o600);
  }

  // The app works again: the same export opens as a new one.
  const again = await openExport(pev, written, 'bm2');
  expect(again.sourceKey).not.toBe(stamp.sourceKey);
  expect(familyOf(indexDir, again.sourceKey)).not.toEqual([]);
  expect(digest(written.root)).toBe(before);
  await checkHidden(pev);
});

test('an action offered for export A is refused once B is open, and changes nothing', async ({
  pev,
}) => {
  const root = realpathSync(testDir('settings-stale'));
  const a = writeExport(root, { seed: 45, messages: 8, runName: 'mail_20250630_120000' });
  const b = writeExport(root, { seed: 45, messages: 6, runName: 'mail_20250101_100000' });
  const first = await openExport(pev, a);
  const indexDir = await pev.main<string>('indexDir');
  const registry = await pev.main<string>('registryFile');

  await openSettings(pev.page);
  await pressButton(pev.page, 'Forget this export…');
  await expect(pev.page.getByRole('group', { name: 'Forget this export' })).toBeVisible();
  const shown = await settingsRead(pev.page);
  if (!shown.ok) throw new Error('no settings read');

  // Another window switches to B.
  const runs = (await view(pev)).active!.runs;
  const other = runs.find((r) => r.runName === b.runName)!;
  expect(await pev.shell<SourceActionResult>('switchRun', [other.runId])).toMatchObject({
    ok: true,
    outcome: 'opened',
  });
  await phase1Done(pev, b.pairs);
  const second = await pev.main<Stamp>('sourceStamp');

  // The confirmation offered for A doesn't carry over to B's Settings.
  await expect(pev.page.getByRole('group', { name: 'Forget this export' })).toHaveCount(0);

  // A Forget, a Rebuild or a Reset sent with what Settings showed for A is refused.
  const send = (channel: string, args: unknown) =>
    pev.page.evaluate(
      ([c, a2]) =>
        (
          window as unknown as {
            __pevTestIpc: {
              invoke(c: string, a: unknown): Promise<SourceActionResult | DoneResult>;
            };
          }
        ).__pevTestIpc.invoke(c, a2),
      [channel, args] as const,
    );
  const old = { sourceKey: first.sourceKey, generation: shown.generation };
  expect(await send(IPC.forgetExport, old)).toEqual({ ok: false, code: 'stale_generation' });
  expect(await send(IPC.rebuildIndex, old)).toEqual({ ok: false, code: 'stale_generation' });
  expect(await send(IPC.resetApp, { generation: shown.generation })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  // B is untouched, and A is still known with its index.
  expect(await pev.main<Stamp>('sourceStamp')).toEqual(second);
  expect(familyOf(indexDir, second.sourceKey)).not.toEqual([]);
  expect(registryUuid(registry, first.sourceKey)).toEqual(expect.any(String));
  expect(familyOf(indexDir, first.sourceKey)).not.toEqual([]);
  await checkHidden(pev);
});

test('Open logs folder goes through the recorder and refuses a link; the diagnostics summary carries no personal data', async ({
  pev,
}) => {
  const root = realpathSync(testDir('settings-logs'));
  const written = writeExport(root, { seed: 46, messages: 8, account: MARKERS[0] });
  await openExport(pev, written);
  // Personal data is pushed at the logs, and a rejected call logs a warning.
  await pev.shell('log', [MARKER_TEXT]);
  await pev.page.evaluate(
    (c) =>
      (
        window as unknown as { __pevTestIpc: { invoke(c: string, a: unknown): Promise<unknown> } }
      ).__pevTestIpc.invoke(c, { generation: 'x' }),
    IPC.settings,
  );
  expect(await pev.main('externalStubbed')).toBe(true);

  await openSettings(pev.page);
  await showTab(pev.page, 'Logs');
  await expect(field(pev.page, 'Location')).toHaveAttribute(
    'title',
    homeRelative(pev.logsDir(), userInfo().homedir) + '/',
  );
  await pressButton(pev.page, 'Open logs folder');
  await expect
    .poll(async () => pev.main<Array<{ method: string; args: string[] }>>('externalCalls'))
    .toContainEqual({ method: 'shell.openPath', args: [pev.logsDir()] });

  await pressButton(pev.page, 'Copy diagnostics summary');
  let text = '';
  await expect
    .poll(async () => {
      const calls = await pev.main<Array<{ method: string; args: string[] }>>('externalCalls');
      text = calls.find((c) => c.method === 'clipboard.writeText')?.args[0] ?? '';
      return text;
    })
    .not.toBe('');
  expect(findMarkers(text)).toEqual([]);
  expect(text).toContain('\nExports: 1\n');
  expect(text).toMatch(/\nIndex sizes: \d/);
  expect(text).toMatch(/\n {2}ipc\.rejected ×\d+\n/);
  expect(text).not.toContain(pev.userData);

  // A link where the logs folder should be is refused.
  const logs = pev.logsDir();
  renameSync(logs, `${logs}-real`);
  symlinkSync(`${logs}-real`, logs);
  try {
    const opened = (await pev.main<Array<{ method: string }>>('externalCalls')).length;
    await pressButton(pev.page, 'Open logs folder');
    await expect(pev.page.locator('.settings-notice')).toHaveText("Couldn't open the logs folder.");
    expect(await pev.main<unknown[]>('externalCalls')).toHaveLength(opened);
  } finally {
    rmSync(logs);
    renameSync(`${logs}-real`, logs);
  }
  await checkHidden(pev);
});

test('settings.json keeps the settings across a restart, is 0600, and a corrupt one gives the defaults', async () => {
  const first = await launch('settings-file');
  const file = join(first.userData, 'settings.json');
  try {
    await openSettings(first.page);
    await showTab(first.page, 'Appearance');
    await first.page.getByRole('radio', { name: 'Dark' }).dispatchEvent('click');
    await first.page.getByRole('radio', { name: 'Plain text' }).dispatchEvent('click');
    await expect
      .poll(() => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null))
      .toEqual({ theme: 'dark', messageView: 'plain' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    await first.close();
  }

  const second = await launch('settings-file', { userData: first.userData });
  try {
    await openSettings(second.page);
    await showTab(second.page, 'Appearance');
    await expect(second.page.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await expect(second.page.getByRole('radio', { name: 'Plain text' })).toBeChecked();
  } finally {
    await second.close();
  }

  writeFileSync(file, `{"theme": "dark", ${JSON.stringify(MARKERS[1])}`);
  const third = await launch('settings-file', { userData: first.userData });
  try {
    await openSettings(third.page);
    await showTab(third.page, 'Appearance');
    await expect(third.page.getByRole('radio', { name: 'System' })).toBeChecked();
    await expect(third.page.getByRole('radio', { name: 'HTML' })).toBeChecked();
    expect(third.hasLog('settings.invalid', { proc: 'main', reason: 'invalid' })).toBe(true);
    expect(findMarkers(JSON.stringify(third.logs()))).toEqual([]);
  } finally {
    await third.close();
  }
});

test('the default message view applies to the next message opened, and the switch still changes it', async ({
  pev,
}) => {
  const root = realpathSync(testDir('settings-view'));
  const written = writeExport(root, { seed: 47, messages: 10 });
  await openExport(pev, written);
  await openSettings(pev.page);
  await showTab(pev.page, 'Appearance');
  await pev.page.getByRole('radio', { name: 'Plain text' }).dispatchEvent('click');
  await expect
    .poll(async () => (await pev.shell<{ settings: { messageView: string } }>('state')).settings)
    .toMatchObject({ messageView: 'plain' });
  await pressButton(pev.page, 'Back to mail');

  await press(pev.page, `[data-folder="${ALL}"]`);
  const rows = (await ask<{ rows: Array<{ threadId: number; newestRowid: number }> }>(pev, {
    op: 'window',
    labelId: ALL,
    anchor: { index: 0 },
    before: 0,
    after: 50,
    selected: null,
  }))!.answer.rows;
  // Each message opened comes up as plain text; the first with an HTML part
  // is the one the switch is tried on.
  let withHtml = false;
  for (const row of rows) {
    await press(pev.page, `.conv[data-thread="${row.threadId}"]`);
    await expect
      .poll(async () => {
        const r = await pev.shell<{
          rowid: number | null;
          mode: string;
          pending: boolean;
          view: { format: string } | null;
        }>('reader');
        return r.rowid === row.newestRowid && !r.pending && r.view !== null
          ? `${r.mode}:${r.view.format}`
          : null;
      })
      .toBe('plain:plain');
    await expect(pev.page.locator('.rp-plain')).toHaveAttribute('aria-pressed', 'true');
    withHtml = (await pev.shell<{ view: { hasHtml: boolean } }>('reader')).view.hasHtml;
    if (withHtml) break;
  }
  expect(withHtml).toBe(true);
  // The switch still changes it, for this message.
  await press(pev.page, '.rp-html');
  await expect
    .poll(async () => {
      const r = await pev.shell<{
        mode: string;
        pending: boolean;
        view: { format: string } | null;
      }>('reader');
      return !r.pending && r.view !== null ? r.mode : null;
    })
    .toBe('html');
  await expect(pev.page.locator('.rp-html')).toHaveAttribute('aria-pressed', 'true');
  await checkHidden(pev);
});

test('Last updated stays as it was when the export opens again with nothing changed', async () => {
  const root = realpathSync(testDir('settings-updated'));
  const written = writeExport(root, { seed: 48, messages: 10 });
  // Built once; quitting folds the index's log into it.
  const first = await launch('settings-updated');
  try {
    await openExport(first, written);
  } finally {
    await first.close();
  }
  /** Opens the export again at launch, and reads Last updated once nothing more is written. */
  const reopenedAt = async (): Promise<number | null> => {
    const app = await launch('settings-updated', { userData: first.userData });
    try {
      await phase1Done(app, written.pairs);
      await new Promise((r) => setTimeout(r, 1500));
      const read = await settingsRead(app.page);
      if (!read.ok || !read.view.index) throw new Error('no index');
      return read.view.index.updatedAt;
    } finally {
      await app.close();
    }
  };
  const once = await reopenedAt();
  expect(once).toEqual(expect.any(Number));
  expect(await reopenedAt()).toBe(once);
});
