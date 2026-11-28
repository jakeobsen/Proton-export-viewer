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
  AliveAfterClose,
  MAX_Z_PROBES,
  isGone,
  killIfSame,
  linuxProbe,
  linuxState,
  processState,
  statThreads,
  type Probe,
  startTimeOf,
  stateFromPs,
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

  it('takes no ps output for a process gone in between, only if probing it again says ESRCH', () => {
    let probes = 0;
    const probe = (code: string | null) => () => {
      probes += 1;
      return code;
    };
    // The first probe found it, and it went before ps looked.
    expect(stateFromPs(null, probe('ESRCH'))).toBe('gone');
    // Still there, or there but someone else's.
    expect(stateFromPs(null, probe(null))).toBe('running');
    expect(stateFromPs(null, probe('EPERM'))).toBe('running');
    expect(probes).toBe(3);
    expect(stateFromPs('Z+', probe('ESRCH'))).toBe('zombie');
    expect(stateFromPs('T', probe('ESRCH'))).toBe('running');
    expect(stateFromPs('Ss', probe('ESRCH'))).toBe('running');
    // Only missing output probes again.
    expect(probes).toBe(3);
  });

  it('counts a Linux zombie leader as exited only when its stat counts exactly one thread', () => {
    // Fields 3 to 22 of a stat line; field 20 (the thread count) is index 17.
    const stat = (state: string, threads: string) => {
      const fields = Array.from({ length: 20 }, (_, i) => String(i + 3));
      fields[0] = state;
      fields[17] = threads;
      return `4242 (co re) (x)) ${fields.join(' ')}`;
    };
    expect(statThreads(stat('Z', '7'))).toBe(7);
    expect(linuxState(stat('Z', '2'))).toBe('running');
    expect(linuxState(stat('Z', '3'))).toBe('running');
    expect(linuxState(stat('Z', '1'))).toBe('zombie');
    // No count, or not one that can be true, confirms nothing.
    expect(linuxState(stat('Z', '0'))).toBe('running');
    expect(linuxState(stat('Z', 'x'))).toBe('running');
    expect(statThreads(stat('Z', 'x'))).toBeNull();
    expect(linuxState('4242 (core) Z 1 2')).toBe('running');
    expect(statThreads('4242 (core) Z 1 2')).toBeNull();
    expect(linuxState(stat('S', '1'))).toBe('running');
  });

  it('takes a failed stat read as gone only when the stat is missing, or probing again says ESRCH', () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    let probes = 0;
    const again = (code: string | null) => () => {
      probes += 1;
      return code;
    };
    // The PID still exists, but its stat couldn't be read: nothing is confirmed.
    expect(linuxProbe(fail('EACCES'), again(null))).toEqual({ state: 'running' });
    expect(linuxProbe(fail('EMFILE'), again('EPERM'))).toEqual({ state: 'running' });
    expect(probes).toBe(2);
    // Gone in between: probing again says so, or the stat is no longer there.
    expect(linuxProbe(fail('EACCES'), again('ESRCH'))).toEqual({ state: 'gone' });
    expect(probes).toBe(3);
    expect(linuxProbe(fail('ENOENT'), again(null))).toEqual({ state: 'gone' });
    expect(linuxProbe(fail('ESRCH'), again(null))).toEqual({ state: 'gone' });
    expect(probes).toBe(3);
    const line = (state: string, threads: string) =>
      `7 (core) ${state} ${Array.from({ length: 19 }, (_, i) => (i === 16 ? threads : '0')).join(' ')}`;
    expect(
      linuxProbe(
        () => line('S', '4'),
        () => 'ESRCH',
      ),
    ).toEqual({ state: 'running' });
    expect(
      linuxProbe(
        () => line('Z', '1'),
        () => null,
      ),
    ).toEqual({ state: 'zombie', threads: 1 });
    expect(
      linuxProbe(
        () => line('Z', '3'),
        () => null,
      ),
    ).toEqual({ state: 'running', threads: 3 });
  });

  it('waits through a zombie leader with live threads, and records each such probe', async () => {
    const probes: Probe[] = [
      { state: 'running', threads: 3 },
      { state: 'running', threads: null },
      { state: 'running', threads: 2 },
      { state: 'zombie', threads: 1 },
    ];
    const waited = await waitGone(1, {
      timeoutMs: 5000,
      startTime: null,
      pollMs: 1,
      probe: () => probes.shift() ?? { state: 'gone' },
    });
    expect(waited).toMatchObject({ state: 'zombie', zThreads: [3, null, 2, 1] });
    const plain = await waitGone(1, {
      timeoutMs: 5000,
      startTime: null,
      probe: () => ({ state: 'gone' }),
    });
    expect(plain).not.toHaveProperty('zThreads');
  });

  it('keeps the probes it saw when it runs out of time, at most MAX_Z_PROBES of them', async () => {
    const failed = waitGone(1, {
      timeoutMs: 400,
      startTime: null,
      pollMs: 0,
      probe: () => ({ state: 'running', threads: 2 }),
    });
    await expect(failed).rejects.toThrow(/^core_alive_after_close: \d+$/);
    const err = await failed.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliveAfterClose);
    const zThreads = (err as AliveAfterClose).zThreads;
    // A poll every few milliseconds for 400 ms sees more than the cap.
    expect(zThreads).toHaveLength(MAX_Z_PROBES);
    expect(new Set(zThreads)).toEqual(new Set([2]));
  });
});
