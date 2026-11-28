// SPDX-License-Identifier: AGPL-3.0-or-later
// Remote images of a body view, once the user allowed them for that view.
//
// Before consent every `r<n>` is the placeholder and the fetcher is never
// touched. Consent is per view and single-flight: the first request starts
// the fetcher and, only once it is ready and the view is still live, allows
// the view and one more load of its body; a request that comes while it runs
// joins it. After consent an image is fetched only when the frame asks for
// it, once, and its result stays with the view until the view is revoked.
// The shell learns counts only. When no live view in any window has consent
// under way or given, the fetcher is stopped.

import { randomBytes } from 'node:crypto';
import { MAX_BODY_REFERENCES, MAX_REMOTE_URL_LENGTH } from '../shared/constants';
import type { Logger } from '../shared/log/writer';
import type { ImageResult } from './fetcher-host';
import type { ConsentOutcome, RemoteCounts, View, ViewRegistry } from './views';

/** The least time between two count updates for one view. */
export const STATUS_INTERVAL_MS = 250;

const REF_RE = /^r([1-9]\d{0,3})$/;

/** What main needs of the fetcher host. */
export interface RemoteFetcher {
  readonly running: boolean;
  ensure(): Promise<void>;
  fetch(viewKey: string, ref: string, url: string): Promise<ImageResult>;
  abort(viewKey: string): void;
  stop(): Promise<void>;
}

/** A view's window: its registry, its id for logs, and where its counts go. */
export interface ViewOwner {
  views: ViewRegistry;
  windowId: number;
  send: (view: View, counts: RemoteCounts) => void;
}

export interface RemoteImagesOptions {
  fetcher: RemoteFetcher;
  log: Logger;
  /** Every live view of every window. */
  liveViews: () => Iterable<View>;
  newKey?: () => string;
  statusIntervalMs?: number;
}

export type Served =
  | { kind: 'image'; bytes: Uint8Array; contentType: string }
  | { kind: 'placeholder' }
  | { kind: 'revoked' };

/**
 * Checks the remote URLs the reader gave for a body with `count` remote ids:
 * one per id, each an absolute http or https URL no longer than the
 * sanitizer keeps. Returns the list, or null when the view can't load them.
 */
export function checkRemoteRefs(refs: unknown, count: number): string[] | null {
  if (count < 1 || count > MAX_BODY_REFERENCES) return null;
  if (!Array.isArray(refs) || refs.length !== count) return null;
  const out: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.length > MAX_REMOTE_URL_LENGTH) return null;
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return null;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return null;
    out.push(ref);
  }
  return out;
}

interface Status {
  owner: ViewOwner;
  timer: ReturnType<typeof setTimeout> | null;
  /** A count changed while the timer ran: it is sent when the timer ends. */
  held: boolean;
}

export class RemoteImages {
  private readonly status = new WeakMap<View, Status>();
  /** An idle stop under way: a new consent waits for it, so it gets a fetcher that stays. */
  private stopping: Promise<void> | null = null;
  /** Builds with test hooks only: consent attempts wait for this before starting the fetcher. */
  testHold: Promise<void> | null = null;
  /** How many consent attempts were started. */
  attempts = 0;

  constructor(private readonly options: RemoteImagesOptions) {}

  /** Consent for the live `view`: starts the fetcher, then allows the view and one reload. */
  allow(owner: ViewOwner, view: View): Promise<ConsentOutcome> {
    const remote = view.remote;
    if (remote.consent === 'allowed') return Promise.resolve({ ok: true, reload: false });
    if (remote.consent === 'pending' && remote.attempt) {
      return remote.attempt.then((outcome) => (outcome.ok ? { ok: true, reload: false } : outcome));
    }
    remote.consent = 'pending';
    remote.viewKey ??= this.newKey(view.token);
    this.status.set(view, { owner, timer: null, held: false });
    const attempt = this.attempt(owner, view);
    remote.attempt = attempt;
    return attempt;
  }

