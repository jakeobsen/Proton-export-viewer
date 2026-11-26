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

export type CoreRequest = OpenRequest | PingRequest | TestRequest | ProofRequest;

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
    }
  | {
      type: 'result';
      reqId: number;
      ok: false;
      code: 'unknown_stub' | 'worker_failed' | 'invalid';
      /** Test builds only: why a test action failed. */
      detail?: string;
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

export type WorkerRequest = WorkerBuild | WorkerTest | WorkerProofRead;

export type WorkerMessage =
  | { type: 'result'; reqId: number; ok: true; body: StubBodyMessage }
  | { type: 'proof-read'; reqId: number; reads: ProofFileRead[] }
  | { type: 'result'; reqId: number; ok: false; code: 'unknown_stub' }
  | { type: 'log'; level: 'error' | 'warn' | 'info'; code: string; data?: Record<string, unknown> };
