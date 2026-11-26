// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader-worker side of the folder-access proof: reads single files from the
// worker thread. Only builds with test hooks contain it.

import type { WorkerMessage, WorkerProofRead } from '../../shared/core-protocol';
import { markLoaded } from '../marker';
import { readFile } from './fs';

markLoaded();

export function handleProofRead(request: WorkerProofRead): WorkerMessage {
  return { type: 'proof-read', reqId: request.reqId, reads: request.paths.map(readFile) };
}
