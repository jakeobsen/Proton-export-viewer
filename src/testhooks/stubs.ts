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
  links: () => ({
    html: [
      '<!doctype html>',
      '<html><body>',
      '<p><a id="link-blank" href="https://example.org/blank" target="_blank" rel="noopener noreferrer">blank</a></p>',
      '<p><a id="link-mailto" href="mailto:someone@example.org" target="_blank" rel="noopener noreferrer">mail</a></p>',
      '<p><a id="link-self" href="https://example.org/self" target="_self">self</a></p>',
      '<p><a id="link-plain" href="https://example.org/plain">plain</a></p>',
      '</body></html>',
    ].join('\n'),
    assets: [],
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
