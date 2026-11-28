// SPDX-License-Identifier: AGPL-3.0-or-later
// Matches in the reader for a message opened from search: marks in the plain
// view, the count and its action in the HTML view, and the match line's
// fallbacks for each state of the message's text.

import { chmodSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, Locator, Page } from '@playwright/test';
import type { LinkPrompt } from '../../src/shared/api';
import type { EmlFile, IndexProgress, IndexTotals } from '../../src/shared/index-types';
import type { ReaderMatch } from '../../src/shared/reader-protocol';
import type { Stamp } from '../../src/shared/sources';
import { writeExport } from '../exports';
import { findMarkers } from '../markers';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;
const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);

interface Reader {
  rowid: number | null;
  pending: boolean;
  refused: string | null;
  fallback: boolean;
  queryId: number | null;
  match: ReaderMatch | null;
  view: { url: string; format: 'plain' | 'html'; highlighted: boolean } | null;
}
const reader = (pev: PevApp) => pev.shell<Reader>('reader');

/** A message of a made-up export, with its own message file. */
interface Mail {
  id: string;
  subject: string;
  time: number;
  text: string;
  html?: string;
  replyTo?: string;
}

const T0 = 1_700_000_000;

function emlOf(mail: Mail): string {
  const head = [
    'From: Sam <sam@example.com>',
    'To: Kim <kim@example.com>',
    `Subject: ${mail.subject}`,
    `Message-ID: <${mail.id}@example.com>`,
    ...(mail.replyTo ? [`In-Reply-To: <${mail.replyTo}@example.com>`] : []),
    'Date: Tue, 14 Nov 2023 10:00:00 +0000',
    'MIME-Version: 1.0',
  ];
  if (mail.html === undefined) {
    return [...head, 'Content-Type: text/plain; charset=utf-8', '', mail.text, ''].join('\r\n');
  }
  return [
    ...head,
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    '',
    mail.text,
    '--alt',
    'Content-Type: text/html; charset=utf-8',
    '',
    mail.html,
    '--alt--',
    '',
  ].join('\r\n');
}

/** Writes an export of exactly these messages, from one generated pair's metadata as a template. */
function craft(name: string, mails: Mail[]): { root: string; run: string } {
  const root = realpathSync(testDir(name));
  const written = writeExport(root, { seed: 73, messages: 1 });
  const template = readdirSync(written.run).find((n) => n.endsWith('.metadata.json'))!;
  const id = template.slice(0, -'.metadata.json'.length);
  const doc = JSON.parse(readFileSync(join(written.run, template), 'utf8')) as {
    Payload: Record<string, unknown>;
  };
  rmSync(join(written.run, template));
  rmSync(join(written.run, `${id}.eml`));
  for (const mail of mails) {
    const payload = {
      ...doc.Payload,
      ID: mail.id,
      ExternalID: '',
      Subject: mail.subject,
      Time: mail.time,
      Headers:
        `Message-ID: <${mail.id}@example.com>\r\n` +
        (mail.replyTo ? `In-Reply-To: <${mail.replyTo}@example.com>\r\n` : ''),
      LabelIDs: ['0', '5'],
      Unread: 0,
      Sender: { Name: 'Sam', Address: 'sam@example.com' },
      ToList: [{ Name: 'Kim', Address: 'kim@example.com' }],
      CCList: [],
      BCCList: [],
      NumAttachments: 0,
      Attachments: [],
    };
    writeFileSync(
      join(written.run, `${mail.id}.metadata.json`),
      JSON.stringify({ ...doc, Payload: payload }),
    );
    writeFileSync(join(written.run, `${mail.id}.eml`), emlOf(mail));
  }
  return { root, run: written.run };
}

