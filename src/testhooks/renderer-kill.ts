// SPDX-License-Identifier: AGPL-3.0-or-later
// Ends a renderer process by its PID. A PID of 0 or below doesn't name one
// process: kill() sends 0 to the caller's whole process group and -1 to every
// process the user may signal, and a renderer that has already gone reports 0.
// Such a PID is refused and nothing is signalled.

export type Kill = (pid: number, signal: 'SIGKILL') => void;

/** True for a PID that names exactly one process. */
export function isSinglePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

/** Sends SIGKILL to `pid` if it names one process. Returns whether it did. */
export function killRenderer(pid: number, kill: Kill): boolean {
  if (!isSinglePid(pid)) return false;
  kill(pid, 'SIGKILL');
  return true;
}
