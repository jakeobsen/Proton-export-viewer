// SPDX-License-Identifier: AGPL-3.0-or-later
// Forwards shell errors to main as class and app frames only. Main validates both again.

import type { ErrorKind } from '../shared/api';
import { errorData } from '../shared/log/schema';

const ROOTS: Array<[string, string]> = [['app://shell/', 'renderer/']];

export function reportError(kind: ErrorKind, err: unknown): void {
  const { errorClass, frames } = errorData(err, ROOTS);
  window.pev.reportError({ kind, errorClass, frames });
}

export function installErrorHandlers(): void {
  window.addEventListener('error', (event) => reportError('uncaught', event.error));
  window.addEventListener('unhandledrejection', (event) => reportError('rejection', event.reason));
}
