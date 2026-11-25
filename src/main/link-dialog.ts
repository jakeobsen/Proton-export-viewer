// SPDX-License-Identifier: AGPL-3.0-or-later
// Placeholder for the link confirmation dialog. It hands the URL to the shell,
// which only shows it. Nothing here opens a browser.

import type { WebContents } from 'electron';
import { IPC } from '../shared/api';
import type { Logger } from '../shared/log/writer';
import { schemeLabel } from './harden';

export class LinkDialog {
  /** URLs passed to the dialog, kept only in builds with test hooks. */
  readonly shown: Array<{ windowId: number; url: string }> = [];

  constructor(private readonly log: Logger) {}

  show(contents: WebContents, windowId: number, url: string): void {
    this.log.info('nav.link_dialog', { scheme: schemeLabel(url), windowId });
    if (__PEV_TEST_HOOKS__) this.shown.push({ windowId, url });
    if (!contents.isDestroyed()) contents.send(IPC.linkDialog, url);
  }
}
