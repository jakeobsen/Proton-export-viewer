// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { RecentJobs } from '../../src/main/sources/recent-jobs';
import type { CoreResult } from '../../src/shared/core-protocol';
import type { RecentJob } from '../../src/shared/recent-search';
import { searchKey } from '../../src/shared/search-chips';
import type { Stamp } from '../../src/shared/sources';

const SRC = '00000000-0000-4000-8000-0000000000aa';
const q = (text: string) => searchKey({ text, chips: [] });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Main's side with a core whose answers the test gives, one sent job at a time. */
function harness(registry: { keep?: boolean; owed?: boolean } = {}) {
  let generation = 1;
  const reg = { keep: registry.keep ?? true, owed: registry.owed ?? false };
  const events: string[] = [];
  const sent: Array<{ job: RecentJob; answer: (r: CoreResult) => void; fail: () => void }> = [];
  const logs: Array<[string, unknown]> = [];
  const log = {
    info: (code: string, data?: unknown) => logs.push([code, data]),
    warn: (code: string, data?: unknown) => logs.push([code, data]),
    error: (code: string, data?: unknown) => logs.push([code, data]),
  };
  const jobs = new RecentJobs({
    log: log as never,
    generation: () => generation,
    send: (_stamp, job) =>
      new Promise<CoreResult>((resolve, reject) => {
        events.push(`send ${job.op}${job.op === 'record' ? ` ${JSON.parse(job.q).text}` : ''}`);
        sent.push({ job, answer: resolve, fail: () => reject(new Error('gone')) });
      }),
    keeps: () => reg.keep,
    owes: () => reg.owed,
    clearOwed: () => {
      events.push('save owed=false');
      reg.owed = false;
    },
  });
  const stamp = (): Stamp => ({ sourceKey: SRC, generation });
  const ok = (job: RecentJob): CoreResult => ({
    type: 'result',
    reqId: 0,
    ok: true,
    recent:
      job.op === 'record'
        ? { op: 'record', invalid: 0 }
        : job.op === 'list'
          ? { op: 'list', rows: [{ q: q('old'), at: 1 }], invalid: 0 }
          : { op: 'wipe', deleted: 1 },
  });
  /** Answers the oldest sent job that has no answer yet. */
  const answer = async (result?: CoreResult) => {
    const next = sent.shift()!;
    next.answer(result ?? ok(next.job));
    await flush();
  };
  const failed: CoreResult = { type: 'result', reqId: 0, ok: false, code: 'unavailable' };
  const bump = () => {
    generation += 1;
    jobs.settle();
  };
  const activate = () => {
    jobs.activated(stamp());
    if (!reg.keep || reg.owed) void jobs.wipe(stamp());
  };
  return { jobs, reg, events, sent, logs, stamp, answer, failed, bump, activate };
}

describe('recent searches in main', () => {
  it('sends jobs one at a time, in the order received, once the index is open', async () => {
    const h = harness();
    h.activate();
    h.jobs.record(h.stamp(), q('a'), 1);
    const list = h.jobs.list(h.stamp());
    h.jobs.record(h.stamp(), q('b'), 2);
    await flush();
    expect(h.events).toEqual([]);
    h.jobs.ready(h.stamp());
    await flush();
    expect(h.events).toEqual(['send record a']);
    await h.answer();
    expect(h.events).toEqual(['send record a', 'send list']);
    await h.answer();
    expect(await list).toEqual([{ text: 'old', chips: [] }]);
    expect(h.events.at(-1)).toBe('send record b');
  });

  it('drops a recording made while the switch is off, and reads nothing without asking core', async () => {
    const h = harness({ keep: false });
    h.activate();
    h.jobs.ready(h.stamp());
    h.jobs.record(h.stamp(), q('a'), 1);
    expect(await h.jobs.list(h.stamp())).toEqual([]);
    await flush();
    expect(h.events).toEqual(['send wipe']);
    expect(h.logs).toContainEqual(['recent.dropped', { reason: 'off' }]);
  });

  it('settles every job of an older generation at the bump', async () => {
    const h = harness();
    h.activate();
    h.jobs.ready(h.stamp());
    h.jobs.record(h.stamp(), q('held'), 1);
    const list = h.jobs.list(h.stamp());
    const clear = h.jobs.wipe(h.stamp());
    await flush();
    expect(h.events).toEqual(['send record held']);
    h.bump();
    expect(await list).toEqual([]);
    expect(await clear).toBe('stale');
    expect(h.jobs.size).toBe(0);
    expect(h.logs).toContainEqual(['recent.dropped', { reason: 'stale' }]);
    // The old answer comes late and changes nothing; the new activation's jobs go.
    h.activate();
    h.jobs.ready(h.stamp());
    h.jobs.record(h.stamp(), q('new'), 2);
    await flush();
    expect(h.events.at(-1)).toBe('send record new');
    await h.answer();
    expect(h.events.at(-1)).toBe('send record new');
  });

  it('keeps a job whose core is gone at the head until the bump', async () => {
    const h = harness();
    h.activate();
    h.jobs.ready(h.stamp());
    const clear = h.jobs.wipe(h.stamp());
    await flush();
    h.sent.shift()!.fail();
    await flush();
    expect(h.jobs.size).toBe(1);
    h.bump();
    expect(await clear).toBe('stale');
  });

  it('ends the jobs of an activation with no index', async () => {
    const h = harness({ owed: true });
    h.activate();
    const clear = h.jobs.wipe(h.stamp());
    h.jobs.noIndex(h.stamp());
    expect(await clear).toBe('failed');
    expect(h.reg.owed).toBe(true);
    expect(h.events).toEqual([]);
  });
});

