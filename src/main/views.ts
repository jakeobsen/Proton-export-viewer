// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-window registry of message-body views. A window has at most one live
// view; it is revoked as soon as the next open is accepted.

import { randomBytes } from 'node:crypto';
import { BODY_SCHEME, VIEW_HOST } from '../shared/constants';
import type { FileIdentity, FileVersion } from '../shared/reader-protocol';

export interface ViewAsset {
  contentType: string;
  bytes: Uint8Array;
}

/** A link in a body: the body holds only its id, never the URL. */
export interface ViewLink {
  url: string;
  text: string;
}

/** What main keeps about one listed attachment; the shell knows it only by its index. */
export interface ViewAttachment {
  /** The part's dotted path in the message. */
  path: string;
  /** The cleaned file name. */
  name: string;
  /** The declared content type, lower-cased. */
  contentType: string;
  /** The decoded size, in bytes. */
  size: number;
}

/** What main keeps about the message a view shows, for the actions on it. */
export interface ViewMessage {
  /** The reader's rowid of the message. */
  rowid: number;
  /** The identity of the file the view was read from; null for a test input. */
  file: FileIdentity | null;
  /**
   * That file's size and time, unchanged across the read; null when it
   * changed meanwhile, or for a test input. A view without one can't save.
   */
  version: FileVersion | null;
  /** The subject as the header shows it: a saved message file is named after it. */
  subject: string;
  /** The Message-ID as Details shows it, or '' when the message has none. */
  messageId: string;
  /** Each listed attachment, by its index in the list the shell shows. */
  attachments: ViewAttachment[];
}

export interface View {
  token: string;
  openId: number;
  generation: number;
  html: string;
  assets: Map<string, ViewAsset>;
  /** Kept apart from the assets: a link id is never served. */
  links: Map<string, ViewLink>;
  /** The message a reader view shows; none for the test hooks' fixed bodies. */
  message: ViewMessage | null;
}

export interface ViewBody {
  html: string;
  assets: Array<{ id: string; contentType: string; bytes: Uint8Array }>;
  links?: Array<{ id: string; url: string; text: string }>;
  message?: ViewMessage;
}

export type InstallOutcome =
  { ok: true; view: View } | { ok: false; reason: 'open_id' | 'generation' };

export const TOKEN_RE = /^[0-9a-f]{32}$/;

export function bodyUrl(token: string): string {
  return `${BODY_SCHEME}://${VIEW_HOST}/${token}`;
}

export class ViewRegistry {
  private readonly live = new Map<string, View>();
  private latestOpenId = 0;
  private pendingToken: string | null = null;
  private authorized: string | null = null;

  constructor(private readonly newToken: () => string = () => randomBytes(16).toString('hex')) {}

  /**
   * Accepts a new open: revokes the live view right away and reserves a token
   * that only becomes live if this open is still the latest when it completes.
   */
  accept(): { openId: number; token: string; revoked: number } {
    const revoked = this.revokeAll();
    this.latestOpenId += 1;
    this.pendingToken = this.newToken();
    return { openId: this.latestOpenId, token: this.pendingToken, revoked };
  }

  install(
    openId: number,
    token: string,
    generation: number,
    currentGeneration: number,
    body: ViewBody,
  ): InstallOutcome {
    if (generation !== currentGeneration) return { ok: false, reason: 'generation' };
    if (openId !== this.latestOpenId || token !== this.pendingToken) {
      return { ok: false, reason: 'open_id' };
    }
    const view: View = {
      token,
      openId,
      generation,
      html: body.html,
      assets: new Map(
        body.assets.map((a) => [a.id, { contentType: a.contentType, bytes: a.bytes }]),
      ),
      links: new Map((body.links ?? []).map((l) => [l.id, { url: l.url, text: l.text }])),
      message: body.message ?? null,
    };
    this.live.set(token, view);
    this.pendingToken = null;
    this.authorized = bodyUrl(token);
    return { ok: true, view };
  }

  /** Drops the token reserved for `openId` when that open ends without a view. */
  abandon(openId: number): void {
    if (openId === this.latestOpenId) this.pendingToken = null;
  }

  /** Revokes the live view and any pending open. Returns how many views were live. */
  revokeAll(): number {
    const count = this.live.size;
    this.live.clear();
    this.pendingToken = null;
    this.authorized = null;
    return count;
  }

  /**
   * Closes the reader: revokes the live view and any pending open, which can
   * then install nothing, not even its fallback. Returns how many views were live.
   */
  close(): number {
    const revoked = this.revokeAll();
    this.latestOpenId += 1;
    return revoked;
  }

  lookup(token: string): View | undefined {
    return TOKEN_RE.test(token) ? this.live.get(token) : undefined;
  }

  /** The live view, if it is the one the open `openId` installed. */
  byOpenId(openId: number): View | undefined {
    for (const view of this.live.values()) if (view.openId === openId) return view;
    return undefined;
  }

  /** The only body URL the body frame may navigate to. */
  authorizedUrl(): string | null {
    return this.authorized;
  }

  get liveCount(): number {
    return this.live.size;
  }

  get latest(): number {
    return this.latestOpenId;
  }
}
