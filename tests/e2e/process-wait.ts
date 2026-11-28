// SPDX-License-Identifier: AGPL-3.0-or-later
// Waiting for a process to be gone. The app's core process can outlive the
// main process for a moment after a close, with the index still open; a test
// that reads the index right after a close waits for core to be gone first.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** How a process looks from outside: running, exited but not yet reaped, or gone. */
export type ProcessState = 'running' | 'zombie' | 'gone';

/** The fields of a `/proc/<pid>/stat` line after the name, which may hold spaces and parentheses. */
function statFields(stat: string): string[] | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  return stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
}

/** The state letter of a `/proc/<pid>/stat` line (field 3). */
export function statState(stat: string): string | null {
  return statFields(stat)?.[0] ?? null;
}

/** The start time of a `/proc/<pid>/stat` line (field 22), in clock ticks since boot. */
export function statStartTime(stat: string): string | null {
  return statFields(stat)?.[19] ?? null;
}

/** The process state letters `ps` gives for `pid`, or null when it gives none. */
function psState(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/**
 * The state of `pid`. A zombie has exited and holds no files or locks; only
 * its exit status waits to be collected.
 */
export function processState(pid: number): ProcessState {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: it exists, but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'running';
  }
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return 'gone';
    }
    return statState(stat) === 'Z' ? 'zombie' : 'running';
  }
  // The process existed a moment ago: unless ps says it's a zombie, it runs.
  return psState(pid)?.startsWith('Z') ? 'zombie' : 'running';
}

/** Whether `pid` has exited: gone, or a zombie. */
export function isGone(pid: number): boolean {
  return processState(pid) !== 'running';
}

/** When `pid` started, as the system gives it, or null when that can't be read. */
export function startTimeOf(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return statStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/**
 * Kills `pid` with SIGKILL, but only while it is still the process that
 * started at `startTime`: a number the system has given to a new process is
 * never killed. Returns whether it sent the signal.
 */
export function killIfSame(pid: number, startTime: string | null): boolean {
  if (startTime === null || startTimeOf(pid) !== startTime) return false;
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

export interface WaitGoneOptions {
  timeoutMs: number;
  /** The start time read with the pid, so that only that process is ever killed. */
  startTime: string | null;
  pollMs?: number;
}

/** How a process waited for was found gone: exited, a zombie, or its number given to a new process. */
export type GoneState = Exclude<ProcessState, 'running'> | 'reused';

/**
 * Resolves once `pid` has exited, with how long that took. A process with
 * that number but another start time is a new one: the one waited for has
 * gone. Past `timeoutMs` it kills the process, if it is still the same one,
 * so nothing outlives the run, and rejects with `core_alive_after_close: <ms>`.
 */
export async function waitGone(
  pid: number,
  options: WaitGoneOptions,
): Promise<{ ms: number; state: GoneState }> {
  const started = Date.now();
  for (;;) {
    const state = processState(pid);
    const ms = Date.now() - started;
    if (state !== 'running') return { ms, state };
    if (options.startTime !== null) {
      const now = startTimeOf(pid);
      if (now !== null && now !== options.startTime) return { ms, state: 'reused' };
    }
    if (ms >= options.timeoutMs) {
      killIfSame(pid, options.startTime);
      throw new Error(`core_alive_after_close: ${ms}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 25));
  }
}
