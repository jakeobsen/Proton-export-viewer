// SPDX-License-Identifier: AGPL-3.0-or-later
// Limits for reading the MIME structure of a message file, shared by the
// reader and the full-text index.

/** The longest header block read, of the message or of one of its parts. */
export const MAX_HEAD_BYTES = 2 * 1024 * 1024;
/** MIME parts read in one message, multiparts included; the parser stops past it. */
export const MAX_MIME_PARTS = 10_000;
