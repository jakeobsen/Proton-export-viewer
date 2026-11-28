// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Pool,
  THREAD_STOPPED,
  ThreadError,
  TIMEOUT,
  THREAD_EXIT,
  WorkerThread,
} from '../../src/core/index/pool';
import { testDir } from '../paths';

// A stand-in for the index's thread script: answers with its thread ID, never
// answers 'hang', ends its thread on 'crash', and on 'inflight' starts a read
// of the descriptor it is given that never answers.
const SCRIPT = `
const { parentPort, threadId } = require('node:worker_threads');
const { read } = require('node:fs');
parentPort.on('message', (r) => {
  if (r.op === 'hang') return;
  if (r.op === 'crash') process.exit(1);
  if (r.op === 'inflight') return read(r.args.fd, Buffer.alloc(1), 0, 1, null, () => {});
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

/** A FIFO, open for reading and writing so that neither end blocks; a read waits for a write. */
const fifos: number[] = [];
function fifo(name: string): { fd: number; release: () => void } {
  const path = join(testDir(name), 'fifo');
  const made = spawnSync('/usr/bin/mkfifo', ['-m', '0600', path]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${String(made.stderr)}`);
  const fd = openSync(path, constants.O_RDWR);
  fifos.push(fd);
  return { fd, release: () => void writeSync(fd, 'x') };
}

/** Whether `p` has settled within `ms`. */
const settledWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

async function lost(call: Promise<unknown>): Promise<ThreadError> {
  const err = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ThreadError);
  return err as ThreadError;
}

afterEach(async () => {
  // Reads still waiting end first, so no thread waits on one after a failed test.
  for (const fd of fifos) writeSync(fd, 'x'.repeat(64));
  await Promise.all(threads.splice(0).map((t) => t.stop()));
  for (const fd of fifos.splice(0)) closeSync(fd);
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

  it('says when the thread that lost a call has exited: after its read under way, each its own', async () => {
    const t = thread();
    const first = fifo('pool-exit-first');
    const second = fifo('pool-exit-second');
    const a = await lost(t.call('inflight', { fd: first.fd }, 200));
    expect(a.code).toBe(TIMEOUT);
    expect(a.exited).toBeInstanceOf(Promise);
    // The thread was told to end, but its read is still under way.
    expect(await settledWithin(a.exited!, 400)).toBe(false);
    // Its replacement answers meanwhile, and loses a call of its own.
    await expect(t.call('echo')).resolves.toBeTruthy();
    const b = await lost(t.call('inflight', { fd: second.fd }, 200));
    expect(b.code).toBe(TIMEOUT);
    expect(await settledWithin(b.exited!, 300)).toBe(false);
    // Each exit follows its own read: the second thread goes first.
    second.release();
    expect(await settledWithin(b.exited!, 2000)).toBe(true);
    expect(await settledWithin(a.exited!, 100)).toBe(false);
    first.release();
    expect(await settledWithin(a.exited!, 2000)).toBe(true);
    expect(t.respawns).toBe(2);
  });

  it('gives the exit with a crash and with a stop, and none for a call no thread took', async () => {
    const t = thread();
    const crashed = await lost(t.call('crash'));
    expect(crashed.code).toBe(THREAD_EXIT);
    expect(await settledWithin(crashed.exited!, 100)).toBe(true);
    const held = fifo('pool-exit-stop');
    const taken = lost(t.call('inflight', { fd: held.fd }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopping = t.stop();
    const stopped = await taken;
    expect(stopped.code).toBe(THREAD_STOPPED);
    expect(await settledWithin(stopped.exited!, 300)).toBe(false);
    held.release();
    await stopping;
    expect(await settledWithin(stopped.exited!, 100)).toBe(true);
    // Refused before any thread took it.
    const refused = await lost(t.call('echo'));
    expect(refused.code).toBe(THREAD_STOPPED);
    expect(refused.exited).toBeUndefined();

    const pool = new Pool([thread()]);
    const busy = pool.run('hang', {}, 0);
    const queued = lost(pool.run('echo', {}, 0));
    const stopPool = pool.stop();
    expect((await queued).exited).toBeUndefined();
    expect((await lost(busy)).exited).toBeInstanceOf(Promise);
    await stopPool;
    expect((await lost(pool.run('echo', {}, 0))).exited).toBeUndefined();
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
