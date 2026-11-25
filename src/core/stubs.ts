// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed placeholder bodies. They travel the same path a parsed message will:
// main -> core -> reader worker -> main -> mail-body:/mail-asset: handlers.

import { samplePng } from './png';

export interface StubAsset {
  id: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface StubBody {
  html: string;
  assets: StubAsset[];
}

/** Builds a body; `assetBase` is `mail-asset://v/<token>` for the view being opened. */
export type StubBuilder = (assetBase: string) => StubBody;

export const STUBS: Record<string, StubBuilder> = {
  sample: (assetBase) => ({
    html: [
      '<!doctype html>',
      '<html><head><style>',
      'body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; margin: 16px; color: #1d1d1f; }',
      '.stub-title { color: rgb(18, 52, 86); font-weight: 700; }',
      '</style></head><body>',
      '<p class="stub-title" id="stub-title">Sample message</p>',
      '<p id="stub-inline" style="color: rgb(120, 30, 60); letter-spacing: 2px">Placeholder body.</p>',
      `<img id="stub-cid" alt="" width="16" height="16" src="${assetBase}/c1">`,
      '<p><a id="stub-link" href="https://example.com/" target="_blank" rel="noopener noreferrer">example.com</a></p>',
      '</body></html>',
    ].join('\n'),
    assets: [{ id: 'c1', contentType: 'image/png', bytes: samplePng() }],
  }),
};
