// SPDX-License-Identifier: AGPL-3.0-or-later
// The index report in the shell: opened from the list header once the export
// is loaded and from the loading line while it loads, its counts and rows for
// a generated export with files that need attention, focus moving to it and
// back, the mail kept under it unseen and inert, "Copy report" with no file
// name in the logs, and the checks on its channel. Then the text of the
// message files: the sidebar's line while it is read, over the whole export
// after a reopen too, and the report's counts and rows for text cut to the
// limit or not read.

import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import type { Stamp } from '../../src/shared/sources';
import { writeExport } from '../exports';
import { MARKERS, findMarkers } from '../markers';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

async function progress(pev: PevApp): Promise<IndexProgress | undefined> {
  return (await pev.main<Answer<IndexTotals>>('indexQuery', { op: 'totals' }))?.progress;
}

/** The message open in the reader, and its view. */
const reader = (pev: PevApp) =>
  pev.shell<{ rowid: number | null; view: { url: string } | null }>('reader');

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');

const invoke = (pev: PevApp, channel: string, ...args: unknown[]) =>
  pev.page.evaluate(
    ([c, a]) =>
      (
        window as unknown as {
          __pevTestIpc: { invoke(c: string, ...x: unknown[]): Promise<unknown> };
        }
      ).__pevTestIpc.invoke(c, ...(a as unknown[])),
    [channel, args] as const,
  );

/** An element's box in the window. */
const rectOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  });

/** The message files' IDs, in name order. */
const emlIds = (run: string) =>
  readdirSync(run)
    .filter((n) => n.endsWith('.eml'))
    .map((n) => n.slice(0, -'.eml'.length))
    .sort();

