// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic messages for the specs that run on the reader pane's body frame,
// and the reader's test source that serves them by rowid.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRIPT_MARKER } from '../../src/testhooks/stubs';
import { ASSET_BASE_MARK } from '../../src/testhooks/unsanitized';
import { testDir } from '../paths';
import { expect, type PevApp } from './app';

function htmlMessage(subject: string, body: string[]): string {
  return [
    `Subject: ${subject}`,
    'From: "Sender" <sender@example.org>',
    'To: <owner@example.com>',
    'Date: Wed, 25 Nov 2026 08:02:11 +0100',
    'Content-Type: text/html; charset=utf-8',
    '',
    ...body,
    '',
  ].join('\r\n');
}

/**
 * A body the sanitizer keeps: a style sheet, a style attribute, a remote image
 * (shown as the view's placeholder `r1`) and a link (the view's link `l1`).
 */
export const SAMPLE = htmlMessage('Sample', [
  '<html><head><style>',
  '.title { color: rgb(18, 52, 86); font-weight: 700; }',
  '</style></head><body>',
  '<p class="title" id="title">Sample message</p>',
  '<p id="inline" style="color: rgb(120, 30, 60); letter-spacing: 2px">Sample text.</p>',
  '<img id="remote" alt="" width="16" height="16" src="https://images.example.org/a.png">',
  '<p><a id="link" href="https://example.com/">example.com</a></p>',
  '</body></html>',
]);

/** Links the sanitizer turns into the view's link ids `l1` and `l2`. */
export const LINKS = htmlMessage('Links', [
  '<html><body>',
  '<p><a id="link-blank" href="https://example.org/blank" target="_blank">blank</a></p>',
  '<p><a id="link-mailto" href="mailto:someone@example.org">mail</a></p>',
  '</body></html>',
]);

/**
 * For the unsanitized path only. A style sheet from the view's own
 * `mail-asset:` base, an `app:` image and a script: the body's CSP and the
 * frame sandbox must stop them on their own.
 */
export const HOSTILE = htmlMessage('Hostile', [
  '<!doctype html>',
  '<html><head>',
  `<link id="probe-css" rel="stylesheet" href="${ASSET_BASE_MARK}/probe.css">`,
  '</head><body>',
  '<p id="hostile-title">Hostile body</p>',
  '<img id="probe-img" alt="" src="app://shell/probe.png">',
  `<script>document.documentElement.setAttribute('data-pev-script','ran');console.log('${SCRIPT_MARKER}');</script>`,
  '</body></html>',
]);

/** For the unsanitized path only: links the sanitizer would turn into link ids or drop. */
export const RAW_LINKS = htmlMessage('Raw links', [
  '<!doctype html>',
  '<html><body>',
  '<p><a id="link-raw" href="https://example.org/raw" target="_blank" rel="noopener noreferrer">raw</a></p>',
  '<p><a id="link-js" href="javascript:void(0)" target="_blank" rel="noopener noreferrer">js</a></p>',
  '<p><a id="link-data" href="data:text/html,hello" target="_blank" rel="noopener noreferrer">data</a></p>',
  '<p><a id="link-self" href="https://example.org/self" target="_self">self</a></p>',
  '<p><a id="link-plain" href="https://example.org/plain">plain</a></p>',
  '</body></html>',
]);

/** For the unsanitized path only: a meta refresh, which the sanitizer would drop. */
export const REFRESH = htmlMessage('Refresh', [
  '<!doctype html>',
  '<html><head><meta http-equiv="refresh" content="0;url=https://example.org/refresh"></head>',
  '<body><p id="refresh-title">Refresh body</p></body></html>',
]);

/** Serves the messages as the reader's rowids 1, 2, … from a new test folder. */
export async function paneSource(pev: PevApp, ...messages: string[]): Promise<void> {
  const root = testDir('pane-source');
  const entries = messages.map((eml, i) => {
    writeFileSync(join(root, `m${i + 1}.eml`), eml);
    return [i + 1, { file: `m${i + 1}.eml` }] as const;
  });
  const result = await pev.main<{ ok: boolean }>('readerSource', root, entries);
  expect(result.ok).toBe(true);
}

/** Turns the reader's unsanitized path on: bodies keep their HTML as the message has it. */
export async function unsanitized(pev: PevApp): Promise<void> {
  const result = await pev.main<{ ok: boolean }>('readerUnsanitized', true);
  expect(result.ok).toBe(true);
}
