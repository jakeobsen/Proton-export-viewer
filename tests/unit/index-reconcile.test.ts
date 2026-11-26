// SPDX-License-Identifier: AGPL-3.0-or-later
// Reconcile on reopen: every case of comparing the folder's files with the
// stored pairs, revs that are never used twice, late results that change
// nothing, conversations that merge, split and are replaced (with their
// counts), and the grouping checked against a from-scratch one after every
// step.

import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../../src/core/index/metadata';
import { threadOfMessage } from '../../src/core/index/queries';
import { BODY_STATE, META_STATE } from '../../src/core/index/schema';
import { asNumber, type Db } from '../../src/core/index/sql';
import {
  PAIR_META_MISSING,
  classify,
  groupMembers,
  groupTotals,
  labelsStatOf,
  type ApplyItem,
  type ApplyStats,
  type FileStat,
  type IndexWriter,
  type PairFiles,
  type Phase1Stats,
  type ReconcilePlan,
  type StoredPair,
} from '../../src/core/index/writer';
import { STAMP, checkAgainstScratch, expected, fresh, message, partition } from '../index-helpers';

// --- A folder of pairs, as reconcile sees it ------------------------------------

/** Past 2^53, so the stored times only compare right as exact 64-bit values. */
const EPOCH_NS = 1_764_000_000_000_000_000n;

function stat(id: string, side: 'meta' | 'eml', version: number, ino = 1): FileStat {
  return {
    rel: side === 'meta' ? `${id}.metadata.json` : `${id}.eml`,
    size: 100 + version,
    mtimeNs: EPOCH_NS + BigInt(version),
    dev: 7n,
    ino: BigInt(ino),
  };
}

/** One pair in the folder: a version per file (null: no file) and what its metadata parses to. */
interface Entry {
  row: MessageRow | null;
  meta: number | null;
  eml: number | null;
  ino?: number;
  dev?: bigint;
}

class Folder {
  readonly entries = new Map<string, Entry>();
  /** The rows the index should hold now, by message ID. */
  readonly indexed = new Map<string, MessageRow>();

  constructor(
    readonly db: Db,
    readonly writer: IndexWriter,
  ) {}

  add(row: MessageRow, entry: Partial<Entry> = {}): this {
    this.entries.set(row.protonId, { row, meta: 1, eml: 1, ...entry });
    return this;
  }

  /** New metadata for a message: a new version of its file. */
  change(row: MessageRow): this {
    const e = this.entries.get(row.protonId)!;
    e.row = row;
    e.meta = (e.meta ?? 0) + 1;
    return this;
  }

  set(id: string, entry: Partial<Entry>): this {
    this.entries.set(id, { ...this.entries.get(id)!, ...entry });
    return this;
  }

  drop(id: string): this {
    this.entries.delete(id);
    return this;
  }

  files(id: string): PairFiles {
    const e = this.entries.get(id);
    const side = (kind: 'meta' | 'eml'): FileStat | null => {
      const version = e?.[kind];
      if (version === null || version === undefined) return null;
      return { ...stat(id, kind, version, e?.ino), dev: e?.dev ?? 7n };
    };
    return { protonId: id, meta: side('meta'), eml: side('eml') };
  }

  scan(): { metadata: Map<string, FileStat>; eml: Map<string, FileStat> } {
    const metadata = new Map<string, FileStat>();
    const eml = new Map<string, FileStat>();
    for (const id of this.entries.keys()) {
      const f = this.files(id);
      if (f.meta) metadata.set(id, f.meta);
      if (f.eml) eml.set(id, f.eml);
    }
    return { metadata, eml };
  }

  /** Off for rows the from-scratch model doesn't take (a label listed twice). */
  verify = true;

  check(): void {
    if (this.verify) checkAgainstScratch(this.db, [...this.indexed.values()]);
  }

