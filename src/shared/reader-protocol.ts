// SPDX-License-Identifier: AGPL-3.0-or-later
// Opening one message in the reader: the messages between the shell and main,
// main and core, and core and its reader worker.

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

/** A message rendered by the reader worker. */
export interface RenderedMessage {
  headers: MessageHeaders;
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
