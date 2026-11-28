// SPDX-License-Identifier: AGPL-3.0-or-later
// Saving attachments and message files to the downloads folder.
//
// Main issues every save. A save waits its turn (one at a time, in the order
// asked, at most MAX_WAITING per window), then:
// 1. the downloads folder and the staging folder are checked not to be, or
//    lie inside, an export;
// 2. core opens the message's file, checked to be the one the view was read
//    from, and starts streaming;
// 3. main registers a one-shot asset under a new token that no renderer ever
//    sees, and has the window download it. `will-download` accepts only that
//    URL, started by main itself, into the staging folder; every other
//    download is cancelled;
// 4. once the download completed with every byte core checked, the file is
//    published into the downloads folder without replacing anything.
// A source switch, Forget, Reset, a closed window or quit cancels saves; a new
// view in the window (an expansion) does not.

import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { ASSET_SCHEME, VIEW_HOST } from '../../shared/constants';
import type { CoreResult } from '../../shared/core-protocol';
import type { Logger } from '../../shared/log/writer';
import type { FileIdentity, FileVersion } from '../../shared/reader-protocol';
import {
  SAVE_IDLE_MS,
  type SaveRequest as CoreSaveRequest,
  type SaveTarget,
} from '../../shared/save-protocol';
import type { Stamp } from '../../shared/sources';
import { insideExport } from './guard';
import { publish, type PublishFs } from './publish';
import { Staging } from './staging';
import { pullBody, type Pull } from './stream';

/** Saves that may wait per window, besides the one running. */
export const MAX_WAITING = 4;
/** How long main waits for the download of a save it started to begin. */
export const DOWNLOAD_START_MS = 30_000;
/** How many published files per window Show in Finder can still find. */
const SAVED_KEPT = 16;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
/** A save request to core, without the id the host gives it. */
type CoreCall = DistributiveOmit<CoreSaveRequest, 'reqId'>;

export interface SaveDeps {
  log: Logger;
  /** A request to the running core for this stamp; throws when there is none. */
  request(call: CoreCall, stamp: Stamp | null): Promise<CoreResult>;
  stamp(): Stamp | null;
  /** The downloads folder, as the app has it now. */
  downloads(): string;
  /** Every export the app knows, the open one included. */
  exportRoots(): string[];
  staging: Staging;
  idleMs?: number;
  downloadStartMs?: number;
}

/** Test builds only: ways to hold and steer a save from a test. */
export interface SaveTestHooks {
  /** How publishing reaches the file system. */
  publishFs?: PublishFs;
  /** Publish by the copy, as if link() from staging had failed. */
  forceCopy?: boolean;
  /** Called before main starts a save's download. */
  beforeDownload?: (url: string) => Promise<void>;
  /** Called with each staged file once its download has completed, before it is published. */
  onStaged?: (path: string) => Promise<void>;
  /** Called with how and where each save was published. */
  onPublished?: (method: 'link' | 'copy', path: string) => void;
}

/** The window a save is for. */
export interface SaveWindow {
  id: number;
  /** Starts a download of `url` in the window, as main. */
  download(url: string): void;
}

/** What a save needs from the view it was asked from. */
export interface SaveAsk {
  openId: number;
  generation: number;
  rowid: number;
  file: FileIdentity;
  version: FileVersion;
  target: SaveTarget;
  /** The asset id: `a<index>`, or `e` for the message file. */
  assetId: string;
  /** The cleaned name to publish under. */
  name: string;
}

export type SaveOutcome =
  { ok: true; saveId: number } | { ok: false; code: 'save_failed' | 'queue_full' };

/** Why a save failed, as logged. */
type FailReason =
  | 'export_root'
  | 'changed'
  | 'unreadable'
  | 'stalled'
  | 'short'
  | 'publish'
  | 'exists'
  | 'foreign'
  | 'cancelled'
  | 'generation'
  | 'window_closed'
  | 'quit'
  | 'not_found'
  | 'core_unavailable';

/** The part of a download item a save uses. */
export interface DownloadLike {
  getURL(): string;
  getURLChain(): string[];
  getInitiatorOrigin(): string;
  setSavePath(path: string): void;
  getReceivedBytes(): number;
  cancel(): void;
  once(event: 'done', listener: (event: unknown, state: string) => void): unknown;
}

interface Job {
  saveId: number;
  win: SaveWindow;
  ask: SaveAsk;
  resolve: (outcome: SaveOutcome) => void;
}

