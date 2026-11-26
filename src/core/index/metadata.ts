// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 1 parsing: one metadata file into the row the writer stores, with the
// conversation keys taken from its raw header block.

import { CAPPED } from './schema';

export const MAX_ID_LENGTH = 998;
export const MAX_REFERENCES = 100;
/**
 * The most entries one message stores per list: its first 200 labels (IDs of
 * at most 256 characters) and the first 1,000 addresses of each address list.
 * So one message is a bounded unit of work for the writer. A message with more
 * has the list's bit set in `capped`. Attachments are listed from the message
 * file itself, not from its metadata, under their own limit.
 */
export const MAX_LABELS = 200;
export const MAX_LABEL_ID_LENGTH = 256;
export const MAX_ATTACHMENTS = 1000;
export const MAX_RECIPIENTS = 1000;

/** The values of every `name:` field in a raw header block, unfolded. */
export function headerValues(block: string, name: string): string[] {
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === wanted) values.push(line.slice(colon + 1));
  }
  return values;
}

/**
 * The msg-ids in a header value: only `<…>` tokens count, trimmed inside and
 * compared exactly. Empty ids and ids over 998 characters are left out, and
 * text outside angle brackets is ignored.
 */
export function msgIds(value: string): string[] {
  const ids: string[] = [];
  for (const match of value.matchAll(/<([^<>]*)>/g)) {
    const id = (match[1] ?? '').trim();
    if (id.length > 0 && id.length <= MAX_ID_LENGTH) ids.push(id);
  }
  return ids;
}

export interface ThreadHeaders {
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  dmarc: string | null;
}

/** Threading and DMARC fields from the header block; the external ID stands in for a missing Message-ID. */
export function threadHeaders(block: string, externalId: string): ThreadHeaders {
  const own = headerValues(block, 'Message-ID').flatMap(msgIds)[0] ?? null;
  const external = externalId.trim();
  const dmarc = headerValues(block, 'Authentication-Results')
    .map((v) => /\bdmarc=([a-z]+)/i.exec(v)?.[1]?.toLowerCase())
    .find((v) => v !== undefined);
  return {
    messageId: own ?? (external.length > 0 && external.length <= MAX_ID_LENGTH ? external : null),
    inReplyTo: headerValues(block, 'In-Reply-To').flatMap(msgIds),
    references: headerValues(block, 'References').flatMap(msgIds),
    dmarc: dmarc ?? null,
  };
}

/** A message's conversation keys: its own id, its In-Reply-To ids and its last 100 References. */
export function conversationKeys(headers: ThreadHeaders): string[] {
  const keys = new Set<string>();
  if (headers.messageId !== null) keys.add(headers.messageId);
  for (const id of headers.inReplyTo) keys.add(id);
  for (const id of headers.references.slice(-MAX_REFERENCES)) keys.add(id);
  return [...keys];
}

export interface Address {
  name: string;
  address: string;
}

export interface MessageRow {
  protonId: string;
  time: number;
  subject: string;
  sender: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  flags: number;
  unread: number;
  replied: number;
  repliedAll: number;
  forwarded: number;
  size: number;
  numAttachments: number;
  mimeType: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  dmarc: string | null;
  labelIds: string[];
  keys: string[];
  /** CAPPED bits of the lists that were cut to their limit. */
  capped: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
const flag = (v: unknown): number => (int(v) ? 1 : 0);

function address(v: unknown): Address {
  const o = (v ?? {}) as Record<string, unknown>;
  return { name: str(o.Name), address: str(o.Address) };
}

export class MetadataError extends Error {
  constructor(readonly code: 'META_JSON' | 'META_SHAPE' | 'META_ID') {
    super(code);
  }
}

/** Parses one `<ID>.metadata.json`. The ID comes from the file name, which the scan paired. */
export function parseMetadata(protonId: string, text: string): MessageRow {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new MetadataError('META_JSON');
  }
  const payload = (doc as { Payload?: unknown } | null)?.Payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MetadataError('META_SHAPE');
  }
  const p = payload as Record<string, unknown>;
  if (str(p.ID) !== protonId) throw new MetadataError('META_ID');
  let capped = 0;
  const list = <T>(v: unknown, max: number, bit: number, map: (x: unknown) => T): T[] => {
    if (!Array.isArray(v)) return [];
    if (v.length > max) capped |= bit;
    return v.slice(0, max).map(map);
  };
  const headers = threadHeaders(str(p.Headers), str(p.ExternalID));
  let labelIds: string[] = [];
  if (Array.isArray(p.LabelIDs)) {
    const valid = new Set<string>();
    for (const v of p.LabelIDs) {
      if (typeof v === 'string' && v.length > 0 && v.length <= MAX_LABEL_ID_LENGTH) valid.add(v);
    }
    labelIds = [...valid];
    if (labelIds.length > MAX_LABELS) {
      capped |= CAPPED.labels;
      labelIds = labelIds.slice(0, MAX_LABELS);
    }
  }
  return {
    protonId,
    time: int(p.Time),
    subject: str(p.Subject),
    sender: address(p.Sender),
    to: list(p.ToList, MAX_RECIPIENTS, CAPPED.to, address),
    cc: list(p.CCList, MAX_RECIPIENTS, CAPPED.cc, address),
    bcc: list(p.BCCList, MAX_RECIPIENTS, CAPPED.bcc, address),
    replyTo: list(p.ReplyTos, MAX_RECIPIENTS, CAPPED.replyTo, address),
    flags: int(p.Flags),
    unread: flag(p.Unread),
    replied: flag(p.IsReplied),
    repliedAll: flag(p.IsRepliedAll),
    forwarded: flag(p.IsForwarded),
    size: int(p.Size),
    numAttachments: Math.max(0, int(p.NumAttachments)),
    mimeType: str(p.MIMEType),
    messageId: headers.messageId,
    inReplyTo: headers.inReplyTo[0] ?? null,
    references: headers.references.slice(-MAX_REFERENCES),
    dmarc: headers.dmarc,
    labelIds,
    keys: conversationKeys(headers),
    capped,
  };
}

export const addressText = (list: Address[]): string =>
  list.map((a) => `${a.name} ${a.address}`.trim()).join(' ');
