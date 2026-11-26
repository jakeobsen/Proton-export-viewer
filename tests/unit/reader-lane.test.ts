// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader lane: one job at a time, a wall-clock limit from dispatch, a heap
// limit, and a new worker after a breach or after a job that left it holding
// too much.

import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { ReaderLane, type Breach } from '../../src/core/reader/lane';

type In = { type: string; reqId?: number; ms?: number; held?: number };
type Out = { type: string; reqId?: number; threadId?: number; held?: number };

// A stand-in for the reader worker, with one behaviour per message type.
const WORKER = `
const { parentPort, threadId } = require('node:worker_threads');
const held = [];
let spins = 0;
parentPort.on('message', (m) => {
  if (m.type === 'echo') parentPort.postMessage({ type: 'done', reqId: m.reqId, threadId });
  if (m.type === 'held') parentPort.postMessage({ type: 'done', reqId: m.reqId, threadId, held: m.held });
  if (m.type === 'slow') setTimeout(() => parentPort.postMessage({ type: 'done', reqId: m.reqId, threadId }), m.ms);
  if (m.type === 'spin') for (;;) spins += 1;
  if (m.type === 'heap') for (;;) held.push(new Array(100000).fill(spins));
  if (m.type === 'crash') process.exit(70);
  if (m.type === 'note') parentPort.postMessage({ type: 'log' });
});
`;

const lanes: Array<ReaderLane<In, Out>> = [];

function lane(
  options: { timeoutMs?: number; heapMb?: number; retire?: (message: Out) => boolean } = {},
) {
  const events = {
    spawns: 0,
    breaches: [] as Array<[Breach, number]>,
    other: [] as Out[],
    exits: [] as number[],
    planned: [] as number[],
    retired: [] as Out[],
  };
  const l = new ReaderLane<In, Out>({
    spawn: (heapMb) =>
      new Worker(WORKER, { eval: true, resourceLimits: { maxOldGenerationSizeMb: heapMb } }),
    timeoutMs: options.timeoutMs ?? 1000,
    heapMb: options.heapMb ?? 64,
    onSpawn: () => {
      events.spawns += 1;
    },
    onBreach: (breach, ms) => events.breaches.push([breach, ms]),
    onOther: (message) => events.other.push(message),
    onExit: (code, planned) => {
      events.exits.push(code);
      if (planned) events.planned.push(code);
    },
    retire: options.retire,
    onRetire: (message) => events.retired.push(message),
  });
  lanes.push(l);
  return { lane: l, events };
}

afterEach(async () => {
  for (const l of lanes.splice(0)) await l.stop();
});

let next = 0;
const req = (type: string, extra: Partial<In> = {}): In => {
  next += 1;
  return { type, reqId: next, ...extra };
};

