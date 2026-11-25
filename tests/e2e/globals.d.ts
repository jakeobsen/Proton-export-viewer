// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PevApi } from '../../src/shared/api';

declare global {
  interface Window {
    pev: PevApi;
  }
}

export {};