  private async attempt(owner: ViewOwner, view: View): Promise<ConsentOutcome> {
    const remote = view.remote;
    this.attempts += 1;
    let started = true;
    try {
      if (__PEV_TEST_HOOKS__ && this.testHold) await this.testHold;
      if (this.stopping) await this.stopping;
      await this.options.fetcher.ensure();
    } catch {
      started = false;
    }
    remote.attempt = null;
    if (!owner.views.isLive(view)) {
      remote.consent = 'none';
      this.options.log.info('remote.refused', { reason: 'not_live', windowId: owner.windowId });
      this.stopIfIdle();
      return { ok: false, code: 'not_live' };
    }
    if (!started) {
      remote.consent = 'none';
      this.options.log.warn('remote.refused', { reason: 'unavailable', windowId: owner.windowId });
      this.stopIfIdle();
      return { ok: false, code: 'unavailable' };
    }
    // Only now: no image of the old frame reaches the fetcher before it is ready.
    remote.consent = 'allowed';
    owner.views.grantLoad(view);
    this.options.log.info('remote.allowed', { openId: view.openId, windowId: owner.windowId });
    return { ok: true, reload: true };
  }

  /**
   * What the frame gets for `ref` of the live `view`: the placeholder before
   * consent; after it, the image, fetched on its first request and shared by
   * every request for it, or the placeholder when it couldn't load.
   */
  async serve(views: ViewRegistry, view: View, ref: string): Promise<Served> {
    const remote = view.remote;
    const match = REF_RE.exec(ref);
    const url = match ? remote.refs?.[Number(match[1]) - 1] : undefined;
    if (remote.consent !== 'allowed' || remote.viewKey === null || url === undefined) {
      return { kind: 'placeholder' };
    }
    let image = remote.images.get(ref);
    if (!image) {
      image = this.options.fetcher.fetch(remote.viewKey, ref, url).then((result) => {
        this.settled(views, view, result);
        return result;
      });
      remote.images.set(ref, image);
    }
    const result = await image;
    if (!views.isLive(view)) return { kind: 'revoked' };
    if (!result.ok) return { kind: 'placeholder' };
    remote.served += 1;
    return { kind: 'image', bytes: result.bytes, contentType: result.contentType };
  }

  private settled(views: ViewRegistry, view: View, result: ImageResult): void {
    if (!views.isLive(view)) {
      this.stopIfIdle();
      return;
    }
    const counts = view.remote.counts;
    if (!result.ok) counts.refused += 1;
    else if (result.insecure) counts.insecure += 1;
    this.push(view);
  }

  /** Sends the view's counts at most once per interval; a change inside it is sent at its end. */
  private push(view: View): void {
    const status = this.status.get(view);
    if (!status) return;
    if (status.timer) {
      status.held = true;
      return;
    }
    const ms = this.options.statusIntervalMs ?? STATUS_INTERVAL_MS;
    const send = () => status.owner.send(view, { ...view.remote.counts });
    const tick = () => {
      if (!status.held) {
        status.timer = null;
        return;
      }
      status.held = false;
      send();
      status.timer = setTimeout(tick, ms);
    };
    send();
    status.timer = setTimeout(tick, ms);
  }

  /** A view was revoked: its images stop at once and its bytes and URLs go. */
  revoked(view: View): void {
    const remote = view.remote;
    const status = this.status.get(view);
    if (status?.timer) clearTimeout(status.timer);
    this.status.delete(view);
    if (remote.viewKey !== null) this.options.fetcher.abort(remote.viewKey);
    if (remote.served > 0) this.options.log.info('remote.served', { count: remote.served });
    remote.images.clear();
    remote.refs = null;
    this.stopIfIdle();
  }

  /** Stops the fetcher when no live view has consent under way or given. */
  private stopIfIdle(): void {
    for (const view of this.options.liveViews()) {
      if (view.remote.consent !== 'none') return;
    }
    if (!this.options.fetcher.running) return;
    this.options.log.info('fetcher.stopped', { reason: 'idle' });
    const stopping = this.options.fetcher.stop().finally(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
  }

  private newKey(token: string): string {
    const make = this.options.newKey ?? (() => randomBytes(16).toString('hex'));
    let key = make();
    while (key === token) key = make();
    return key;
  }
}
