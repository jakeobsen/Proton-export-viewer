// SPDX-License-Identifier: AGPL-3.0-or-later
// Opening one message in the reader: the messages between the shell and main,
// main and core, and core and its reader worker.

import type { RasterFormat } from './attachment-types';

/**
 * What the shell asks for: the message's HTML body, its plain text, or its
 * HTML body even though it is too large to open as HTML by default.
 */
export const OPEN_MODES = ['html', 'plain', 'html-anyway'] as const;
export type OpenMode = (typeof OPEN_MODES)[number];

/** Header fields for display. Plain strings: the shell shows them as text, never as HTML. */
export interface MessageHeaders {
  subject: string;
  from: string;
  to: string;
  cc: string;
  /** ISO 8601, or null when the message has no valid date. */
  date: string | null;
}

/**
 * A link in a rendered body. The body holds only its opaque id
 * (`mail-asset://v/<token>/l<n>`); main keeps the URL and the link text.
 */
export interface BodyLink {
  id: string;
  url: string;
  text: string;
}

/**
 * An inline image a body shows as `mail-asset://v/<token>/<id>`: bytes that
 * passed the raster check, and the Content-Type of the format it found.
 */
export interface InlineImage {
  id: string;
  contentType: string;
  bytes: Uint8Array;
}

/** One attachment of a rendered message, in the order the message has its parts. */
export interface AttachmentEntry {
  /** The part's dotted path in the message: `1.2` is the second part of the first. */
  path: string;
  /** The cleaned file name. */
  name: string;
  /** The part's declared content type, lower-cased. Kept by main; never shown. */
  contentType: string;
  /** What kind of file it is, from a fixed list of labels. */
  label: string;
  /** The decoded size, in bytes. */
  size: number;
  /** The name's extension is one of a program or a script. */
  risky: boolean;
  /** The raster format the part's first bytes have, or null. Only a signature check. */
  imageFormat: RasterFormat | null;
}

/** Details shows at most this many References ids. */
export const MAX_REFERENCES = 20;

/** What Details shows beyond the header lines. Every value is cleaned for display. */
export interface MessageDetails {
  /** The Message-ID, or '' when the message has none. */
  messageId: string;
  /** The first MAX_REFERENCES ids of References. */
  references: string[];
  /** How many more ids References holds. */
  moreReferences: number;
  /** The message's structure in a line, e.g. "multipart/mixed · HTML and plain text · 3 attachments". */
  format: string;
}

/** A message rendered by the reader worker. */
export interface RenderedMessage {
  headers: MessageHeaders;
  /** Its attachments, as listed in this view's mode. */
  attachments: AttachmentEntry[];
  details: MessageDetails;
  /** The body document that mail-body: serves. */
  html: string;
  links: BodyLink[];
  /** The format the body was rendered in. */
  format: 'plain' | 'html';
  /** How many distinct remote images and media the body refers to, each shown as a placeholder. */
  remote: number;
  /** How many `cid:` ids (`c1`…) the body refers to. */
  cids: number;
  /** The `c<n>` ids that show an image; every other one shows the placeholder. */
  images: InlineImage[];
  /** How many inline images, `cid:` and `data:`, the body has that aren't shown. */
  imagesRefused: number;
  /** True when the message has an HTML body. */
  hasHtml: boolean;
  /** True when HTML was asked for but its size alone kept it from being shown; it can be asked for anyway. */
  htmlTooLarge: boolean;
  /**
   * Why only part of the body is shown: 'size', it is so large that only the
   * first part of its plain text is; 'parts', the message has more parts than
   * are read. Null when the body is shown whole.
   */
  cut: 'size' | 'parts' | null;
}

/** A large synthetic message, generated while a test runs (test builds only). */
export interface GeneratedMessage {
  kind: 'text' | 'html' | 'attachment';
  bytes: number;
  seed: number;
}

/** Inputs that exist only to test the reader lane's limits (test builds only). */
export type TestInput =
  | { kind: 'generated'; spec: GeneratedMessage }
  | { kind: 'spin' }
  | { kind: 'heap' }
  | { kind: 'throw'; markers: string }
  | { kind: 'sleep'; ms: number };

/**
 * Where the reader worker reads a message from: a file core opened read-only
 * (core closes it when the job ends), or a test input.
 */