describe('the reader lane', () => {
  it('answers a job with the reply that carries its reqId', async () => {
    const { lane: l } = lane();
    const message = req('echo');
    const outcome = await l.job(message);
    expect(outcome).toMatchObject({ ok: true, message: { type: 'done', reqId: message.reqId } });
  });

  it('ends a job that runs past the wall-clock limit, and the next job runs on a new worker', async () => {
    const { lane: l, events } = lane({ timeoutMs: 300 });
    const first = await l.job(req('echo'));
    const started = Date.now();
    expect(await l.job(req('spin'))).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(events.breaches.map(([b]) => b)).toEqual(['timeout']);
    const after = await l.job(req('echo'));
    expect(after.ok).toBe(true);
    const threadOf = (o: typeof first) => (o.ok ? o.message.threadId : undefined);
    expect(threadOf(after)).not.toBe(threadOf(first));
    expect(events.spawns).toBe(2);
    // An exit after a breach is not one the lane planned.
    await expect.poll(() => events.exits).toHaveLength(1);
    expect(events.planned).toEqual([]);
  });

  it('ends a job that runs out of heap as a limit breach, and the next job works', async () => {
    const { lane: l, events } = lane({ heapMb: 32, timeoutMs: 20_000 });
    expect(await l.job(req('heap'))).toEqual({ ok: false, reason: 'limit' });
    expect(events.breaches.map(([b]) => b)).toEqual(['limit']);
    expect((await l.job(req('echo'))).ok).toBe(true);
  });

  it('fails the running job when the worker exits, and the next job works', async () => {
    const { lane: l, events } = lane();
    expect(await l.job(req('crash'))).toEqual({ ok: false, reason: 'crash' });
    expect(events.exits).toContain(70);
    expect(events.planned).toEqual([]);
    expect(events.breaches).toEqual([]);
    expect((await l.job(req('echo'))).ok).toBe(true);
  });

  it('runs one job at a time, each limit counted from when the job reaches the worker', async () => {
    const { lane: l } = lane({ timeoutMs: 400 });
    // Together they take longer than one limit; each alone fits.
    const jobs = [l.job(req('slow', { ms: 250 })), l.job(req('slow', { ms: 250 }))];
    expect(l.queued).toBe(1);
    const outcomes = await Promise.all(jobs);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
  });

  it('drops queued jobs of a key when a newer job of it arrives', async () => {
    const { lane: l } = lane();
    const running = l.job(req('slow', { ms: 150 }), { key: 1, order: 1 });
    const older = l.job(req('echo'), { key: 2, order: 1 });
    const other = l.job(req('echo'), { key: 3, order: 1 });
    const newer = l.job(req('echo'), { key: 2, order: 2 });
    expect(await older).toEqual({ ok: false, reason: 'superseded' });
    expect((await running).ok).toBe(true);
    expect((await other).ok).toBe(true);
    expect((await newer).ok).toBe(true);
  });

  it('never lets an older job drop a newer one that arrived first', async () => {
    const { lane: l } = lane();
    // The worker is busy; the newer job queues before the older one arrives.
    const busy = l.job(req('slow', { ms: 200 }), { key: 9, order: 1 });
    const newer = l.job(req('echo'), { key: 1, order: 3 });
    const older = l.job(req('echo'), { key: 1, order: 2 });
    expect(await older).toEqual({ ok: false, reason: 'superseded' });
    expect(l.queued).toBe(1);
    expect((await newer).ok).toBe(true);
    expect((await busy).ok).toBe(true);
  });

  it('drops a job older than the running one of its key, and keeps a newer one', async () => {
    const { lane: l } = lane();
    const running = l.job(req('slow', { ms: 200 }), { key: 1, order: 5 });
    expect(await l.job(req('echo'), { key: 1, order: 4 })).toEqual({
      ok: false,
      reason: 'superseded',
    });
    const newer = l.job(req('echo'), { key: 1, order: 6 });
    expect((await running).ok).toBe(true);
    expect((await newer).ok).toBe(true);
  });

  it('answers calls outside the queue, and passes other messages on', async () => {
    const { lane: l, events } = lane();
    const slow = l.job(req('slow', { ms: 300 }));
    const call = req('echo') as In & { reqId: number };
    const replied = await l.call(call);
    expect(replied).toMatchObject({ type: 'done', reqId: call.reqId });
    l.post({ type: 'note' });
    await expect.poll(() => events.other).toEqual([{ type: 'log' }]);
    expect((await slow).ok).toBe(true);
  });

  it('reports the heap of the current worker, and null without one', async () => {
    const { lane: l } = lane();
    expect(await l.heapStatistics()).toBeNull();
    expect(await l.job(req('echo'))).toMatchObject({ ok: true });
    expect((await l.heapStatistics())?.used_heap_size).toBeGreaterThan(0);
  });

  it('reports null for a worker that has ended, or that ends before it answers', async () => {
    const stand = (getHeapStatistics: () => Promise<unknown>) =>
      Object.assign(new EventEmitter(), {
        threadId: 1,
        postMessage: () => undefined,
        terminate: () => Promise.resolve(1),
        getHeapStatistics,
      });
    // One refuses, as a worker that ran out of heap does until its exit event;
    // the other never answers, and then exits.
    const refusing = stand(() =>
      Promise.reject(Object.assign(new Error('not running'), { code: 'ERR_WORKER_NOT_RUNNING' })),
    );
    const silent = stand(() => new Promise(() => undefined));
    for (const worker of [refusing, silent]) {
      const l = new ReaderLane<In, Out>({
        spawn: () => worker as unknown as Worker,
        timeoutMs: 1000,
        heapMb: 64,
      });
      lanes.push(l);
      l.post(req('echo'));
      const stats = l.heapStatistics();
      if (worker === silent) worker.emit('exit', 1);
      expect(await stats).toBeNull();
    }
  });

  it('replaces a worker that a job left holding too much, once the reply is in', async () => {
    const { lane: l, events } = lane({ retire: (message) => (message.held ?? 0) > 100 });
    const threadOf = (o: Awaited<ReturnType<typeof l.job>>) => (o.ok ? o.message.threadId : -1);
    const first = await l.job(req('held', { held: 10 }));
    const kept = await l.job(req('held', { held: 100 }));
    expect(threadOf(kept)).toBe(threadOf(first));
    expect(events.spawns).toBe(1);

    const heavy = await l.job(req('held', { held: 101 }));
    expect(heavy).toMatchObject({ ok: true, message: { held: 101 } });
    expect(threadOf(heavy)).toBe(threadOf(first));
    expect(events.retired).toMatchObject([{ held: 101 }]);
    // The next worker is started at once, and the next job runs on it.
    expect(events.spawns).toBe(2);
    expect(l.describe().threadId).not.toBe(threadOf(first));
    const after = await l.job(req('echo'));
    expect(threadOf(after)).toBe(l.describe().threadId);
    await expect.poll(() => events.exits).toHaveLength(1);
    // The lane ended a sound worker on purpose: a planned exit.
    expect(events.planned).toEqual(events.exits);
    expect(events.breaches).toEqual([]);
  });

  it('runs a job queued behind the one that retires its worker on the new worker', async () => {
    const { lane: l } = lane({ retire: (message) => (message.held ?? 0) > 100 });
    const heavy = l.job(req('held', { held: 500 }));
    const queued = l.job(req('echo'));
    const [h, q] = await Promise.all([heavy, queued]);
    expect(h.ok && q.ok).toBe(true);
    if (h.ok && q.ok) expect(q.message.threadId).not.toBe(h.message.threadId);
  });

  it('uses new limits from the next worker on', async () => {
    const { lane: l, events } = lane({ heapMb: 512, timeoutMs: 20_000 });
    await l.setLimits({ heapMb: 32, timeoutMs: 300 });
    expect(await l.job(req('spin'))).toEqual({ ok: false, reason: 'timeout' });
    expect(await l.job(req('heap'))).toEqual({ ok: false, reason: 'limit' });
    expect(events.breaches.map(([b]) => b)).toEqual(['timeout', 'limit']);
  });
});
