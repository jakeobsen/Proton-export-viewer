// SPDX-License-Identifier: AGPL-3.0-or-later
// The body job's own contracts, with the text extraction replaced by a byte
// counter: it reads no more than the size the scan recorded, even from a file
// that has grown since, and it closes the descriptor it opened once the read
// has settled, whatever the outcome.

import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { scanRun } from '../../src/core/containment';
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
  const ref = scanRun(dir).eml.get('a')!;
  return { dir, ref, file: join(dir, 'a.eml') };
}

/** This process's open descriptors. */
const openFds = () => readdirSync('/dev/fd').length;

describe('the body job', () => {
  it('reads no more than the size the scan recorded, from a file that has grown since', async () => {
    const { dir, ref, file } = folder('body-job-bound', 'words '.repeat(50_000));
    appendFileSync(file, 'x'.repeat(1024 * 1024));
    counter.bytes = [];
    counter.failAfter = null;
    expect(await bodyJob(dir, { protonId: 'a', rev: 1, ref })).toMatchObject({
      ok: false,
      error: BODY_CHANGED,
    });
    expect(counter.bytes).toEqual([ref.size]);
  });

  it('closes its descriptor once the read has settled: read, changed, and failed', async () => {
    const ok = folder('body-job-fd-ok', 'plain words');
    const changed = folder('body-job-fd-changed', 'first');
    writeFileSync(changed.file, message('second, longer'));
    const failed = folder('body-job-fd-failed', 'words '.repeat(200_000));
    const before = openFds();
    counter.failAfter = null;
    expect(await bodyJob(ok.dir, { protonId: 'a', rev: 1, ref: ok.ref })).toMatchObject({
      ok: true,
    });
    expect(openFds()).toBe(before);
    expect(await bodyJob(changed.dir, { protonId: 'a', rev: 1, ref: changed.ref })).toMatchObject({
      ok: false,
      error: BODY_CHANGED,
    });
    expect(openFds()).toBe(before);
    counter.failAfter = 1;
    expect(await bodyJob(failed.dir, { protonId: 'a', rev: 1, ref: failed.ref })).toMatchObject({
      ok: false,
      error: 'BODY_FAILED',
    });
    counter.failAfter = null;
    expect(openFds()).toBe(before);
  });
});
