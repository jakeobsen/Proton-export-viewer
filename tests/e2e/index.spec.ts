// SPDX-License-Identifier: AGPL-3.0-or-later
// The export index in the app: opening an export creates its index in core
// and runs phase 1; the list, the folders and the counts come from it; the
// registry keeps the index's identity, and a reopen uses the same index.

import {
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SourceActionResult } from '../../src/shared/api';
import type {
  IndexProgress,
  IndexTotals,
  ListPage,
  RowDetails,
  Sidebar,
} from '../../src/shared/index-types';
import type { SourcesView, Stamp } from '../../src/shared/sources';
import { digest } from '../../tools/gen-export/tree.mjs';
import { writeExport } from '../exports';
import { MARKERS, MARKER_TEXT, findMarkers } from '../markers';
import { testDir } from '../paths';
import { expect, launch, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);

async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ phase: 'done', loaded: total, total, failed: 0 });
}

/** The background checks the fixture makes, for an app launched without it. */
async function checkHidden(pev: PevApp): Promise<void> {
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
  expect(await pev.main('windowEvents')).toEqual([]);
  expect(await pev.main('dialogCalls')).toEqual([]);
}

function dbUuidOf(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return String(db.prepare("SELECT value FROM source_meta WHERE key = 'db_uuid'").get()?.value);
  } finally {
    db.close();
  }
}

test('opening an export builds its index in core, with private files and the identity in the registry', async ({
  pev,
}) => {
  const root = realpathSync(testDir('index-open'));
  const written = writeExport(root, { seed: 3, messages: 40 });
  await pev.main('queuePick', root, 'bm1');
  expect(await pev.shell<SourceActionResult>('chooseFolder', [])).toMatchObject({
    ok: true,
    outcome: 'opened',
  });
  await phase1Done(pev, written.pairs);
  const stamp = await pev.main<Stamp>('sourceStamp');

  const totals = (await ask<IndexTotals>(pev, { op: 'totals' }))!.answer;
  expect(totals).toMatchObject({ messages: 40, pairs: 40 });
  const sidebar = (await ask<Sidebar>(pev, { op: 'sidebar' }))!.answer;
  const allMail = sidebar.folders.find((f) => f.id === '5')!;
  expect(allMail.conversations).toBe(totals.conversations);
  expect(sidebar.folders.some((f) => f.kind === 'folder' || f.kind === 'label')).toBe(true);
  const page = (await ask<ListPage>(pev, { op: 'page', labelId: '5', after: null }))!.answer;
  expect(page.rows).toHaveLength(totals.conversations);
  const details = (await ask<RowDetails[]>(pev, {
    op: 'details',
    threadIds: page.rows.slice(0, 5).map((r) => r.threadId),
  }))!.answer;
  expect(details).toHaveLength(5);
  expect(details.every((d) => d.participants.length > 0)).toBe(true);
  const resolved = (await ask<number>(pev, { op: 'resolve', rowid: page.rows[0]!.anchorRowid }))!
    .answer;
  expect(resolved).toBe(page.rows[0]!.threadId);

  // <userData>/index/<sourceKey>.sqlite and its sidecars: 0600 in a 0700 folder.
  const indexDir = await pev.main<string>('indexDir');
  expect(statSync(indexDir).mode & 0o777).toBe(0o700);
  const files = readdirSync(indexDir);
  expect(files).toContain(`${stamp.sourceKey}.sqlite`);
  for (const name of files) {
    expect(name.startsWith(`${stamp.sourceKey}.sqlite`)).toBe(true);
    expect(statSync(join(indexDir, name)).mode & 0o777, name).toBe(0o600);
  }
  // The same identity in the database and in the source's registry entry.
  const dbUuid = dbUuidOf(join(indexDir, `${stamp.sourceKey}.sqlite`));
  const registry = JSON.parse(readFileSync(await pev.main<string>('registryFile'), 'utf8')) as {
    sources: Array<{ sourceKey: string; dbUuid?: string }>;
  };
  expect(registry.sources.find((s) => s.sourceKey === stamp.sourceKey)?.dbUuid).toBe(dbUuid);

  // Core logged the index's events by code only.
  expect(pev.hasLog('index.created', { proc: 'core' })).toBe(true);
  expect(pev.hasLog('index.phase1_done', { proc: 'core', count: 40 })).toBe(true);
  expect(pev.hasLog('index.opened', { proc: 'main' })).toBe(true);
});

