// SPDX-License-Identifier: AGPL-3.0-or-later
// Messages between main and the core utility process, and between core and its reader worker.

export interface CoreInit {
  type: 'init';
  logsDir: string;
  appRoot: string;
}

export interface StubAssetMessage {
  id: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface StubBodyMessage {
  html: string;
  assets: StubAssetMessage[];
}

export interface OpenRequest {
  type: 'open';
  reqId: number;
  openId: number;
  generation: number;
  token: string;
  stubId: string;
}

export interface PingRequest {
  type: 'ping';
  reqId: number;
}

export interface TestRequest {
  type: 'test';
  reqId: number;
  action: string;
  markers?: string;
}

export type CoreRequest = OpenRequest | PingRequest | TestRequest;

export type CoreResult =
  | { type: 'result'; reqId: number; ok: true; body?: StubBodyMessage; value?: number }
  | {
      type: 'result';
      reqId: number;
      ok: false;
      code: 'unknown_stub' | 'worker_failed' | 'invalid';
    };

export interface WorkerBuild {
  type: 'build';
  reqId: number;
  stubId: string;
  token: string;
}

export interface WorkerTest {
  type: 'test';
  action: string;
  markers?: string;
}

export type WorkerRequest = WorkerBuild | WorkerTest;

export type WorkerMessage =
  | { type: 'result'; reqId: number; ok: true; body: StubBodyMessage }
  | { type: 'result'; reqId: number; ok: false; code: 'unknown_stub' }
  | { type: 'log'; level: 'error' | 'warn' | 'info'; code: string; data?: Record<string, unknown> };
