// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 1 parsing: one metadata file into the row the writer stores, with the
// conversation keys taken from its raw header block.

export const MAX_ID_LENGTH = 998;
export const MAX_REFERENCES = 100;
/**
 * The most rows one message stores: its first 200 labels (IDs of at most 256
 * characters), its first 1,000 attachments and the first 1,000 addresses of
 * each address list. So one message is a bounded unit of work for the writer.
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
  attachments: Array<{ name: string; mime: string; size: number }>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
const flag = (v: unknown): number => (int(v) ? 1 : 0);

function address(v: unknown): Address {
  const o = (v ?? {}) as Record<string, unknown>;
  return { name: str(o.Name), address: str(o.Address) };
}

const addresses = (v: unknown): Address[] =>
  Array.isArray(v) ? v.slice(0, MAX_RECIPIENTS).map(address) : [];

export class MetadataError extends Error {
  constructor(readonly code: string) {
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
  if (!payload || typeof payload !== 'object') throw new MetadataError('META_SHAPE');
  const p = payload as Record<string, unknown>;
  if (str(p.ID) !== protonId) throw new MetadataError('META_ID');
  const headers = threadHeaders(str(p.Headers), str(p.ExternalID));
  const labelIds = Array.isArray(p.LabelIDs)
    ? [
        ...new Set(
          p.LabelIDs.filter(
            (v): v is string =>
              typeof v === 'string' && v.length > 0 && v.length <= MAX_LABEL_ID_LENGTH,
          ),
        ),
      ].slice(0, MAX_LABELS)
    : [];
  const attachments = Array.isArray(p.Attachments)
    ? p.Attachments.slice(0, MAX_ATTACHMENTS).map((a) => {
        const o = (a ?? {}) as Record<string, unknown>;
        return { name: str(o.Name), mime: str(o.MIMEType), size: int(o.Size) };
      })
    : [];
  return {
    protonId,
    time: int(p.Time),
    subject: str(p.Subject),
    sender: address(p.Sender),
    to: addresses(p.ToList),
    cc: addresses(p.CCList),
    bcc: addresses(p.BCCList),
    replyTo: addresses(p.ReplyTos),
    flags: int(p.Flags),
    unread: flag(p.Unread),
    replied: flag(p.IsReplied),
    repliedAll: flag(p.IsRepliedAll),
    forwarded: flag(p.IsForwarded),
    size: int(p.Size),
    numAttachments: int(p.NumAttachments),
    mimeType: str(p.MIMEType),
    messageId: headers.messageId,
    inReplyTo: headers.inReplyTo[0] ?? null,
    references: headers.references,
    dmarc: headers.dmarc,
    labelIds,
    keys: conversationKeys(headers),
    attachments,
  };
}

export const addressText = (list: Address[]): string =>
  list.map((a) => `${a.name} ${a.address}`.trim()).join(' ');
