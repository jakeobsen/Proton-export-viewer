// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PevApi } from '../shared/api';

declare global {
  interface Window {
    pev: PevApi;
  }
}

export {};
