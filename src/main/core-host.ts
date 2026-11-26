// SPDX-License-Identifier: AGPL-3.0-or-later
// Starts the core utility process and talks to it over a MessagePort.
// Core is started on demand and restarted on the next request after it exits.

import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from 'electron';
import type { CoreInit, CoreRequest, CoreResult } from '../shared/core-protocol';
import type { Logger } from '../shared/log/writer';

type Pending = { resolve: (r: CoreResult) => void; reject: (e: Error) => void };

export interface CoreHostOptions {
  corePath: string;
  logsDir: string;
  appRoot: string;
  log: Logger;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type CoreCall = DistributiveOmit<CoreRequest, 'reqId'>;

export class CoreUnavailableError extends Error {}

export class CoreHost {
  private child: UtilityProcess | null = null;
  private port: MessagePortMain | null = null;
  private starting: Promise<void> | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: CoreHostOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(this.options.corePath, [], {
        serviceName: 'Core',
        stdio: 'ignore',
      });
      const { port1, port2 } = new MessageChannelMain();
      this.child = child;
      this.port = port1;
      let ready = false;
      port1.on('message', (event) => {
        const message = event.data as CoreResult | { type: 'ready' };
        if (message.type === 'ready') {
          ready = true;
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
        this.options.log.info('core.spawn');
        const init: CoreInit = {
          type: 'init',
          logsDir: this.options.logsDir,
          appRoot: this.options.appRoot,
        };
        child.postMessage(init, [port2]);
      });
      child.once('exit', (code) => {
        this.options.log.warn('core.exit', { exitCode: code });
        this.child = null;
        this.port?.close();
        this.port = null;
        this.starting = null;
        for (const entry of this.pending.values()) entry.reject(new CoreUnavailableError());
        this.pending.clear();
        if (!ready) reject(new CoreUnavailableError());
      });
    });
    return this.starting;
  }

  async request(call: CoreCall): Promise<CoreResult> {
    await this.start();
    const port = this.port;
    if (!port) throw new CoreUnavailableError();
    this.seq += 1;
    const reqId = this.seq;
    return new Promise<CoreResult>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      port.postMessage({ ...call, reqId } as CoreRequest);
    });
  }

  /** Ends core; resolves once it has exited. The next request starts a new one. */
  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    return exited;
  }
}