async function totals(pev: PevApp): Promise<IndexProgress | undefined> {
  return (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress;
}

/** Opens the export and waits until both phases are done. */
async function openIndexed(pev: PevApp, root: string, pairs: number): Promise<void> {
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(() => totals(pev), { timeout: 30_000 })
    .toMatchObject({ phase: 'done', loaded: pairs, bodyPhase: 'done' });
}

/** Hidden windows get no key events from the system: the box's value is set and its input event sent. */
function typeText(page: Page, text: string): Promise<void> {
  return page.evaluate((t) => {
    const box = document.querySelector<HTMLInputElement>('.search-box');
    if (!box) throw new Error('no search box');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, t);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

async function searchFor(pev: PevApp, text: string): Promise<void> {
  await typeText(pev.page, text);
  await expect
    .poll(async () => {
      const s = await pev.shell<{ resultsFor: string | null; active: boolean; searching: boolean }>(
        'search',
      );
      return s.resultsFor === text && s.active && !s.searching;
    })
    .toBe(true);
}

const press = (target: Locator) => target.dispatchEvent('click');

/** The result row whose subject holds `word`. */
const resultWith = (pev: PevApp, word: string) =>
  pev.page.locator('.results .conv', { has: pev.page.locator('.subj .t', { hasText: word }) });

/** Selects the result whose subject holds `word` and waits for its open to end. */
async function openResult(pev: PevApp, word: string): Promise<Reader> {
  const row = resultWith(pev, word);
  const anchor = Number(await row.getAttribute('data-rowid'));
  await press(row);
  await expect
    .poll(async () => {
      const r = await reader(pev);
      return r.rowid === anchor && !r.pending;
    })
    .toBe(true);
  return reader(pev);
}

async function settledReader(pev: PevApp, rowid: number): Promise<Reader> {
  await expect
    .poll(async () => {
      const r = await reader(pev);
      return r.rowid === rowid && !r.pending;
    })
    .toBe(true);
  return reader(pev);
}

const matchLine = (pev: PevApp) => pev.page.locator('.card.expanded .rp-matches');

/** The marked texts in the body frame, and its text. */
async function marks(frame: Frame): Promise<{ marked: string[]; inLinks: string[]; text: string }> {
  return frame.evaluate(() => ({
    marked: [...document.querySelectorAll('mark')].map((m) => m.textContent ?? ''),
    inLinks: [...document.querySelectorAll('a mark')].map((m) => m.textContent ?? ''),
    text: document.body.textContent ?? '',
  }));
}

const status = async (pev: PevApp, url: string) =>
  (await pev.main<{ status: number }>('fetchIn', 1, url)).status;

test('from search, the plain view marks the matches and the HTML view counts them', async ({
  pev,
}) => {
  test.setTimeout(120_000);
  const big = `invoice ${'filler words for the size limit '.repeat(40_000)}`;
  const mails: Mail[] = [
    {
      id: 'A1',
      subject: 'Alpha notes',
      time: T0 + 1,
      text:
        'The invoice is attached. Pay at https://pay.example.test/invoice?id=7 today.\n' +
        'Literal <mark>x</mark> and sentinel stay text.',
    },
    {
      id: 'A2',
      subject: 'Re: Alpha notes',
      time: T0 + 2,
      replyTo: 'A1',
      text: 'Thanks, nothing else.',
    },
    {
      id: 'B1',
      subject: 'Bravo statement',
      time: T0 + 3,
      text: 'Your invoice text part',
      html: '<p>Your HTML invoice body</p>',
    },
    { id: 'C1', subject: 'Charlie log', time: T0 + 4, text: big },
  ];
  const { root } = craft('hl-marks', mails);
  await openIndexed(pev, root, mails.length);
  await searchFor(pev, 'invoice');

  // A plain-only message: marks in the body, at the matched words only, and no match line.
  const plain = await openResult(pev, 'Alpha');
  expect(plain.view).toMatchObject({ format: 'plain', highlighted: true });
  expect(plain.match).toMatchObject({ state: 1, columns: [], bodyMatches: 2, changed: false });
  const frame = await pev.bodyFrame(plain.view!.url);
  const shown = await marks(frame);
  expect(shown.marked).toEqual(['invoice', 'invoice']);
  // The match inside the URL is a mark inside its link.
  expect(shown.inLinks).toEqual(['invoice']);
  // Markup and mark characters in mail stay text: the only marks are the matches.
  expect(shown.text).toContain('Literal <mark>x</mark> and sentinel stay text.');
  expect(shown.text).not.toMatch(/[]/);
  await expect(matchLine(pev)).toHaveCount(0);
  // That link still reaches the link dialog, with its URL.
  await frame.evaluate(() => (document.querySelector('a') as HTMLElement).click());
  await expect
    .poll(async () => (await pev.main<LinkPrompt[]>('linkDialogs')).map((d) => d.url))
    .toEqual(['https://pay.example.test/invoice?id=7']);
  await press(pev.page.locator('.link-cancel'));
  await expect(pev.page.locator('.link-dialog')).toHaveCount(0);

  // A card in the same conversation that didn't match: no line and no marks.
  const shownCards = await pev.shell<{ cards: Array<{ rowid: number }>; expanded: number }>(
    'cards',
  );
  const other = shownCards.cards.map((c) => c.rowid).find((r) => r !== shownCards.expanded)!;
  await press(pev.page.locator(`.card[data-rowid="${other}"] .card-h`));
  const unmatched = await settledReader(pev, other);
  expect(unmatched.match).toBeNull();
  expect(unmatched.view).toMatchObject({ format: 'plain', highlighted: false });
  expect((await marks(await pev.bodyFrame(unmatched.view!.url))).marked).toEqual([]);
  await expect(matchLine(pev)).toHaveCount(0);

  // An HTML message: no marks in the body, the count, and its action.
  const html = await openResult(pev, 'Bravo');
  expect(html.view).toMatchObject({ format: 'html', highlighted: false });
  expect((await marks(await pev.bodyFrame(html.view!.url))).marked).toEqual([]);
  await expect(matchLine(pev)).toHaveText('1 match·Show highlights in plain text');
  const oldUrl = html.view!.url;
  await press(matchLine(pev).locator('button'));
  await expect.poll(async () => (await reader(pev)).view?.format ?? null).toBe('plain');
  const switched = await reader(pev);
  expect(switched.view!.highlighted).toBe(true);
  expect((await marks(await pev.bodyFrame(switched.view!.url))).marked).toEqual(['invoice']);
  // The old token is revoked, and there is one body frame.
  expect(await status(pev, oldUrl)).toBe(404);
  expect(pev.page.frames().filter((f) => f.url().startsWith('mail-body:'))).toHaveLength(1);
  await expect(matchLine(pev)).toHaveCount(0);

  // Only the first 1 MB of a long body is indexed: its marks, and that line.
  const long = await openResult(pev, 'Charlie');
  expect(long.match).toMatchObject({ state: 2, bodyMatches: 1 });
  expect(long.view).toMatchObject({ format: 'plain', highlighted: true });
  expect((await marks(await pev.bodyFrame(long.view!.url))).marked).toEqual(['invoice']);
  await expect(pev.page.locator('.card.expanded .rp-truncated')).toHaveText('First 1 MB indexed');

  // Marks that fail the worker's check: the file's own text, unmarked, and no
  // action offering highlights the worker dropped.
  expect((await pev.main<{ ok: boolean }>('readerBreakMarks', true)).ok).toBe(true);
  const alpha = await openResult(pev, 'Alpha');
  expect(alpha.view).toMatchObject({ format: 'plain', highlighted: false });
  expect((await marks(await pev.bodyFrame(alpha.view!.url))).marked).toEqual([]);
  await expect(matchLine(pev)).toHaveCount(0);
  await expect
    .poll(() => pev.hasLog('reader.marks_dropped', { proc: 'worker', count: 2 }))
    .toBe(true);
  expect((await pev.main<{ ok: boolean }>('readerBreakMarks', false)).ok).toBe(true);

  // Main takes the search's ID only: a malformed one is refused, and an
  // unknown or older one opens the message without its matches.
  const generation = (await pev.shell<{ generation: number }>('state')).generation;
  const queryId = (await reader(pev)).queryId!;
  const openRaw = (args: Record<string, unknown>) =>
    pev.page.evaluate(
      (a) =>
        (
          window as unknown as {
            __pevTestIpc: { invoke(c: string, ...x: unknown[]): Promise<unknown> };
          }
        ).__pevTestIpc.invoke('pev:open', a),
      { rowid: alpha.rowid, mode: 'plain', generation, ...args },
    ) as Promise<{ ok: boolean; code?: string; match?: ReaderMatch | null }>;
  for (const bad of ['7', 0, -1, 1.5, null, { text: 'invoice' }]) {
    expect(await openRaw({ queryId: bad })).toEqual({ ok: false, code: 'invalid' });
  }
  expect(await openRaw({ text: 'invoice' })).toEqual({ ok: false, code: 'invalid' });
  expect(await openRaw({ queryId: queryId + 1000 })).toMatchObject({ ok: true, match: null });
  expect(await openRaw({ queryId })).toMatchObject({ ok: true, match: { bodyMatches: 2 } });

  // Outside search, the same message opens without marks.
  await typeText(pev.page, '');
  await expect.poll(async () => (await reader(pev)).rowid).toBeNull();
  // Nothing of the search or the mail reached a log file.
  for (const file of readdirSync(pev.logsDir())) {
    const text = readFileSync(join(pev.logsDir(), file), 'utf8');
    expect(text, file).not.toContain('invoice');
    expect(findMarkers(text), file).toEqual([]);
  }
});

test('the match line says where else a message matched when its body shows no marks', async ({
  pev,
}) => {
  test.setTimeout(120_000);
  const mails: Mail[] = [
    { id: 'S1', subject: 'Invoice reminder', time: T0 + 1, text: 'Please pay soon.' },
    { id: 'T1', subject: 'Invoice timeout', time: T0 + 2, text: 'This one is never read.' },
    { id: 'U1', subject: 'Invoice unreadable', time: T0 + 3, text: 'No one can read this.' },
    { id: 'R1', subject: 'Invoice removed', time: T0 + 4, text: 'The invoice was here.' },
    { id: 'R2', subject: 'Only body', time: T0 + 5, text: 'An invoice in the body only.' },
  ];
  const { root, run } = craft('hl-lines', mails);
  chmodSync(join(run, 'U1.eml'), 0o000);
  await pev.main('indexTestSettings', { jobMs: 1500, stallBodyOf: 'T1' });
  await openIndexed(pev, root, mails.length);
  await pev.main('indexTestSettings', null);
  await searchFor(pev, 'invoice');

  const subjectOnly = await openResult(pev, 'reminder');
  expect(subjectOnly.match).toMatchObject({ state: 1, columns: ['subject'], bodyMatches: 0 });
  await expect(matchLine(pev)).toHaveText('Matches in: subject');

  const timedOut = await openResult(pev, 'timeout');
  expect(timedOut.match).toMatchObject({ state: 3, reason: 'timeout' });
  await expect(matchLine(pev)).toHaveText('Matches in: subject · Timed out');

  // The file can't be read: the fallback, and the line with its reason.
  const unreadable = await openResult(pev, 'unreadable');
  expect(unreadable).toMatchObject({ fallback: true, match: { state: 3, reason: 'unreadable' } });
  await expect(matchLine(pev)).toHaveText("Matches in: subject · Couldn't read text");

  // Removed after indexing, before any reconcile: the index still says indexed.
  rmSync(join(run, 'R1.eml'));
  rmSync(join(run, 'R2.eml'));
  const removed = await openResult(pev, 'removed');
  expect(removed).toMatchObject({
    refused: 'eml_missing',
    match: { state: 1, columns: ['subject'] },
  });
  await expect(pev.page.locator('.card.expanded .rp-state')).toHaveText(
    'Matches in: subject · Message file missing',
  );
  // A body-only match: the pane says the file is missing, and nothing more.
  const bodyOnly = await openResult(pev, 'Only');
  expect(bodyOnly.refused).toBe('eml_missing');
  await expect(pev.page.locator('.card.expanded .rp-state')).toHaveText('Message file missing');
  await expect(matchLine(pev)).toHaveCount(0);

  // Filters only, at state 3: no line.
  await searchFor(pev, 'from:sam@example.com');
  const filters = await openResult(pev, 'timeout');
  expect(filters.match).toBeNull();
  await expect(matchLine(pev)).toHaveCount(0);

  // Opened again, the reconcile finds R1's file gone: state 4, the same line.
  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  await pev.shell('openExport', [key]);
  await searchFor(pev, 'invoice');
  const anchor = Number(await resultWith(pev, 'removed').getAttribute('data-rowid'));
  await expect
    .poll(async () => (await ask<EmlFile>(pev, { op: 'eml', rowid: anchor }))?.answer?.bodyState)
    .toBe(4);
  const missing = await openResult(pev, 'removed');
  expect(missing).toMatchObject({ refused: 'eml_missing', match: { state: 4 } });
  await expect(pev.page.locator('.card.expanded .rp-state')).toHaveText(
    'Matches in: subject · Message file missing',
  );
});

test('a message whose body is not indexed yet says so', async ({ pev }) => {
  const mails: Mail[] = [
    { id: 'W1', subject: 'Invoice waiting', time: T0 + 1, text: 'invoice body' },
  ];
  const { root } = craft('hl-waiting', mails);
  await pev.main('indexTestSettings', { holdWrites: true });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(
      async () => {
        const progress = await totals(pev);
        if (progress?.phase === 'done' && progress.loaded === mails.length) return true;
        if ((await pev.main<number>('heldWrites')) > 0) await pev.main('releaseWrites', 1);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await pev.main('indexTestSettings', null);
  await searchFor(pev, 'invoice');
  const waiting = await openResult(pev, 'waiting');
  expect(waiting.match).toMatchObject({ state: 0, columns: ['subject'], bodyMatches: 0 });
  await expect(matchLine(pev)).toHaveText('Body not indexed yet');
});
