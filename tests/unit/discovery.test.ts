// SPDX-License-Identifier: AGPL-3.0-or-later
// Finding the export runs below a picked folder, and only as deep as the
// export's own layout.

import { lstat, readdir, realpath } from 'node:fs/promises';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverRuns, type DiscoveryFs } from '../../src/main/sources/discovery';
import { testDir } from '../paths';

/** Counts every call discovery makes. */
function counting() {
  const calls = { readdir: [] as string[], lstat: 0, realpath: 0 };
  const fs: DiscoveryFs = {
    realpath: (p) => {
      calls.realpath += 1;
      return realpath(p);
    },
    readdir: (p) => {
      calls.readdir.push(p);
      return readdir(p, { withFileTypes: true });
    },
    lstat: (p) => {
      calls.lstat += 1;
      return lstat(p);
    },
  };
  return { fs, calls };
}

function tool(name: string) {
  const root = realpathSync(testDir(name));
  const dirs = [
    'alice@example.com/mail_20250101_100000',
    'alice@example.com/mail_20250630_120000',
    'bob@example.org/mail_20250315_080000',
    'logs',
  ];
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'logs', '20250630_120000_export.log'), 'x');
  writeFileSync(join(root, 'alice@example.com', 'mail_notes'), 'a file, not a run');
  return root;
}

describe('discoverRuns', () => {
  it("finds every run below the export tool's folder, newest first", async () => {
    const root = tool('disc-tool');
    expect(await discoverRuns(root)).toEqual({
      root,
      runs: [
        {
          rel: 'alice@example.com/mail_20250630_120000',
          runName: 'mail_20250630_120000',
          accountName: 'alice@example.com',
        },
        {
          rel: 'bob@example.org/mail_20250315_080000',
          runName: 'mail_20250315_080000',
          accountName: 'bob@example.org',
        },
        {
          rel: 'alice@example.com/mail_20250101_100000',
          runName: 'mail_20250101_100000',
          accountName: 'alice@example.com',
        },
      ],
    });
  });

  it('finds the runs of an account folder, and a run folder by itself', async () => {
    const root = tool('disc-account');
    const account = join(root, 'alice@example.com');
    expect((await discoverRuns(account)).runs).toEqual([
      {
        rel: 'mail_20250630_120000',
        runName: 'mail_20250630_120000',
        accountName: 'alice@example.com',
      },
      {
        rel: 'mail_20250101_100000',
        runName: 'mail_20250101_100000',
        accountName: 'alice@example.com',
      },
    ]);
    const run = join(account, 'mail_20250101_100000');
    expect(await discoverRuns(run)).toEqual({
      root: run,
      runs: [{ rel: '', runName: 'mail_20250101_100000', accountName: null }],
    });
  });

  it('finds nothing in a deep tree, and looks only two levels down', async () => {
    const root = realpathSync(testDir('disc-deep'));
    let path = root;
    for (let depth = 0; depth < 40; depth += 1) {
      path = join(path, `d${depth}`);
      for (let n = 0; n < 3; n += 1) mkdirSync(join(path, `side${n}`), { recursive: true });
    }
    mkdirSync(join(path, 'mail_20250630_120000'));
    const { fs, calls } = counting();
    const started = performance.now();
    expect((await discoverRuns(root, fs)).runs).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
    // The pick and its one child folder.
    expect(calls.readdir).toEqual([root, join(root, 'd0')]);
  });

  it('follows no link, so a link loop finishes at once with nothing found', async () => {
    const root = realpathSync(testDir('disc-loop'));
    mkdirSync(join(root, 'acct'));
    symlinkSync(root, join(root, 'acct', 'mail_loop'));
    symlinkSync(root, join(root, 'loop'));
    symlinkSync('.', join(root, 'acct', 'self'));
    const elsewhere = realpathSync(testDir('disc-loop-target'));
    mkdirSync(join(elsewhere, 'mail_20250630_120000'));
    symlinkSync(elsewhere, join(root, 'linked-account'));
    symlinkSync(join(elsewhere, 'mail_20250630_120000'), join(root, 'mail_20250701_000000'));
    const { fs, calls } = counting();
    const started = performance.now();
    expect((await discoverRuns(root, fs)).runs).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(calls.readdir).toEqual([root, join(root, 'acct')]);
  });

  it('finds nothing in a pick that is not a folder or is gone', async () => {
    const root = realpathSync(testDir('disc-file'));
    writeFileSync(join(root, 'mail_20250630_120000'), 'x');
    expect((await discoverRuns(join(root, 'mail_20250630_120000'))).runs).toEqual([]);
    expect((await discoverRuns(join(root, 'missing'))).runs).toEqual([]);
  });
});
