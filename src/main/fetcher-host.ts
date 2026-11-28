// SPDX-License-Identifier: AGPL-3.0-or-later
// Starts the remote-image fetcher and talks to it over a MessagePort.
//
// The fetcher starts on demand and only through `spawnGuard`, which main sets
// to run the spawn while the open export's folder access is released, so the
// fetcher never holds it. A spawn waits a bounded time for the fetcher's
// ready message; a fetcher that exits or stays silent is killed, and the
// spawn fails. A fetcher that exits fails the images it still had with
// `crashed`; the next request starts a new one, through the guard again.
//
// The fetcher parses responses from servers the mail chose, so main trusts
// nothing it sends: every message is checked field by field, a result only
// counts for an image main is waiting for, its bytes are limited and checked
// again by main's own raster check, and the type served is the one main's
// check found. Its log events go through an allowlist and the log schema,
// at a capped rate.

import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from 'electron';
import { RASTER_CONTENT_TYPES, checkRaster, type RasterFormat } from '../core/reader/raster';
import {
  FETCH_REFUSALS,
  IMAGE_MAX_BYTES,
  type Destination,
  type FetcherInit,
  type FetcherTestInit,
  type FetcherTestReply,
  type FetchRefusal,
  type ToFetcher,
} from '../shared/fetcher-protocol';
import { isLogCode } from '../shared/log/codes';
import type { Logger } from '../shared/log/writer';

export const READY_TIMEOUT_MS = 10_000;
export const STOP_TIMEOUT_MS = 5_000;
/**
 * The fetcher's whole environment. Not empty: Electron gives a utility
 * process its parent's environment when the map it gets is empty.
 */
export const FETCHER_ENV: Readonly<Record<string, string>> = Object.freeze({
  PEV_PROCESS: 'fetcher',
});

/**
 * After this many crashes within the window, a request is refused with
 * `crashed` without a spawn until the window has passed: each spawn holds
 * the source queue and cycles the folder access, so a message whose images
 * crash the fetcher each time can't stall the app.
 */
export const CRASH_LIMIT = { crashes: 3, windowMs: 60_000 };

/**
 * The only codes the fetcher may send, each with the only fields it may
 * carry; main's own fetcher.* codes are refused, and any other field is left
 * out before the log schema checks the rest.
 */
export const RELAYED: Readonly<Record<string, readonly string[]>> = {
  'fetcher.fetched': ['statusClass', 'bytes', 'ms'],
  'fetcher.refused': ['reason', 'ms', 'statusClass'],
  'fetcher.uncaught': ['errorClass'],
  'fetcher.rejection': ['errorClass'],
};

/** At most this many relayed log events per window; the rest are counted and dropped. */
export const RELAY_LIMIT = { events: 200, windowMs: 10_000 };

export type ImageResult =
  | { ok: true; bytes: Uint8Array; format: RasterFormat; contentType: string; insecure: boolean }
  | { ok: false; reason: FetchRefusal; insecure: boolean };

export interface FetcherHostOptions {
  fetcherPath: string;
  /** Main's own log. */
  log: Logger;
  /** Where the fetcher's relayed events go: main's file, as proc `fetcher`. */
  relay: Logger;
  /** Runs a spawn; main makes it release the export's folder access around it. */
  spawnGuard: (spawn: () => Promise<void>) => Promise<void>;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  relayLimit?: { events: number; windowMs: number };
  crashLimit?: { crashes: number; windowMs: number };
  now?: () => number;
  /** Tests only: ends a process for good once its kill went unanswered. */
  killProcess?: (pid: number) => void;
}

export class FetcherUnavailableError extends Error {}

interface Pending {
  viewKey: string;
  resolve: (result: ImageResult) => void;
}

const LOG_LEVELS = ['error', 'warn', 'info'] as const;

