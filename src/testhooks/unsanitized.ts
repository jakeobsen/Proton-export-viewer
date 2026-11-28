// SPDX-License-Identifier: AGPL-3.0-or-later
// The unsanitized path of test builds: the HTML body as the message has it,
// without the sanitizer and the CSS filter, so a test can show that the
// body's CSP and the frame sandbox hold on their own, and that the request
// records see what they stop.

import type { HtmlSource, SanitizedBody } from '../core/reader/sanitize';
import { markLoaded } from './marker';

markLoaded();

/** The core test action that turns the unsanitized path on or off. */
export const READER_UNSANITIZED_ACTION = 'pev-reader-unsanitized';

/**
 * Stands for the view's asset base in a test message, so a test body can refer
 * to the view's own `mail-asset:` URLs, which are only known once it opens.
 */
export const ASSET_BASE_MARK = '{{asset-base}}';

/**
 * Keeps the HTML as it is, its parts joined as the parser joins them: no
 * references are rewritten, no links are kept, and no inline image is served.
 * The one change: the asset-base mark becomes the view's asset base.
 */
export function unsanitized(sources: readonly HtmlSource[], assetBase: string): SanitizedBody {
  const html = sources.map((source) => source.html).join('<br/>\n');
  return {
    html: html.replaceAll(ASSET_BASE_MARK, assetBase),
    links: [],
    remote: 0,
    cids: 0,
    cidTargets: [],
  };
}
