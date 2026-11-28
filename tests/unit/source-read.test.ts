// SPDX-License-Identifier: AGPL-3.0-or-later
// The source view's reads in core: only from the file the view was read
// from, so a file changed since is refused before anything is read; a part's
// read waits in its window's slot; the file is closed either way.

import { describe, expect, it, vi } from 'vitest';
import type { CoreResult, WorkerMessage, WorkerRequest } from '../../src/shared/core-protocol';
import type { SourceRequest } from '../../src/shared/reader-protocol';
import type { JobOutcome, JobSlot } from '../../src/core/reader/lane';
import { readSource } from '../../src/core/reader/source-read';

const FILE = { dev: '16777232', ino: '4242' };

function make(opened: { dev: string; ino: string } | null, ok = true) {
  const replies: CoreResult[] = [];
  const jobs: Array<{ message: WorkerRequest; slot: JobSlot | null }> = [];
  const close = vi.fn(async () => {});
  const deps = {
    open: async () =>
      ok
        ? {
            ok: true as const,
            opened: { input: { kind: 'fd' as const, fd: 9 }, file: opened, close },
          }
        : { ok: false as const, code: 'refused' as const },
    job: async (
      message: WorkerRequest,
      slot: JobSlot | null,
    ): Promise<JobOutcome<WorkerMessage>> => {
      jobs.push({ message, slot });
      return {
        ok: true,
        message: {
          type: 'sourced',
          reqId: 7,
          heldBytes: 0,
          ok: true,
          headers: { bytes: new Uint8Array([0x53]), truncated: false },
        },
      };
    },
    reply: (result: CoreResult) => replies.push(result),
  };
  return { deps, replies, jobs, close };
}

const request = (file: SourceRequest['file'], what: SourceRequest['what'] = { kind: 'headers' }) =>
  ({
    type: 'source',
    reqId: 7,
    openId: 1,
    generation: 1,
    rowid: 17,
    file,
    what,
    lane: 3,
    ...(what.kind === 'part' ? { order: 4 } : {}),
  }) as SourceRequest;

describe('the source read in core', () => {
  it('refuses a file whose identity changed since the view, and reads nothing', async () => {
    for (const now of [{ dev: FILE.dev, ino: '4243' }, { dev: '16777233', ino: FILE.ino }, null]) {
      const t = make(now);
      await readSource(request(FILE), t.deps);
      expect(t.replies).toEqual([{ type: 'result', reqId: 7, ok: false, code: 'changed' }]);
      expect(t.jobs).toEqual([]);
      expect(t.close).toHaveBeenCalledTimes(1);
    }
  });

  it('reads the same file, and a fallback, which names none', async () => {
    for (const named of [FILE, null]) {
      const t = make({ ...FILE });
      await readSource(request(named), t.deps);
      expect(t.replies).toEqual([
        {
          type: 'result',
          reqId: 7,
          ok: true,
          headers: { bytes: new Uint8Array([0x53]), truncated: false },
        },
      ]);
      expect(t.jobs).toHaveLength(1);
      expect(t.jobs[0]!.message).toMatchObject({ type: 'source', what: { kind: 'headers' } });
      expect(t.jobs[0]!.slot).toBeNull();
      expect(t.close).toHaveBeenCalledTimes(1);
    }
  });

  it("waits in the window's slot for a part, and says when the file was refused", async () => {
    const t = make({ ...FILE });
    await readSource(request(FILE, { kind: 'part', path: '1.2' }), t.deps);
    expect(t.jobs[0]!.slot).toEqual({ key: -3, order: 4 });
    const refused = make(null, false);
    await readSource(request(FILE), refused.deps);
    expect(refused.replies).toEqual([
      { type: 'result', reqId: 7, ok: false, code: 'reader_failed', reason: 'file' },
    ]);
    expect(refused.jobs).toEqual([]);
  });
});
