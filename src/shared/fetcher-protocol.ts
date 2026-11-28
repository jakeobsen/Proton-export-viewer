// SPDX-License-Identifier: AGPL-3.0-or-later
// Messages between main and the remote-image fetcher. The fetcher only ever
// gets a view key, a reference within that view and a URL: never a token, a
// path or a row id.

/** One image's limits, across all its redirects. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_MS = 10_000;
export const MAX_REDIRECTS = 5;
/** One view's limits. */
export const VIEW_MAX_IMAGES = 100;
export const VIEW_MAX_BYTES = 25 * 1024 * 1024;
export const VIEW_MAX_CONCURRENT = 6;

/** Why an image wasn't loaded. Fixed codes: they reach the logs. */
export const FETCH_REFUSALS = [
  // The URL.
  'invalid',
  'scheme',
  'userinfo',
  'port',
  // The addresses, and the connection.
  'address',
  'dns',
  'network',
  'tls',
  // The response.
  'status',
  'encoding',
  'redirects',
  // The raster check.
  'format',
  'canvas',
  'frames',
  'pixels',
  'container',
  // The budgets.
  'too_large',
  'total',
  'too_many',
  'timeout',
  // Main's side.
  'aborted',
  'crashed',
] as const;
export type FetchRefusal = (typeof FETCH_REFUSALS)[number];

export interface FetcherTestInit {
  /** The one loopback address and port the fetcher may reach. */
  loopbackAllow: { address: string; port: number };
  /** Every connect is recorded, for the tests to read. */
  recordConnects: boolean;
}

export interface FetcherInit {
  type: 'init';
  test?: FetcherTestInit;
}

export interface FetchRequest {
  type: 'fetch';
  viewKey: string;
  ref: string;
  url: string;
}

export interface AbortRequest {
  type: 'abort';
  viewKey: string;
}

/** Builds with test hooks only. */
export interface FetcherTestRequest {
  type: 'test';
  reqId: number;
  call: 'destinations' | 'read';
  /** For `read`: a file the fetcher tries to open. */
  path?: string;
}

export type ToFetcher = FetchRequest | AbortRequest | FetcherTestRequest;

export type FetchResult =
  | {
      type: 'result';
      viewKey: string;
      ref: string;
      ok: true;
      bytes: Uint8Array;
      /** What the fetcher's raster check found; main checks again and uses its own. */
      format: string;
      insecure: boolean;
    }
  | {
      type: 'result';
      viewKey: string;
      ref: string;
      ok: false;
      reason: FetchRefusal;
      insecure: boolean;
    };

export interface FetcherLog {
  type: 'log';
  level: 'error' | 'warn' | 'info';
  code: string;
  data?: Record<string, unknown>;
}

/** One connect: the address and port the socket reached, and the TLS server name sent. */
export interface Destination {
  address: string;
  port: number;
  servername: string | null;
}

export interface FetcherTestReply {
  type: 'test-reply';
  reqId: number;
  destinations?: Destination[];
  read?: { ok: boolean; code: string | null };
}

export type FromFetcher = { type: 'ready' } | FetchResult | FetcherLog | FetcherTestReply;
