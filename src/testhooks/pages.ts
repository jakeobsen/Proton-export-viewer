// SPDX-License-Identifier: AGPL-3.0-or-later
// Extra app:// routes served only in builds with test hooks.

import { samplePng } from '../core/png';
import { markLoaded } from './marker';
import { SCRIPT_MARKER } from './stubs';

markLoaded();

export const TEST_PAGE = {
  scriptControl: 'app://shell/__test/script-control.html',
  fetch: 'app://shell/__test/fetch.html',
  subframeHost: 'app://shell/__test/subframe-host.html',
  subframe: 'app://shell/__test/subframe.html',
} as const;

function html(body: string, csp: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
    {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
        'Cache-Control': 'no-store',
      },
    },
  );
}

export async function testRoute(pathname: string): Promise<Response | null> {
  switch (pathname) {
    case '/probe.png':
      return new Response(new Uint8Array(samplePng()), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
      });
    case '/__test/script-control.html':
      // Positive control for the script detector: the same marker script, allowed to run.
      return html(
        `<p>script control</p><script>document.documentElement.setAttribute('data-pev-script','ran');console.log('${SCRIPT_MARKER}');</script>`,
        "default-src 'none'; script-src 'unsafe-inline'",
      );
    case '/__test/fetch.html':
      // A page whose CSP lets requests through to the session's request filter.
      return html('<p>fetch page</p>', "default-src 'none'; connect-src *");
    case '/__test/subframe-host.html':
      return html(
        `<iframe id="sub" src="${TEST_PAGE.subframe}"></iframe>`,
        "default-src 'none'; frame-src app:",
      );
    case '/__test/subframe.html':
      return html('<p id="sub-ready">subframe</p>', "default-src 'none'");
    default:
      return null;
  }
}
