// SPDX-License-Identifier: AGPL-3.0-or-later
// A stream over a borrowed file descriptor never closes it: not when it is
// destroyed, and not when a read through it stops at the parser's limits.

import { closeSync, fstatSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { borrowedFdStream } from '../../src/core/fd-stream';
import { MAX_MIME_PARTS } from '../../src/core/mime-limits';
import { extractMessage } from '../../src/core/reader/extract';
import { bodiesAround } from '../mime-parts';
import { removeTestDirs, takeTestDirs, testDir } from '../paths';

const isOpen = (fd: number) => {
  try {
    fstatSync(fd);
    return true;
  } catch {
    return false;
  }
};

afterAll(() => removeTestDirs(takeTestDirs()));

describe('a stream over a borrowed descriptor', () => {
  it('leaves the descriptor open when it is destroyed', async () => {
    const path = join(testDir('fd-destroy'), 'm.eml');
    writeFileSync(path, 'Subject: x\r\n\r\nbody');
    const fd = openSync(path, 'r');
    const stream = borrowedFdStream(fd, { start: 0 });
    stream.destroy();
    await new Promise((resolve) => stream.once('close', resolve));
    expect(isOpen(fd)).toBe(true);
    closeSync(fd);
    expect(isOpen(fd)).toBe(false);
  });

  it("leaves it open when a read stops at the parser's limits, for the owner's one close", async () => {
    const path = join(testDir('fd-cut'), 'm.eml');
    writeFileSync(path, bodiesAround(MAX_MIME_PARTS + 10));
    const fd = openSync(path, 'r');
    const message = await extractMessage(borrowedFdStream(fd, { start: 0 }));
    expect(message.stopped).toBe(true);
    expect(message.text.content).toContain('Text before the parts.');
    expect(isOpen(fd)).toBe(true);
    closeSync(fd);
    expect(() => closeSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });
});