interface Running extends Job {
  started: number;
  size: number;
  url: string;
  token: string;
  staged: string;
  item: DownloadLike | null;
  /** Core sent the last chunk, after its check of the file. */
  coreDone: boolean;
  /** How the file was published. */
  method: 'link' | 'copy' | null;
  failure: FailReason | null;
  /** Resolves when the download has ended, or the save failed before it began. */
  ended: Promise<{ state: string; received: number }>;
  end: (value: { state: string; received: number }) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Saved {
  path: string;
  dev: string;
  ino: string;
  openId: number;
}

/** One window's saves: its one-shot assets, the download it expects and what it saved. */
export class WindowSaves {
  waiting = 0;
  readonly oneShots = new Map<string, { id: string; save: Running }>();
  expecting: Running | null = null;
  readonly saved = new Map<number, Saved>();

  constructor(
    readonly windowId: number,
    private readonly manager: SaveManager,
  ) {}

  /**
   * The body of a one-shot save asset, once; null if `token` and `id` name
   * none. A request a page made (one with an initiator) uses it up and fails
   * the save: only the browser's own download may fetch it.
   */
  serve(token: string, id: string, initiated: boolean): Response | null {
    const shot = this.oneShots.get(token);
    if (!shot || shot.id !== id) return null;
    this.oneShots.delete(token);
    if (initiated) {
      this.manager.fail(shot.save, 'foreign');
      return null;
    }
    return this.manager.body(shot.save);
  }

  /**
   * Whether `will-download` may go ahead: only the download of the save this
   * window expects, at its URL with no redirect, started by main (no
   * initiator, no frame). Anything it can't tell counts as foreign.
   */
  willDownload(item: DownloadLike, frame: unknown): boolean {
    const save = this.expecting;
    if (!save) return false;
    let url: string;
    let chain: string[];
    let origin: string;
    try {
      url = item.getURL();
      chain = item.getURLChain();
      origin = item.getInitiatorOrigin();
    } catch {
      return false;
    }
    if (url !== save.url) return false;
    this.expecting = null;
    if (chain.length !== 1 || chain[0] !== save.url || origin !== '' || frame !== null) {
      this.manager.fail(save, 'foreign');
      return false;
    }
    save.item = item;
    item.setSavePath(save.staged);
    item.once('done', (_event, state) => save.end({ state, received: item.getReceivedBytes() }));
    return true;
  }

  /** The published file of save `saveId` asked from view `openId`, if it is still that file. */
  savedFile(saveId: number, openId: number): Saved | null {
    const saved = this.saved.get(saveId);
    return saved && saved.openId === openId ? saved : null;
  }

  remember(saveId: number, saved: Saved): void {
    this.saved.set(saveId, saved);
    while (this.saved.size > SAVED_KEPT) {
      const oldest = this.saved.keys().next().value as number;
      this.saved.delete(oldest);
    }
  }
}

export class SaveManager {
  private readonly windows = new Map<number, WindowSaves>();
  private readonly queue: Job[] = [];
  private running: Running | null = null;
  private seq = 0;
  /** Test builds only. */
  test: SaveTestHooks = {};

  constructor(private readonly deps: SaveDeps) {}

  /** Where downloads wait to be published. */
  get stagingDir(): string {
    return this.deps.staging.dir;
  }

  /** The saves of window `windowId`. */
  forWindow(windowId: number): WindowSaves {
    let found = this.windows.get(windowId);
    if (!found) {
      found = new WindowSaves(windowId, this);
      this.windows.set(windowId, found);
    }
    return found;
  }

  /** Asks for a save; resolves when it has ended. */
  request(win: SaveWindow, ask: SaveAsk): Promise<SaveOutcome> {
    const saves = this.forWindow(win.id);
    if (saves.waiting >= MAX_WAITING) {
      this.deps.log.warn('save.queue_full', { windowId: win.id });
      return Promise.resolve({ ok: false, code: 'queue_full' });
    }
    this.seq += 1;
    const saveId = this.seq;
    saves.waiting += 1;
    return new Promise<SaveOutcome>((resolve) => {
      this.queue.push({ saveId, win, ask, resolve });
      this.next();
    });
  }

  /** Cancels every save, waiting or running: the source changed, or the app is reset. */
  cancelAll(reason: 'generation'): void {
    for (const job of this.queue.splice(0)) this.drop(job, reason);
    if (this.running) this.fail(this.running, reason);
  }

