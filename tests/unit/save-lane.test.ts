// SPDX-License-Identifier: AGPL-3.0-or-later
// Core's save lane: one save at a time; the file must still be the one the
// view saw; one chunk at a time on credit; the completing chunk only after the
// file is checked again; no progress for the idle time fails it; and the file
// is closed only once the worker has exited.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveLane, type SaveWorker } from '../../src/core/save/lane';
import { PREVIEW_MAX_BYTES, type FileVersion } from '../../src/shared/reader-protocol';
import type { SaveWorkerIn, SaveWorkerOut } from '../../src/shared/save-protocol';

class FakeWorker extends EventEmitter implements SaveWorker {
  readonly posted: SaveWorkerIn[] = [];
  terminated = 0;

  postMessage(message: SaveWorkerIn): void {
    this.posted.push(message);
  }

  send(message: SaveWorkerOut): void {
    this.emit('message', message);
  }

  terminate(): Promise<number> {
    this.terminated += 1;
    // The thread exits a moment later.
    setTimeout(() => this.emit('exit', 1), 5);
    return Promise.resolve(1);
  }
}

const VERSION: FileVersion = { size: '100', mtimeNs: '1700000000000000000' };
const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(options: { idleMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  let now: FileVersion = { ...VERSION };
  const closed: number[] = [];
  const lane = new SaveLane({
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    version: () => now,
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
  });
  const file = (fd: number) => ({ fd, close: () => closed.push(fd) });
  return {
    lane,
    workers,
    closed,
    file,
    setVersion: (v: FileVersion) => {
      now = v;
    },
  };
}

describe('SaveLane', () => {
  it('refuses a file whose size or time differ from the view’s, and closes it', () => {
    const t = setup();
    t.setVersion({ ...VERSION, mtimeNs: '1700000000000000001' });
    expect(t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 })).toEqual({
      ok: false,
      code: 'changed',
    });
    expect(t.closed).toEqual([10]);
    expect(t.workers).toHaveLength(0);
  });

  it('runs one save at a time', () => {
    const t = setup();
    expect(t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 }).ok).toBe(true);
    expect(t.lane.open(2, t.file(11), VERSION, { kind: 'eml', size: 100 })).toEqual({
      ok: false,
      code: 'busy',
    });
    expect(t.closed).toEqual([11]);
  });

  it('streams the message file at the size the view saw', () => {
    const t = setup();
    const opened = t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 5 });
    expect(opened).toEqual({ ok: true, size: 100 });
    expect(t.workers[0]?.posted[0]).toEqual({
      type: 'start',
      fd: 10,
      fileSize: 100,
      target: { kind: 'eml', size: 100 },
    });
  });

  it('hands over one chunk per pull, and asks for the next only when it is taken', async () => {
    const t = setup();
    t.lane.open(1, t.file(10), VERSION, { kind: 'part', path: '1.2', contentType: 'a/b', size: 7 });
    const worker = t.workers[0]!;
    worker.send({ type: 'chunk', bytes: bytes(3) });
    expect(worker.posted.filter((m) => m.type === 'more')).toHaveLength(0);
    const first = await t.lane.pull(1);
    expect(first).toEqual({ ok: true, chunk: bytes(3), done: false });
    expect(worker.posted.filter((m) => m.type === 'more')).toHaveLength(1);
    const second = t.lane.pull(1);
    worker.send({ type: 'last', bytes: bytes(4, 2) });
    expect(await second).toEqual({ ok: true, chunk: bytes(4, 2), done: true });
    expect(t.lane.busy).toBe(false);
  });

  it('a file changed by the end fails the save instead of completing it', async () => {
    const t = setup();
    t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 });
    const pulled = t.lane.pull(1);
    t.setVersion({ ...VERSION, size: '101' });
    t.workers[0]!.send({ type: 'last', bytes: bytes(100) });
    expect(await pulled).toEqual({ ok: false, code: 'changed' });
    expect(await t.lane.pull(1)).toEqual({ ok: false, code: 'changed' });
  });

  it('closes the file only after the worker has exited', async () => {
    const t = setup();
    t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 });
    const cancelled = t.lane.cancel(1);
    expect(t.workers[0]!.terminated).toBe(1);
    expect(t.closed).toEqual([]);
    await cancelled;
    expect(t.closed).toEqual([10]);
    expect(t.lane.busy).toBe(false);
  });

  it('a worker that fails ends the save with its reason', async () => {
    const t = setup();
    t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 });
    const pulled = t.lane.pull(1);
    t.workers[0]!.send({ type: 'failed', reason: 'unreadable' });
    expect(await pulled).toEqual({ ok: false, code: 'unreadable' });
  });

  it('a preview past the cap is refused before a worker starts, and its file closed', () => {
    const t = setup();
    const preview = (size: number) =>
      ({ kind: 'preview', path: '1.2', contentType: 'image/png', size, format: 'png' }) as const;
    expect(t.lane.open(1, t.file(10), VERSION, preview(PREVIEW_MAX_BYTES + 1))).toEqual({
      ok: false,
      code: 'refused',
    });
    expect(t.closed).toEqual([10]);
    expect(t.workers).toHaveLength(0);
    expect(t.lane.open(2, t.file(11), VERSION, preview(PREVIEW_MAX_BYTES))).toEqual({
      ok: true,
      size: PREVIEW_MAX_BYTES,
    });
  });

  it('a preview the worker refuses ends as refused', async () => {
    const t = setup();
    t.lane.open(1, t.file(10), VERSION, {
      kind: 'preview',
      path: '1.2',
      contentType: 'image/png',
      size: 100,
      format: 'png',
    });
    const pulled = t.lane.pull(1);
    t.workers[0]!.send({ type: 'failed', reason: 'refused' });
    expect(await pulled).toEqual({ ok: false, code: 'refused' });
  });

  it('a worker that exits on its own fails the save, and the file is closed', async () => {
    const t = setup();
    t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 });
    const pulled = t.lane.pull(1);
    t.workers[0]!.emit('exit', 70);
    expect(await pulled).toEqual({ ok: false, code: 'unreadable' });
    expect(t.closed).toEqual([10]);
  });

  it('a pull for another save gets nothing', async () => {
    const t = setup();
    t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 });
    expect(await t.lane.pull(2)).toEqual({ ok: false, code: 'cancelled' });
  });

  describe('no progress', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fails a save with no progress for the idle time', async () => {
      const t = setup({ idleMs: 1000 });
      t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 });
      const pulled = t.lane.pull(1);
      await vi.advanceTimersByTimeAsync(999);
      t.workers[0]!.send({ type: 'tick' });
      await vi.advanceTimersByTimeAsync(999);
      expect(t.lane.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(2);
      expect(await pulled).toEqual({ ok: false, code: 'stalled' });
      expect(t.workers[0]!.terminated).toBe(1);
    });

    it('a chunk main doesn’t take for the idle time fails the save', async () => {
      const t = setup({ idleMs: 1000 });
      t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 });
      t.workers[0]!.send({ type: 'chunk', bytes: bytes(10) });
      await vi.advanceTimersByTimeAsync(1001);
      expect(t.lane.busy).toBe(false);
      expect(await t.lane.pull(1)).toEqual({ ok: false, code: 'stalled' });
    });
  });

  it('a pull waits for the worker’s next chunk', async () => {
    const t = setup();
    t.lane.open(1, t.file(10), VERSION, { kind: 'eml', size: 100 });
    let answered = false;
    const pulled = t.lane.pull(1).then((r) => {
      answered = true;
      return r;
    });
    await tick();
    expect(answered).toBe(false);
    t.workers[0]!.send({ type: 'chunk', bytes: bytes(2) });
    expect(await pulled).toEqual({ ok: true, chunk: bytes(2), done: false });
  });
});
