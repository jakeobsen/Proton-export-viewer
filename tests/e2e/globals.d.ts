// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PevApi } from '../../src/shared/api';

declare global {
  interface Window {
    pev: PevApi;
    /** Raw IPC, only in builds with test hooks. */
    __pevTestIpc: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;
      send(channel: string, ...args: unknown[]): void;
    };
  }
}

export {};
