// SPDX-License-Identifier: AGPL-3.0-or-later
// Starts the core utility process and talks to it over a MessagePort.
// Main's own requests start core on demand, and start it again after it
// exits. Calls the shell makes go only to a core already up for the open
// source (requestRunning): they never start one.
// Core starts with the source set at that moment, and keeps it until it
// exits: changing the source takes a stop and a new start.

import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from 'electron';
import type {
  CoreEvent,
  CoreInit,
  CoreRequest,
  CoreResult,
  CoreSource,
  CoreTestInit,
} from '../shared/core-protocol';
import type { Logger } from '../shared/log/writer';
import type { Stamp } from '../shared/sources';

type Pending = { resolve: (r: CoreResult) => void; reject: (e: Error) => void };

/** How long a stop waits for core to exit before it gives up on that core. */
export const STOP_TIMEOUT_MS = 5_000;

export interface CoreHostOptions {
  corePath: string;
  logsDir: string;
  /** `<userData>/index`. */
  indexDir: string;
  appRoot: string;
  log: Logger;
  /** Tests only: a shorter wait for a core that doesn't exit. */
  stopTimeoutMs?: number;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type CoreCall = DistributiveOmit<CoreRequest, 'reqId'>;

export class CoreUnavailableError extends Error {}

export class CoreHost {
  private child: UtilityProcess | null = null;
  private port: MessagePortMain | null = null;
  private starting: Promise<void> | null = null;
  /** Fails the start under way, for a core that is gone before it was ready. */
  private failStart: ((err: Error) => void) | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private source: CoreSource | null = null;
  /** The source the running core was started with. */
  private childSource: CoreSource | null = null;
  /** The running core has said it is ready. */
  private childReady = false;
  /** Receives what core reports without being asked. */
  onEvent: ((event: CoreEvent) => void) | null = null;
  /** The run folders of the exports the app knows, for the next start of core. */
  exports: () => string[] = () => [];
  /** Builds with test hooks only: what the next start of core gets for its tests. */
  testInit: CoreTestInit | null = null;

  constructor(private readonly options: CoreHostOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** The source the next start of core gets; a running core keeps its own. */
  setSource(source: CoreSource | null): void {
    this.source = source ? { ...source } : null;
  }

  /**
   * Starts core with this source, or with none. A core that was started with
   * another one is stopped first. Resolves true if one was stopped.
   */
  async startWith(source: CoreSource | null): Promise<boolean> {
    this.setSource(source);
    let replaced = false;
    if (this.child && !sameSource(this.childSource, this.source)) {
      await this.stop();
      replaced = true;
    }
    await this.start();
    return replaced;
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    const source = this.source;
    this.childSource = source;
    const starting = new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(this.options.corePath, [], {
        serviceName: 'Core',
        stdio: 'ignore',
      });
      const { port1, port2 } = new MessageChannelMain();
      this.child = child;
      this.port = port1;
      this.childReady = false;
      this.failStart = reject;
      port1.on('message', (event) => {
        const message = event.data as CoreResult | CoreEvent | { type: 'ready' };
        if (message.type === 'event') {
          // Only from the core this host is talking to.
          if (this.child === child) this.onEvent?.(message);
          return;
        }
        if (message.type === 'ready') {
          if (this.child !== child) return;
          this.childReady = true;
          this.failStart = null;
          this.options.log.info('core.ready');
          resolve();
          return;
        }
        const entry = this.pending.get(message.reqId);
        if (entry) {
          this.pending.delete(message.reqId);
          entry.resolve(message);
        }
      });
      port1.start();
      child.once('spawn', () => {
        // A core given up on before it spawned gets nothing, and is ended.
        if (this.child !== child) {
          child.kill();
          return;
        }
        this.options.log.info('core.spawn');
        const init: CoreInit = {
          type: 'init',
          logsDir: this.options.logsDir,
          appRoot: this.options.appRoot,
          indexDir: this.options.indexDir,
          source,
          exports: this.exports(),
          ...(__PEV_TEST_HOOKS__ && this.testInit ? { test: { ...this.testInit } } : {}),
        };
        child.postMessage(init, [port2]);
      });
      child.once('exit', (code) => {
        this.options.log.warn('core.exit', { exitCode: code });
        this.release(child);
      });
    });
    // Whoever started core gets the failure; nothing else has to wait for it.
    starting.catch(() => undefined);
    this.starting = starting;
    return starting;
  }

  /**
   * Forgets a core that exited, or that a stop gave up on: its requests fail,
   * and the next start makes a new one. A later exit of an older core changes
   * nothing.
   */
  private release(child: UtilityProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.childReady = false;
    this.childSource = null;
    this.port?.close();
    this.port = null;
    this.starting = null;
    this.failStart?.(new CoreUnavailableError());
    this.failStart = null;
    for (const entry of this.pending.values()) entry.reject(new CoreUnavailableError());
    this.pending.clear();
  }

  /**
   * A request only for a core already started for this stamp: the open
   * source's, or none when no source is open. It waits for that core to be
   * ready, but never starts one, so a call made while the source is being
   * switched can't start a core in the middle of the switch.
   */
  async requestRunning(call: CoreCall, stamp: Stamp | null): Promise<CoreResult> {
    const starting = this.starting;
    if (!this.child || !starting || !sameStamp(this.childSource, stamp)) {
      throw new CoreUnavailableError();
    }
    await starting;
    if (this.starting !== starting) throw new CoreUnavailableError();
    return this.send(call);
  }

  async request(call: CoreCall): Promise<CoreResult> {
    await this.start();
    return this.send(call);
  }

  private send(call: CoreCall): Promise<CoreResult> {
    const port = this.port;
    if (!port) return Promise.reject(new CoreUnavailableError());
    this.seq += 1;
    const reqId = this.seq;
    return new Promise<CoreResult>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      port.postMessage({ ...call, reqId } as CoreRequest);
    });
  }

  /**
   * Ends core; resolves once it has exited. A core that hasn't spawned yet
   * can't be killed, so it is killed as soon as it has. A core that doesn't
   * exit in time is given up on, so a stop always ends. The next request
   * starts a new one.
   */
  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    const ms = this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    return new Promise<void>((resolve) => {
      const kill = () => {
        child.kill();
      };
      const done = () => {
        clearTimeout(timer);
        child.removeListener('exit', done);
        child.removeListener('spawn', kill);
        this.release(child);
        resolve();
      };
      const timer = setTimeout(() => {
        this.options.log.warn('core.stop_timeout', { ms });
        done();
      }, ms);
      child.once('exit', done);
      if (!child.kill()) child.once('spawn', kill);
    });
  }
}

function sameStamp(source: CoreSource | null, stamp: Stamp | null): boolean {
  if (source === null || stamp === null) return source === stamp;
  return source.sourceKey === stamp.sourceKey && source.generation === stamp.generation;
}

function sameSource(a: CoreSource | null, b: CoreSource | null): boolean {
  if (a === null || b === null) return a === b;
  return a.sourceKey === b.sourceKey && a.generation === b.generation && a.root === b.root;
}