export type ReaderInput = { kind: 'fd'; fd: number } | { kind: 'test'; input: TestInput };

/** Why a reader job gave no body. The reader then shows its fallback. */
export const READER_FAILURES = ['timeout', 'limit', 'crash', 'parse', 'file'] as const;
export type ReaderFailure = (typeof READER_FAILURES)[number];

/** A file's identity as the reader opened it: its device and inode, as decimal strings. */
export interface FileIdentity {
  dev: string;
  ino: string;
}

/**
 * main -> core: the path of the file a view was read from, for Show in folder.
 * Core answers only while the message's file is still that same file.
 */
export interface LocateRequest {
  type: 'locate';
  reqId: number;
  generation: number;
  rowid: number;
  file: FileIdentity;
}

/** main -> core: open one message for a window. */
export interface ReadRequest {
  type: 'read';
  reqId: number;
  openId: number;
  generation: number;
  token: string;
  rowid: number;
  mode: OpenMode;
  /** The window the open is for. Its newer opens, by openId, drop this one while it waits. */
  lane: number;
}

/** The most of one header block the source view shows. */
export const SOURCE_HEADER_BYTES = 256 * 1024;

/** What the source view reads from a message. */
export type SourceWhat =
  { kind: 'headers' } | { kind: 'structure' } | { kind: 'part'; path: string };

/** A dotted part path: `1`, `1.2`, `1.2.10`… */
export const PART_PATH_RE = /^1(?:\.[1-9]\d{0,6}){0,64}$/;

/** One part of a message, as the source view's tree shows it. */
export interface SourcePart {
  /** Dotted path: `1` is the message, `1.2` its second child. */
  path: string;
  /** The parent's index in the list, or -1 for the message. */
  parent: number;
  /** The Content-Type's type and subtype as the splitter read it, lower case; '' if none. */
  contentType: string;
  /** The Content-Type's charset parameter, or null. */
  charset: string | null;
  /** The cleaned file name, or '' when the part names none. */
  name: string;
  /** Content-Disposition: inline. */
  inline: boolean;
  /** Decoded bytes: a leaf's from its transfer decoder, a container's the sum of its parts'. */
  size: number;
  /** The read stopped before the part's end: `size` is only what was read. */
  cut: boolean;
}

/** A raw header block, at most the source view's cap. */
export interface SourceHeaders {
  bytes: Uint8Array;
  /** More of the block was there than `bytes` holds. */
  truncated: boolean;
}

/**
 * main -> core: read for the source view of a window's message. `file` is
 * the identity of the file the view was read from; null when the open failed
 * and there is no view, as for the reader's fallback.
 */
export interface SourceRequest {
  type: 'source';
  reqId: number;
  openId: number;
  generation: number;
  rowid: number;
  file: FileIdentity | null;
  what: SourceWhat;
  /** The window it is for. */
  lane: number;
  /** For a part: newer selections of the window drop this one while it waits. */
  order?: number;
}

/** core -> reader worker: read for the source view. */
export interface WorkerSource {
  type: 'source';
  reqId: number;
  input: ReaderInput;
  what: SourceWhat;
}

/** reader worker -> core. `headers` is null for a part the message doesn't have. */
export type WorkerSourced =
  | {
      type: 'sourced';
      reqId: number;
      heldBytes: number;
      ok: true;
      headers?: SourceHeaders | null;
      parts?: SourcePart[];
    }
  | { type: 'sourced'; reqId: number; heldBytes: number; ok: false };

/** core -> reader worker: render one message. */
export interface WorkerRender {
  type: 'render';
  reqId: number;
  input: ReaderInput;
  mode: OpenMode;
  /** `mail-asset://v/<token>` of the view being opened. */
  assetBase: string;
  /** Test builds only: serve the HTML body without the sanitizer and the CSS filter. */
  unsanitized?: true;
}

/**
 * reader worker -> core. `heldBytes` is the memory the worker holds once the
 * job is done: its JS heap and the buffers outside it.
 */
export type WorkerRendered =
  | { type: 'rendered'; reqId: number; heldBytes: number; ok: true; message: RenderedMessage }
  | { type: 'rendered'; reqId: number; heldBytes: number; ok: false; code: 'parse' };