function killHard(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

const keyOf = (viewKey: string, ref: string) => `${viewKey}\u0000${ref}`;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;

export class FetcherHost {
  private child: UtilityProcess | null = null;
  private port: MessagePortMain | null = null;
  private starting: Promise<void> | null = null;
  private failStart: ((err: Error) => void) | null = null;
  /** Fetchers being stopped on purpose, with what their pending images resolve to. */
  private readonly stopping = new WeakMap<UtilityProcess, FetchRefusal>();
  private readonly pending = new Map<string, Pending>();
  private relayWindow = { start: 0, events: 0, dropped: 0 };
  /** When recent fetchers crashed, oldest first. */
  private crashes: number[] = [];
  private crashHeld = false;
  private testSeq = 0;
  private readonly testPending = new Map<number, (reply: FetcherTestReply) => void>();
  /** Builds with test hooks only: what the next fetcher gets for its tests. */
  testInit: FetcherTestInit | null = null;

  constructor(private readonly options: FetcherHostOptions) {}

  get running(): boolean {
    return this.child !== null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Makes sure a fetcher is up and ready, starting one through the guard if needed. */
  ensure(): Promise<void> {
    if (this.starting) return this.starting;
    // Ready already: a start whose guard failed afterwards (the folder access
    // couldn't be started again) still left a fetcher that holds no access.
    if (this.child && this.port && !this.failStart) return Promise.resolve();
    if (this.crashLimited()) return Promise.reject(new FetcherUnavailableError());
    const starting = this.options.spawnGuard(() => this.spawn());
    this.starting = starting;
    starting.catch(() => {
      if (this.starting === starting) this.starting = null;
    });
    return starting;
  }

  /** Fetches one image for a view. Never rejects: a failure is a refusal. */
  fetch(viewKey: string, ref: string, url: string): Promise<ImageResult> {
    const key = keyOf(viewKey, ref);
    const existing = this.pending.get(key);
    if (existing) return Promise.resolve({ ok: false, reason: 'invalid', insecure: false });
    return new Promise<ImageResult>((resolve) => {
      this.pending.set(key, { viewKey, resolve });
      this.ensure().then(
        () => {
          // Aborted, or failed by an exit, while the fetcher started.
          if (this.pending.get(key)?.resolve !== resolve) return;
          if (!this.port) {
            this.settle(key, { ok: false, reason: 'crashed', insecure: false });
            return;
          }
          this.post({ type: 'fetch', viewKey, ref, url });
        },
        () => this.settle(key, { ok: false, reason: 'crashed', insecure: false }),
      );
    });
  }

  /** Stops a view's images at once: they resolve `aborted` now, and the fetcher drops them. */
  abort(viewKey: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.viewKey !== viewKey) continue;
      this.pending.delete(key);
      entry.resolve({ ok: false, reason: 'aborted', insecure: false });
    }
    if (this.port) this.post({ type: 'abort', viewKey });
  }

  /** Views with an image still pending. */
  pendingViews(): Set<string> {
    return new Set([...this.pending.values()].map((p) => p.viewKey));
  }

  /** Builds with test hooks only: asks the running fetcher something. */
  testCall(call: 'destinations'): Promise<Destination[]>;
  testCall(call: 'read', path: string): Promise<{ ok: boolean; code: string | null }>;
  testCall(call: 'destinations' | 'read', path?: string): Promise<unknown> {
    if (!__PEV_TEST_HOOKS__ || !this.port) return Promise.reject(new FetcherUnavailableError());
    this.testSeq += 1;
    const reqId = this.testSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.testPending.delete(reqId);
        reject(new FetcherUnavailableError());
      }, this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
      this.testPending.set(reqId, (reply) => {
        clearTimeout(timer);
        resolve(call === 'destinations' ? (reply.destinations ?? []) : reply.read);
      });
      this.post({ type: 'test', reqId, call, ...(path === undefined ? {} : { path }) });
    });
  }

  private post(message: ToFetcher): void {
    this.port?.postMessage(message);
  }

  private settle(key: string, result: ImageResult): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    entry.resolve(result);
  }

  /** True while recent crashes hold spawns back; logs the hold once. */
  private crashLimited(): boolean {
    const limit = this.options.crashLimit ?? CRASH_LIMIT;
    const now = (this.options.now ?? Date.now)();
    this.crashes = this.crashes.filter((t) => now - t < limit.windowMs);
    const held = this.crashes.length >= limit.crashes;
    if (held && !this.crashHeld) {
      this.options.log.warn('fetcher.crash_limit', { count: this.crashes.length });
    }
    this.crashHeld = held;
    return held;
  }

  private spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: UtilityProcess;
      try {
        child = utilityProcess.fork(this.options.fetcherPath, [], {
          serviceName: 'Fetcher',
          stdio: 'ignore',
          // Nothing of main's environment: no proxy, no extra certificates,
          // no TLS or Node options can reach the fetcher. Electron starts a
          // utility process with its parent's environment when the map is
          // empty, so the map holds one fixed entry and nothing else.
          env: { ...FETCHER_ENV },
        });
      } catch (err) {
        this.crashes.push((this.options.now ?? Date.now)());
        reject(err instanceof Error ? err : new FetcherUnavailableError());
        return;
      }
      const { port1, port2 } = new MessageChannelMain();
      this.child = child;
      this.port = port1;
      const ms = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (this.child !== child) return;
        this.options.log.warn('fetcher.ready_timeout', { ms });
        void this.stopChild(child, 'crashed');
      }, ms);
      this.failStart = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      port1.on('message', (event) => {
        if (this.child !== child) return;
        const message: unknown = event.data;
        if (isPlainObject(message) && message.type === 'ready' && this.failStart) {
          clearTimeout(timer);
          this.failStart = null;
          this.options.log.info('fetcher.ready');
          resolve();
          return;
        }
        this.receive(message);
      });
      port1.start();
      child.once('spawn', () => {
        if (this.child !== child) {
          child.kill();
          return;
        }
        this.options.log.info('fetcher.spawn');
        const init: FetcherInit = {
          type: 'init',
          ...(__PEV_TEST_HOOKS__ && this.testInit ? { test: { ...this.testInit } } : {}),
        };
        child.postMessage(init, [port2]);
      });
      child.once('exit', (code) => {
        this.options.log.warn('fetcher.exit', { exitCode: code });
        this.release(child);
      });
    });
  }

  /** Forgets a fetcher that exited or was given up on: its images fail, and a start under way fails. */
  private release(child: UtilityProcess): void {
    if (this.child !== child) return;
    const reason = this.stopping.get(child) ?? 'crashed';
    if (reason === 'crashed') this.crashes.push((this.options.now ?? Date.now)());
    this.child = null;
    this.port?.close();
    this.port = null;
    this.starting = null;
    this.failStart?.(new FetcherUnavailableError());
    this.failStart = null;
    for (const entry of this.pending.values())
      entry.resolve({ ok: false, reason, insecure: false });
    this.pending.clear();
    this.testPending.clear();
  }

  /** Checks one message from the fetcher; anything that doesn't fit is dropped. */
  private receive(message: unknown): void {
    if (!isPlainObject(message)) return;
    if (message.type === 'result') this.receiveResult(message);
    else if (message.type === 'log') this.relay(message);
    else if (__PEV_TEST_HOOKS__ && message.type === 'test-reply') {
      const reqId = message.reqId;
      if (typeof reqId !== 'number') return;
      const done = this.testPending.get(reqId);
      this.testPending.delete(reqId);
      done?.(message as unknown as FetcherTestReply);
    }
  }

  private receiveResult(message: Record<string, unknown>): void {
    const { viewKey, ref, ok, insecure } = message;
    if (typeof viewKey !== 'string' || typeof ref !== 'string') return;
    const key = keyOf(viewKey, ref);
    // Only for an image main is waiting for.
    if (!this.pending.has(key)) return;
    if (typeof insecure !== 'boolean') {
      this.settle(key, { ok: false, reason: 'invalid', insecure: false });
      return;
    }
    if (ok === false) {
      const reason = message.reason;
      const known =
        typeof reason === 'string' && (FETCH_REFUSALS as readonly string[]).includes(reason);
      this.settle(key, {
        ok: false,
        reason: known ? (reason as FetchRefusal) : 'invalid',
        insecure,
      });
      return;
    }
    const bytes = message.bytes;
    if (
      ok !== true ||
      !(bytes instanceof Uint8Array) ||
      bytes.length === 0 ||
      bytes.length > IMAGE_MAX_BYTES
    ) {
      this.settle(key, { ok: false, reason: 'invalid', insecure });
      return;
    }
    // Main's own check decides, whatever the fetcher said the format was.
    const own = new Uint8Array(bytes);
    const check = checkRaster(own);
    if (!check.ok) {
      this.settle(key, { ok: false, reason: check.reason, insecure });
      return;
    }
    this.settle(key, {
      ok: true,
      bytes: own,
      format: check.image.format,
      contentType: RASTER_CONTENT_TYPES[check.image.format],
      insecure,
    });
  }

  /** Writes a fetcher log event to main's file, if it is one the fetcher may send. */
  private relay(message: Record<string, unknown>): void {
    const { level, code, data } = message;
    if (typeof level !== 'string' || !(LOG_LEVELS as readonly string[]).includes(level)) return;
    if (typeof code !== 'string' || !Object.hasOwn(RELAYED, code) || !isLogCode(code)) return;
    if (data !== undefined && !isPlainObject(data)) return;
    if (!this.withinRelayLimit()) return;
    const fields = RELAYED[code]!;
    const kept =
      data === undefined
        ? undefined
        : Object.fromEntries(Object.entries(data).filter(([key]) => fields.includes(key)));
    this.options.relay.log(level as (typeof LOG_LEVELS)[number], code, kept);
  }

  private withinRelayLimit(): boolean {
    const limit = this.options.relayLimit ?? RELAY_LIMIT;
    const now = (this.options.now ?? Date.now)();
    const window = this.relayWindow;
    if (now - window.start >= limit.windowMs) {
      if (window.dropped > 0) {
        this.options.log.warn('fetcher.relay_dropped', { count: window.dropped });
      }
      this.relayWindow = { start: now, events: 0, dropped: 0 };
    }
    if (this.relayWindow.events >= limit.events) {
      this.relayWindow.dropped += 1;
      return false;
    }
    this.relayWindow.events += 1;
    return true;
  }

  /** Ends the fetcher; resolves once it has exited or was given up on. Its images fail `aborted`. */
  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    return this.stopChild(child, 'aborted');
  }

  private stopChild(child: UtilityProcess, reason: FetchRefusal): Promise<void> {
    this.stopping.set(child, reason);
    const ms = this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    return new Promise<void>((resolve) => {
      const kill = () => {
        child.kill();
      };
      const exited = () => {
        clearTimeout(timer);
        child.removeListener('spawn', kill);
        this.release(child);
        resolve();
      };
      const timer = setTimeout(() => {
        this.options.log.warn('fetcher.stop_timeout', { ms });
        child.removeListener('exit', exited);
        child.removeListener('spawn', kill);
        if (child.pid !== undefined) (this.options.killProcess ?? killHard)(child.pid);
        this.release(child);
        resolve();
      }, ms);
      child.once('exit', exited);
      if (!child.kill()) child.once('spawn', kill);
    });
  }
}
