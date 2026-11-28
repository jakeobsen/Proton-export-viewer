// SPDX-License-Identifier: AGPL-3.0-or-later
// Saving attachments and message files. The test build's downloads folder is
// a new folder under test-output for each launch; nothing is ever written
// anywhere else. Each save goes through the real path: core's save lane, main's
// one-shot asset, the window's own download into staging, and the publish.

import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import type { MessageOpenResult, SaveResult } from '../../src/shared/api';
import { cleanFilename } from '../../src/shared/filename';
import { candidates, emlName } from '../../src/main/saves/names';
import { HOSTILE_FILENAMES, hostileMessages } from '../../tools/gen-export/hostile.mjs';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

const crlf = (lines: string[]) => lines.join('\r\n');
const sha = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Names collide as the volume compares them: without case on macOS. */
const fold = (name: string) => (process.platform === 'darwin' ? name.toLowerCase() : name);

// A failed test prints how its saves went: log codes and their fields, which
// never hold a name, a path or a URL.
test.afterEach(({ pev }, info) => {
  if (info.status === info.expectedStatus) return;
  const lines = pev
    .logs()
    .filter((l) => l.code.startsWith('save.') || l.level === 'warn' || l.level === 'error')
    .map((l) => `${l.proc} ${l.level} ${l.code} ${JSON.stringify(l.data)}`);
  console.log(`[${info.title}] logs:\n${lines.join('\n')}`);
});

