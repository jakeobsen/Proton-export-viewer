// SPDX-License-Identifier: AGPL-3.0-or-later
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { Pool, TIMEOUT, THREAD_EXIT, WorkerThread } from '../../src/core/index/pool';

// A stand-in for the index's thread script: answers with its thread ID, never
// answers 'hang', and ends its thread on 'crash'.
const SCRIPT = `
const { parentPort, threadId } = require('node:worker_threads');
parentPort.on('message', (r) => {
  if (r.op === 'hang') return;
  if (r.op === 'crash') process.exit(1);
  if (r.op === 'fail') return parentPort.postMessage({ id: r.id, ok: false, error: 'META_JSON' });
  parentPort.postMessage({ id: r.id, ok: true, data: { threadId, args: r.args } });
});
`;

const threads: WorkerThread[] = [];
function thread(): WorkerThread {
  const t = new WorkerThread(() => new Worker(SCRIPT, { eval: true }));
  threads.push(t);
  return t;
}

afterEach(async () => {
  await Promise.all(threads.splice(0).map((t) => t.stop()));
});

describe('index threads', () => {
  it('answers calls and passes failures on by code', async () => {
    const t = thread();
    await expect(t.call('echo', { a: 1 })).resolves.toMatchObject({ args: { a: 1 } });
    await expect(t.call('fail')).rejects.toMatchObject({ code: 'META_JSON' });
  });

  it('ends a job past its limit and starts a new thread in its place', async () => {
    const t = thread();
    let respawned = 0;
    t.onRespawn = () => (respawned += 1);
    const first = await t.call<{ threadId: number }>('echo');
    const started = performance.now();
    await expect(t.call('hang', {}, 200)).rejects.toMatchObject({ code: TIMEOUT });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(t.respawns).toBe(1);
    expect(respawned).toBe(1);
    const next = await t.call<{ threadId: number }>('echo');
    expect(next.threadId).not.toBe(first.threadId);
  });

  it('replaces a thread that ends, failing what it had', async () => {
    const t = thread();
    await expect(t.call('crash')).rejects.toMatchObject({ code: THREAD_EXIT });
    expect(t.respawns).toBe(1);
    await expect(t.call('echo')).resolves.toBeTruthy();
  });

  it('runs pool jobs first come first served, and a timeout costs only its thread', async () => {
    const pool = new Pool([thread(), thread()]);
    const results = await Promise.allSettled([
      pool.run('hang', {}, 200),
      pool.run('echo', { n: 1 }, 1000),
      pool.run('echo', { n: 2 }, 1000),
      pool.run('echo', { n: 3 }, 1000),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(pool.respawns).toBe(1);
    await pool.stop();
  });
});
