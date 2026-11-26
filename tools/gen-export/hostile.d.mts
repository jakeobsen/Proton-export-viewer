// SPDX-License-Identifier: AGPL-3.0-or-later
export const CANARY_IPS: string[];
export const IP_LITERAL_FORMS: [string, string][];
export function dimensionBombPng(width: number, height: number): Buffer;
export function gif(width: number, height: number, frames: number): Buffer;

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
}

export function hostileMessages(options: {
  seed: number | string;
  nonce: string;
  labelInfo: { file: { Payload: Array<{ ParentID?: string }> } };
  owner: { Name: string; Address: string };
}): { plans: HostilePlan[]; extras: unknown[]; counts: Record<string, number> };
