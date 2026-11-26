// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader lane: one job at a time, a wall-clock limit from dispatch, a heap
// limit, and a new worker after a breach.

import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { ReaderLane, type Breach } from '../../src/core/reader/lane';

type In = { type: string; reqId?: number; ms?: number };
type Out = { type: string; reqId?: number; threadId?: number };

// A stand-in for the reader worker, with one behaviour per message type.
const WORKER = `
const { parentPort, threadId } = require('node:worker_threads');
const held = [];
let spins = 0;
parentPort.on('message', (m) => {
  if (m.type === 'echo') parentPort.postMessage({ type: 'done', reqId: m.reqId, threadId });
  if (m.type === 'slow') setTimeout(() => parentPort.postMessage({ type: 'done', reqId: m.reqId, threadId }), m.ms);
  if (m.type === 'spin') for (;;) spins += 1;
  if (m.type === 'heap') for (;;) held.push(new Array(100000).fill(spins));
  if (m.type === 'crash') process.exit(70);
  if (m.type === 'note') parentPort.postMessage({ type: 'log' });
});
`;

const lanes: Array<ReaderLane<In, Out>> = [];

function lane(options: { timeoutMs?: number; heapMb?: number } = {}) {
  const events = {
    spawns: 0,
    breaches: [] as Array<[Breach, number]>,
    other: [] as Out[],
    exits: [] as number[],
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
    onExit: (code) => events.exits.push(code),
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

  it('drops queued jobs for a key when a newer job for it arrives', async () => {
    const { lane: l } = lane();
    const running = l.job(req('slow', { ms: 150 }), 1);
    const older = l.job(req('echo'), 2);
    const other = l.job(req('echo'), 3);
    const newer = l.job(req('echo'), 2);
    expect(await older).toEqual({ ok: false, reason: 'superseded' });
    expect((await running).ok).toBe(true);
    expect((await other).ok).toBe(true);
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

  it('uses new limits from the next worker on', async () => {
    const { lane: l, events } = lane({ heapMb: 512, timeoutMs: 20_000 });
    await l.setLimits({ heapMb: 32, timeoutMs: 300 });
    expect(await l.job(req('spin'))).toEqual({ ok: false, reason: 'timeout' });
    expect(await l.job(req('heap'))).toEqual({ ok: false, reason: 'limit' });
    expect(events.breaches.map(([b]) => b)).toEqual(['timeout', 'limit']);
  });
});
