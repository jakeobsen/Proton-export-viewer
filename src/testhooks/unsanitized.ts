// SPDX-License-Identifier: AGPL-3.0-or-later
// The unsanitized path of test builds: the HTML body as the message has it,
// without the sanitizer and the CSS filter, so a test can show that the
// body's CSP and the frame sandbox hold on their own, and that the request
// records see what they stop.

import type { SanitizedBody } from '../core/reader/sanitize';
import { markLoaded } from './marker';

markLoaded();

/** The core test action that turns the unsanitized path on or off. */
export const READER_UNSANITIZED_ACTION = 'pev-reader-unsanitized';

/** Keeps the HTML as it is: no references are rewritten, and no links are kept. */
export function unsanitized(html: string): SanitizedBody {
  return { html, links: [], remote: 0, cids: 0 };
}
