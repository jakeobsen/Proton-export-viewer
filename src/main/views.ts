// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-window registry of message-body views. A window has at most one live
// view; it is revoked as soon as the next open is accepted. A view may hold
// one attachment preview, which goes with it.

import { randomBytes } from 'node:crypto';
import { ASSET_SCHEME, BODY_SCHEME, VIEW_HOST } from '../shared/constants';
import type { AttachmentPreview, FileIdentity, FileVersion } from '../shared/reader-protocol';

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
  /** The format and canvas the whole part passed the raster check with; null: no preview. */
  preview: AttachmentPreview | null;
}

/** The attachment preview a view holds: one image, served under the view's token. */
export interface ViewPreview {
  /** Names the preview in its URLs (`p<n>`); a new preview gets a new number. */
  n: number;
  /** The attachment's index in the view's list. */
  index: number;
  /** The type of the format the bytes passed the raster check as. */
  contentType: string;
  bytes: Uint8Array;
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

/**
 * One showing of a window's message source, from View source to Back: the
 * header block it shows, under a URL of the view's own token that changes
 * with each block.
 */
export interface SourceState {
  /**
   * Names this showing among all of the window's: a read started for an
   * earlier one never shows, nor changes its paths, in a later one.
   */
  session: number;
  /** The number of the block shown, in its URL; 0 until the first. */
  n: number;
  /** The shell's latest selection; the answer to an older one is dropped. */
  seq: number;
  /** The block's document and text, once its first answer is in. */
  doc: string | null;
  text: string | null;
  /** The parts core read for the tree: a part is named only by one of these paths. */
  paths: ReadonlySet<string> | null;
  /** The message, and the file the view was read from (null for a fallback, which has none). */
  rowid: number;
  file: FileIdentity | null;
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
  /** Set while the source view shows. */
  source: SourceState | null;
  /**
   * The source blocks this view has shown, across every showing: a block's
   * URL is never used twice in the view's life.
   */
  sourceBlocks: number;
  /**
   * Only a source view, for an open the reader couldn't render: it has no
   * body, and its body URL is never authorized or served.
   */
  sourceOnly: boolean;
  /** The attachment preview the view shows, if any. */
  preview: ViewPreview | null;
}

/**
 * An open that ended with the reader's fallback: its message, for View
 * source, as often as it is asked for until the next open. The token is the
 * one the next source view of it gets.
 */
interface Fallback {
  openId: number;
  token: string;
  generation: number;
  rowid: number;
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

/** The URL of a view's `n`th source document. */
export function sourceUrl(token: string, n: number): string {
  return `${BODY_SCHEME}://${VIEW_HOST}/${token}/source/${n}`;
}

/** The fixed document that shows preview `n` of the view with `token`. */
export function previewUrl(token: string, n: number): string {
  return `${BODY_SCHEME}://${VIEW_HOST}/${token}/p${n}`;
}

/** The image of preview `n` of the view with `token`. */
export function previewAssetUrl(token: string, n: number): string {
  return `${ASSET_SCHEME}://${VIEW_HOST}/${token}/p${n}`;
}

export class ViewRegistry {
  private readonly live = new Map<string, View>();
  private latestOpenId = 0;
  private pendingToken: string | null = null;
  private authorized: string | null = null;
  private fallback: Fallback | null = null;
  private sourceSessions = 0;
  private previewSeq = 0;

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
      source: null,
      sourceBlocks: 0,
      sourceOnly: false,
      preview: null,
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

  /**
   * Records that the latest open ended with the reader's fallback. Its
   * reserved token is kept, for a source view of that message only.
   */
  markFallback(openId: number, generation: number, rowid: number): void {
    if (openId !== this.latestOpenId || this.pendingToken === null) return;
    this.fallback = { openId, token: this.pendingToken, generation, rowid };
    this.pendingToken = null;
  }

  /** The fallback of the open `openId`, while it is the window's latest. */
  fallbackFor(openId: number): { generation: number; rowid: number } | null {
    const f = this.fallback;
    return f && f.openId === openId && openId === this.latestOpenId
      ? { generation: f.generation, rowid: f.rowid }
      : null;
  }

