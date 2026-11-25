// SPDX-License-Identifier: AGPL-3.0-or-later
// Forwards shell errors to main as class and app frames only. Main validates both again.

import type { ErrorKind } from '../shared/api';
import { errorData } from '../shared/log/schema';
import { getShellState, refreshGeneration } from './shell';

const ROOTS: Array<[string, string]> = [['app://shell/', 'renderer/']];

/** Sends the report for the shell's current generation, asking main for it first if needed. */
export function reportError(kind: ErrorKind, err: unknown): void {
  const { errorClass, frames } = errorData(err, ROOTS);
  const send = (generation: number | null) => {
    if (generation !== null) window.pev.reportError({ generation, kind, errorClass, frames });
  };
  const known = getShellState().generation;
  if (known !== null) send(known);
  else void refreshGeneration().then(send, () => undefined);
}

export function installErrorHandlers(): void {
  window.addEventListener('error', (event) => reportError('uncaught', event.error));
  window.addEventListener('unhandledrejection', (event) => reportError('rejection', event.reason));
}
