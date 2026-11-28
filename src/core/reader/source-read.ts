// SPDX-License-Identifier: AGPL-3.0-or-later
// The source view's reads in core: the message's header block, its parts, or
// one part's header block, read in the reader lane. Only from the file the
// view was read from, when main names one: a file changed since is refused.

import type { CoreResult, WorkerMessage, WorkerRequest } from '../../shared/core-protocol';
import type { ReaderFailure, SourceRequest } from '../../shared/reader-protocol';
import type { ReaderFile } from '../source';
import type { JobOutcome, JobSlot } from './lane';

export interface SourceReadDeps {
  /** Opens the message's file, as the reader's opens do. */
  open(request: SourceRequest): Promise<ReaderFile | { ok: false; code: 'no_source' }>;
  /** Runs a job in the reader lane. */
  job(message: WorkerRequest, slot: JobSlot | null): Promise<JobOutcome<WorkerMessage>>;
  reply(result: CoreResult): void;
}

/**
 * Answers one source request. A part's read gives way to a newer selection
 * in the same window while it waits.
 */
export async function readSource(request: SourceRequest, deps: SourceReadDeps): Promise<void> {
  const { reqId } = request;
  const fail = (
    code:
      | 'no_source'
      | 'not_found'
      | 'superseded'
      | 'unavailable'
      | 'eml_missing'
      | 'changed'
      | 'reader_failed',
    reason?: ReaderFailure,
  ) => deps.reply({ type: 'result', reqId, ok: false, code, ...(reason ? { reason } : {}) });
  const found = await deps.open(request);
  if (!found.ok) return found.code === 'refused' ? fail('reader_failed', 'file') : fail(found.code);
  const opened = found.opened;
  try {
    const expected = request.file;
    if (
      expected &&
      (!opened.file || opened.file.dev !== expected.dev || opened.file.ino !== expected.ino)
    ) {
      return fail('changed');
    }
    const slot =
      request.what.kind === 'part' && request.order !== undefined
        ? { key: -request.lane, order: request.order }
        : null;
    const outcome = await deps.job(
      { type: 'source', reqId, input: opened.input, what: request.what },
      slot,
    );
    if (!outcome.ok) {
      return outcome.reason === 'superseded'
        ? fail('superseded')
        : fail('reader_failed', outcome.reason);
    }
    const message = outcome.message;
    if (message.type !== 'sourced') return fail('reader_failed', 'crash');
    if (!message.ok) return fail('reader_failed', 'parse');
    deps.reply({
      type: 'result',
      reqId,
      ok: true,
      ...(message.headers !== undefined ? { headers: message.headers } : {}),
      ...(message.parts ? { parts: message.parts } : {}),
    });
  } finally {
    await opened.close().catch(() => undefined);
  }
}
