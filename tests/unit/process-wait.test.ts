// SPDX-License-Identifier: AGPL-3.0-or-later
// Waiting for a process to be gone: it resolves only once the process has
// exited (a zombie counts), so a lock it held is free; a process that stays
// is killed after the timeout, and only if it is still the same process.

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/core/index/sql';
import {
  isGone,
  killIfSame,
  processState,
  startTimeOf,
  statStartTime,
  statState,
  waitGone,
} from '../e2e/process-wait';
import { testDir } from '../paths';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

/** A Node child running `script`; it gets `argv[1]` and talks over stdin and stdout. */
function node(script: string, arg = ''): ChildProcess {
  const child = spawn(process.execPath, ['-e', script, arg], { stdio: ['pipe', 'pipe', 'ignore'] });
  children.push(child);
  return child;
}

/** The first line the child writes. */
async function firstLine(child: ChildProcess): Promise<string> {
  const [chunk] = (await once(child.stdout!, 'data')) as [Buffer];
  return chunk.toString('utf8').split('\n')[0]!;
}

// Holds an exclusive lock on the database at argv[1]; exits 300 ms after a
// line on stdin, still holding it until then.
const HOLDER = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('ready\\n');
process.stdin.once('data', () => setTimeout(() => process.exit(0), 300));
`;

function canWrite(path: string): boolean {
  const db = openDb(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

describe('process-wait', () => {
  it('resolves only once the process has exited, and its lock is then free', async () => {
    const path = join(testDir('process-wait'), 'held.sqlite');
    openDb(path).close();
    const holder = node(HOLDER, path);
    expect(await firstLine(holder)).toBe('ready');
    const pid = holder.pid!;
    expect(canWrite(path)).toBe(false);
    let exited = false;
    holder.once('exit', () => {
      exited = true;
    });
    holder.stdin!.write('go\n');
    const waited = await waitGone(pid, { timeoutMs: 5000, startTime: startTimeOf(pid) });
    expect(waited.ms).toBeGreaterThanOrEqual(200);
    expect(isGone(pid)).toBe(true);
    // No busy timeout needed any more.
    expect(canWrite(path)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exited).toBe(true);
  });

  it('kills a process that stays past the timeout, and fails', async () => {
    const child = node("process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
    expect(await firstLine(child)).toBe('ready');
    const pid = child.pid!;
    const exit = once(child, 'exit');
    await expect(waitGone(pid, { timeoutMs: 100, startTime: startTimeOf(pid) })).rejects.toThrow(
      /^core_alive_after_close: \d+$/,
    );
    const [, signal] = (await exit) as [number | null, string | null];
    expect(signal).toBe('SIGKILL');
  });

  it('never kills a process that started at another time, and counts it as a new one', async () => {
    const child = node("process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
    expect(await firstLine(child)).toBe('ready');
    const pid = child.pid!;
    expect(startTimeOf(pid)).not.toBeNull();
    expect(killIfSame(pid, 'another start time')).toBe(false);
    expect(killIfSame(pid, null)).toBe(false);
    // The number now names another process: the one waited for is gone.
    const waited = await waitGone(pid, { timeoutMs: 5000, startTime: 'another start time' });
    expect(waited.state).toBe('reused');
    expect(waited.ms).toBeLessThan(1000);
    expect(processState(pid)).toBe('running');
  });

  it('counts a zombie as gone: it has exited and holds nothing', async () => {
    // The shell starts a short sleep in the background, then becomes a long
    // one, which never collects it: the short one stays a zombie.
    const child = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 5'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.push(child);
    const zombie = Number(await firstLine(child));
    expect(zombie).toBeGreaterThan(0);
    const waited = await waitGone(zombie, { timeoutMs: 3000, startTime: null });
    expect(waited.state).toBe('zombie');
    expect(isGone(zombie)).toBe(true);
    // The process that never collected it is still running.
    expect(processState(child.pid!)).toBe('running');
  });

  it('reads the state and start time after the last parenthesis of a stat line', () => {
    const fields = Array.from({ length: 20 }, (_, i) => String(i + 4)).join(' ');
    const stat = `4242 (a) b (c)) Z ${fields}`;
    expect(statState(stat)).toBe('Z');
    expect(statStartTime(stat)).toBe('22');
    expect(statState('no name here')).toBeNull();
    expect(statStartTime('1 (short) S 1')).toBeNull();
  });
});
