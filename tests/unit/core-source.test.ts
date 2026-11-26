// SPDX-License-Identifier: AGPL-3.0-or-later
// Core's side of a source: work is stamped with the source and generation core
// started with, requests for another stamp are refused, and the scan's results
// go through the writer.

import { realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SourceSession } from '../../src/core/source';
import { runIdentity } from '../../src/core/identity';
import type { CoreResult } from '../../src/shared/core-protocol';
import type { Logger } from '../../src/shared/log/writer';
import { writeExport } from '../exports';
import { testDir } from '../paths';

const KEY = '01234567-89ab-cdef-0123-456789abcdef';

function session(root: string | null, generation = 3) {
  const replies: CoreResult[] = [];
  const lines: Array<{ code: string; data: unknown }> = [];
  const push = (code: string, data?: unknown) => lines.push({ code, data });
  const log: Logger = { log: (_l, c, d) => push(c, d), error: push, warn: push, info: push };
  const s = new SourceSession({ sourceKey: KEY, generation, root }, log, (r) => replies.push(r));
  const next = async () => {
    for (let i = 0; i < 100 && replies.length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 5));
    return replies.shift();
  };
  return { s, replies, lines, next };
}

describe('SourceSession', () => {
  it('answers identify and scan with the stamp it was started with', async () => {
    const written = writeExport(realpathSync(testDir('core-src')), { seed: 1, messages: 6 });
    symlinkSync(join(written.run, 'labels.json'), join(written.run, 'x.eml'));
    const t = session(written.run);
    const stamp = { sourceKey: KEY, generation: 3 };

    t.s.handle({ type: 'identify', reqId: 1, stamp });
    expect(await t.next()).toEqual({
      type: 'result',
      reqId: 1,
      ok: true,
      stamp,
      identity: await runIdentity(written.run),
    });

    t.s.handle({ type: 'scan', reqId: 2, stamp });
    const scanned = await t.next();
    expect(scanned).toMatchObject({ reqId: 2, ok: true, stamp, scan: { pairs: 6, labels: true } });
    expect(scanned?.ok && scanned.scan?.rejected.symlink).toBe(1);
    expect(t.s.records).toMatchObject({ scans: 1, rejected: [{ rel: 'x.eml', kind: 'symlink' }] });
    expect(t.lines.map((l) => l.code)).toEqual(['scan.done', 'scan.rejected']);
    expect(t.lines[1]?.data).toEqual({ reason: 'symlink', count: 1 });
  });

  it('refuses a request for another source or generation', async () => {
    const written = writeExport(realpathSync(testDir('core-src-stale')), { seed: 1, messages: 2 });
    const t = session(written.run);
    t.s.handle({ type: 'scan', reqId: 1, stamp: { sourceKey: KEY, generation: 2 } });
    expect(await t.next()).toEqual({
      type: 'result',
      reqId: 1,
      ok: false,
      code: 'stale',
      stamp: { sourceKey: KEY, generation: 3 },
    });
    t.s.handle({ type: 'identify', reqId: 2, stamp: { sourceKey: 'other', generation: 3 } });
    expect(await t.next()).toMatchObject({ reqId: 2, ok: false, code: 'stale' });
    expect(t.s.records.scans).toBe(0);
  });

  it('has no root while the run is unavailable, and when it was started without a source', async () => {
    const missing = join(realpathSync(testDir('core-src-missing')), 'gone');
    const offline = session(missing);
    expect(offline.s.hasRoot).toBe(false);
    expect(offline.lines.map((l) => l.code)).toEqual(['source.unavailable']);
    offline.s.handle({ type: 'scan', reqId: 1, stamp: { sourceKey: KEY, generation: 3 } });
    expect(await offline.next()).toEqual({
      type: 'result',
      reqId: 1,
      ok: false,
      code: 'unavailable',
    });

    const replies: CoreResult[] = [];
    const none = new SourceSession(null, { log() {}, error() {}, warn() {}, info() {} }, (r) =>
      replies.push(r),
    );
    none.handle({ type: 'identify', reqId: 1, stamp: { sourceKey: KEY, generation: 1 } });
    expect(replies).toEqual([{ type: 'result', reqId: 1, ok: false, code: 'no_source' }]);
    expect(none.gate.current).toBeNull();
  });

  it('takes no root that resolves anywhere but itself', async () => {
    const written = writeExport(realpathSync(testDir('core-src-link')), { seed: 1, messages: 2 });
    const via = join(realpathSync(testDir('core-src-link-via')), 'run');
    symlinkSync(written.run, via);
    const t = session(via);
    expect(t.s.hasRoot).toBe(false);
    expect(t.lines.map((l) => l.code)).toEqual(['source.unavailable']);
    expect(session(written.run).s.hasRoot).toBe(true);
  });

  it('reports a run that went away during the work as unavailable', async () => {
    const written = writeExport(realpathSync(testDir('core-src-vanish')), { seed: 1, messages: 2 });
    const t = session(written.run);
    rmSync(written.run, { recursive: true });
    t.s.handle({ type: 'scan', reqId: 1, stamp: { sourceKey: KEY, generation: 3 } });
    expect(await t.next()).toMatchObject({ reqId: 1, ok: false, code: 'unavailable' });
  });
});

describe('generated exports for the same-run check', () => {
  it('can share run name, account and labels.json and still differ in identity', async () => {
    const a = writeExport(realpathSync(testDir('same-run-a')), { seed: 1 });
    const b = writeExport(realpathSync(testDir('same-run-b')), {
      seed: 2,
      account: a.account,
      labelsSeed: 1,
    });
    expect([b.account, b.runName]).toEqual([a.account, a.runName]);
    const [ia, ib] = [await runIdentity(a.run), await runIdentity(b.run)];
    expect(ib.labelsSha256).toBe(ia.labelsSha256);
    expect(ib.metadataNames).toBe(ia.metadataNames);
    expect(ib.namesSha256).not.toBe(ia.namesSha256);
  });
});
