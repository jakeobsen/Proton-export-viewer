// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 2's descriptors: core opens each message file within the job's time
// limit and lends it to a pool thread; a file is closed at once after a reply
// or a refusal before any thread took the job, and only once the thread has
// exited when a thread was ended with the job, since a read it had under way
// finishes before that exit. Repeated timeouts hold no more than the cap.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { openContainedAsync, scanRun, type FileRef } from '../../src/core/containment';
import { BodyFiles } from '../../src/core/index/body-files';
import {
  THREAD_STOPPED,
  ThreadError,
  WorkerThread,
  type IndexThread,
  type ThreadRole,
} from '../../src/core/index/pool';
import { IndexService, type IndexOptions } from '../../src/core/index/service';
import { BODY_STATE } from '../../src/core/index/schema';
import { openDb } from '../../src/core/index/sql';
import type { Logger } from '../../src/shared/log/writer';
import { writeExport } from '../exports';
import { InlineThread, STAMP } from '../index-helpers';
import { testDir } from '../paths';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether `p` has settled within `ms`. */
const settledWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    delay(ms).then(() => false),
  ]);

async function until(test: () => boolean, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!test()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await delay(10);
  }
}

/** True while `fd` is open on the file `ref` names. */
function openOn(fd: number, ref: Pick<FileRef, 'dev' | 'ino'>): boolean {
  try {
    const st = fstatSync(fd, { bigint: true });
    return st.dev === ref.dev && st.ino === ref.ino;
  } catch {
    return false;
  }
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A FIFO, open for reading and writing so that neither end blocks; a read waits for a write. */
function fifo(dir: string): { fd: number; release: (bytes?: number) => void } {
  const path = join(dir, 'fifo');
  const made = spawnSync('/usr/bin/mkfifo', ['-m', '0600', path]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${String(made.stderr)}`);
  const fd = openSync(path, constants.O_RDWR);
  cleanup.push(() => closeSync(fd));
  return { fd, release: (bytes = 1) => void writeSync(fd, 'x'.repeat(bytes)) };
}

/** A file to open, and its identity. */
function plainFile(name: string) {
  const path = join(testDir(name), 'f');
  writeFileSync(path, 'text');
  const st = statSync(path, { bigint: true });
  return { path, dev: st.dev, ino: st.ino };
}

describe('the descriptor ledger', () => {
  it('gives up on an open past its limit, and closes the file when it arrives', async () => {
    const file = plainFile('body-files-late');
    const files = new BodyFiles(4);
    let fd = -1;
    const late = new Promise<number>((resolve) =>
      setTimeout(() => resolve((fd = openSync(file.path, 'r'))), 300),
    );
    expect(await files.open(() => late, 100)).toBe('timeout');
    expect(files.count).toBe(1);
    await late;
    await until(() => files.count === 0);
    expect(openOn(fd, file)).toBe(false);
    await files.drain();
  });

  it('closes a lent descriptor once `after` settles, never before, and drains then', async () => {
    const file = plainFile('body-files-after');
    const files = new BodyFiles(4);
    const opened = await files.open(() => Promise.resolve(openSync(file.path, 'r')), 1000);
    if (typeof opened !== 'object') throw new Error('not opened');
    let exit: () => void = () => {};
    files.close(opened.fd, new Promise<void>((resolve) => (exit = resolve)));
    const drained = files.drain();
    expect(await settledWithin(drained, 200)).toBe(false);
    expect(openOn(opened.fd, file)).toBe(true);
    exit();
    await drained;
    expect(openOn(opened.fd, file)).toBe(false);
  });

  it('starts no open past the cap until a file is closed', async () => {
    const file = plainFile('body-files-cap');
    const files = new BodyFiles(2);
    const fds: number[] = [];
    const open = () => Promise.resolve(openSync(file.path, 'r')).then((fd) => (fds.push(fd), fd));
    await files.open(open, 1000);
    await files.open(open, 1000);
    const third = files.open(open, 1000);
    expect(await settledWithin(third, 200)).toBe(false);
    expect(fds).toHaveLength(2);
    files.close(fds[0]!);
    expect(await third).toEqual({ fd: fds[2] });
    files.close(fds[1]!);
    files.close(fds[2]!);
    await files.drain();
  });

  it('frees the slot of a refused open, and rejects as the open did', async () => {
    const files = new BodyFiles(1);
    const refusal = new Error('refused');
    await expect(files.open(() => Promise.reject(refusal), 1000)).rejects.toBe(refusal);
    expect(files.count).toBe(0);
    await expect(
      files.open(() => {
        throw refusal;
      }, 1000),
    ).rejects.toBe(refusal);
    expect(files.count).toBe(0);
  });

  it('stops: an open waiting for a slot and one under way give up, and the late file is closed', async () => {
    const file = plainFile('body-files-stop');
    const files = new BodyFiles(1);
    let fd = -1;
    let arrive: () => void = () => {};
    const underWay = files.open(
      () =>
        new Promise<number>((resolve) => (arrive = () => resolve((fd = openSync(file.path, 'r'))))),
      10_000,
    );
    const waiting = files.open(() => Promise.resolve(openSync(file.path, 'r')), 10_000);
    files.stop();
    expect(await underWay).toBe('stopped');
    expect(await waiting).toBe('stopped');
    expect(await files.open(() => Promise.resolve(openSync(file.path, 'r')), 10_000)).toBe(
      'stopped',
    );
    arrive();
    await files.drain();
    expect(openOn(fd, file)).toBe(false);
  });
});

// --- Phase 2 with body jobs on a real worker thread ----------------------------

/**
 * A stand-in for a pool thread's body job, on a real worker thread. By message
 * ID: 'read' answers at once from the lent descriptor; 'inflight' starts a
 * read of the FIFO that answers only once the test writes to it, and never
 * replies; 'blocked' waits for the FIFO in a synchronous read, then replies.
 */
const BODY_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
parentPort.on('message', (r) => {
  const { fd, item } = r.args;
  const reply = () => parentPort.postMessage({ id: r.id, ok: true, data: {
    protonId: item.protonId, rev: item.rev, ok: true, body: 'lent ' + fs.fstatSync(fd).size,
    truncated: false, attachments: [], attachmentText: '', attachmentsCapped: false, inputBytes: 0,
  } });
  const mode = workerData.modes[item.protonId] || workerData.mode;
  if (mode === 'inflight') return fs.read(workerData.fifo, Buffer.alloc(1), 0, 1, null, () => {});
  if (mode === 'blocked') fs.readSync(workerData.fifo, Buffer.alloc(1), 0, 1, null);
  reply();
});
`;

/** Runs body jobs on a worker thread, and everything else in this process. */
class BodyOnWorker implements IndexThread {
  onRespawn: (() => void) | null = null;
  constructor(
    private readonly inline: InlineThread,
    private readonly worker: WorkerThread,
  ) {}
  get respawns(): number {
    return this.inline.respawns + this.worker.respawns;
  }
  call<T>(op: string, args?: unknown, timeoutMs?: number): Promise<T> {
    return op === 'body'
      ? this.worker.call<T>(op, args, timeoutMs)
      : this.inline.call<T>(op, args, timeoutMs);
  }
  async stop(): Promise<void> {
    await this.worker.stop();
    await this.inline.stop();
  }
}

interface Opened {
  id: string;
  fd: number;
  ref: FileRef;
}

function phase2(
  name: string,
  messages: number,
  setup: {
    mode?: string;
    modes?: (ids: string[]) => Record<string, string>;
    options?: IndexOptions;
    openFile?: (root: string, ref: FileRef) => Promise<number>;
    wrap?: (thread: IndexThread) => IndexThread;
  },
) {
  const dir = testDir(name);
  const written = writeExport(join(dir, 'export'), { seed: 11, messages });
  const run = realpathSync(written.run);
  const ids = readdirSync(run)
    .filter((n) => n.endsWith('.eml'))
    .map((n) => n.slice(0, -'.eml'.length))
    .sort();
  const pipe = fifo(dir);
  const modes = setup.modes?.(ids) ?? {};
  const opened: Opened[] = [];
  const quiet = () => {};
  const log: Logger = { log: quiet, error: quiet, warn: quiet, info: quiet };
  const service = new IndexService({
    indexDir: join(dir, 'index'),
    stamp: STAMP,
    root: run,
    log,
    isCurrent: () => true,
    options: { poolSize: 1, ...setup.options },
    openFile: async (root, ref) => {
      const fd = await (setup.openFile ?? openContainedAsync)(root, ref);
      opened.push({ id: ref.rel.slice(0, -'.eml'.length), fd, ref });
      return fd;
    },
    thread: (role: ThreadRole) => {
      const inline = new InlineThread(role);
      if (role !== 'parse') return inline;
      const worker = new WorkerThread(
        () =>
          new Worker(BODY_SCRIPT, {
            eval: true,
            workerData: { fifo: pipe.fd, mode: setup.mode ?? 'read', modes },
          }),
      );
      const thread = new BodyOnWorker(inline, worker);
      return setup.wrap ? setup.wrap(thread) : thread;
    },
  });
  cleanup.push(async () => {
    pipe.release(1024);
    await service.close();
  });
  const states = () => {
    const db = openDb(service.dbPath, true);
    try {
      return Object.fromEntries(
        db
          .stmt('SELECT proton_id, body_state, error_code FROM pairs')
          .all()
          .map((r) => [String(r.proton_id), [Number(r.body_state), r.error_code ?? null]]),
      );
    } finally {
      db.close();
    }
  };
  const fdOf = (id: string) => opened.find((o) => o.id === id)!;
  return { run, ids, pipe, opened, service, states, fdOf, scan: () => scanRun(run) };
}

describe('phase 2 descriptors', () => {
  it('keeps a timed-out file open until its thread has exited mid-read, and ends indexing after', async () => {
    let slow = '';
    const p = phase2('body-fd-timeout', 6, {
      options: { jobMs: 300 },
      modes: (ids) => ({ [(slow = ids[2]!)]: 'inflight' }),
    });
    await p.service.open(null);
    const indexing = p.service.startIndexing(p.scan());
    await until(() => p.service.progress.bodyPhase === 'done');
    expect(p.service.progress).toMatchObject({ bodiesDone: 6, bodiesFailed: 1, timeouts: 1 });
    // The thread that had it was told to end, but its read is still under way.
    const held = p.fdOf(slow);
    expect(await settledWithin(indexing, 400)).toBe(false);
    expect(openOn(held.fd, held.ref)).toBe(true);
    for (const o of p.opened) if (o.id !== slow) expect(openOn(o.fd, o.ref), o.id).toBe(false);
    p.pipe.release();
    await indexing;
    expect(openOn(held.fd, held.ref)).toBe(false);
    expect(p.states()[slow]).toEqual([BODY_STATE.failed, 'BODY_TIMEOUT']);
    expect(p.opened.map((o) => o.id).sort()).toEqual(p.ids);
  });

  it('holds a close that follows a timeout until the old thread has exited, then closes its file', async () => {
    let slow = '';
    const p = phase2('body-fd-close', 8, {
      options: { jobMs: 300 },
      modes: (ids) => ({ [(slow = ids[0]!)]: 'inflight' }),
    });
    await p.service.open(null);
    const indexing = p.service.startIndexing(p.scan());
    await until(() => p.service.progress.timeouts === 1);
    const closing = p.service.close();
    expect(await settledWithin(closing, 400)).toBe(false);
    const held = p.fdOf(slow);
    expect(openOn(held.fd, held.ref)).toBe(true);
    p.pipe.release();
    await closing;
    await indexing;
    for (const o of p.opened) expect(openOn(o.fd, o.ref), o.id).toBe(false);
  });

  it('holds a close during a read until the thread has exited, then closes its file', async () => {
    let slow = '';
    const p = phase2('body-fd-stop', 6, {
      options: { jobMs: 10_000 },
      modes: (ids) => ({ [(slow = ids[1]!)]: 'inflight' }),
    });
    await p.service.open(null);
    const indexing = p.service.startIndexing(p.scan());
    await until(() => p.opened.some((o) => o.id === slow));
    // The thread has the job, and its read waits on the FIFO.
    await delay(100);
    const closing = p.service.close();
    expect(await settledWithin(closing, 400)).toBe(false);
    const held = p.fdOf(slow);
    expect(openOn(held.fd, held.ref)).toBe(true);
    p.pipe.release();
    await closing;
    await indexing;
    expect(p.service.progress.timeouts).toBe(0);
    for (const o of p.opened) expect(openOn(o.fd, o.ref), o.id).toBe(false);
  });

  it('stops opening at the cap while timed-out threads hold their files, and goes on as they close', async () => {
    // One thread: two lanes, so at most four descriptors.
    let heldMax = 0;
    const p = phase2('body-fd-cap', 10, {
      mode: 'blocked',
      options: { jobMs: 150 },
      openFile: async (root, ref) => {
        heldMax = Math.max(heldMax, p.opened.filter((o) => openOn(o.fd, o.ref)).length + 1);
        return openContainedAsync(root, ref);
      },
    });
    await p.service.open(null);
    const indexing = p.service.startIndexing(p.scan());
    await until(() => p.opened.length === 4 && p.service.progress.timeouts === 4);
    // Every file is held by a thread stuck in a read; nothing more opens.
    await delay(600);
    expect(p.opened).toHaveLength(4);
    expect(p.opened.every((o) => openOn(o.fd, o.ref))).toBe(true);
    // One thread's read ends: its file is closed, and the next one opens.
    p.pipe.release(1);
    await until(() => p.opened.length === 5);
    p.pipe.release(64);
    await indexing;
    expect(heldMax).toBeLessThanOrEqual(4);
    expect(p.service.progress).toMatchObject({ bodyPhase: 'done', bodiesDone: 10 });
    expect(p.service.progress.timeouts).toBeGreaterThanOrEqual(4);
    for (const o of p.opened) expect(openOn(o.fd, o.ref), o.id).toBe(false);
  });

  it('closes the file of a job no thread took at once', async () => {
    let refusedFd: { fd: number; ref: FileRef } | null = null;
    let openAfterRefusal: boolean | null = null;
    const p = phase2('body-fd-refused', 4, {
      wrap: (thread) => ({
        get respawns() {
          return thread.respawns;
        },
        onRespawn: null,
        stop: () => thread.stop(),
        call: async <T>(op: string, args?: unknown, ms?: number): Promise<T> => {
          if (op !== 'body') return thread.call<T>(op, args, ms);
          const { fd, item } = args as { fd: number; item: { ref: FileRef } };
          refusedFd = { fd, ref: item.ref };
          // Checked once the refusal has been handled, while indexing ends.
          setTimeout(() => (openAfterRefusal = openOn(fd, item.ref)), 100);
          throw new ThreadError(THREAD_STOPPED);
        },
      }),
    });
    await p.service.open(null);
    await p.service.startIndexing(p.scan());
    expect(refusedFd).not.toBeNull();
    await until(() => openAfterRefusal !== null);
    expect(openAfterRefusal).toBe(false);
    expect(p.service.progress.bodyPhase).toBe('failed');
  });

  it('gives an open past its limit BODY_TIMEOUT, and closes its file as soon as it arrives', async () => {
    let late = '';
    let lateFd: { fd: number; ref: FileRef } | null = null;
    let openAfterArrival: boolean | null = null;
    const p = phase2('body-fd-late-open', 5, {
      options: { jobMs: 200 },
      modes: (ids) => ((late = ids[1]!), {}),
      openFile: async (root, ref) => {
        if (!ref.rel.startsWith(late)) return openContainedAsync(root, ref);
        await delay(600);
        const fd = await openContainedAsync(root, ref);
        lateFd = { fd, ref };
        setTimeout(() => (openAfterArrival = openOn(fd, ref)), 50);
        return fd;
      },
    });
    await p.service.open(null);
    await p.service.startIndexing(p.scan());
    expect(p.states()[late]).toEqual([BODY_STATE.failed, 'BODY_TIMEOUT']);
    expect(p.service.progress).toMatchObject({ bodiesDone: 5, bodiesFailed: 1, timeouts: 1 });
    expect(lateFd).not.toBeNull();
    await until(() => openAfterArrival !== null);
    expect(openAfterArrival).toBe(false);
  });

  it('closes every file once the jobs have answered', async () => {
    const p = phase2('body-fd-normal', 12, {});
    await p.service.open(null);
    await p.service.startIndexing(p.scan());
    expect(p.service.progress).toMatchObject({
      bodyPhase: 'done',
      bodiesDone: 12,
      bodiesFailed: 0,
    });
    expect(p.opened).toHaveLength(12);
    for (const o of p.opened) expect(openOn(o.fd, o.ref), o.id).toBe(false);
    expect(Object.values(p.states()).every(([s]) => s === BODY_STATE.indexed)).toBe(true);
  });
});