  /** Cancels a closed window's saves and forgets it. */
  closeWindow(windowId: number): void {
    for (const job of [...this.queue]) {
      if (job.win.id !== windowId) continue;
      this.queue.splice(this.queue.indexOf(job), 1);
      this.drop(job, 'window_closed');
    }
    if (this.running?.win.id === windowId) this.fail(this.running, 'window_closed');
    this.windows.delete(windowId);
  }

  /** At quit: cancels the running download and removes every staged or partial file, now. */
  quit(): void {
    for (const job of this.queue.splice(0)) this.drop(job, 'quit');
    if (this.running) this.fail(this.running, 'quit');
    this.deps.staging.sweep(
      (dir) => !insideExport(dir, this.deps.exportRoots()),
      (reason) => this.deps.log.warn('save.partial_kept', { reason }),
    );
  }

  private drop(job: Job, reason: FailReason): void {
    this.forWindow(job.win.id).waiting -= 1;
    this.deps.log.info('save.failed', { reason, windowId: job.win.id });
    job.resolve({ ok: false, code: 'save_failed' });
  }

  private next(): void {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.forWindow(job.win.id).waiting -= 1;
    void this.run(job);
  }

  /** Ends a save as failed (the first reason counts) and stops its download and its stream in core. */
  fail(save: Running, reason: FailReason): void {
    if (save.failure !== null) return;
    save.failure = reason;
    if (save.timer) clearTimeout(save.timer);
    save.timer = null;
    if (save.item) {
      // Chromium ends the download as cancelled and removes what it wrote.
      try {
        save.item.cancel();
      } catch {
        save.end({ state: 'cancelled', received: 0 });
      }
    } else {
      save.end({ state: 'cancelled', received: 0 });
    }
  }

  /** Restarts the no-progress timer of the running save. */
  private touch(save: Running, ms: number, reason: FailReason): void {
    if (save.timer) clearTimeout(save.timer);
    save.timer = setTimeout(() => this.fail(save, reason), ms);
  }

