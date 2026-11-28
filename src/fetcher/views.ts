// SPDX-License-Identifier: AGPL-3.0-or-later
// Each view's images: at most VIEW_MAX_IMAGES started, VIEW_MAX_BYTES received
// and VIEW_MAX_CONCURRENT at once; the rest wait their turn. Aborting a view
// stops its requests at once and drops what waits.

import {
  VIEW_MAX_BYTES,
  VIEW_MAX_CONCURRENT,
  VIEW_MAX_IMAGES,
  type FetchRefusal,
  type FetchRequest,
} from '../shared/fetcher-protocol';
import type { ImageOutcome, ViewBytes } from './request';

export type RunImage = (url: string, view: ViewBytes, signal: AbortSignal) => Promise<ImageOutcome>;

interface View {
  started: number;
  received: number;
  active: number;
  waiting: FetchRequest[];
  controller: AbortController;
  bytes: ViewBytes;
}

export interface ViewLimits {
  images: number;
  bytes: number;
  concurrent: number;
}

export const VIEW_LIMITS: ViewLimits = {
  images: VIEW_MAX_IMAGES,
  bytes: VIEW_MAX_BYTES,
  concurrent: VIEW_MAX_CONCURRENT,
};

export class ViewScheduler {
  private readonly views = new Map<string, View>();

  constructor(
    private readonly run: RunImage,
    /** Told each image's outcome, unless its view was aborted first. */
    private readonly done: (request: FetchRequest, outcome: ImageOutcome) => void,
    private readonly limits: ViewLimits = VIEW_LIMITS,
  ) {}

  /** Requests in flight or waiting, for one view or all. */
  pending(viewKey?: string): number {
    const count = (v: View) => v.active + v.waiting.length;
    if (viewKey !== undefined) {
      const view = this.views.get(viewKey);
      return view ? count(view) : 0;
    }
    let total = 0;
    for (const view of this.views.values()) total += count(view);
    return total;
  }

  fetch(request: FetchRequest): void {
    const view = this.viewFor(request.viewKey);
    if (view.started >= this.limits.images) {
      this.refuse(request, 'too_many');
      return;
    }
    view.started += 1;
    view.waiting.push(request);
    this.pump(request.viewKey, view);
  }

  abort(viewKey: string): void {
    const view = this.views.get(viewKey);
    if (!view) return;
    this.views.delete(viewKey);
    view.waiting = [];
    view.controller.abort();
  }

  private viewFor(viewKey: string): View {
    let view = this.views.get(viewKey);
    if (!view) {
      const created: View = {
        started: 0,
        received: 0,
        active: 0,
        waiting: [],
        controller: new AbortController(),
        bytes: {
          take: (n) => {
            created.received += n;
            return created.received <= this.limits.bytes;
          },
          left: () => Math.max(0, this.limits.bytes - created.received),
        },
      };
      view = created;
      this.views.set(viewKey, view);
    }
    return view;
  }

  private refuse(request: FetchRequest, reason: FetchRefusal): void {
    this.done(request, { ok: false, reason, insecure: false, status: null, ms: 0 });
  }

  private pump(viewKey: string, view: View): void {
    while (view.active < this.limits.concurrent && view.waiting.length > 0) {
      const request = view.waiting.shift()!;
      view.active += 1;
      void this.run(request.url, view.bytes, view.controller.signal)
        .catch((): ImageOutcome => ({
          ok: false,
          reason: 'network',
          insecure: false,
          status: null,
          ms: 0,
        }))
        .then((outcome) => {
          view.active -= 1;
          // An aborted view's outcomes go nowhere: main has failed them already.
          if (this.views.get(viewKey) !== view) return;
          this.done(request, outcome);
          this.pump(viewKey, view);
        });
    }
  }
}
