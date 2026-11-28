// SPDX-License-Identifier: AGPL-3.0-or-later
// The body job's own contracts, with the text extraction replaced by a byte
// counter: it reads no more than the size the scan recorded, even from a file
// that has grown since, and it leaves the descriptor core lent it open, with
// its own stream closed, whatever the outcome.

import { appendFileSync, closeSync, fstatSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { examine, openContained, type FileRef } from '../../src/core/containment';
import { testDir } from '../paths';

const counter = vi.hoisted(() => ({
  bytes: [] as number[],
  /** Fails the extraction once this many bytes have arrived. */
  failAfter: null as number | null,
}));

vi.mock('../../src/core/index/body', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/index/body')>();
  return {
    ...real,
    extractBody: async (input: AsyncIterable<Buffer>) => {
      let n = 0;
      for await (const chunk of input) {
        n += chunk.length;
        if (counter.failAfter !== null && n >= counter.failAfter) {
          counter.bytes.push(n);
          throw Object.assign(new Error('extract failed'), { code: 'FAILED' });
        }
      }
      counter.bytes.push(n);
      return {
        body: '',
        truncated: false,
        attachments: [],
        attachmentText: '',
        attachmentsCapped: false,
        inputBytes: n,
      };
    },
  };
});

const { BODY_CHANGED, bodyJob } = await import('../../src/core/index/ops');

const message = (body: string) =>
  ['Subject: s', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');

function folder(name: string, body: string) {
  const dir = testDir(name);
  writeFileSync(join(dir, 'a.metadata.json'), '{}');
  writeFileSync(join(dir, 'a.eml'), message(body));
  // The identity phase 1 records for the message file.
  const found = examine(dir, 'a.eml');
  if (!found || !('ref' in found)) throw new Error('no regular message file');
  return { dir, ref: found.ref, file: join(dir, 'a.eml') };
}

/** This process's open descriptors. */
const openFds = () => readdirSync('/dev/fd').length;

/** True while `fd` is open on the file `ref` names. */
function openOn(fd: number, ref: FileRef): boolean {
  try {
    const st = fstatSync(fd, { bigint: true });
    return st.dev === ref.dev && st.ino === ref.ino;
  } catch {
    return false;
  }
}

/** Runs the job on a descriptor opened as core opens it; the caller closes it. */
async function lent(dir: string, ref: FileRef) {
  const fd = openContained(dir, ref);
  return { fd, result: await bodyJob(fd, { protonId: 'a', rev: 1, ref }) };
}

describe('the body job', () => {
  it('reads no more than the size the scan recorded, from a file that has grown since', async () => {
    const { dir, ref, file } = folder('body-job-bound', 'words '.repeat(50_000));
    appendFileSync(file, 'x'.repeat(1024 * 1024));
    counter.bytes = [];
    counter.failAfter = null;
    const { fd, result } = await lent(dir, ref);
    closeSync(fd);
    expect(result).toMatchObject({ ok: false, error: BODY_CHANGED });
    expect(counter.bytes).toEqual([ref.size]);
  });

  it('leaves the lent descriptor open and opens none of its own: read, changed, and failed', async () => {
    const ok = folder('body-job-fd-ok', 'plain words');
    const changed = folder('body-job-fd-changed', 'first');
    writeFileSync(changed.file, message('second, longer'));
    const failed = folder('body-job-fd-failed', 'words '.repeat(200_000));
    const before = openFds();
    const cases = [
      { f: ok, failAfter: null, expected: { ok: true } },
      { f: changed, failAfter: null, expected: { ok: false, error: BODY_CHANGED } },
      { f: failed, failAfter: 1, expected: { ok: false, error: 'BODY_FAILED' } },
    ];
    for (const { f, failAfter, expected } of cases) {
      counter.failAfter = failAfter;
      const { fd, result } = await lent(f.dir, f.ref);
      expect(result).toMatchObject(expected);
      // Still the scanned file, and nothing else of the job's is open.
      expect(openOn(fd, f.ref)).toBe(true);
      expect(openFds()).toBe(before + 1);
      closeSync(fd);
      expect(openFds()).toBe(before);
    }
    counter.failAfter = null;
  });
});