  /**
   * Reconciles as a reopen does: the plan, the changes that need nothing read,
   * then each change to read gets its rev and its result is written. The
   * stored conversations are checked against a from-scratch grouping after
   * every transaction.
   */
  reconcile(): { plan: ReconcilePlan; applied: ApplyStats[]; written: Phase1Stats } {
    const scanned = this.scan();
    const plan = this.writer.planReconcile(scanned.metadata, scanned.eml);
    const item = (c: (typeof plan.changes)[number]): ApplyItem => ({
      change: c,
      files: this.files(c.protonId),
    });
    const now = plan.changes.filter((c) => c.meta !== 'parse').map(item);
    const toRead = plan.changes.filter((c) => c.meta === 'parse').map(item);
    const applied = [this.writer.applyChanges(STAMP, now)];
    for (const c of plan.changes) {
      if (c.meta === 'remove' || c.gone) this.indexed.delete(c.protonId);
    }
    this.check();
    applied.push(this.writer.applyChanges(STAMP, toRead));
    this.check();
    const revs = new Map(applied[1]!.revs);
    const written = this.writer.phase1Batch(
      STAMP,
      toRead.map((u) => {
        const row = this.entries.get(u.change.protonId)!.row;
        return {
          pair: u.files,
          expectedRev: revs.get(u.change.protonId)!,
          row,
          error: row ? null : 'META_JSON',
        };
      }),
    );
    for (const u of toRead) {
      const row = this.entries.get(u.change.protonId)!.row;
      if (row) this.indexed.set(row.protonId, row);
      else this.indexed.delete(u.change.protonId);
    }
    this.check();
    return { plan, applied, written };
  }
}

function folder(): Folder {
  const { db, writer } = fresh();
  return new Folder(db, writer);
}

const pairRow = (db: Db, id: string) =>
  db
    .stmt('SELECT rev, file_id, meta_state, body_state, error_code FROM pairs WHERE proton_id = ?')
    .get(id);
const rowidOf = (db: Db, id: string) =>
  asNumber(db.stmt('SELECT rowid FROM messages WHERE proton_id = ?').get(id)?.rowid);
const count = (db: Db, sql: string, ...params: string[]) =>
  asNumber(Object.values(db.stmt(sql).get(...params) ?? {})[0]);
const revSeq = (db: Db) => count(db, "SELECT value FROM source_meta WHERE key = 'rev_seq'");

/** Per folder or label: conversations listed and unread conversations, as the sidebar counts them. */
function folderCounts(db: Db): Record<string, [number, number]> {
  return Object.fromEntries(
    db
      .stmt(
        'SELECT label_id, count(*) AS n, sum(unread_count > 0) AS u FROM thread_labels GROUP BY label_id',
      )
      .all()
      .map((r) => [String(r.label_id), [asNumber(r.n), asNumber(r.u)]]),
  );
}

const ftsHits = (db: Db, term: string) =>
  db
    .stmt('SELECT rowid FROM fts WHERE fts MATCH ?')
    .all(term)
    .map((r) => asNumber(r.rowid));

// --- The comparison ---------------------------------------------------------------

