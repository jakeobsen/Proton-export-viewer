// SPDX-License-Identifier: AGPL-3.0-or-later
// The neutral image served in place of every remote image, and of every
// inline image that isn't shown: one transparent pixel.

const PLACEHOLDER_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

export const PLACEHOLDER = {
  contentType: 'image/png',
  bytes: new Uint8Array(Buffer.from(PLACEHOLDER_BASE64, 'base64')),
};

/** The placeholder as a `data:` URL, for inline images in the body itself. */
export const PLACEHOLDER_DATA_URL = `data:image/png;base64,${PLACEHOLDER_BASE64}`;