test('a reopen at launch uses the same index and indexes nothing twice', async () => {
  const root = realpathSync(testDir('index-reopen'));
  const written = writeExport(root, { seed: 4, messages: 25 });
  const first = await launch('index-reopen-1');
  await first.main('queuePick', root, 'bm1');
  await first.shell('chooseFolder', []);
  await phase1Done(first, written.pairs);
  const stamp = await first.main<Stamp>('sourceStamp');
  const indexDir = await first.main<string>('indexDir');
  const dbPath = join(indexDir, `${stamp.sourceKey}.sqlite`);
  const uuid = dbUuidOf(dbPath);
  await checkHidden(first);
  await first.close();

  const again = await launch('index-reopen-2', { userData: first.userData });
  try {
    await phase1Done(again, written.pairs);
    expect((await again.main<Stamp>('sourceStamp')).sourceKey).toBe(stamp.sourceKey);
    expect(dbUuidOf(dbPath)).toBe(uuid);
    const totals = (await ask<IndexTotals>(again, { op: 'totals' }))!.answer;
    expect(totals).toMatchObject({ messages: 25, pairs: 25 });
    expect(again.logs('core').filter((l) => l.code === 'index.created')).toHaveLength(1);
    await checkHidden(again);
  } finally {
    await again.close();
  }
});

test('a reopen brings the index in line with the files, and reads only what changed', async () => {
  const root = realpathSync(testDir('index-reconcile'));
  const written = writeExport(root, { seed: 5, messages: 25 });
  const first = await launch('index-reconcile-1');
  await first.main('queuePick', root, 'bm1');
  await first.shell('chooseFolder', []);
  await phase1Done(first, written.pairs);
  await first.close();

  const metas = readdirSync(written.run)
    .filter((n) => n.endsWith('.metadata.json'))
    .sort();
  const [gone, changed, template] = metas as [string, string, string];
  rmSync(join(written.run, gone));
  const doc = JSON.parse(readFileSync(join(written.run, changed), 'utf8')) as {
    Payload: Record<string, unknown>;
  };
  doc.Payload.Subject = 'Changed on disk';
  writeFileSync(join(written.run, changed), JSON.stringify(doc));
  const copy = JSON.parse(readFileSync(join(written.run, template), 'utf8')) as {
    Payload: Record<string, unknown>;
  };
  const added = `${String(copy.Payload.ID)}Added`;
  copy.Payload.ID = added;
  writeFileSync(join(written.run, `${added}.metadata.json`), JSON.stringify(copy));
  const before = digest(root);

  let stamp: Stamp | undefined;
  let indexDir: string | undefined;
  const again = await launch('index-reconcile-2', { userData: first.userData });
  try {
    await phase1Done(again, written.pairs);
    const totals = (await ask<IndexTotals>(again, { op: 'totals' }))!.answer;
    // One message gone (its message file stays, as a pair), one added without a message file.
    expect(totals).toMatchObject({ messages: written.pairs, pairs: written.pairs + 1 });
    const reconciled = again.logs('core').filter((l) => l.code === 'index.reconciled');
    expect(reconciled.map((l) => l.data.count)).toEqual([2]);
    expect(again.logs('core').filter((l) => l.code === 'index.created')).toHaveLength(1);
    stamp = await again.main<Stamp>('sourceStamp');
    indexDir = await again.main<string>('indexDir');
    await checkHidden(again);
  } finally {
    await again.close();
  }
  // The app read the folder and wrote nothing there.
  expect(digest(root)).toBe(before);
  const db = new DatabaseSync(join(indexDir!, `${stamp!.sourceKey}.sqlite`), { readOnly: true });
  try {
    const subject = (id: string) =>
      db.prepare('SELECT subject FROM messages WHERE proton_id = ?').get(id)?.subject;
    expect(subject(changed.slice(0, -'.metadata.json'.length))).toBe('Changed on disk');
    expect(subject(gone.slice(0, -'.metadata.json'.length))).toBeUndefined();
    expect(subject(added)).toBe(copy.Payload.Subject);
  } finally {
    db.close();
  }
});

