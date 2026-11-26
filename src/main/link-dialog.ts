// SPDX-License-Identifier: AGPL-3.0-or-later
// The link dialog. Main resolves a link id from a body, keeps the URL, and
// sends the shell only what the dialog shows. The shell answers with the
// dialog's id and the user's choice; main checks the view and the URL's scheme
// again before it opens or copies anything.

import { randomBytes } from 'node:crypto';
import { clipboard, shell, type WebContents } from 'electron';
import { IPC, type LinkPrompt, type RejectCode } from '../shared/api';
import type { LinkAction } from '../shared/constants';
import type { Logger } from '../shared/log/writer';
import type { AppWindow } from './context';
import { schemeLabel } from './harden';
import { linkPrompt, linkScheme, resolveLink, type LinkRefusal } from './links';
import type { ViewLink } from './views';

/** The one dialog a window may have open. */
interface Pending {
  dialogId: string;
  token: string;
  generation: number;
  url: string;
}

export const DIALOG_ID_RE = /^[0-9a-f]{32}$/;

export class LinkDialog {
  /** What each dialog showed, kept only in builds with test hooks. */
  readonly shown: Array<{ windowId: number } & LinkPrompt> = [];
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly log: Logger,
    private readonly newId: () => string = () => randomBytes(16).toString('hex'),
  ) {}

  /**
   * Opens the dialog for a link id clicked in this window's body, or returns
   * why there is none. A new dialog replaces the window's previous one.
   */
  request(
    contents: WebContents,
    appWin: AppWindow,
    url: string,
    generation: number,
  ): LinkRefusal | null {
    const found = resolveLink(url, appWin.views, generation);
    if (!found.ok) return found.reason;
    this.show(contents, appWin.id, found.token, found.generation, found.link);
    return null;
  }

  private show(
    contents: WebContents,
    windowId: number,
    token: string,
    generation: number,
    link: ViewLink,
  ): void {
    const dialogId = this.newId();
    this.pending.set(windowId, { dialogId, token, generation, url: link.url });
    const prompt = linkPrompt(dialogId, link);
    this.log.info('nav.link_dialog', { scheme: schemeLabel(link.url), windowId });
    if (__PEV_TEST_HOOKS__) this.shown.push({ windowId, ...prompt });
    if (!contents.isDestroyed()) contents.send(IPC.linkDialog, prompt);
  }

  /**
   * Carries out the user's choice for the window's open dialog. Each dialog
   * takes one choice. Opening and copying need the view the link came from to
   * still be live at the current generation.
   */
  async act(
    appWin: AppWindow,
    dialogId: string,
    action: LinkAction,
    generation: number,
  ): Promise<RejectCode | null> {
    const pending = this.pending.get(appWin.id);
    if (!pending || pending.dialogId !== dialogId) return 'unknown_dialog';
    this.pending.delete(appWin.id);
    const windowId = appWin.id;
    const scheme = schemeLabel(pending.url);
    if (action === 'cancel') {
      this.log.info('nav.link_action', { action, scheme, windowId });
      return null;
    }
    if (pending.generation !== generation) return 'stale_generation';
    if (!appWin.views.lookup(pending.token)) return 'superseded';
    if (!linkScheme(pending.url)) return 'invalid';
    try {
      if (action === 'open') await shell.openExternal(pending.url);
      else await clipboard.writeText(pending.url);
    } catch {
      this.log.warn('nav.link_action', { action, scheme, windowId, reason: 'open_failed' });
      return null;
    }
    this.log.info('nav.link_action', { action, scheme, windowId });
    return null;
  }

  /** Drops a closed window's dialog. */
  forget(windowId: number): void {
    this.pending.delete(windowId);
  }
}
