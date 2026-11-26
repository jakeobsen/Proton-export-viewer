// SPDX-License-Identifier: AGPL-3.0-or-later
export type ProfileName = 'perf' | 'small' | 'stress' | 'hostile';

export interface Entry {
  path: string;
  type: 'dir' | 'file' | 'symlink' | 'fifo';
  data?: Buffer;
  target?: string;
  mtime: number;
}

export interface Summary {
  meta: true;
  counts: Record<string, number>;
  account: string;
  run: string;
  probePair: string | null;
}

export const EXPORT_TIME: number;
export const RUN_FOLDER: string;
export const METADATA_BYTES: { min: number; max: number };
export const PROFILES: Record<ProfileName, Record<string, unknown>>;
export const UNKNOWN_LABEL_IDS: string[];
export function accountAddress(profile: string, seed: number): string;
export function guessedAttachmentEntry(attachment: {
  id: string;
  name: string;
  size: number;
  type: string;
}): Record<string, unknown>;
export function entries(
  profile: ProfileName,
  options: { seed: number; nonce?: string | null },
): Generator<Entry | Summary>;