test("the index's log events carry codes and file IDs only", async ({ pev }) => {
  const root = realpathSync(testDir('index-redaction'));
  const written = writeExport(root, { seed: 5, messages: 12, account: MARKERS[0] });
  const names = readdirSync(written.run)
    .filter((n) => n.endsWith('.metadata.json'))
    .sort();
  // A message with markers everywhere and every list over its limit.
  const capped = join(written.run, names[0]!);
  const doc = JSON.parse(readFileSync(capped, 'utf8')) as { Payload: Record<string, unknown> };
  const many = (tag: string) =>
    Array.from({ length: 1500 }, (_, i) => ({
      Name: MARKER_TEXT,
      Address: `${tag}${i}@example.org`,
    }));
  Object.assign(doc.Payload, {
    Subject: MARKER_TEXT,
    Sender: { Name: MARKER_TEXT, Address: MARKERS[0] },
    LabelIDs: Array.from({ length: 300 }, (_, i) => `${MARKERS[4]}-${i}`),
    ToList: many('t'),
    CCList: many('c'),
    BCCList: many('b'),
    ReplyTos: many('r'),
  });
  writeFileSync(capped, JSON.stringify(doc));
  // A metadata file that isn't JSON, and a labels.json that isn't either.
  writeFileSync(join(written.run, names[1]!), `{"Payload": "${MARKER_TEXT}`);
  writeFileSync(join(written.run, 'labels.json'), `[${MARKER_TEXT}`);

  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ phase: 'done', loaded: 12, total: 12, failed: 1, capped: 1 });
  const page = (await ask<ListPage>(pev, { op: 'page', labelId: '5', after: null }))!.answer;
  const details = (await ask<RowDetails[]>(pev, {
    op: 'details',
    threadIds: page.rows.map((r) => r.threadId),
  }))!.answer;
  expect(details.some((d) => d.subject === MARKER_TEXT)).toBe(true);

  for (const code of [
    'index.created',
    'index.labels_failed',
    'index.capped',
    'index.meta_failed',
    'index.phase1_done',
  ]) {
    expect(pev.hasLog(code, { proc: 'core' }), code).toBe(true);
  }
  expect(pev.hasLog('index.opened', { proc: 'main' })).toBe(true);
  const cappedLists = pev
    .logs('core')
    .filter((l) => l.code === 'index.capped')
    .map((l) => l.data.list);
  expect(cappedLists).toEqual(['labels', 'to', 'cc', 'bcc', 'replyTo']);
  for (const line of pev.logs('core').filter((l) => l.code.startsWith('index.'))) {
    expect(line.data.dropped, line.code).toBeUndefined();
  }
  const dir = pev.logsDir();
  for (const file of readdirSync(dir)) {
    expect(findMarkers(readFileSync(join(dir, file), 'utf8')), file).toEqual([]);
  }
});

test('an unavailable export is browsed from its index, without access to the folder', async () => {
  const root = realpathSync(testDir('index-offline'));
  const written = writeExport(root, { seed: 6, messages: 15 });
  const first = await launch('index-offline-1');
  let uuid: string;
  try {
    await first.main('queuePick', root, 'bm1');
    await first.shell('chooseFolder', []);
    await phase1Done(first, written.pairs);
    const stamp = await first.main<Stamp>('sourceStamp');
    uuid = dbUuidOf(join(await first.main<string>('indexDir'), `${stamp.sourceKey}.sqlite`));
    await checkHidden(first);
  } finally {
    await first.close();
  }

  // The export is gone at the next launch.
  renameSync(join(root, written.account), join(root, 'moved-away'));
  const gone = await launch('index-offline-2', { userData: first.userData });
  try {
    await expect
      .poll(async () => (await gone.main<SourcesView>('sourcesView')).active?.status)
      .toBe('offline');
    const records = await gone.main<{ data: { hasRoot: boolean } }>('core', 'source-records');
    expect(records.data.hasRoot).toBe(false);
    await expect
      .poll(async () => (await ask<IndexTotals>(gone, { op: 'totals' }))?.answer)
      .toMatchObject({ messages: 15 });
    expect((await ask<IndexTotals>(gone, { op: 'totals' }))!.progress.phase).toBe('unavailable');
    const stamp = await gone.main<Stamp>('sourceStamp');
    expect(dbUuidOf(join(await gone.main<string>('indexDir'), `${stamp.sourceKey}.sqlite`))).toBe(
      uuid,
    );
    await checkHidden(gone);
  } finally {
    await gone.close();
  }
});
