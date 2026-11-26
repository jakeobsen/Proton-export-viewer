// SPDX-License-Identifier: AGPL-3.0-or-later
// Types shared by main, core and the shell about export sources.

import type { IndexCondition } from './index-types';

/** The source and generation a piece of async work belongs to. */
export interface Stamp {
  sourceKey: string;
  generation: number;
}

export function sameStamp(a: Stamp | null | undefined, b: Stamp | null | undefined): boolean {
  return !!a && !!b && a.sourceKey === b.sourceKey && a.generation === b.generation;
}

/** Why an entry of a run folder isn't used. */
export const REJECT_KINDS = [
  'symlink',
  'directory',
  'fifo',
  'socket',
  'device',
  'other_type',
  'too_large',
  'changed',
  'unreadable',
] as const;
export type RejectKind = (typeof REJECT_KINDS)[number];

/** What tells one export run from another at the same place. */
export interface RunIdentity {
  /** Hex SHA-256 of labels.json, or null when the run has no usable one. */
  labelsSha256: string | null;
  /** Hex SHA-256 of the sorted metadata file names, each followed by a NUL byte. */
  namesSha256: string;
  metadataNames: number;
}

/** The counts from one containment scan of a run folder. */
export interface ScanSummary {
  /** Messages with both files. */
  pairs: number;
  metadataOnly: number;
  emlOnly: number;
  labels: boolean;
  /** Regular files of another kind; never read. */
  ignored: number;
  rejected: Record<RejectKind, number>;
}

// --- What the shell sees -------------------------------------------------------

export interface ExportRow {
  /** Opaque; the shell names exports by this key, never by path. */
  sourceKey: string;
  account: string | null;
  runName: string;
}

export interface RunChoice {
  /** Opaque, valid for the open pick until the next open or switch. */
  runId: string;
  account: string | null;
  runName: string;
  current: boolean;
}

export interface ActiveExport extends ExportRow {
  status: 'online' | 'offline';
  /** The state of its index, once known. */
  index: IndexCondition | null;
  /** The runs found in the same picked folder; the run picker shows when there's more than one. */
  runs: RunChoice[];
}

export interface SourcesView {
  /** The export open at the last quit is being opened again. */
  restoring: boolean;
  active: ActiveExport | null;
  /** Most recently opened first, the open one included. */
  recent: ExportRow[];
}

export type SourceOutcome =
  | 'opened'
  | 'offline'
  | 'new_source'
  | 'canceled'
  | 'no_export'
  | 'unavailable'
  | 'forgotten'
  /** Nothing can be opened: the app's data is being reset. */
  | 'closed'
  /** The index couldn't be deleted yet; nothing was changed. */
  | 'busy';