/** Rewrites one message file as a plain-text message whose body is `bytes` long. */
function bigEml(run: string, id: string, bytes: number): void {
  const line = 'lorem ipsum dolor sit amet consectetur adipiscing elit\r\n';
  const body = line.repeat(Math.ceil(bytes / line.length));
  writeFileSync(
    join(run, `${id}.eml`),
    `From: a@example.com\r\nTo: b@example.com\r\nSubject: Long\r\nDate: Tue, 24 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
  );
}

/** Moves a message's two files to another folder. */
function move(id: string, from: string, to: string): void {
  for (const ext of ['.eml', '.metadata.json']) {
    writeFileSync(join(to, id + ext), readFileSync(join(from, id + ext)));
    rmSync(join(from, id + ext));
  }
}

/** Lets phase 1's writes through one at a time until it is done; phase 2's stay held. */
async function loadWithTextHeld(pev: PevApp, pairs: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const p = await progress(pev);
        if (p?.phase === 'done') return p.loaded === pairs && p.bodyPhase === 'indexing';
        if ((await pev.main<number>('heldWrites')) > 0) await pev.main('releaseWrites', 1);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** The report's rows: result, whole file name and reason. */
const rowsOf = (page: Page) =>
  page.locator('.ix-card .report tbody tr').evaluateAll((trs) =>
    trs.map((tr) => {
      const td = [...tr.querySelectorAll('td')];
      return [td[0]!.textContent, td[1]!.getAttribute('title'), td[2]!.textContent];
    }),
  );

/** The text of each clipboard write; test builds record them instead. */
async function clipboardWrites(pev: PevApp): Promise<string[]> {
  const calls = await pev.main<Array<{ method: string; args: string[] }>>('externalCalls');
  return calls.filter((c) => c.method === 'clipboard.writeText').map((c) => c.args[0] ?? '');
}

test('the report lists the files that need attention, and copies them as text', async ({ pev }) => {
  const root = realpathSync(testDir('report-files'));
  const written = writeExport(root, { seed: 46, messages: 12 });
  const ids = readdirSync(written.run)
    .filter((n) => n.endsWith('.eml'))
    .map((n) => n.slice(0, -'.eml'.length))
    .sort();
  rmSync(join(written.run, `${ids[0]}.metadata.json`));
  rmSync(join(written.run, `${ids[1]}.eml`));
  writeFileSync(join(written.run, `${ids[2]}.metadata.json`), '{"Version": 1, "Payload": {');
  // A refused file named with personal data: it is shown and copied, never logged.
  const marked = `${MARKERS.filter((m) => !m.includes('/')).join(' | ')}.metadata.json`;
  symlinkSync(join(written.run, `${ids[3]}.eml`), join(written.run, marked));

  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(() => progress(pev), { timeout: 20_000 })
    .toMatchObject({ phase: 'done', bodyPhase: 'done' });

  const link = pev.page.locator('.list-head .attention');
  await expect(link).toHaveText('4 files need attention');
  await press(pev.page, '.list-head .attention');

  // The link is hidden under the report: focus moves to the card's heading.
  const card = pev.page.locator('.ix-card');
  await expect(card.locator('h1')).toHaveText('Index report');
  await expect(card.locator('h1')).toBeFocused();
  await expect(card.locator('.phase.messages h3 .pill')).toHaveText('Done');
  // The mail stays mounted under the report, unseen and inert, and the report
  // takes exactly its place.
  const mail = pev.page.locator('main.content');
  await expect(mail).toHaveCount(1);
  await expect(mail).toHaveAttribute('inert', '');
  await expect(mail).toBeHidden();
  await expect(pev.page.locator('.list-scroll')).toBeHidden();
  expect(await rectOf(pev.page, 'main.center')).toEqual(await rectOf(pev.page, 'main.content'));
  // 12 pairs, less the two whose metadata is missing or isn't JSON.
  const stats = card.locator('.phase.messages .ix-stats');
  await expect(stats).toContainText('10 messages');
  await expect(stats).toContainText('folders and labels');
  await expect(stats).toContainText(/took \d/);
  await expect(card.locator('.report h2')).toHaveText('4 files need attention');
  const rows = await card.locator('.report tbody tr').evaluateAll((trs) =>
    trs.map((tr) => {
      const td = [...tr.querySelectorAll('td')];
      return [td[0]!.textContent, td[1]!.getAttribute('title'), td[2]!.textContent];
    }),
  );
  expect(rows).toEqual([
    ['Skipped', marked, 'Symbolic link. Not read.'],
    ['Skipped', `${ids[2]}.metadata.json`, 'Invalid JSON. Not listed.'],
    ['Skipped', `${ids[0]}.eml`, 'Metadata missing. Not listed.'],
    ['Listed', `${ids[1]}.metadata.json`, 'Message file missing.'],
  ]);
  // Long names show their start and end; the whole name is the title.
  await expect(card.locator('.report tbody tr').nth(1).locator('.file')).toContainText('…');
  // Each name keeps its own direction inside its cell.
  const name = card.locator('.report tbody tr').first().locator('.file');
  await expect(name).toHaveAttribute('dir', 'auto');
  expect(await name.evaluate((td) => getComputedStyle(td).unicodeBidi)).toBe('isolate');

  await press(pev.page, '.ix-foot button:text("Copy report")');
  await expect(card.locator('.ix-foot .note')).toHaveText('Report copied.');
  const copies = await clipboardWrites(pev);
  expect(copies).toHaveLength(1);
  const text = copies[0]!;
  expect(text).toContain('Messages: 10\n');
  expect(text).toContain('4 files need attention\n');
  expect(text).toContain(`Skipped\t${marked}\tSymbolic link. Not read. (symlink)\n`);
  expect(text).not.toContain(root);
  expect(text).not.toContain(written.account);
  expect(text).not.toContain(written.runName);
  await expect.poll(() => pev.hasLog('report.copied', { proc: 'main', count: 4 })).toBe(true);
  // The file names went to the screen and the clipboard, and into no log.
  const dir = pev.logsDir();
  for (const file of readdirSync(dir)) {
    expect(findMarkers(readFileSync(join(dir, file), 'utf8')), file).toEqual([]);
  }

  // Closed, focus goes back to the link that opened it.
  await press(pev.page, '.ix-foot button:text("Start browsing")');
  await expect(card).toHaveCount(0);
  await expect(mail).not.toHaveAttribute('inert', '');
  await expect(pev.page.locator('.list-scroll')).toBeVisible();
  await expect(link).toBeFocused();
});

test('the loading line opens the report while the export loads', async ({ pev }) => {
  const root = realpathSync(testDir('report-loading'));
  const written = writeExport(root, { seed: 47, messages: 40 });
  await pev.main('indexTestSettings', { batchPairs: 10, holdWrites: true });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect.poll(() => pev.main<number>('heldWrites')).toBeGreaterThan(0);
  await pev.main('releaseWrites', 1);
  await expect.poll(async () => (await progress(pev))?.loaded).toBe(10);
  // Nothing needs attention, so the header names nothing.
  await expect(pev.page.locator('.list-head .attention')).toHaveCount(0);
  // A message open in the reader.
  await press(pev.page, '.list-scroll .conv >> nth=0');
  await expect.poll(async () => (await reader(pev)).view?.url ?? null).not.toBeNull();
  const shown = await reader(pev);
  const loads = async () => {
    const { body } = await pev.main<{ body: string[] }>('requests', 1);
    return body.filter((u) => u === shown.view!.url).length;
  };
  await expect.poll(loads).toBeGreaterThan(0);
  const loaded = await loads();

  await press(pev.page, '.side-foot .loading-text');
  const card = pev.page.locator('.ix-card');
  await expect(card.locator('h1')).toHaveText('Indexing');
  await expect(card.locator('.phase.messages h3 .pill')).toHaveText('25%');
  await expect(card.locator('.phase.messages .ix-stats')).toContainText(
    `Loading 10 of ${written.pairs}…`,
  );
  await expect(card.locator('.phase.messages .progress')).toHaveAttribute('aria-valuenow', '10');
  // The full text comes once the messages are loaded.
  await expect(card.locator('.phase.text')).toHaveCount(0);
  await expect(card.locator('.report')).toHaveCount(0);
  // The open message's frame stays under the report, unseen.
  const frame = pev.page.locator('.reader iframe.rp-frame');
  await expect(frame).toHaveAttribute('src', shown.view!.url);
  await expect(frame).toBeHidden();
  await expect(pev.page.locator('main.content')).toHaveAttribute('inert', '');

  await pev.main('releaseWrites', null);
  await expect
    .poll(() => progress(pev), { timeout: 20_000 })
    .toMatchObject({ phase: 'done', bodyPhase: 'done' });
  // Indexing until the text of every message file is read.
  await expect(card.locator('h1')).toHaveText('Index report');
  await expect(card.locator('.phase.messages h3 .pill')).toHaveText('Done');
  await expect(card.locator('.phase.messages .ix-stats')).toContainText(
    `${written.pairs} messages`,
  );
  await expect(card.locator('.phase.messages .progress')).toHaveCount(0);
  await press(pev.page, '.ix-foot button:text("Start browsing")');
  await expect(card).toHaveCount(0);
  await expect(pev.page.locator('.list-head .attention')).toHaveCount(0);
  // The mail stayed as it was under the report: the same message and its
  // frame, with the body not loaded again.
  expect(await reader(pev)).toMatchObject({ rowid: shown.rowid, view: { url: shown.view!.url } });
  await expect(frame).toHaveAttribute('src', shown.view!.url);
  await expect(frame).toBeVisible();
  await pev.page.waitForTimeout(300);
  expect(await loads()).toBe(loaded);
});

test('the report channels check their arguments and the generation', async ({ pev }) => {
  const root = realpathSync(testDir('report-channel'));
  writeExport(root, { seed: 48, messages: 6 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect.poll(() => progress(pev), { timeout: 20_000 }).toMatchObject({ phase: 'done' });
  const generation = (await pev.shell<{ generation: number }>('state')).generation;

  expect(await invoke(pev, 'pev:index', { query: { op: 'report' }, generation })).toMatchObject({
    ok: true,
    generation,
    answer: { messages: 6, attention: 0, rows: [] },
  });
  expect(
    await invoke(pev, 'pev:index', { query: { op: 'report', all: true }, generation }),
  ).toEqual({ ok: false, code: 'invalid' });

  expect(await invoke(pev, 'pev:copy-report', { generation })).toEqual({ ok: true, generation });
  for (const bad of [[], [{}], [{ generation, text: 'x' }], [{ generation }, 'extra'], ['x']]) {
    expect(await invoke(pev, 'pev:copy-report', ...bad), JSON.stringify(bad)).toEqual({
      ok: false,
      code: 'invalid',
    });
  }
  expect(await invoke(pev, 'pev:copy-report', { generation: generation + 1 })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  // Only the valid call reached the clipboard.
  expect(await clipboardWrites(pev)).toHaveLength(1);
});

test('while the text is read, the sidebar shows how far and opens the report; then the report lists text cut or not read', async ({
  pev,
}) => {
  const root = realpathSync(testDir('report-text-held'));
  const written = writeExport(root, { seed: 52, messages: 8 });
  const [big, swapped] = emlIds(written.run) as [string, string];
  // Over the 1 MB that is kept for search.
  bigEml(written.run, big, 1_100_000);
  await pev.main('indexTestSettings', { holdWrites: true });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  // A write waits once the scan is done: the message file becomes a FIFO,
  // which phase 2 refuses when it opens it.
  await expect.poll(() => pev.main<number>('heldWrites'), { timeout: 20_000 }).toBeGreaterThan(0);
  rmSync(join(written.run, `${swapped}.eml`));
  expect(spawnSync('/usr/bin/mkfifo', [join(written.run, `${swapped}.eml`)]).status).toBe(0);
  await loadWithTextHeld(pev, written.pairs);

  const line = pev.page.locator('.side-foot .full-text');
  await expect(line).toHaveText('Full text 0% · search is partial');
  await expect(pev.page.locator('.side-foot [role="progressbar"]')).toHaveAttribute(
    'aria-valuenow',
    '0',
  );
  await press(pev.page, '.side-foot .full-text');
  const card = pev.page.locator('.ix-card');
  await expect(card.locator('h1')).toHaveText('Indexing');
  await expect(card.locator('h1')).toBeFocused();
  await expect(card.locator('.phase.messages h3 .pill')).toHaveText('Done');
  const text = card.locator('.phase.text');
  await expect(text.locator('h3 .pill')).toHaveText('0%');
  await expect(text.locator('.progress')).toHaveAttribute('aria-valuenow', '0');
  await expect(text.locator('.ix-stats')).toHaveText(`0 / ${written.pairs} bodies indexed`);
  // Closed, focus goes back to the line that opened it.
  await press(pev.page, '.ix-foot button:text("Start browsing")');
  await expect(card).toHaveCount(0);
  await expect(line).toBeFocused();

  await pev.main('releaseWrites', null);
  await expect
    .poll(() => progress(pev), { timeout: 20_000 })
    .toMatchObject({ bodyPhase: 'done', bodiesFailed: 1, bodiesTruncated: 1 });
  // Once the text is read, the line goes, and the header counts the two files.
  await expect(line).toHaveCount(0);
  const link = pev.page.locator('.list-head .attention');
  await expect(link).toHaveText('2 files need attention');
  await press(pev.page, '.list-head .attention');
  await expect(card.locator('h1')).toHaveText('Index report');
  await expect(text.locator('h3 .pill')).toHaveText('Done');
  await expect(text.locator('.progress')).toHaveCount(0);
  // The cut text is indexed; the text not read isn't.
  await expect(text.locator('.ix-stats')).toContainText(
    `${written.pairs - 1} / ${written.pairs} bodies indexed`,
  );
  await expect(text.locator('.ix-stats')).toContainText('1 skipped · 1 truncated');
  expect(await rowsOf(pev.page)).toEqual([
    ['Skipped', `${swapped}.eml`, "Couldn't read text"],
    ['Truncated', `${big}.eml`, 'Over the 1 MB search limit'],
  ]);
  await press(pev.page, '.ix-foot button:text("Copy report")');
  await expect(card.locator('.ix-foot .note')).toHaveText('Report copied.');
  const copied = (await clipboardWrites(pev))[0]!;
  expect(copied).toContain(`Bodies indexed: ${written.pairs - 1} of ${written.pairs}\n`);
  expect(copied).toContain('Text not read: 1 (fifo 1)\n');
  expect(copied).toContain('Text over the limit: 1\n');
  expect(copied).toContain(`Skipped\t${swapped}.eml\tCouldn't read text (fifo)\n`);
  expect(copied).toContain(`Truncated\t${big}.eml\tOver the 1 MB search limit (truncated)\n`);
});