/** A message with one attachment `name` holding `bytes`, base64-encoded. */
function withAttachment(name: string, bytes: Buffer, subject = 'Files'): string {
  return crlf([
    `Subject: ${subject}`,
    'From: <sender@example.org>',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain',
    '',
    'See the file.',
    '--m',
    `Content-Type: application/octet-stream; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    (bytes.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
    '--m--',
    '',
  ]);
}

/** Writes the messages and makes them the reader's test source; returns the folder. */
async function source(pev: PevApp, name: string, files: Record<string, string | Buffer>) {
  const root = realpathSync(testDir(name));
  const entries: Array<[number, { file: string }]> = [];
  Object.entries(files).forEach(([file, data], i) => {
    writeFileSync(join(root, file), data);
    entries.push([i + 1, { file }]);
  });
  const result = await pev.main<{ ok: boolean }>('readerSource', root, entries);
  expect(result.ok).toBe(true);
  return root;
}

/** Opens a message and waits until the pane shows its view. */
async function open(pev: PevApp, rowid: number, mode?: 'html' | 'plain') {
  const opened = await pev.shell<MessageOpenResult>('openInReader', mode ? [rowid, mode] : [rowid]);
  expect(opened.ok).toBe(true);
  await expect
    .poll(async () => {
      const r = await pev.shell<{ pending: boolean; view: { url: string } | null }>('reader');
      return !r.pending && r.view !== null;
    })
    .toBe(true);
  return pev.shell<{
    view: { openId: number; attachments: Array<{ index: number; name: string; size: number }> };
  }>('reader');
}

const save = (pev: PevApp, index: number) => pev.shell<SaveResult>('saveAttachment', [index]);
const saveEml = (pev: PevApp) => pev.shell<SaveResult>('saveMessageFile');
const downloads = (pev: PevApp) => pev.main<string>('downloadsDir');
const listed = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const staging = (pev: PevApp) => pev.main<string[]>('stagingFiles');

/** Sends a request on a channel straight to main, as any shell code could. */
function invoke(pev: PevApp, channel: string, ...args: unknown[]): Promise<unknown> {
  return pev.page.evaluate(([c, a]) => window.__pevTestIpc.invoke(c, ...a), [
    channel,
    args,
  ] as const);
}

const generationNow = async (pev: PevApp) =>
  ((await invoke(pev, 'pev:state')) as { generation: number }).generation;

/** The SHA-256 of every file in a folder, by name. */
function digests(dir: string): Record<string, string> {
  return Object.fromEntries(listed(dir).map((n) => [n, sha(readFileSync(join(dir, n)))]));
}

test('each hostile-named attachment saves under its cleaned name, with its bytes, and nothing else', async ({
  pev,
}) => {
  const plans = hostileMessages({
    seed: 3,
    nonce: 'savenames',
    labelInfo: { file: { Payload: [] } },
    owner: { Name: 'Owner', Address: 'owner@example.com' },
  }).plans.filter((p) => /\/attachments_images\/filename-/.test(p.key));
  // Every name in the list, and the two special cases, are in the corpus.
  expect(plans.length).toBe(HOSTILE_FILENAMES.length + 2);
  const files = Object.fromEntries(plans.map((p, i) => [`m${i}.eml`, p.emlData]));
  const root = await source(pev, 'save-hostile', files);
  const before = digests(root);
  const dir = await downloads(pev);
  const used = new Set<string>();
  const expected: Record<string, string> = {};
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i]!;
    const { view } = await open(pev, i + 1);
    expect(view.attachments.map((a) => a.name)).toEqual(
      plan.attachments.map((a) => cleanFilename(a.name)),
    );
    for (const attachment of view.attachments) {
      const result = await save(pev, attachment.index);
      expect(result, plan.key).toMatchObject({ ok: true });
      // The first free name, as the volume compares names.
      const name = [...candidates(cleanFilename(attachment.name))].find((c) => !used.has(fold(c)))!;
      used.add(fold(name));
      const declared = plan.attachments[attachment.index]!;
      expected[name] =
        declared.type === 'text/plain'
          ? sha(
              Buffer.from(
                plan.key.endsWith('twins') && attachment.index === 1 ? 'second' : 'first',
              ),
            )
          : sha(Buffer.from('attachment\n'));
    }
  }
  // Exactly the expected files, with the decoded bytes, in the downloads folder only.
  expect(digests(dir)).toEqual(expected);
  expect(digests(root)).toEqual(before);
  expect(await staging(pev)).toEqual([]);
  // The name comes from the disposition's filename*, continuations joined.
  expect(Object.keys(expected)).toContain('résumé.pdf');
  // A dots-only name becomes "attachment"; a reserved one gets "_".
  expect(Object.keys(expected)).toEqual(
    expect.arrayContaining(['attachment', '_con.TXT', '_Lpt9.log']),
  );
  // On a volume that ignores case the second twin is numbered.
  if (process.platform === 'darwin') expect(Object.keys(expected)).toContain('notes (2).TXT');
  else expect(Object.keys(expected)).toContain('notes.TXT');
});

test('a message file saves byte for byte under its subject, and twice as " (2)"', async ({
  pev,
}) => {
  const eml = withAttachment('a.bin', Buffer.from('x'), 'Quarterly: report/final');
  await source(pev, 'save-eml', { 'one.eml': eml, 'empty.eml': '' });
  await open(pev, 1);
  const dir = await downloads(pev);
  const name = emlName('Quarterly: report/final');
  expect(await saveEml(pev)).toMatchObject({ ok: true });
  expect(await saveEml(pev)).toMatchObject({ ok: true });
  expect(readFileSync(join(dir, name), 'utf8')).toBe(eml);
  expect(readFileSync(join(dir, name.replace(/\.eml$/, ' (2).eml')), 'utf8')).toBe(eml);
  // The pane says so, and offers the file in Finder (recorded, not run).
  await expect(pev.page.locator('.rp-saved')).toHaveText(/Saved to Downloads/);
  await pev.page.locator('.rp-show-saved').dispatchEvent('click');
  await expect
    .poll(() => pev.main<Array<{ method: string; args: string[] }>>('externalCalls'))
    .toEqual([
      {
        method: 'showItemInFolder',
        args: [join(realpathSync(dir), name.replace(/\.eml$/, ' (2).eml'))],
      },
    ]);

  // An empty message file is saved empty.
  const opened = await pev.shell<MessageOpenResult>('openInReader', [2]);
  if (opened.ok && 'outcome' in opened && opened.outcome === 'view') {
    expect(await saveEml(pev)).toMatchObject({ ok: true });
    expect(statSync(join(dir, 'message.eml')).size).toBe(0);
  }
});

test('the attachment row and the action bar save, and the pane says how it went', async ({
  pev,
}) => {
  const bytes = Buffer.from('row bytes');
  await source(pev, 'save-ui', { 'one.eml': withAttachment('row.txt', bytes) });
  await open(pev, 1);
  await pev.page.locator('.rp-att-save').first().dispatchEvent('click');
  await expect(pev.page.locator('.rp-saved')).toHaveText(/Saved to Downloads/);
  expect(readFileSync(join(await downloads(pev), 'row.txt'))).toEqual(bytes);
  await pev.page.locator('.rp-save-eml').dispatchEvent('click');
  await expect
    .poll(() => listed(join(pev.userData, 'downloads')))
    .toEqual(['Files.eml', 'row.txt']);
});

test('a destination made after the download started is not overwritten', async ({ pev }) => {
  const bytes = Buffer.from('ours');
  await source(pev, 'save-race', { 'one.eml': withAttachment('race.txt', bytes) });
  await open(pev, 1);
  const dir = await downloads(pev);
  await pev.main('saveHoldStaged');
  const saving = save(pev, 0);
  await expect.poll(() => pev.main<number>('saveStagedHeld')).toBe(1);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'race.txt'), 'theirs');
  await pev.main('saveReleaseStaged');
  expect(await saving).toMatchObject({ ok: true });
  expect(readFileSync(join(dir, 'race.txt'), 'utf8')).toBe('theirs');
  expect(readFileSync(join(dir, 'race (2).txt'))).toEqual(bytes);
});

test('the forced copy publishes; a held copy shows no final name; a failed one leaves nothing', async ({
  pev,
}) => {
  const bytes = Buffer.alloc(700_000, 7);
  await source(pev, 'save-copy', { 'one.eml': withAttachment('copy.bin', bytes) });
  await open(pev, 1);
  const dir = await downloads(pev);
  await pev.main('saveForceCopy', true);
  expect(await save(pev, 0)).toMatchObject({ ok: true });
  expect(sha(readFileSync(join(dir, 'copy.bin')))).toBe(sha(bytes));
  expect(listed(dir)).toEqual(['copy.bin']);
  expect(pev.hasLog('save.done', { reason: 'copy' })).toBe(true);

  await pev.main('saveHoldCopy');
  const saving = save(pev, 0);
  await expect.poll(() => pev.main<number>('saveCopiesHeld')).toBe(1);
  // Only the hidden temporary file is there while the copy is held.
  expect(listed(dir).filter((n) => n !== 'copy.bin')).toEqual([
    expect.stringMatching(/^\.[0-9a-f]{32}\.partial$/),
  ]);
  expect(existsSync(join(dir, 'copy (2).bin'))).toBe(false);
  await pev.main('saveReleaseCopy', true);
  expect(await saving).toEqual({ ok: false, code: 'save_failed' });
  expect(listed(dir)).toEqual(['copy.bin']);
  expect(await staging(pev)).toEqual([]);
  await expect(pev.page.locator('.rp-save-failed')).toHaveText(/Couldn.t save/);
});

test('a message file changed since it was opened can’t be saved', async ({ pev }) => {
  const root = await source(pev, 'save-changed', {
    'one.eml': withAttachment('c.txt', Buffer.from('c')),
  });
  await open(pev, 1);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'one.eml'), later, later);
  expect(await save(pev, 0)).toEqual({ ok: false, code: 'save_failed' });
  expect(await saveEml(pev)).toEqual({ ok: false, code: 'save_failed' });
  expect(listed(await downloads(pev))).toEqual([]);
  expect(pev.hasLog('save.failed', { reason: 'changed' })).toBe(true);
});

test('a file replaced during a held save fails it, leaving nothing in downloads or staging', async ({
  pev,
}) => {
  const bytes = Buffer.alloc(2_000_000, 3);
  const root = await source(pev, 'save-replaced', { 'one.eml': withAttachment('big.bin', bytes) });
  await open(pev, 1);
  await pev.main('coreHoldSaves');
  const saving = save(pev, 0);
  await expect.poll(() => pev.main<number>('coreSavesHeld')).toBe(1);
  // Same size, new time: only the check after streaming can see it.
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'one.eml'), later, later);
  await pev.main('coreReleaseSaves');
  expect(await saving).toEqual({ ok: false, code: 'save_failed' });
  expect(listed(await downloads(pev))).toEqual([]);
  expect(await staging(pev)).toEqual([]);
});

test('a source change during a held save cancels it with no file left', async ({ pev }) => {
  await source(pev, 'save-switch', {
    'one.eml': withAttachment('s.bin', Buffer.alloc(900_000, 1)),
  });
  await open(pev, 1);
  await pev.main('coreHoldSaves');
  const saving = save(pev, 0);
  await expect.poll(() => pev.main<number>('coreSavesHeld')).toBe(1);
  await pev.main('bumpGeneration');
  expect(await saving).toEqual({ ok: false, code: 'save_failed' });
  await pev.main('coreReleaseSaves');
  expect(listed(await downloads(pev))).toEqual([]);
  await expect.poll(() => staging(pev)).toEqual([]);
  expect(pev.hasLog('save.failed', { reason: 'generation' })).toBe(true);
});

test('a save already started finishes after the window opens another message', async ({ pev }) => {
  const bytes = Buffer.alloc(900_000, 9);
  await source(pev, 'save-expand', {
    'one.eml': withAttachment('kept.bin', bytes),
    'two.eml': withAttachment('other.bin', Buffer.from('o')),
  });
  await open(pev, 1);
  await pev.main('coreHoldSaves');
  const saving = save(pev, 0);
  await expect.poll(() => pev.main<number>('coreSavesHeld')).toBe(1);
  await open(pev, 2);
  await pev.main('coreReleaseSaves');
  expect(await saving).toMatchObject({ ok: true });
  expect(sha(readFileSync(join(await downloads(pev), 'kept.bin')))).toBe(sha(bytes));
});

test('only the live view saves, with a strict request', async ({ pev }) => {
  await source(pev, 'save-stale', {
    'one.eml': withAttachment('a.txt', Buffer.from('a')),
    'two.eml': withAttachment('b.txt', Buffer.from('b')),
  });
  const first = (await open(pev, 1)).view.openId;
  await open(pev, 2);
  const generation = await generationNow(pev);
  expect(await invoke(pev, 'pev:save', { openId: first, index: 0, generation })).toEqual({
    ok: false,
    code: 'superseded',
  });
  const live = (await pev.shell<{ view: { openId: number } }>('reader')).view.openId;
  expect(
    await invoke(pev, 'pev:save', { openId: live, index: 0, generation: generation + 1 }),
  ).toEqual({ ok: false, code: 'stale_generation' });
  for (const bad of [
    { openId: live, index: 0, generation, name: 'x' },
    { openId: live, index: -1, generation },
    { openId: live, generation },
  ]) {
    expect(await invoke(pev, 'pev:save', bad)).toEqual({ ok: false, code: 'invalid' });
  }
  expect(await invoke(pev, 'pev:save', { openId: live, index: 5, generation })).toEqual({
    ok: false,
    code: 'not_found',
  });
  expect(await invoke(pev, 'pev:save-eml', { openId: live, generation, index: 0 })).toEqual({
    ok: false,
    code: 'invalid',
  });
  expect(listed(await downloads(pev))).toEqual([]);
});

test(`a fifth waiting save in a window is refused at once`, async ({ pev }) => {
  await source(pev, 'save-queue', { 'one.eml': withAttachment('q.bin', Buffer.alloc(10, 1)) });
  await open(pev, 1);
  await pev.main('coreHoldSaves');
  const running = save(pev, 0);
  await expect.poll(() => pev.main<number>('coreSavesHeld')).toBe(1);
  const waiting = [save(pev, 0), save(pev, 0), save(pev, 0), save(pev, 0)];
  expect(await save(pev, 0)).toEqual({ ok: false, code: 'queue_full' });
  expect(pev.hasLog('save.queue_full')).toBe(true);
  await pev.main('coreReleaseSaves');
  expect(await running).toMatchObject({ ok: true });
  for (const w of waiting) expect(await w).toMatchObject({ ok: true });
  expect(listed(await downloads(pev))).toHaveLength(5);
});

test('downloads a page starts are cancelled, and a page that requests a save’s asset ends it', async ({
  pev,
}) => {
  await source(pev, 'save-foreign', { 'one.eml': withAttachment('f.bin', Buffer.from('f')) });
  await open(pev, 1);
  // A download the shell itself starts.
  await pev.page.evaluate(() => {
    const a = document.createElement('a');
    a.href = 'app://shell/probe.png';
    a.download = 'probe.png';
    document.body.append(a);
    a.click();
    a.remove();
  });
  await expect.poll(() => pev.hasLog('download.cancelled')).toBe(true);
  // A page that requests the save's own URL before main's download does.
  await pev.main('saveHoldDownload');
  const saving = save(pev, 0);
  await expect.poll(() => pev.main<number>('saveDownloadsHeld')).toBe(1);
  const url = await pev.main<string>('saveLastUrl');
  await pev.page.evaluate((src) => {
    const img = document.createElement('img');
    img.src = src;
    document.body.append(img);
  }, url);
  await expect.poll(() => pev.hasLog('save.failed', { reason: 'foreign' })).toBe(true);
  await pev.main('saveReleaseDownload');
  expect(await saving).toEqual({ ok: false, code: 'save_failed' });
  expect(listed(await downloads(pev))).toEqual([]);
});

test('a downloads folder that is, or links to, an export is refused before anything is made', async ({
  pev,
}) => {
  const root = realpathSync(testDir('save-guard'));
  const written = writeExport(root, { seed: 72, messages: 3 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(
      async () =>
        (
          await pev.main<{ answer: IndexTotals; progress: IndexProgress } | null>('indexQuery', {
            op: 'totals',
          })
        )?.progress,
      { timeout: 20_000 },
    )
    .toMatchObject({ phase: 'done', loaded: written.pairs });
  await open(pev, 1);
  const before = digests(written.run);
  // The export's own folder as the downloads folder.
  await pev.main('setDownloadsDir', written.run);
  expect(await saveEml(pev)).toEqual({ ok: false, code: 'save_failed' });
  // A link to it, from the test's folder.
  const alias = join(realpathSync(testDir('save-guard-alias')), 'Downloads');
  symlinkSync(written.run, alias);
  await pev.main('setDownloadsDir', alias);
  expect(await saveEml(pev)).toEqual({ ok: false, code: 'save_failed' });
  expect(digests(written.run)).toEqual(before);
  expect(pev.hasLog('save.failed', { reason: 'export_root' })).toBe(true);
  expect(await staging(pev)).toEqual([]);
});

test('a ~200 MB save streams with main’s memory bounded', async ({ pev }) => {
  test.setTimeout(240_000);
  const root = realpathSync(testDir('save-large'));
  const size = 200 * 1024 * 1024;
  // Written in pieces, so this test's own memory stays small too.
  const fd = openSync(join(root, 'big.eml'), 'w');
  const head = crlf([
    'Subject: Large',
    'From: <sender@example.org>',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain',
    '',
    'Large file.',
    '--m',
    'Content-Type: application/octet-stream; name="large.bin"',
    'Content-Disposition: attachment; filename="large.bin"',
    'Content-Transfer-Encoding: base64',
    '',
    '',
  ]);
  writeSync(fd, head);
  const hash = createHash('sha256');
  const piece = Buffer.alloc(57 * 16384);
  for (let i = 0; i < piece.length; i += 1) piece[i] = (i * 31) & 0xff;
  for (let done = 0; done < size; done += piece.length) {
    const part = piece.subarray(0, Math.min(piece.length, size - done));
    hash.update(part);
    writeSync(fd, `${(part.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')}\r\n`);
  }
  writeSync(fd, '--m--\r\n');
  closeSync(fd);
  expect(
    (await pev.main<{ ok: boolean }>('readerSource', root, [[1, { file: 'big.eml' }]])).ok,
  ).toBe(true);
  // The open reads the whole message once to list its parts and their sizes.
  await pev.main('readerLimits', { timeoutMs: 60_000 });
  await open(pev, 1, 'plain');
  const base = await pev.main<NodeJS.MemoryUsage>('mainMemory');
  let peak = base;
  let done = false;
  const saving = save(pev, 0).finally(() => {
    done = true;
  });
  while (!done) {
    const now = await pev.main<NodeJS.MemoryUsage>('mainMemory');
    if (now.arrayBuffers > peak.arrayBuffers) peak = now;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(await saving).toMatchObject({ ok: true });
  const saved = join(await downloads(pev), 'large.bin');
  expect(statSync(saved).size).toBe(size);
  const savedHash = createHash('sha256');
  for await (const chunk of createReadStream(saved)) savedHash.update(chunk as Buffer);
  expect(savedHash.digest('hex')).toBe(hash.digest('hex'));
  // Far less than the file: main never holds it whole.
  expect(peak.arrayBuffers - base.arrayBuffers).toBeLessThan(64 * 1024 * 1024);
});

test('save events log codes and sizes, never a name, a path or a URL', async ({ pev }) => {
  const marker = 'pev-marker-save-9q2';
  const root = await source(pev, 'save-redaction', {
    'one.eml': withAttachment(`${marker}.pdf`, Buffer.from('m'), `${marker} subject`),
  });
  await open(pev, 1);
  await pev.main('saveHoldDownload');
  const saving = save(pev, 0);
  await expect.poll(() => pev.main<number>('saveDownloadsHeld')).toBe(1);
  const url = await pev.main<string>('saveLastUrl');
  await pev.main('saveReleaseDownload');
  expect(await saving).toMatchObject({ ok: true });
  expect(await saveEml(pev)).toMatchObject({ ok: true });
  await pev.page.locator('.rp-show-saved').dispatchEvent('click');
  await expect.poll(() => pev.hasLog('save.shown')).toBe(true);
  const text = JSON.stringify(pev.logs());
  expect(text).not.toContain(marker);
  expect(text).not.toContain(url.split('/')[3]!);
  expect(text).not.toContain(await downloads(pev));
  expect(text).not.toContain(root);
});