describe('what reconcile does with a stored pair', () => {
  const stored = (over: Partial<StoredPair> = {}): StoredPair => {
    const asStored = (f: FileStat) => ({
      rel: f.rel,
      size: f.size,
      mtimeNs: String(f.mtimeNs),
      dev: String(f.dev),
      ino: String(f.ino),
    });
    return {
      protonId: 'p',
      metaState: META_STATE.indexed,
      meta: asStored(stat('p', 'meta', 1)),
      eml: asStored(stat('p', 'eml', 1)),
      ...over,
    };
  };
  const m1 = stat('p', 'meta', 1);
  const e1 = stat('p', 'eml', 1);
  const pick = (c: ReturnType<typeof classify>) =>
    c && { meta: c.meta, eml: c.eml, gone: c.gone, refresh: c.refresh };

  it('leaves an unchanged pair alone, and a failed one that is unchanged too', () => {
    expect(classify(stored(), m1, e1)).toBeNull();
    expect(classify(stored({ metaState: META_STATE.failed }), m1, e1)).toBeNull();
  });

  it('reads changed metadata again and keeps the body', () => {
    for (const changed of [
      stat('p', 'meta', 2),
      { ...m1, size: 1 },
      { ...m1, mtimeNs: m1.mtimeNs + 1n },
      { ...m1, rel: 'other.metadata.json' },
    ]) {
      expect(pick(classify(stored(), changed, e1))).toEqual({
        meta: 'parse',
        eml: 'keep',
        gone: false,
        refresh: false,
      });
    }
    expect(
      pick(classify(stored({ metaState: META_STATE.failed }), stat('p', 'meta', 2), e1)),
    ).toMatchObject({ meta: 'parse' });
  });

  it('reads metadata again that was queued and never written', () => {
    expect(pick(classify(stored({ metaState: META_STATE.pending }), m1, e1))).toMatchObject({
      meta: 'parse',
      eml: 'keep',
    });
  });

  it('clears the body of a changed message file and keeps the metadata', () => {
    expect(pick(classify(stored(), m1, stat('p', 'eml', 2)))).toEqual({
      meta: 'keep',
      eml: 'changed',
      gone: false,
      refresh: false,
    });
  });

  it('reads both again when both changed', () => {
    expect(pick(classify(stored(), stat('p', 'meta', 2), stat('p', 'eml', 2)))).toMatchObject({
      meta: 'parse',
      eml: 'changed',
    });
  });

  it('takes the message out when its metadata is gone, with or without its message file', () => {
    expect(pick(classify(stored(), undefined, e1))).toMatchObject({ meta: 'remove', eml: 'keep' });
    // Already gone before: nothing more to do.
    expect(
      classify(stored({ metaState: META_STATE.missing, meta: null }), undefined, e1),
    ).toBeNull();
  });

  it('marks a missing message file', () => {
    expect(pick(classify(stored(), m1, undefined))).toMatchObject({ meta: 'keep', eml: 'missing' });
  });

  it('deletes a pair with neither file', () => {
    expect(pick(classify(stored(), undefined, undefined))).toMatchObject({ gone: true });
  });

  it('treats a file that comes back as changed', () => {
    expect(
      pick(classify(stored({ metaState: META_STATE.missing, meta: null }), m1, e1)),
    ).toMatchObject({ meta: 'parse', eml: 'keep' });
    expect(pick(classify(stored({ eml: null }), m1, e1))).toMatchObject({
      meta: 'keep',
      eml: 'back',
    });
  });

  it('only updates the numbers when just the device or inode moved (remounted or copied)', () => {
    for (const [meta, eml] of [
      [
        { ...m1, dev: 99n },
        { ...e1, dev: 99n },
      ],
      [{ ...m1, ino: 9n }, e1],
      [m1, { ...e1, ino: 9n }],
    ] as const) {
      expect(pick(classify(stored(), meta, eml))).toEqual({
        meta: 'keep',
        eml: 'keep',
        gone: false,
        refresh: true,
      });
    }
  });
});

describe('grouping members again', () => {
  const m = (rowid: number, keys: string[]) => ({
    rowid,
    time: 0,
    unread: 0,
    numAttachments: 0,
    keys,
  });

  it('splits into linked groups, the largest first, ties to the lowest rowid', () => {
    const groups = groupMembers([
      m(1, ['a']),
      m(2, ['b']),
      m(3, ['b', 'c']),
      m(4, ['a', 'x']),
      m(5, ['c']),
      m(6, []),
    ]);
    expect(groups).toEqual([[1, 2, 4], [0, 3], [5]]);
  });

  it('totals a group of any size, with more members than a call takes arguments', () => {
    const n = 500_000;
    const members = Array.from({ length: n }, (_, i) => ({
      rowid: i + 1,
      // Times out of order, so first and last aren't the ends of the list.
      time: ((i * 7_919) % n) - 1_000,
      unread: i % 3 === 0 ? 1 : 0,
      numAttachments: i % 5 === 0 ? 2 : 0,
      keys: [],
    }));
    const group = members.map((_, i) => i);
    expect(groupTotals(members, group)).toEqual({
      count: n,
      unread: Math.ceil(n / 3),
      withAttachments: n / 5,
      first: -1_000,
      last: n - 1 - 1_000,
    });
    expect(groupTotals(members, [3, 1, 4])).toEqual({
      count: 3,
      unread: 1,
      withAttachments: 0,
      first: Math.min(members[1]!.time, members[3]!.time, members[4]!.time),
      last: Math.max(members[1]!.time, members[3]!.time, members[4]!.time),
    });
  });
});

// --- The table --------------------------------------------------------------------