test('after a reopen, the sidebar shows the text read over the whole export, and the report only the bodies indexed', async ({
  pev,
}) => {
  const root = realpathSync(testDir('report-text-reopen'));
  const written = writeExport(root, { seed: 53, messages: 10 });
  const ids = emlIds(written.run);
  const later = ids.slice(0, 2);
  const tooLong = ids[2]!;
  // Its text alone is more than one write takes, so it isn't read.
  bigEml(written.run, tooLong, 300_000);
  const aside = realpathSync(testDir('report-text-aside'));
  for (const id of later) move(id, written.run, aside);
  await pev.main('indexTestSettings', { txnBytes: 200_000 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(() => progress(pev), { timeout: 20_000 })
    .toMatchObject({ phase: 'done', bodyPhase: 'done', bodiesFailed: 1 });
  const first = await pev.main<Stamp>('sourceStamp');

  // Another export, then this one again from its index, with the two messages
  // back and their text held.
  await pev.main('indexTestSettings', null);
  const other = realpathSync(testDir('report-text-other'));
  const otherExport = writeExport(other, { seed: 54, messages: 3 });
  await pev.main('queuePick', other, 'bm2');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(async () => (await pev.main<Stamp>('sourceStamp')).sourceKey)
    .not.toBe(first.sourceKey);
  await expect
    .poll(() => progress(pev), { timeout: 20_000 })
    .toMatchObject({ phase: 'done', loaded: otherExport.pairs });
  for (const id of later) move(id, aside, written.run);
  await pev.main('indexTestSettings', { holdWrites: true, txnBytes: 200_000 });
  await pev.shell('openExport', [first.sourceKey]);
  await expect
    .poll(async () => (await pev.main<Stamp>('sourceStamp')).sourceKey)
    .toBe(first.sourceKey);
  await loadWithTextHeld(pev, written.pairs);

  // Eight of the ten files were handled before: seven indexed, one not read.
  await expect(pev.page.locator('.side-foot .full-text')).toHaveText(
    'Full text 80% · search is partial',
  );
  await expect(pev.page.locator('.side-foot [role="progressbar"]')).toHaveAttribute(
    'aria-valuenow',
    '80',
  );
  await press(pev.page, '.side-foot .full-text');
  const text = pev.page.locator('.ix-card .phase.text');
  await expect(text.locator('h3 .pill')).toHaveText('80%');
  await expect(text.locator('.ix-stats')).toContainText('7 / 10 bodies indexed');
  await expect(text.locator('.ix-stats')).toContainText('1 skipped · 0 truncated');
  expect(await rowsOf(pev.page)).toEqual([['Skipped', `${tooLong}.eml`, "Couldn't read text"]]);

  await pev.main('releaseWrites', null);
  await expect
    .poll(() => progress(pev), { timeout: 20_000 })
    .toMatchObject({ bodyPhase: 'done', bodiesBefore: 8, bodiesDone: 2 });
  await expect(text.locator('h3 .pill')).toHaveText('Done');
  await expect(text.locator('.ix-stats')).toContainText('9 / 10 bodies indexed');
});
