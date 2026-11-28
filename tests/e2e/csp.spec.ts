// SPDX-License-Identifier: AGPL-3.0-or-later
// Negative CSP control with its positive controls: the body's header CSP and the
// iframe sandbox are what stop the probes and the script, not a broken probe.
// The hostile body goes through the reader's unsanitized path into the reader
// pane's body frame, so nothing but the CSP and the sandbox stands in its way.

import type { Frame, Page } from '@playwright/test';
import { expect, test, type PevApp } from './app';
import { HOSTILE, paneSource, unsanitized } from './pane-messages';

const SCRIPT_MARKER = 'pev-script-marker';

interface Requests {
  app: string[];
  body: string[];
  asset: string[];
  blocked: string[];
}

async function probeHits(pev: PevApp, windowId = 1) {
  const r = await pev.main<Requests>('requests', windowId);
  return {
    img: r.app.filter((u) => u === 'app://shell/probe.png').length,
    css: r.asset.filter((u) => u.endsWith('/probe.css')).length,
  };
}

async function scriptRan(target: Frame | Page): Promise<boolean> {
  return target.evaluate(() => document.documentElement.getAttribute('data-pev-script') === 'ran');
}

/** Opens the hostile body, unsanitized, in the reader pane, with a fresh request record. */
async function openHostile(pev: PevApp) {
  await paneSource(pev, HOSTILE);
  await unsanitized(pev);
  await pev.main('clearRequests');
  return pev.showInPane(1, 'html');
}

test('the header CSP blocks both probes and the script does not run @pane', async ({ pev }) => {
  const { frame, token } = await openHostile(pev);

  // The probe elements are really in the loaded body, the style sheet on the
  // view's own asset base.
  expect(await frame.locator('#probe-img').count()).toBe(1);
  expect(await frame.locator('#probe-css').getAttribute('href')).toBe(
    `mail-asset://v/${token}/probe.css`,
  );
  expect(await frame.locator('#hostile-title').textContent()).toBe('Hostile body');

  // CSP violations are reported for both probes.
  await expect
    .poll(() => {
      const violations = pev.consoleMessages.filter((m) =>
        m.text.includes('Content Security Policy'),
      );
      return {
        img: violations.some((m) => m.text.includes('app://shell/probe.png')),
        css: violations.some((m) => m.text.includes('probe.css')),
      };
    })
    .toEqual({ img: true, css: true });

  expect(await probeHits(pev)).toEqual({ img: 0, css: 0 });
  expect(await scriptRan(frame)).toBe(false);
  expect(pev.consoleMessages.some((m) => m.text === SCRIPT_MARKER)).toBe(false);
  expect(await pev.shell<string | null>('frameSandbox')).toBe('allow-popups');
});

test('positive control: without the CSP header each probe is hit @pane', async ({ pev }) => {
  await pev.main('setBodyCsp', false);
  const { frame } = await openHostile(pev);

  await expect.poll(() => probeHits(pev)).toEqual({ img: 1, css: 1 });
  // The sandbox still stops the script without any CSP.
  expect(await scriptRan(frame)).toBe(false);
  expect(pev.consoleMessages.some((m) => m.text === SCRIPT_MARKER)).toBe(false);
});

test('positive control: the script detector sees the marker where scripts run', async ({ pev }) => {
  const control = await pev.openWindow('script-control');
  const messages: string[] = [];
  control.page.on('console', (m) => messages.push(m.text()));
  await pev.main('loadUrl', control.windowId, 'app://shell/__test/script-control.html');
  // The page can still be navigating when the load call returns; a check made
  // then finds no page to run in, and is simply made again.
  await expect.poll(() => scriptRan(control.page).catch(() => false)).toBe(true);
  await expect.poll(() => messages.includes(SCRIPT_MARKER)).toBe(true);
});