describe('the owed wipe', () => {
  it('is cleared only by the last wipe enqueued, and saved before the next job is sent', async () => {
    const h = harness();
    h.activate();
    h.jobs.ready(h.stamp());
    // Off, On, Off: two wipes, with a recording queued behind each.
    h.reg.keep = false;
    h.reg.owed = true;
    const first = h.jobs.wipe(h.stamp());
    h.reg.keep = true;
    h.jobs.record(h.stamp(), q('after-on'), 1);
    h.reg.keep = false;
    const second = h.jobs.wipe(h.stamp());
    h.reg.keep = true;
    h.jobs.record(h.stamp(), q('after-second'), 2);
    await flush();
    await h.answer();
    expect(await first).toBe('ok');
    // Not the last wipe: still owed, so the recording behind it is dropped.
    expect(h.reg.owed).toBe(true);
    expect(h.events).toEqual(['send wipe', 'send wipe']);
    await h.answer();
    expect(await second).toBe('ok');
    expect(h.events).toEqual([
      'send wipe',
      'send wipe',
      'save owed=false',
      'send record after-second',
    ]);
    expect(h.logs).toContainEqual(['recent.dropped', { reason: 'wipe_owed' }]);
  });

  it('stays owed after a wipe that fails, and the gate stays closed', async () => {
    const h = harness({ owed: true });
    h.activate();
    h.jobs.ready(h.stamp());
    const list = h.jobs.list(h.stamp());
    h.jobs.record(h.stamp(), q('behind'), 1);
    expect(await list).toEqual([]);
    await flush();
    await h.answer(h.failed);
    expect(h.reg.owed).toBe(true);
    expect(h.events).toEqual(['send wipe']);
    expect(h.logs).toContainEqual(['recent.wipe_failed', {}]);
    // Afterwards: a read finds nothing without core, a recording is dropped at once.
    expect(await h.jobs.list(h.stamp())).toEqual([]);
    h.jobs.record(h.stamp(), q('later'), 2);
    await flush();
    expect(h.events).toEqual(['send wipe']);
    // A Clear is a wipe: its ok opens the gate.
    const clear = h.jobs.wipe(h.stamp());
    await flush();
    await h.answer();
    expect(await clear).toBe('ok');
    expect(h.reg.owed).toBe(false);
    h.jobs.record(h.stamp(), q('open'), 3);
    await flush();
    expect(h.events.at(-1)).toBe('send record open');
  });

  it('is paid first by the next activation, whatever the switch says', async () => {
    const h = harness();
    h.activate();
    h.jobs.ready(h.stamp());
    h.reg.keep = false;
    h.reg.owed = true;
    const off = h.jobs.wipe(h.stamp());
    h.reg.keep = true;
    await flush();
    // Core exits with the wipe in it: the bump drops it, and it stays owed.
    h.sent.shift();
    h.bump();
    expect(await off).toBe('stale');
    expect(h.reg.owed).toBe(true);
    h.activate();
    h.jobs.record(h.stamp(), q('first'), 1);
    const list = h.jobs.list(h.stamp());
    h.jobs.ready(h.stamp());
    await flush();
    expect(await list).toEqual([]);
    expect(h.events.slice(-1)).toEqual(['send wipe']);
    await h.answer();
    expect(h.events.slice(-2)).toEqual(['save owed=false', 'send record first']);
  });

  it('answers a read while the wipe is held at once, with nothing', async () => {
    const h = harness();
    h.activate();
    h.jobs.ready(h.stamp());
    h.reg.keep = false;
    h.reg.owed = true;
    void h.jobs.wipe(h.stamp());
    h.reg.keep = true;
    await flush();
    expect(await h.jobs.list(h.stamp())).toEqual([]);
    expect(h.events).toEqual(['send wipe']);
  });
});
