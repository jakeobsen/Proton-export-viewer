// SPDX-License-Identifier: AGPL-3.0-or-later
export const CANARY_IPS: string[];
export const IP_LITERAL_FORMS: [string, string][];
export function dimensionBombPng(width: number, height: number): Buffer;
export function gif(width: number, height: number, frames: number): Buffer;
export function paddedPng(bytes: number): Buffer;

export const SCRIPT_MARKER: string;
export const MARKER_ATTRIBUTE: string;

/** What a hostile message's body refers to (see hostile.mjs). */
export interface HostileRefs {
  rewrite: number;
  /** A string is one reference; an array lists alternatives, of which one loads. */
  loads: Array<string | string[]>;
  hints: string[];
}

/** Throws unless `declared` is a valid reference declaration. */
export function checkRefs(where: string, declared: unknown): void;

/** One hostile message: its key is `hostile/<seed>/<nonce>/<category>/<name>`. */
export interface HostilePlan {
  key: string;
  id: string;
  messageId: string;
  subject: string;
  emlData: Buffer;
  mimeType: string;
  skipEml?: boolean;
  skipMetadata?: boolean;
  refs: HostileRefs;
}

export function hostileMessages(options: {
  seed: number | string;
  nonce: string;
  labelInfo: { file: { Payload: Array<{ ParentID?: string }> } };
  owner: { Name: string; Address: string };
}): { plans: HostilePlan[]; extras: unknown[]; counts: Record<string, number> };
