// SPDX-License-Identifier: AGPL-3.0-or-later
// Core-process side of the folder-access proof: core walks and reads a whole
// export, has its reader worker read single files, and tries the changes the
// sandbox must deny. Only builds with test hooks contain it.

import type {
  CoreResult,
  ProofFileRead,
  ProofReply,
  ProofRequest,
} from '../../shared/core-protocol';
import { markLoaded } from '../marker';
import { changeOps, readFile, scanTree } from './fs';

markLoaded();

export interface CoreProofDeps {
  reply: (result: CoreResult) => void;
  /** Has the reader worker read these files; null if the worker failed. */
  workerRead: (paths: string[]) => Promise<ProofFileRead[] | null>;
}

export async function handleProof(request: ProofRequest, deps: CoreProofDeps): Promise<void> {
  const { call } = request;
  let proof: ProofReply;
  switch (call.action) {
    case 'scan':
      proof = {
        action: 'scan',
        pid: process.pid,
        scan: scanTree(call.root),
        worker: await deps.workerRead(call.reads),
      };
      break;
    case 'ops':
      proof = { action: 'ops', pid: process.pid, ops: changeOps(call.targets) };
      break;
    case 'read':
      proof = { action: 'read', pid: process.pid, read: readFile(call.path) };
      break;
  }
  deps.reply({ type: 'result', reqId: request.reqId, ok: true, proof });
}