describe('reconcile on reopen', () => {
  it('registers new pairs with new revs, reads them, and leaves unchanged ones alone', () => {
    const f = folder()
      .add(message('a', ['a']))
      .add(message('b', ['b']));
    const first = f.reconcile();
    expect(first.plan.changes.map((c) => [c.protonId, c.fresh])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    expect(first.applied[1]!.revs).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(first.written).toMatchObject({ messages: 2, dropped: 0 });
    // Reopened with nothing changed: nothing to do.
    expect(f.reconcile().plan.changes).toEqual([]);
    expect(revSeq(f.db)).toBe(2);
  });

  it('takes out a message whose metadata is gone, keeps its pair, and places it again when it comes back', () => {
    const f = folder()
      .add(message('a', ['a'], { unread: 1, labelIds: ['0', '5'] }))
      .add(message('b', ['b', 'a'], { unread: 1, labelIds: ['0', '5'] }));
    f.reconcile();
    const before = asNumber(pairRow(f.db, 'b')?.rev);
    const rowid = rowidOf(f.db, 'b');
    expect(ftsHits(f.db, 'b')).toContain(rowid);

    f.set('b', { meta: null });
    const removed = f.reconcile();
    expect(removed.applied[0]).toMatchObject({ removed: 1, deleted: 0 });
    expect(pairRow(f.db, 'b')).toMatchObject({
      meta_state: META_STATE.missing,
      error_code: PAIR_META_MISSING,
      body_state: BODY_STATE.pending,
    });
    expect(asNumber(pairRow(f.db, 'b')?.rev)).toBeGreaterThan(before);
    // The row, its labels, its text and its full-text entry are gone.
    expect(count(f.db, 'SELECT count(*) FROM messages WHERE proton_id = ?', 'b')).toBe(0);
    expect(count(f.db, `SELECT count(*) FROM message_labels WHERE message_rowid = ${rowid}`)).toBe(
      0,
    );
    expect(count(f.db, `SELECT count(*) FROM message_text WHERE rowid = ${rowid}`)).toBe(0);
    expect(ftsHits(f.db, 'b')).not.toContain(rowid);
    expect(folderCounts(f.db)).toEqual({ '0': [1, 1], '5': [1, 1] });

    const gone = asNumber(pairRow(f.db, 'b')?.rev);
    f.set('b', { meta: 2 });
    const back = f.reconcile();
    expect(back.plan.changes).toMatchObject([{ protonId: 'b', fresh: false, meta: 'parse' }]);
    expect(asNumber(pairRow(f.db, 'b')?.rev)).toBeGreaterThan(gone);
    expect(pairRow(f.db, 'b')).toMatchObject({ meta_state: META_STATE.indexed, error_code: null });
    expect(partition(f.db)).toEqual([['a', 'b']]);
    // It comes back as a new row: no message is ever given a removed one's
    // rowid, even the highest one's.
    expect(rowidOf(f.db, 'b')).toBeGreaterThan(rowid);
  });

  it('deletes everything of a pair with neither file, and gives one found again a rev never used', () => {
    const f = folder()
      .add(message('a', ['a']))
      .add(message('b', ['b']));
    f.reconcile();
    const fileId = String(pairRow(f.db, 'b')?.file_id);
    const highest = revSeq(f.db);
    f.drop('b');
    expect(f.reconcile().applied[0]).toMatchObject({ removed: 1, deleted: 1 });
    expect(pairRow(f.db, 'b')).toBeUndefined();
    f.add(message('b', ['b']));
    const again = f.reconcile();
    expect(again.plan.changes).toMatchObject([{ protonId: 'b', fresh: true }]);
    expect(again.applied[1]!.revs).toEqual([['b', highest + 1]]);
    // A new pair: a new file ID too.
    expect(String(pairRow(f.db, 'b')?.file_id)).not.toBe(fileId);
  });

  it('places a changed message again, keeping its rowid and its body', () => {
    const f = folder()
      .add(message('a', ['a'], { labelIds: ['0', '5'], unread: 1 }))
      .add(message('b', ['b']));
    f.reconcile();
    const rowid = rowidOf(f.db, 'a');
    // What phase 2 will have stored for the body.
    f.db.stmt("UPDATE message_text SET body = 'zebra' WHERE rowid = ?").run(rowid);
    f.change(message('a', ['a'], { subject: 'renamed', labelIds: ['5', '10'], unread: 0 }));
    const step = f.reconcile();
    expect(step.plan.changes).toMatchObject([{ protonId: 'a', meta: 'parse', eml: 'keep' }]);
    expect(step.written).toMatchObject({ messages: 1, replaced: 1, dropped: 0 });
    expect(rowidOf(f.db, 'a')).toBe(rowid);
    expect(ftsHits(f.db, 'zebra')).toEqual([rowid]);
    expect(ftsHits(f.db, 'renamed')).toEqual([rowid]);
    expect(pairRow(f.db, 'a')?.body_state).toBe(BODY_STATE.pending);
    expect(folderCounts(f.db)).toEqual({ '5': [2, 0], '10': [1, 0] });
  });

  it('clears the body of a changed or missing message file and queues it for phase 2', () => {
    const f = folder()
      .add(message('a', ['a']))
      .add(message('b', ['b']))
      .add(message('c', ['c']));
    f.reconcile();
    for (const id of ['a', 'b', 'c']) {
      f.db
        .stmt("UPDATE message_text SET body = ?, attachments = 'report.pdf' WHERE rowid = ?")
        .run(`body${id}`, rowidOf(f.db, id));
      f.db.stmt('UPDATE pairs SET body_state = 1 WHERE proton_id = ?').run(id);
    }
    const revs = Object.fromEntries(
      ['a', 'b', 'c'].map((id) => [id, asNumber(pairRow(f.db, id)?.rev)]),
    );
    f.set('a', { eml: 2 }).set('b', { eml: null });
    const step = f.reconcile();
    expect(step.applied[0]).toMatchObject({ bodies: 2, removed: 0 });
    expect(pairRow(f.db, 'a')?.body_state).toBe(BODY_STATE.pending);
    expect(pairRow(f.db, 'b')?.body_state).toBe(BODY_STATE.emlMissing);
    expect(asNumber(pairRow(f.db, 'a')?.rev)).toBeGreaterThan(revs.a!);
    expect(asNumber(pairRow(f.db, 'b')?.rev)).toBeGreaterThan(revs.b!);
    expect(ftsHits(f.db, 'bodya')).toEqual([]);
    expect(ftsHits(f.db, 'bodyb')).toEqual([]);
    expect(ftsHits(f.db, 'report')).toEqual([rowidOf(f.db, 'c')]);
    // The metadata and the untouched pair stay as they were.
    expect(ftsHits(f.db, 'a')).toContain(rowidOf(f.db, 'a'));
    expect(pairRow(f.db, 'c')).toMatchObject({ body_state: 1, rev: revs.c });
    // The message file comes back: its body is pending again.
    f.set('b', { eml: 3 });
    f.reconcile();
    expect(pairRow(f.db, 'b')?.body_state).toBe(BODY_STATE.pending);
  });

  it('reads both again when both files changed, and clears the body', () => {
    const f = folder().add(message('a', ['a']));
    f.reconcile();
    f.db.stmt("UPDATE message_text SET body = 'zebra'").run();
    f.change(message('a', ['a'], { subject: 'new' })).set('a', { eml: 2 });
    const step = f.reconcile();
    expect(step.plan.changes).toMatchObject([{ meta: 'parse', eml: 'changed' }]);
    expect(ftsHits(f.db, 'zebra')).toEqual([]);
    expect(ftsHits(f.db, 'new')).toEqual([rowidOf(f.db, 'a')]);
  });

  it('takes out a message whose changed metadata no longer parses, and records the code', () => {
    const f = folder()
      .add(message('a', ['a']))
      .add(message('b', ['b', 'a']));
    f.reconcile();
    f.set('b', { row: null, meta: 2 });
    const step = f.reconcile();
    expect(step.written).toMatchObject({ failed: 1, removed: 1, messages: 0 });
    expect(step.written.errors).toEqual([
      { fileId: String(pairRow(f.db, 'b')?.file_id), code: 'META_JSON' },
    ]);
    expect(pairRow(f.db, 'b')).toMatchObject({
      meta_state: META_STATE.failed,
      error_code: 'META_JSON',
    });
    expect(partition(f.db)).toEqual([['a']]);
    // Unchanged, it isn't read again on the next reopen.
    expect(f.reconcile().plan.changes).toEqual([]);
  });

  it('updates only the stored numbers when the device or inode moved, with no new rev and nothing read', () => {
    const f = folder().add(message('a', ['a']));
    f.reconcile();
    const rev = asNumber(pairRow(f.db, 'a')?.rev);
    f.set('a', { dev: 42n, ino: 5 });
    const step = f.reconcile();
    expect(step.plan.changes).toMatchObject([{ refresh: true, meta: 'keep', eml: 'keep' }]);
    expect(step.applied[0]).toMatchObject({ refreshed: 1 });
    expect(asNumber(pairRow(f.db, 'a')?.rev)).toBe(rev);
    expect(
      count(
        f.db,
        "SELECT count(*) FROM pairs WHERE CAST(meta_dev AS TEXT) = '42' AND meta_ino = 5 AND eml_ino = 5",
      ),
    ).toBe(1);
    expect(f.reconcile().plan.changes).toEqual([]);
  });

  it('keeps an eml-only pair with its code, and adds its message once the metadata appears', () => {
    const f = folder().add(message('a', ['a']), { meta: null });
    const first = f.reconcile();
    expect(first.applied[0]).toMatchObject({ registered: 1 });
    expect(pairRow(f.db, 'a')).toMatchObject({
      meta_state: META_STATE.missing,
      error_code: PAIR_META_MISSING,
    });
    f.set('a', { meta: 1 });
    f.reconcile();
    expect(partition(f.db)).toEqual([['a']]);
  });
});

describe('late results', () => {
  it('drop a result whose pair changed, went or came back since it was read', () => {
    const f = folder()
      .add(message('a', ['a']))
      .add(message('b', ['b']));
    f.reconcile();
    const files = f.files('b');
    const queued = (id: string) => asNumber(pairRow(f.db, id)?.rev);

    // b changes: a result read for its old rev links it to a, and is dropped.
    const oldRev = queued('b');
    f.change(message('b', ['b'], { subject: 'v2' }));
    f.reconcile();
    const late = (rev: number) =>
      f.writer.phase1Batch(STAMP, [
        { pair: files, expectedRev: rev, row: message('b', ['b', 'a']), error: null },
      ]);
    expect(late(oldRev)).toMatchObject({ dropped: 1, messages: 0, merges: 0 });
    // Nor does a second copy of the result already written count.
    expect(late(queued('b'))).toMatchObject({ dropped: 1, messages: 0 });

    // b's files go: the result has no pair to land on.
    const beforeGone = queued('b');
    f.drop('b');
    f.reconcile();
    expect(late(beforeGone)).toMatchObject({ dropped: 1 });

    // b is deleted and found again in the same generation: a result for the
    // deleted pair's rev, or one read before it was found again, is dropped.
    f.add(message('b', ['b']));
    const scanned = f.scan();
    const plan = f.writer.planReconcile(scanned.metadata, scanned.eml);
    const reg = f.writer.applyChanges(
      STAMP,
      plan.changes.map((c) => ({ change: c, files: f.files(c.protonId) })),
    );
    const newRev = new Map(reg.revs).get('b')!;
    expect(newRev).toBeGreaterThan(beforeGone);
    expect(late(beforeGone)).toMatchObject({ dropped: 1 });
    expect(late(oldRev)).toMatchObject({ dropped: 1 });
    // No conversation changed through any of them.
    expect(partition(f.db)).toEqual([['a']]);
    expect(count(f.db, 'SELECT count(*) FROM threads')).toBe(1);
    // The result for the rev it has now is written.
    expect(late(newRev)).toMatchObject({ messages: 1, merges: 0 });
    expect(partition(f.db)).toEqual([['a', 'b']]);
  });
});

// --- Conversations ------------------------------------------------------------------

describe('conversations through reconcile', () => {
  it('merge when a linking message appears, with the counts', () => {
    const f = folder()
      .add(message('a', ['a'], { labelIds: ['0', '5'], unread: 1, time: 10 }))
      .add(message('b', ['b'], { labelIds: ['0', '5'], unread: 1, time: 20 }));
    f.reconcile();
    expect(folderCounts(f.db)).toEqual({ '0': [2, 2], '5': [2, 2] });
    f.add(message('link', ['link', 'a', 'b'], { labelIds: ['7', '5'], time: 30 }));
    const step = f.reconcile();
    expect(step.written.merges).toBe(1);
    expect(partition(f.db)).toEqual([['a', 'b', 'link']]);
    expect(folderCounts(f.db)).toEqual({ '0': [1, 1], '5': [1, 1], '7': [1, 0] });
  });

  it('split when the linking message’s metadata disappears, with the counts', () => {
    const f = folder()
      .add(message('a', ['a'], { labelIds: ['0', '5'], unread: 1, time: 10, numAttachments: 1 }))
      .add(message('b', ['b'], { labelIds: ['0', '5'], unread: 0, time: 20 }))
      .add(message('link', ['link', 'a', 'b'], { labelIds: ['7', '5'], unread: 1, time: 30 }));
    f.reconcile();
    expect(partition(f.db)).toEqual([['a', 'b', 'link']]);
    expect(folderCounts(f.db)).toEqual({ '0': [1, 1], '5': [1, 1], '7': [1, 1] });
    f.set('link', { meta: null });
    const step = f.reconcile();
    expect(step.applied[0]).toMatchObject({ removed: 1, splits: 1, regrouped: 1 });
    expect(partition(f.db)).toEqual([['a'], ['b']]);
    expect(folderCounts(f.db)).toEqual({ '0': [2, 1], '5': [2, 1] });
    const threads = f.db
      .stmt(
        'SELECT msg_count, unread_count, attach_count, first_time, last_time FROM threads ORDER BY first_time',
      )
      .all()
      .map((r) => Object.values(r).map(asNumber));
    expect(threads).toEqual([
      [1, 1, 1, 10, 10],
      [1, 0, 0, 20, 20],
    ]);
  });

  it('replace {A, C}, {B} with {A}, {B, C} when C’s metadata changes, with the counts', () => {
    const f = folder()
      .add(message('A', ['A'], { labelIds: ['0', '5'], unread: 1, time: 10 }))
      .add(message('B', ['B'], { labelIds: ['0', '5'], unread: 0, time: 20 }))
      .add(message('C', ['C', 'A'], { labelIds: ['0', '5'], unread: 0, time: 30 }));
    f.reconcile();
    expect(partition(f.db)).toEqual([['A', 'C'], ['B']]);
    const rowidC = rowidOf(f.db, 'C');
    const before = threadOfMessage(f.db, rowidC);
    f.change(message('C', ['C', 'B'], { labelIds: ['0', '5'], unread: 1, time: 30 }));
    const step = f.reconcile();
    expect(step.written).toMatchObject({ replaced: 1, messages: 1, merges: 0 });
    expect(partition(f.db)).toEqual([['A'], ['B', 'C']]);
    expect(folderCounts(f.db)).toEqual({ '0': [2, 2], '5': [2, 2] });
    // The selection follows C by its rowid, wherever it is now.
    expect(rowidOf(f.db, 'C')).toBe(rowidC);
    expect(threadOfMessage(f.db, rowidC)).toBe(threadOfMessage(f.db, rowidOf(f.db, 'B')));
    expect(threadOfMessage(f.db, rowidC)).not.toBe(before);
  });

  it('re-resolves a merged-away conversation through the rowid', () => {
    const f = folder()
      .add(message('big1', ['big', 'x1']))
      .add(message('big2', ['big', 'x2']))
      .add(message('small', ['small']));
    f.reconcile();
    const selected = rowidOf(f.db, 'small');
    const shown = threadOfMessage(f.db, selected)!;
    f.add(message('link', ['link', 'small', 'big']));
    f.reconcile();
    // The smaller conversation merged into the larger: its ID is retired.
    expect(count(f.db, `SELECT count(*) FROM threads WHERE thread_id = ${shown}`)).toBe(0);
    expect(threadOfMessage(f.db, selected)).toBe(threadOfMessage(f.db, rowidOf(f.db, 'big1')));
  });

  it('change no conversation for a late result with a stale rev', () => {
    const f = folder()
      .add(message('a', ['a']))
      .add(message('b', ['b']));
    f.reconcile();
    const stale = asNumber(pairRow(f.db, 'b')?.rev);
    f.change(message('b', ['b'], { subject: 'v2' }));
    f.reconcile();
    const threads = f.db.stmt('SELECT * FROM threads ORDER BY thread_id').all();
    const stats = f.writer.phase1Batch(STAMP, [
      { pair: f.files('b'), expectedRev: stale, row: message('b', ['b', 'a']), error: null },
    ]);
    expect(stats).toMatchObject({ dropped: 1, merges: 0, splits: 0, regrouped: 0 });
    expect(f.db.stmt('SELECT * FROM threads ORDER BY thread_id').all()).toEqual(threads);
  });

  it('count a label once per message, whether placed or grouped again', () => {
    const f = folder()
      .add(message('a', ['a'], { labelIds: ['5', '5', '0'] }))
      .add(message('b', ['b', 'a']));
    f.verify = false;
    f.reconcile();
    const perLabel = () =>
      f.db
        .stmt('SELECT label_id, msg_count FROM thread_labels ORDER BY label_id')
        .all()
        .map((r) => [String(r.label_id), asNumber(r.msg_count)]);
    expect(perLabel()).toEqual([
      ['0', 1],
      ['5', 2],
    ]);
    f.change(message('b', ['b', 'a'], { subject: 'again' }));
    f.reconcile();
    expect(perLabel()).toEqual([
      ['0', 1],
      ['5', 2],
    ]);
  });

  it('stay equal to a from-scratch grouping after every step of a long random run', () => {
    let seed = 20261126;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
    const labels = ['0', '7', '10', 'L1', 'L2'];
    const randomRow = (id: string): MessageRow =>
      message(id, [id, ...keys.filter(() => rand(6) === 0)], {
        time: rand(1000),
        unread: rand(2),
        numAttachments: rand(3) === 0 ? 1 : 0,
        labelIds: ['5', ...labels.filter(() => rand(3) === 0)],
      });
    const f = folder();
    const ids = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, '0')}`);
    for (const id of ids.slice(0, 25)) f.add(randomRow(id));
    f.reconcile();
    for (let step = 0; step < 60; step += 1) {
      for (let n = 0; n < 6; n += 1) {
        const id = ids[rand(ids.length)]!;
        const e = f.entries.get(id);
        if (!e) {
          f.add(randomRow(id), { meta: rand(4) === 0 ? null : 1 });
          continue;
        }
        switch (rand(6)) {
          case 0:
            f.change(randomRow(id));
            break;
          case 1:
            f.set(id, { meta: e.meta === null ? 1 : null });
            break;
          case 2:
            f.set(id, { eml: e.eml === null ? 1 : rand(2) ? null : e.eml + 1 });
            break;
          case 3:
            f.drop(id);
            break;
          case 4:
            f.set(id, { row: null, meta: (e.meta ?? 0) + 1 });
            break;
          default:
            f.set(id, { row: randomRow(id), meta: (e.meta ?? 0) + 1 });
        }
      }
      // Checked inside after every transaction; the partition as a whole here.
      f.reconcile();
      expect(partition(f.db)).toEqual(expected([...f.indexed.values()]));
      let present = 0;
      for (const [id, e] of f.entries) {
        const p = pairRow(f.db, id);
        if (e.meta === null && e.eml === null) {
          expect(p, id).toBeUndefined();
          continue;
        }
        present += 1;
        expect(p, id).toBeDefined();
        expect(asNumber(p?.meta_state), id).toBe(
          e.meta === null ? META_STATE.missing : e.row ? META_STATE.indexed : META_STATE.failed,
        );
        expect(asNumber(p?.body_state), id).toBe(
          e.eml === null ? BODY_STATE.emlMissing : BODY_STATE.pending,
        );
      }
      expect(count(f.db, 'SELECT count(*) FROM pairs')).toBe(present);
      expect(f.reconcile().plan.changes).toEqual([]);
    }
    const revs = f.db
      .stmt('SELECT rev FROM pairs')
      .all()
      .map((r) => asNumber(r.rev));
    expect(new Set(revs).size).toBe(revs.length);
  });
});

describe('labels.json', () => {
  it('is recorded by name, size and time, not by device or inode', () => {
    const a = stat('labels', 'meta', 1);
    expect(labelsStatOf(a)).toBe(labelsStatOf({ ...a, dev: 99n, ino: 2n }));
    expect(labelsStatOf(a)).not.toBe(labelsStatOf({ ...a, size: 1 }));
    expect(labelsStatOf(a)).not.toBe(labelsStatOf({ ...a, mtimeNs: a.mtimeNs + 1n }));
  });

  it('comes back from the plan as stored, and goes with the labels when the file is gone', () => {
    const { db, writer } = fresh();
    const empty = new Map<string, FileStat>();
    expect(writer.planReconcile(empty, empty).labelsStat).toBeNull();
    const recorded = labelsStatOf(stat('labels', 'meta', 1));
    writer.writeLabels(
      STAMP,
      [
        {
          id: 'L1',
          name: 'Work',
          path: 'Work',
          parentId: null,
          color: null,
          type: 1,
          kind: 'label',
        },
      ],
      recorded,
    );
    expect(writer.planReconcile(empty, empty).labelsStat).toBe(recorded);
    writer.writeLabels(STAMP, [], null);
    expect(writer.planReconcile(empty, empty).labelsStat).toBeNull();
    expect(count(db, 'SELECT count(*) FROM labels')).toBe(0);
    db.close();
  });
});
