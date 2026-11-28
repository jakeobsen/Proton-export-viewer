// SPDX-License-Identifier: AGPL-3.0-or-later
// Log redaction: markers are pushed through every logging path in main, core,
// the core worker and the renderer, including the crash and exit handlers.
// Each path must first prove it logged; then no marker may be in any log file.

import {
  chmodSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../src/core/index/schema';
import type { MessageOpenResult, SourceActionResult } from '../../src/shared/api';
import type { IndexProgress } from '../../src/shared/index-types';
import type { Stamp } from '../../src/shared/sources';
import { writeExport } from '../exports';
import { MARKERS, MARKER_TEXT, findMarkers } from '../markers';
import { testDir } from '../paths';
import { expect, launch, test, type PevApp } from './app';
import {
  addChip,
  addIndexRows,
  backToMail,
  clearButton,
  keyInBox,
  mailboxFollows,
  openIndexSettings,
  phase1Done as recentPhase1,
  recentTexts,
  setKeep,
  settled,
  typeText,
} from './search-ui';

test('no marker reaches a log file through any path', async ({ pev }) => {
  const M = MARKER_TEXT;

  // Main.
  await pev.main('mainLog', M);
  await pev.main('mainError', M);
  await pev.main('mainThrow', M);
  await pev.main('mainReject', M);

  // Core.
  await pev.main('core', 'log', M);
  await pev.main('core', 'error', M);
  await pev.main('core', 'throw', M);
  await pev.main('core', 'reject', M);

  // Core worker: a normal log, a crash, and an unhandled rejection.
  await pev.main('core', 'worker-log', M);
  await pev.main('core', 'worker-crash', M);
  await expect.poll(() => pev.hasLog('core.worker_exit', { exitCode: 70 })).toBe(true);
  await pev.main('core', 'worker-reject', M);
  await expect
    .poll(() => pev.logs('core').filter((l) => l.code === 'core.worker_exit').length)
    .toBe(2);

  // Reader lane: a parse failure whose error carries the markers, a timeout
  // and a heap breach, each ending in the reader's fallback. Lower limits keep
  // it short; the paths are the same.
  const root = testDir('redaction-reader');
  writeFileSync(
    join(root, 'link.eml'),
    ['Subject: Link', 'Content-Type: text/plain; charset=utf-8', '', M, ''].join('\r\n'),
  );
  const source = await pev.main<{ ok: boolean }>('readerSource', root, [
    [1, { test: { kind: 'throw', markers: M } }],
    [2, { test: { kind: 'spin' } }],
    [3, { test: { kind: 'heap' } }],
    [4, { file: 'link.eml' }],
  ]);
  expect(source.ok).toBe(true);

  // The link dialog: a link whose URL and text carry markers is shown and
  // copied, a choice is refused, and a URL that is not a link id is denied.
  const linked = await pev.page.evaluate(async () => {
    const state = await window.pev.state();
    if (!state.ok) return state;
    return window.pev.open(4, 'plain', state.generation);
  });
  if (!linked.ok || linked.outcome !== 'view') throw new Error('no view');
  await pev.shell('windowOpen', [`${linked.url.replace('mail-body:', 'mail-asset:')}/l1`]);
  await pev.page.click('.link-copy');
  await expect.poll(() => pev.hasLog('nav.link_action', { action: 'copy' })).toBe(true);
  await pev.shell('windowOpen', [`${linked.url.replace('mail-body:', 'mail-asset:')}/l9`]);
  await pev.shell('windowOpen', [M]);
  await pev.main('readerLimits', { heapMb: 64, timeoutMs: 500 });
  for (const rowid of [1, 2, 3]) {
    const opened = await pev.page.evaluate(async (r) => {
      const state = await window.pev.state();
      if (!state.ok) return state;
      return window.pev.open(r, 'plain', state.generation);
    }, rowid);
    expect((opened as MessageOpenResult & { outcome?: string }).outcome).toBe('fallback');
  }

  // Renderer.
  await pev.shell('log', [M]);
  await pev.shell('error', [M]);
  await pev.shell('throwUncaught', [M]);
  await pev.shell('reject', [M]);

  const expected: Array<[string, string]> = [
    ['main', 'test.log'],
    ['main', 'test.error'],
    ['main', 'main.uncaught'],
    ['main', 'main.rejection'],
    ['core', 'test.log'],
    ['core', 'test.error'],
    ['core', 'core.uncaught'],
    ['core', 'core.rejection'],
    ['worker', 'test.log'],
    ['worker', 'worker.uncaught'],
    ['worker', 'worker.rejection'],
    ['core', 'core.worker_exit'],
    ['worker', 'reader.parse_failed'],
    ['core', 'reader.timeout'],
    ['core', 'reader.limit'],
    ['main', 'open.fallback'],
    ['main', 'nav.link_dialog'],
    ['main', 'nav.link_action'],
    ['main', 'nav.window_open_denied'],
    ['renderer', 'test.log'],
    ['renderer', 'renderer.error'],
    ['renderer', 'renderer.uncaught'],
    ['renderer', 'renderer.rejection'],
  ];
  for (const [proc, code] of expected) {
    await expect.poll(() => pev.hasLog(code, { proc }), { message: `${proc} ${code}` }).toBe(true);
  }

  // A renderer crash, then a core exit.
  await pev.page.evaluate((m) => {
    document.title = m;
  }, M);
  await pev.main('crashRenderer', 1);
  await expect
    .poll(() => pev.hasLog('renderer.gone', { proc: 'main' }))
    .toBe(true)
    .catch((err: unknown) => {
      console.log(
        'main log:',
        JSON.stringify(
          pev
            .logs('main')
            .slice(-10)
            .map((l) => l.code),
        ),
      );
      throw err;
    });
  await pev.main('core', 'exit');
  await expect.poll(() => pev.hasLog('core.exit', { exitCode: 3 })).toBe(true);
  await expect.poll(() => pev.hasLog('child.gone', { processType: 'Utility' })).toBe(true);

  // The error events carry classes and app frames only.
  const uncaught = pev.logs('main').find((l) => l.code === 'main.uncaught');
  expect(uncaught?.data.errorClass).toBe('Error');
  expect(Array.isArray(uncaught?.data.frames)).toBe(true);
  const dropped = pev.logs('main').find((l) => l.code === 'test.log');
  expect(dropped?.data).toEqual({ dropped: 4 });

  // No marker, in any form, and no home-folder path in any log file.
  const dir = pev.logsDir();
  const files = readdirSync(dir);
  expect(files.sort()).toEqual(['core.jsonl', 'main.jsonl', 'renderer.jsonl']);
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    expect(findMarkers(text), file).toEqual([]);
    expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
  }
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

const progressOf = async (pev: PevApp): Promise<IndexProgress | undefined> =>
  (await pev.main<{ progress: IndexProgress } | null>('indexQuery', { op: 'totals' }))?.progress;

/** A message whose subject, text and attachment name carry the markers. */
function markerMessage(): string {
  return [
    `Subject: ${MARKER_TEXT}`,
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    MARKER_TEXT,
    '--b',
    `Content-Type: application/pdf; name="${MARKERS[5]}"`,
    'Content-Disposition: attachment',
    '',
    'x',
    '--b--',
    '',
  ].join('\r\n');
}

function setSchemaVersion(dbPath: string, version: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

test('no marker reaches a log file through the index text and its schema checks, failures included', async () => {
  test.setTimeout(180_000);
  // The exports' folders carry markers, so an error that names a path carries them too.
  const rootA = realpathSync(testDir(MARKERS[0]));
  const a = writeExport(rootA, { seed: 34, messages: 6 });
  const emls = readdirSync(a.run)
    .filter((f) => f.endsWith('.eml'))
    .sort();
  writeFileSync(join(a.run, emls[0]!), markerMessage());
  // A text over the small transaction budget below.
  writeFileSync(
    join(a.run, emls[1]!),
    [
      'Subject: long',
      'Content-Type: text/plain; charset=utf-8',
      '',
      MARKER_TEXT.repeat(20),
      '',
    ].join('\r\n'),
  );
  // A message file that can't be read.
  chmodSync(join(a.run, emls[2]!), 0o000);
  const rootB = realpathSync(testDir(MARKERS[4]));
  writeExport(rootB, { seed: 35, messages: 3 });

  const first = await launch('redaction-index-1');
  let stampA: Stamp;
  let indexDir: string;
  try {
    // A: phase 2 reads every file, with one unreadable and one over the budget.
    await first.main('indexTestSettings', { txnBytes: 600 });
    await first.main('queuePick', rootA, 'bm1');
    await first.shell('chooseFolder', []);
    await expect
      .poll(() => progressOf(first), { timeout: 30_000 })
      .toMatchObject({ phase: 'done', bodyPhase: 'done' });
    stampA = await first.main<Stamp>('sourceStamp');
    indexDir = await first.main<string>('indexDir');

    // B: its phase 2 is under way, its first write held, when it is forgotten.
    // Forgetting the open export closes its index inside the same core, so
    // the write that was held ends as stale and that core logs it.
    await first.main('indexTestSettings', { holdWrites: true });
    await first.main('queuePick', rootB, 'bm2');
    await first.shell('chooseFolder', []);
    const keyB = (await first.main<Stamp>('sourceStamp')).sourceKey;
    await expect.poll(() => first.main<number>('heldWrites')).toBeGreaterThan(0);
    await first.main('releaseWrites', 1);
    await expect
      .poll(async () => (await progressOf(first))?.bodyPhase, { timeout: 30_000 })
      .toBe('indexing');
    await expect.poll(() => first.main<number>('heldWrites')).toBeGreaterThan(0);
    await first.main('indexTestSettings', null);
    expect(await first.shell<SourceActionResult>('forgetExport', [keyB])).toMatchObject({
      ok: true,
      outcome: 'forgotten',
    });
    await expect
      .poll(() => first.hasLog('index.phase2_failed', { proc: 'core', reason: 'stale_generation' }))
      .toBe(true);

    // A is open again at quit, for the schema checks below.
    await first.shell('openExport', [stampA.sourceKey]);
    await expect
      .poll(async () => (await first.main<Stamp>('sourceStamp')).sourceKey)
      .toBe(stampA.sourceKey);
    for (const code of ['index.phase2_done', 'index.body_failed', 'index.body_too_large']) {
      await expect.poll(() => first.hasLog(code, { proc: 'core' }), { message: code }).toBe(true);
    }
  } finally {
    await first.close();
  }

  // A's index is of an older schema version: rebuilt while the export is there.
  const dbPath = join(indexDir, `${stampA.sourceKey}.sqlite`);
  setSchemaVersion(dbPath, SCHEMA_VERSION - 1);
  const second = await launch('redaction-index-2', { userData: first.userData });
  try {
    await expect
      .poll(() => second.hasLog('index.schema_rebuild', { proc: 'core' }), { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(() => progressOf(second), { timeout: 30_000 })
      .toMatchObject({ phase: 'done', bodyPhase: 'done' });
  } finally {
    await second.close();
  }

  // Again, with the export gone: kept as it is until the export is back.
  setSchemaVersion(dbPath, SCHEMA_VERSION - 1);
  renameSync(join(rootA, a.account), join(rootA, 'moved-away'));
  const third = await launch('redaction-index-3', { userData: first.userData });
  try {
    await expect
      .poll(() => third.hasLog('index.schema_pending', { proc: 'core' }), { timeout: 30_000 })
      .toBe(true);
  } finally {
    await third.close();
  }

  // No marker, in any form, and no home-folder path in any log file.
  const dir = third.logsDir();
  for (const file of readdirSync(dir)) {
    expect(findMarkers(readFileSync(join(dir, file), 'utf8')), file).toEqual([]);
  }
});

test('no marker reaches a log file through the recent searches', async () => {
  const root = realpathSync(testDir(`${MARKERS[0]}-recent`));
  const written = writeExport(root, { seed: 36, messages: 4 });
  const first = await launch('redaction-recent-1');
  let dbPath: string;
  try {
    await first.main('queuePick', root, 'bm1');
    await first.shell('chooseFolder', []);
    await recentPhase1(first, written.pairs);
    await mailboxFollows(first);
    const stamp = await first.main<Stamp>('sourceStamp');
    dbPath = join(await first.main<string>('indexDir'), `${stamp.sourceKey}.sqlite`);
    // A marker query with a marker From chip, committed and listed.
    await typeText(first.page, MARKER_TEXT);
    await settled(first, MARKER_TEXT, 0);
    await addChip(first.page, { k: 'from', v: MARKERS[0] });
    await settled(first, MARKER_TEXT, 1);
    await keyInBox(first.page, 'Enter');
    await expect.poll(() => recentTexts(first.page)).toEqual([MARKER_TEXT]);
    await expect.poll(() => first.hasLog('recent.recorded', { proc: 'core' })).toBe(true);
  } finally {
    await first.close();
  }
  // A row that fails the check, holding the markers.
  addIndexRows(dbPath, [{ q: `{"v":1,"text":${JSON.stringify(MARKER_TEXT)}`, at: Date.now() }]);

  const second = await launch('redaction-recent-2', { userData: first.userData });
  try {
    await recentPhase1(second, written.pairs);
    await mailboxFollows(second);
    await expect.poll(() => recentTexts(second.page)).toEqual([MARKER_TEXT]);
    await expect
      .poll(() => second.hasLog('recent.invalid_rows', { proc: 'core', count: 1 }))
      .toBe(true);
    // Committed again, cleared, committed, then the switch turned off.
    await typeText(second.page, MARKERS[1]);
    await settled(second, MARKERS[1]);
    await keyInBox(second.page, 'Enter');
    await expect.poll(() => recentTexts(second.page)).toEqual([MARKERS[1], MARKER_TEXT]);
    await openIndexSettings(second.page);
    await clearButton(second.page).dispatchEvent('click');
    await expect.poll(() => second.hasLog('recent.cleared', { proc: 'core', count: 2 })).toBe(true);
    await backToMail(second.page);
    await typeText(second.page, MARKERS[3]);
    await settled(second, MARKERS[3]);
    await keyInBox(second.page, 'Enter');
    await expect.poll(() => recentTexts(second.page)).toEqual([MARKERS[3]]);
    await openIndexSettings(second.page);
    await setKeep(second.page, false);
    await expect.poll(() => second.hasLog('recent.cleared', { proc: 'core', count: 1 })).toBe(true);
    await backToMail(second.page);
    await typeText(second.page, MARKERS[5]);
    await settled(second, MARKERS[5]);
    await keyInBox(second.page, 'Enter');
    await expect.poll(() => second.hasLog('recent.dropped', { reason: 'off' })).toBe(true);
  } finally {
    await second.close();
  }

  // No marker, in any form, and no home-folder path in any log file.
  const dir = second.logsDir();
  for (const file of readdirSync(dir)) {
    expect(findMarkers(readFileSync(join(dir, file), 'utf8')), file).toEqual([]);
  }
});
