// SPDX-License-Identifier: AGPL-3.0-or-later
// Waiting for a process to be gone. The app's core process can outlive the
// main process for a moment after a close, with the index still open; a test
// that reads the index right after a close waits for core to be gone first.
// On Linux a process counts as gone only once its last thread has ended.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

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

/** A process's state, and on Linux, when its stat said Z, how many of its threads were listed. */
export interface Probe {
  state: ProcessState;
  tasks?: number;
}

/**
 * The state of a Linux process from its stat line and the number of entries
 * in its task folder (null when that can't be read). The stat shows Z for the
 * thread-group leader as soon as it exits, while its other threads may still
 * be ending with files open; the files, and the locks on them, go only with
 * the last thread. So it is a zombie only once the leader is alone.
 */
export function linuxState(stat: string, tasks: number | null): ProcessState {
  if (statState(stat) !== 'Z') return 'running';
  return tasks === null || tasks <= 1 ? 'zombie' : 'running';
}

/** How many threads `/proc/<pid>/task` lists, or null when it can't be read. */
function taskCount(pid: number): number | null {
  try {
    return readdirSync(`/proc/${pid}/task`).length;
  } catch {
    return null;
  }
}

/**
 * The state of `pid`. A zombie has exited and holds no files or locks; only
 * its exit status waits to be collected.
 */
export function probeProcess(pid: number): Probe {
  const first = probe(pid);
  if (first === 'ESRCH') return { state: 'gone' };
  // EPERM: it exists, but belongs to someone else.
  if (first !== null) return { state: 'running' };
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return { state: 'gone' };
    }
    if (statState(stat) !== 'Z') return { state: 'running' };
    const tasks = taskCount(pid);
    return { state: linuxState(stat, tasks), ...(tasks === null ? {} : { tasks }) };
  }
  return { state: stateFromPs(psState(pid), () => probe(pid)) };
}

export function processState(pid: number): ProcessState {
  return probeProcess(pid).state;
}

/**
 * The state of a process that existed a moment ago, from the state `ps` gives
 * for it. No output means it went in between, but only if probing it again
 * says there is no such process (ESRCH); otherwise it still runs.
 */
export function stateFromPs(stat: string | null, probeAgain: () => string | null): ProcessState {
  if (stat === null) return probeAgain() === 'ESRCH' ? 'gone' : 'running';
  return stat.startsWith('Z') ? 'zombie' : 'running';
}

/** The error `kill(pid, 0)` gives, such as ESRCH or EPERM, or null when there is none. */
function probe(pid: number): string | null {
  try {
    process.kill(pid, 0);
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'unknown';
  }
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
  /** Tests only: probes the process instead of the system. */
  probe?: (pid: number) => Probe;
}

/** The most thread counts a wait keeps, one per probe that saw Z. */
export const MAX_Z_PROBES = 100;

/** How a process waited for was found gone: exited, a zombie, or its number given to a new process. */
export type GoneState = Exclude<ProcessState, 'running'> | 'reused';

/** How a wait ended, with the thread count of each probe that saw a Linux Z. */
export interface Waited {
  ms: number;
  state: GoneState;
  zTasks?: number[];
}

/** A wait that ran out of time: the process was killed, and this is what was seen. */
export class AliveAfterClose extends Error {
  constructor(
    readonly ms: number,
    readonly zTasks: number[],
  ) {
    super(`core_alive_after_close: ${ms}`);
  }
}

/**
 * Resolves once `pid` has exited, with how long that took. A process with
 * that number but another start time is a new one: the one waited for has
 * gone. Past `timeoutMs` it kills the process, if it is still the same one,
 * so nothing outlives the run, and rejects with `core_alive_after_close: <ms>`.
 */
export async function waitGone(pid: number, options: WaitGoneOptions): Promise<Waited> {
  const started = Date.now();
  const zTasks: number[] = [];
  const seen = () => (zTasks.length > 0 ? { zTasks } : {});
  for (;;) {
    const probed = (options.probe ?? probeProcess)(pid);
    if (probed.tasks !== undefined && zTasks.length < MAX_Z_PROBES) zTasks.push(probed.tasks);
    const ms = Date.now() - started;
    if (probed.state !== 'running') return { ms, state: probed.state, ...seen() };
    if (options.startTime !== null) {
      const now = startTimeOf(pid);
      if (now !== null && now !== options.startTime) return { ms, state: 'reused', ...seen() };
    }
    if (ms >= options.timeoutMs) {
      killIfSame(pid, options.startTime);
      throw new AliveAfterClose(ms, zTasks);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 25));
  }
}
