// SPDX-License-Identifier: AGPL-3.0-or-later
// The neutral image served in place of every remote image: one transparent pixel.

export const PLACEHOLDER = {
  contentType: 'image/png',
  bytes: new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
      'base64',
    ),
  ),
};