  /** The response body of a save: core's chunks, pulled as the download takes them. */
  body(save: Running): Response {
    const next = async (): Promise<Pull> => {
      if (save.failure !== null) throw new Error('save failed');
      let result: CoreResult;
      try {
        result = await this.deps.request(
          { type: 'save-pull', saveId: save.saveId },
          this.deps.stamp(),
        );
      } catch {
        this.fail(save, 'core_unavailable');
        throw new Error('core unavailable');
      }
      if (!result.ok) {
        const code = result.code;
        this.fail(
          save,
          code === 'changed' || code === 'unreadable' || code === 'stalled' ? code : 'cancelled',
        );
        throw new Error('save failed');
      }
      if (save.failure !== null) throw new Error('save failed');
      const chunk = result.chunk ?? new Uint8Array(0);
      if (result.done) save.coreDone = true;
      this.touch(save, this.deps.idleMs ?? SAVE_IDLE_MS, 'stalled');
      return { chunk, done: result.done === true };
    };
    return new Response(
      pullBody(next, () => this.fail(save, 'cancelled')),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(save.size),
          'Content-Disposition': 'attachment',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  }

  private async run(job: Job): Promise<void> {
    const { win, saveId } = job;
    const saves = this.forWindow(win.id);
    let end!: Running['end'];
    const save: Running = {
      ...job,
      started: Date.now(),
      size: 0,
      url: '',
      token: '',
      staged: '',
      item: null,
      coreDone: false,
      method: null,
      failure: null,
      ended: new Promise((resolve) => {
        end = resolve;
      }),
      end: (value) => end(value),
      timer: null,
    };
    this.running = save;
    let opened = false;
    let outcome: SaveOutcome = { ok: false, code: 'save_failed' };
    try {
      outcome = await this.steps(save, saves, () => {
        opened = true;
      });
    } catch {
      this.fail(save, 'publish');
    } finally {
      if (save.timer) clearTimeout(save.timer);
      saves.oneShots.delete(save.token);
      if (saves.expecting === save) saves.expecting = null;
      if (opened && !save.coreDone) {
        void this.deps
          .request({ type: 'save-cancel', saveId }, this.deps.stamp())
          .catch(() => undefined);
      }
      if (save.staged !== '') removeQuietly(save.staged);
      if (outcome.ok) {
        this.deps.log.info('save.done', {
          reason: save.method ?? 'link',
          bytes: save.size,
          ms: Date.now() - save.started,
          windowId: win.id,
        });
      } else {
        this.deps.log.info('save.failed', { reason: save.failure ?? 'publish', windowId: win.id });
      }
      this.running = null;
      job.resolve(outcome);
      this.next();
    }
  }

  private async steps(save: Running, saves: WindowSaves, onOpen: () => void): Promise<SaveOutcome> {
    const failed: SaveOutcome = { ok: false, code: 'save_failed' };
    const { ask, win, saveId } = save;
    this.deps.log.info('save.started', { windowId: win.id });

    // 1. Neither the downloads folder nor staging may be, or lie in, an export.
    const downloads = this.deps.downloads();
    const staging = this.deps.staging;
    if (
      insideExport(downloads, this.deps.exportRoots()) ||
      insideExport(staging.dir, this.deps.exportRoots())
    ) {
      this.fail(save, 'export_root');
      return failed;
    }
    let dest: string;
    try {
      mkdirSync(downloads, { recursive: true });
      dest = realpathSync.native(downloads);
      staging.ensure();
    } catch {
      this.fail(save, 'publish');
      return failed;
    }

    // 2. Core opens the file the view was read from, and checks it.
    let opened: CoreResult;
    try {
      opened = await this.deps.request(
        {
          type: 'save-open',
          saveId,
          generation: ask.generation,
          rowid: ask.rowid,
          file: ask.file,
          version: ask.version,
          target: ask.target,
        },
        this.deps.stamp(),
      );
    } catch {
      this.fail(save, 'core_unavailable');
      return failed;
    }
    if (!opened.ok) {
      const code = opened.code;
      this.fail(save, code === 'changed' || code === 'unreadable' ? code : 'not_found');
      return failed;
    }
    onOpen();
    if (save.failure !== null) return failed;
    save.size = opened.size ?? 0;

    // 3. A one-shot asset under a token no renderer sees, downloaded by main.
    save.token = randomBytes(16).toString('hex');
    save.url = `${ASSET_SCHEME}://${VIEW_HOST}/${save.token}/${ask.assetId}`;
    save.staged = staging.newFile();
    saves.oneShots.set(save.token, { id: ask.assetId, save });
    saves.expecting = save;
    if (__PEV_TEST_HOOKS__ && this.test.beforeDownload) await this.test.beforeDownload(save.url);
    this.touch(save, this.deps.downloadStartMs ?? DOWNLOAD_START_MS, 'stalled');
    try {
      if (save.failure === null) win.download(save.url);
    } catch {
      // The window is gone.
      this.fail(save, 'cancelled');
    }

    // 4. The download ends: complete, every byte, and core's check passed.
    const ended = await save.ended;
    if (save.timer) clearTimeout(save.timer);
    save.timer = null;
    if (save.failure !== null) return failed;
    if (ended.state !== 'completed' || ended.received !== save.size || !save.coreDone) {
      this.fail(save, 'short');
      return failed;
    }
    if (__PEV_TEST_HOOKS__ && this.test.onStaged) await this.test.onStaged(save.staged);
    if (save.failure !== null) return failed;

    // 5. Checked again just before publishing, then published without replacing.
    if (insideExport(dest, this.deps.exportRoots())) {
      this.fail(save, 'export_root');
      return failed;
    }
    const published = await publish(save.staged, dest, ask.name, {
      ...(__PEV_TEST_HOOKS__ && this.test.publishFs ? { fs: this.test.publishFs } : {}),
      ...(__PEV_TEST_HOOKS__ && this.test.forceCopy ? { forceCopy: true } : {}),
      partialPath: (dir) => Staging.partialIn(dir),
      notePartial: (path) => staging.notePartial(path),
      ownPartial: (path, id) => staging.ownPartial(path, id),
      clearNote: () => staging.clearNote(),
      onPartialKept: (reason) =>
        this.deps.log.warn('save.partial_kept', { reason, windowId: win.id }),
    });
    if (!published.ok) {
      this.fail(save, published.reason);
      return failed;
    }
    // A cancel that came during the publish leaves the file published: it is complete.
    save.method = published.method;
    if (__PEV_TEST_HOOKS__) this.test.onPublished?.(published.method, published.path);
    saves.remember(saveId, {
      path: published.path,
      dev: published.dev,
      ino: published.ino,
      openId: ask.openId,
    });
    return { ok: true, saveId };
  }
}

/** Removes a save's staged file, whatever its link count; quiet if it is gone. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Not there, or the next sweep removes it.
  }
}