  /**
   * Starts the source view for the open `openId`: of its live view, or of its
   * fallback, which becomes a view of its own with no body each time. Null
   * when that open is no longer the window's latest.
   */
  beginSource(openId: number): View | null {
    let view = this.byOpenId(openId) ?? null;
    let from: { rowid: number; file: FileIdentity | null } | null = view?.message
      ? { rowid: view.message.rowid, file: view.message.file }
      : null;
    if (!view && openId === this.latestOpenId) {
      const f = this.fallback;
      if (f && f.openId === openId) {
        from = { rowid: f.rowid, file: null };
        view = {
          token: f.token,
          openId,
          generation: f.generation,
          html: '',
          assets: new Map(),
          links: new Map(),
          message: null,
          source: null,
          sourceBlocks: 0,
          sourceOnly: true,
          preview: null,
        };
        this.live.set(f.token, view);
      }
    }
    if (!view || !from) return null;
    if (!view.source) {
      this.sourceSessions += 1;
      view.source = {
        session: this.sourceSessions,
        n: 0,
        seq: 0,
        doc: null,
        text: null,
        paths: null,
        ...from,
      };
    }
    return view;
  }

  /** True while `view` is live and showing its source. */
  inSource(view: View): view is View & { source: SourceState } {
    return this.live.get(view.token) === view && view.source !== null;
  }

  /** True while `view` is live and still in the showing of its source named `session`. */
  inSession(view: View, session: number): view is View & { source: SourceState } {
    return this.inSource(view) && view.source.session === session;
  }

  /** A new selection in the source view; answers for older ones are then dropped. */
  select(view: View): number | null {
    if (!this.inSource(view)) return null;
    view.source.seq += 1;
    return view.source.seq;
  }

  /**
   * Shows a header block as the view's next source document, if the showing
   * `session` still shows and `seq` is still its latest selection. Its URL
   * becomes the only one the body frame may load. Null if the answer came too
   * late.
   */
  showSource(view: View, session: number, seq: number, doc: string, text: string): string | null {
    if (!this.inSession(view, session) || view.source.seq !== seq) return null;
    view.sourceBlocks += 1;
    view.source.n = view.sourceBlocks;
    view.source.doc = doc;
    view.source.text = text;
    this.authorized = sourceUrl(view.token, view.source.n);
    return this.authorized;
  }

  /** The text of the block the source view shows, while it shows one. */
  shownText(view: View): string | null {
    return this.inSource(view) ? view.source.text : null;
  }

  /**
   * Leaves the source view. A view with a body gets its body URL back as the
   * only one the frame may load. A source-only view is revoked; its fallback
   * stays, under a new token, so View source can show it again with URLs
   * the revoked one never had.
   */
  leaveSource(view: View): string | null {
    if (this.live.get(view.token) !== view) return null;
    view.source = null;
    if (view.sourceOnly) {
      this.live.delete(view.token);
      this.authorized = null;
      const f = this.fallback;
      if (f && f.openId === view.openId && f.token === view.token) f.token = this.newToken();
      return null;
    }
    this.authorized = bodyUrl(view.token);
    return this.authorized;
  }

  /** The source document `n` of a live view, while it is the one shown. */
  sourceDoc(token: string, n: number): string | null {
    const view = this.lookup(token);
    const source = view?.source;
    return source && source.n === n && source.doc !== null ? source.doc : null;
  }

  /** Revokes the live view and any pending open. Returns how many views were live. */
  revokeAll(): number {
    const count = this.live.size;
    this.live.clear();
    this.pendingToken = null;
    this.authorized = null;
    this.fallback = null;
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

  /**
   * Gives the live view of open `openId`, if it still has `token`, a preview
   * of attachment `index`, in place of any it had. Returns its number, or
   * null when that view is no longer live.
   */
  setPreview(
    openId: number,
    token: string,
    index: number,
    contentType: string,
    bytes: Uint8Array,
  ): number | null {
    const view = this.byOpenId(openId);
    if (!view || view.token !== token) return null;
    this.previewSeq += 1;
    view.preview = { n: this.previewSeq, index, contentType, bytes };
    return this.previewSeq;
  }

  /** Drops the preview of the live view of open `openId`. Returns whether it had one. */
  clearPreview(openId: number): boolean {
    const view = this.byOpenId(openId);
    if (!view?.preview) return false;
    view.preview = null;
    return true;
  }

  /** The only preview URL a preview frame may navigate to: the live view's, while it has one. */
  previewFrameUrl(): string | null {
    for (const view of this.live.values()) {
      if (view.preview) return previewUrl(view.token, view.preview.n);
    }
    return null;
  }

  get liveCount(): number {
    return this.live.size;
  }

  get latest(): number {
    return this.latestOpenId;
  }
}
