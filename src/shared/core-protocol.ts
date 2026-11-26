// SPDX-License-Identifier: AGPL-3.0-or-later
// Messages between main and the core utility process, and between core and its reader worker.

import type { IndexAnswer, IndexOpened, IndexProgress, IndexQuery } from './index-types';
import type {
  BodyLink,
  ReadRequest,
  ReaderFailure,
  RenderedMessage,
  WorkerRender,
  WorkerRendered,
} from './reader-protocol';
import type { RunIdentity, ScanSummary, Stamp } from './sources';

/** The export run core serves. `root` is null while the run is unavailable. */
export interface CoreSource extends Stamp {
  root: string | null;
}

export interface CoreInit {
  type: 'init';
  logsDir: string;
  appRoot: string;
  /** `<userData>/index`: where each source's index is kept. */
  indexDir: string;
  /** Null until a source is open: core then has no access to any export. */
  source: CoreSource | null;
  /**
   * The run folder of every export the app knows. No index file is opened,
   * made or deleted while one of them overlaps the index folder.
   */
  exports: string[];
}

export interface StubAssetMessage {
  id: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface StubBodyMessage {
  html: string;
  assets: StubAssetMessage[];
  links?: BodyLink[];
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
  /** Test builds only: the arguments of a structured test action. */
  payload?: unknown;
}

/** The outcome of one file-system operation: `code` is the error code it failed with. */
export interface ProofOutcome {
  ok: boolean;
  code: string | null;
}

/** One file read: its size and SHA-256 (hex) when the read succeeded. */
export interface ProofFileRead extends ProofOutcome {
  path: string;
  bytes: number | null;
  sha256: string | null;
}

/** Files the write, create, rename and delete checks target. */
export interface ProofTargets {
  /** An existing file, opened for writing and appended to. */
  write: string;
  /** A file that doesn't exist yet, created exclusively. */
  create: string;
  /** An existing file, renamed to the same name plus `.renamed`. */
  rename: string;
  /** An existing file, deleted. */
  remove: string;
}

/** The change checks; they run in this order. */
export type ProofOpName = 'write' | 'create' | 'rename' | 'remove';

/**
 * What the change checks expect: the sandbox denies them, or (in the
 * unsandboxed control) they succeed. The first outcome that differs ends the
 * checks.
 */
export type ProofExpect = 'denied' | 'allowed';

/** Each change check's outcome; null for the checks after the first unexpected one. */
export type ProofOps = Record<ProofOpName, ProofOutcome | null>;

/** A walk of a whole folder, with the digest of every entry (see the proof tree module). */
export interface ProofScan extends ProofOutcome {
  digest: string | null;
  entries: number;
  files: number;
}

/** Folder-access proof calls, handled by core in builds with test hooks only. */
export type ProofCall =
  | { action: 'scan'; root: string; reads: string[] }
  | { action: 'ops'; targets: ProofTargets; expect: ProofExpect }
  | { action: 'read'; path: string };

export type ProofReply =
  | { action: 'scan'; pid: number; scan: ProofScan; worker: ProofFileRead[] | null }
  | { action: 'ops'; pid: number; ops: ProofOps }
  | { action: 'read'; pid: number; read: ProofFileRead };

export interface ProofRequest {
  type: 'proof';
  reqId: number;
  call: ProofCall;
}

/** Computes the open run's identity. */
export interface IdentifyRequest {
  type: 'identify';
  reqId: number;
  stamp: Stamp;
}

/** Scans the open run's folder and records what it rejects. */
export interface ScanRequest {
  type: 'scan';
  reqId: number;
  stamp: Stamp;
}

/**
 * Opens the open run's index: the one with this identity, or a new one if
 * there is none or it isn't usable. Phase 1 starts after the answer.
 */
export interface IndexRequest {
  type: 'index';
  reqId: number;
  stamp: Stamp;
  /** The identity the registry holds for this source's index; null if none. */
  dbUuid: string | null;
  /** The index is made in place of a damaged one. */
  rebuild?: boolean;
}

/**
 * Forgets a source: tears down its index if it is the open one, then deletes
 * its index files. Nothing of it is opened or created afterwards.
 */
export interface ForgetRequest {
  type: 'forget';
  reqId: number;
  sourceKey: string;
}

/**
 * Closes core to every open and rebuild, and tears down the open source's
 * index, before the app's data is deleted.
 */
export interface ResetRequest {
  type: 'reset';
  reqId: number;
}

/**
 * Core tells main about the open source's index without being asked: its
 * state changed, or (with `damaged`) it was found damaged, torn down and its
 * files deleted, so main can have it rebuilt.
 */
export interface CoreEvent {
  type: 'event';
  event: 'index';
  stamp: Stamp;
  progress: IndexProgress;
  damaged: boolean;
}

/** A read from the open run's index. */
export interface IndexQueryRequest {
  type: 'index-query';
  reqId: number;
  stamp: Stamp;
  query: IndexQuery;
}

export type CoreRequest =
  | OpenRequest
  | PingRequest
  | TestRequest
  | ProofRequest
  | IdentifyRequest
  | ScanRequest
  | ReadRequest
  | IndexRequest
  | IndexQueryRequest
  | ForgetRequest
  | ResetRequest;

export type CoreResult =
  | {
      type: 'result';
      reqId: number;
      ok: true;
      body?: StubBodyMessage;
      value?: number;
      /** Test builds only: the result of a structured test action. */
      data?: unknown;
      proof?: ProofReply;
      /** The source and generation the work was done for. */
      stamp?: Stamp;
      identity?: RunIdentity;
      scan?: ScanSummary;
      /** The rendered message of a `read`. */
      read?: RenderedMessage;
      index?: IndexOpened;
      answer?: IndexAnswer;
      progress?: IndexProgress;
    }
  | {
      type: 'result';
      reqId: number;
      ok: false;
      code:
        | 'unknown_stub'
        | 'worker_failed'
        | 'invalid'
        | 'stale'
        | 'no_source'
        | 'unavailable'
        | 'not_found'
        | 'superseded'
        | 'reader_failed'
        | 'no_index'
        | 'damaged'
        | 'closed'
        | 'busy';
      /** Why the reader gave no body, for `reader_failed`. */
      reason?: ReaderFailure;
      /** Test builds only: why a test action failed. */
      detail?: string;
      stamp?: Stamp;
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

/** Folder-access proof: read these files from the worker thread. */
export interface WorkerProofRead {
  type: 'proof-read';
  reqId: number;
  paths: string[];
}

export type WorkerRequest = WorkerBuild | WorkerTest | WorkerProofRead | WorkerRender;

export type WorkerMessage =
  | WorkerRendered
  | { type: 'result'; reqId: number; ok: true; body: StubBodyMessage }
  | { type: 'proof-read'; reqId: number; reads: ProofFileRead[] }
  | { type: 'result'; reqId: number; ok: false; code: 'unknown_stub' }
  | { type: 'log'; level: 'error' | 'warn' | 'info'; code: string; data?: Record<string, unknown> };
