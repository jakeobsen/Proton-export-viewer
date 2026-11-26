// SPDX-License-Identifier: AGPL-3.0-or-later
// Bodies used only by tests. They are deliberately unsanitized.

import { samplePng } from '../core/png';
import type { StubBuilder } from '../core/stubs';
import { markLoaded } from './marker';

markLoaded();

export const SCRIPT_MARKER = 'pev-script-marker';
const SCRIPT = `<script>document.documentElement.setAttribute('data-pev-script','ran');console.log('${SCRIPT_MARKER}');</script>`;

export const TEST_STUBS: Record<string, StubBuilder> = {
  hostile: (assetBase) => ({
    html: [
      '<!doctype html>',
      '<html><head>',
      `<link id="probe-css" rel="stylesheet" href="${assetBase}/probe.css">`,
      '</head><body>',
      '<p id="hostile-title">Hostile body</p>',
      '<img id="probe-img" alt="" src="app://shell/probe.png">',
      SCRIPT,
      '</body></html>',
    ].join('\n'),
    assets: [
      {
        id: 'probe.css',
        contentType: 'text/css; charset=utf-8',
        bytes: new TextEncoder().encode('body{}'),
      },
      { id: 'c1', contentType: 'image/png', bytes: samplePng() },
    ],
  }),
  links: (assetBase) => ({
    html: [
      '<!doctype html>',
      '<html><body>',
      `<p><a id="link-blank" href="${assetBase}/l1" target="_blank" rel="noopener noreferrer">blank</a></p>`,
      `<p><a id="link-mailto" href="${assetBase}/l2" target="_blank" rel="noopener noreferrer">mail</a></p>`,
      `<p><a id="link-poisoned" href="${assetBase}/l3" target="_blank" rel="noopener noreferrer">poisoned</a></p>`,
      `<p><a id="link-id-self" href="${assetBase}/l1" target="_self">id self</a></p>`,
      '<p><a id="link-raw" href="https://example.org/raw" target="_blank" rel="noopener noreferrer">raw</a></p>',
      '<p><a id="link-js" href="javascript:void(0)" target="_blank" rel="noopener noreferrer">js</a></p>',
      '<p><a id="link-data" href="data:text/html,hello" target="_blank" rel="noopener noreferrer">data</a></p>',
      '<p><a id="link-self" href="https://example.org/self" target="_self">self</a></p>',
      '<p><a id="link-plain" href="https://example.org/plain">plain</a></p>',
      '</body></html>',
    ].join('\n'),
    assets: [],
    links: [
      { id: 'l1', url: 'https://example.org/blank', text: 'blank' },
      { id: 'l2', url: 'mailto:someone@example.org', text: 'mail' },
      // Main must never offer a URL without a link scheme, even one in its own map.
      { id: 'l3', url: 'javascript:void(0)', text: 'poisoned' },
    ],
  }),
  // A link id used as an image and in CSS: the asset handler never serves one.
  'link-refs': (assetBase) => ({
    html: [
      '<!doctype html>',
      `<html><head><style>#css-ref{width:8px;height:8px;background:url("${assetBase}/l2")}</style></head><body>`,
      `<img id="img-ref" alt="" src="${assetBase}/l1">`,
      '<div id="css-ref"></div>',
      '</body></html>',
    ].join('\n'),
    assets: [],
    links: [
      { id: 'l1', url: 'https://example.org/img', text: 'img' },
      { id: 'l2', url: 'https://example.org/css', text: 'css' },
    ],
  }),
  refresh: () => ({
    html: [
      '<!doctype html>',
      '<html><head><meta http-equiv="refresh" content="0;url=https://example.org/refresh"></head>',
      '<body><p id="refresh-title">Refresh body</p></body></html>',
    ].join('\n'),
    assets: [],
  }),
  'bad-magic': (assetBase) => ({
    html: `<!doctype html><html><body><img id="bad" src="${assetBase}/c1"></body></html>`,
    assets: [
      { id: 'c1', contentType: 'image/png', bytes: new TextEncoder().encode('not an image') },
    ],
  }),
};
