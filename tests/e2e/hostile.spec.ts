// SPDX-License-Identifier: AGPL-3.0-or-later
// The hostile corpus end to end, generated afresh for each run. Every message
// opens on the normal path and on the test-only unsanitized path, judged by
// the app's own request records, the body's CSP reports and the session's
// preconnect requests; every link in it is clicked; and the IP-literal
// messages open again with the resolver rule dropped.

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame } from '@playwright/test';
import type { LinkPrompt, MessageOpenResult } from '../../src/shared/api';
import type { OpenMode } from '../../src/shared/reader-protocol';
import {
  MARKER_ATTRIBUTE,
  SCRIPT_MARKER,
  hostileMessages,
  type HostilePlan,
} from '../../tools/gen-export/hostile.mjs';
import { testDir } from '../paths';
import { expect, launch, test, tokenOf, type PevApp } from './app';

interface Requests {
  app: string[];
  body: string[];
  asset: string[];
  blocked: string[];
  console: Array<{ frame: string; text: string }>;
  sessionPreconnects: string[];
}

type Shown = LinkPrompt & { windowId: number };

const NONCE = randomBytes(6).toString('hex');
const HOST = `leak-${NONCE}.test`;
const REMOTE = /^(?:https?|wss?):/i;
/** How long to wait after a body loads for anything it starts late. */
const SETTLE_MS = 200;

function corpus(): HostilePlan[] {
  return hostileMessages({
    seed: 1,
    nonce: NONCE,
    labelInfo: { file: { Payload: [] } },
    owner: { Name: 'Owner', Address: 'owner@example.com' },
  }).plans.filter((p) => !p.skipEml);
}

const nameOf = (plan: HostilePlan) => plan.key.split('/').slice(3).join('/');
const categoryOf = (plan: HostilePlan) => plan.key.split('/')[3] ?? '';

/** A URL as the browser writes it, so declared and reported URLs compare. */
function normal(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** Writes the messages under a new test folder and makes message i the reader's rowid i + 1. */
async function source(pev: PevApp, plans: HostilePlan[]): Promise<void> {
  const root = testDir('hostile-root');
  const entries = plans.map((plan, i) => {
    writeFileSync(join(root, `m${i}.eml`), plan.emlData);
    return [i + 1, { file: `m${i}.eml` }] as const;
  });
  const result = await pev.main<{ ok: boolean }>('readerSource', root, entries);
  expect(result.ok).toBe(true);
}

/** Opens a message in the reader pane, as the shell does. */
function openRow(pev: PevApp, rowid: number, mode: OpenMode): Promise<MessageOpenResult> {
  return pev.paneOpen(rowid, mode);
}

/** The reader pane's frame once it shows the view, after anything it starts late. */
async function show(pev: PevApp, url: string): Promise<Frame> {
  const frame = await pev.paneFrame(url);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return frame;
}

type Logged = { frame: string; text: string };

/**
 * The CSP reports one body logged, as main records its frames' console
 * messages: a nested frame's refusal reaches only main. A report the previous
 * body logs late comes from that body's own frame, so it never counts here.
 */
async function cspMessages(pev: PevApp, frameUrl: string): Promise<Logged[]> {
  const seen = await pev.main<Requests>('requests', 1);
  return seen.console.filter(
    (m) => m.frame === frameUrl && m.text.includes('Content Security Policy'),
  );
}

/** The URLs that CSP reports name, each once. */
function reportedUrls(messages: Logged[]): string[] {
  const out = new Set<string>();
  for (const { text } of messages) {
    for (const [, url] of text.matchAll(/'([a-z][a-z0-9+.-]*:[^']*)'/gi)) {
      if (url) out.add(normal(url));
    }
  }
  return [...out];
}

/** The remote URLs that one body's CSP reported, each once. */
async function cspReported(pev: PevApp, frameUrl: string): Promise<string[]> {
  return reportedUrls(await cspMessages(pev, frameUrl)).filter((u) => REMOTE.test(u));
}

const sorted = (urls: string[]) => [...urls].sort();

/** Declared loads not seen, and seen URLs not declared. */
function compare(declared: Array<string | string[]>, seen: Set<string>) {
  const missing = declared
    .filter((l) => (Array.isArray(l) ? !l.some((a) => seen.has(normal(a))) : !seen.has(normal(l))))
    .map((l) => (Array.isArray(l) ? l.join(' | ') : l));
  const allowed = new Set(declared.flat().map(normal));
  const extra = [...seen].filter((s) => !allowed.has(s));
  return { missing, extra };
}

/** What the served body holds that the sanitizer should have removed, and its links. */
function inspect(frame: Frame, token: string, hints: string[]) {
  return frame.evaluate(
    ([attribute, host, base, hintUrls]) => {
      // Every URL left in an attribute or a style sheet is one of this view's ids.
      const stray = (text: string) =>
        text.includes(host) ||
        [...text.matchAll(/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'()<>,]*/gi)].some(
          ([url]) => !url.startsWith(base),
        );
      // The one other URL left may be an inline image's data: URL, only in <img src>.
      const inlineImage = (el: Element, a: Attr) =>
        el.localName === 'img' &&
        a.name === 'src' &&
        /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(a.value);
      const strays: string[] = [];
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.attributes) {
          if (inlineImage(el, a)) continue;
          if (stray(a.value) || /data:/i.test(a.value)) strays.push(`${el.localName} ${a.name}`);
        }
        if (el.localName === 'style' && stray(el.textContent ?? '')) strays.push('style sheet');
      }
      // A DNS-only hint is gone when its host is nowhere in the served body.
      const html = document.documentElement.outerHTML;
      const hintsLeft = hintUrls.filter((h) =>
        html.includes(new URL(h, 'https://base.invalid/').hostname),
      );
      return {
        marker: document.documentElement.getAttribute(attribute),
        hintsLeft,
        dropped: document.querySelectorAll(
          'script, link, meta, base, iframe, frame, object, embed, form, svg, math, template',
        ).length,
        strays,
        links: [...document.querySelectorAll('a[href], area[href]')].map(
          (el) => el.getAttribute('href') ?? '',
        ),
      };
    },
    [MARKER_ATTRIBUTE, HOST, `mail-asset://v/${token}/`, hints] as const,
  );
}

function shown(pev: PevApp): Promise<Shown[]> {
  return pev.main<Shown[]>('linkDialogs');
}

/** Clicks the body's nth link, as script does: no hover and no press. */
async function clickLink(frame: Frame, index: number): Promise<void> {
  await frame.evaluate((i) => {
    (document.querySelectorAll('a[href], area[href]')[i] as HTMLElement).click();
  }, index);
}

/** The frames of the window that hold a remote page. */
function remoteFrames(pev: PevApp): string[] {
  return pev.page
    .frames()
    .map((f) => f.url())
    .filter((u) => REMOTE.test(u));
}

/** Every image in the body that loaded, by its URL. */
function loadedImages(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    [...document.images].filter((i) => i.complete && i.naturalWidth > 0).map((i) => i.src),
  );
}

test('every hostile message on the normal path: declared rewrites, only its own requests, CSP reports only for its own ids, no script, links only open the dialog @pane', async ({
  pev,
}) => {
  test.setTimeout(300_000);
  const plans = corpus();
  expect(plans.length).toBeGreaterThan(90);
  await source(pev, plans);

  const summary: Record<string, unknown> = {};
  let linksClicked = 0;
  for (const [i, plan] of plans.entries()) {
    const name = nameOf(plan);
    // Plain text has its links as well.
    const modes: OpenMode[] = categoryOf(plan) === 'plain_text' ? ['html', 'plain'] : ['html'];
    for (const mode of modes) {
      await pev.main('clearRequests');
      const opened = await openRow(pev, i + 1, mode);
      // Each message ends in a view or the fallback.
      expect(opened.ok, name).toBe(true);
      if (!opened.ok) continue;
      const key = mode === 'html' ? name : `${name} (plain)`;
      if (opened.outcome === 'fallback') {
        summary[key] = { outcome: 'fallback', declared: plan.refs.rewrite };
        continue;
      }
      // A plain view has nothing to rewrite.
      const declared = mode === 'html' && opened.format === 'html' ? plan.refs.rewrite : 0;
      expect(opened.remote, name).toBe(declared);
      const token = tokenOf(opened.url);
      const frame = await show(pev, opened.url);
      const dom = await inspect(frame, token, plan.refs.hints);
      expect(dom.marker, name).toBeNull();
      expect(dom.hintsLeft, name).toEqual([]);
      expect(dom.dropped, name).toBe(0);
      expect(dom.strays, name).toEqual([]);

      // Links: each click adds one dialog record and nothing else happens.
      const links = new Map(
        await pev.main<Array<[string, { url: string; text: string }]>>('viewLinks', 1, token),
      );
      for (const [index, href] of dom.links.entries()) {
        const id = href.slice(`mail-asset://v/${token}/`.length);
        const link = links.get(id);
        expect(link, `${name} ${href}`).toBeDefined();
        const before = (await shown(pev)).length;
        await clickLink(frame, index);
        await expect
          .poll(async () => (await shown(pev)).length, { timeout: 5_000 })
          .toBe(before + 1);
        const record = (await shown(pev)).at(-1);
        expect(record?.windowId, name).toBe(1);
        expect(record?.url, name).toBe(link?.url);
        expect(frame.url(), name).toBe(opened.url);
        linksClicked += 1;
      }
      expect(pev.page.url()).toBe('app://shell/index.html');
      expect(pev.app.windows()).toHaveLength(1);
      expect(await pev.main('externalCalls')).toEqual([]);

      // Only this view's own requests, none cancelled, and no CSP report.
      const seen = await pev.main<Requests>('requests', 1);
      const markerLogged = seen.console.some((m) => m.text === SCRIPT_MARKER);
      expect(seen.blocked, name).toEqual([]);
      expect(seen.sessionPreconnects, name).toEqual([]);
      expect(markerLogged, name).toBe(false);
      expect(
        seen.body.filter((u) => u !== opened.url),
        name,
      ).toEqual([]);
      expect(
        seen.asset.filter((u) => !u.startsWith(`mail-asset://v/${token}/`)),
        name,
      ).toEqual([]);
      expect(
        seen.app.filter((u) => !u.startsWith('app://shell/')),
        name,
      ).toEqual([]);
      // The CSP may stop this view's own ids where the element can't use them
      // (a placeholder as a video source), but never names anything else.
      const reported = reportedUrls(await cspMessages(pev, opened.url));
      expect(
        reported.filter((u) => !u.startsWith(`mail-asset://v/${token}/`)),
        name,
      ).toEqual([]);
      expect(remoteFrames(pev), name).toEqual([]);
      summary[key] = {
        outcome: 'view',
        format: opened.format,
        declared,
        rewritten: opened.remote,
        webRequest: seen.blocked.length,
        csp: reported.length,
        preconnect: seen.sessionPreconnects.length,
        hintsDeclared: plan.refs.hints.length,
        hintsRemoved: plan.refs.hints.length - dom.hintsLeft.length,
        scriptMarker: dom.marker !== null || markerLogged,
        links: dom.links.length,
      };
    }
  }
  expect(pev.consoleMessages.some((m) => m.text === SCRIPT_MARKER)).toBe(false);
  expect(linksClicked).toBeGreaterThan(10);
  console.log('hostile normal path:', JSON.stringify(summary));
});

test('the recorders work: on the unsanitized path each declared load is cancelled or reported, and nothing else @pane', async ({
  pev,
}) => {
  test.setTimeout(300_000);
  const plans = corpus();
  await source(pev, plans);
  expect((await pev.main<{ ok: boolean }>('readerUnsanitized', true)).ok).toBe(true);

  const summary: Record<string, unknown> = {};
  let total = 0;
  let withLoads = 0;
  for (const [i, plan] of plans.entries()) {
    const name = nameOf(plan);
    await pev.main('clearRequests');
    const opened = await openRow(pev, i + 1, 'html');
    expect(opened.ok, name).toBe(true);
    if (!opened.ok) continue;
    if (opened.outcome !== 'view' || opened.format !== 'html') {
      // No HTML is served, so nothing can load.
      expect(plan.refs.loads, name).toEqual([]);
      summary[name] = { outcome: opened.outcome, loads: 0 };
      continue;
    }
    // The body is the message's own HTML: nothing rewritten.
    expect(opened.remote, name).toBe(0);
    const frame = await show(pev, opened.url);
    const observe = async () => {
      const seen = await pev.main<Requests>('requests', 1);
      const blocked = [...new Set(seen.blocked.filter((u) => REMOTE.test(u)).map(normal))];
      const reported = await cspReported(pev, opened.url);
      return { blocked, reported, all: new Set([...blocked, ...reported]) };
    };
    if (plan.refs.loads.length > 0) {
      withLoads += 1;
      await expect
        .poll(async () => compare(plan.refs.loads, (await observe()).all).missing, {
          timeout: 5_000,
        })
        .toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    }
    const { blocked, reported, all } = await observe();
    const { console: logged, sessionPreconnects } = await pev.main<Requests>('requests', 1);
    const markerLogged = logged.some((m) => m.text === SCRIPT_MARKER);
    expect(markerLogged, name).toBe(false);
    expect(compare(plan.refs.loads, all), name).toEqual({ missing: [], extra: [] });
    // The header CSP is on, so the frame's own requests never reach the filter.
    expect(blocked, name).toEqual([]);
    // The sandbox still stops scripts.
    const marker = await frame.evaluate(
      (a) => document.documentElement.getAttribute(a),
      MARKER_ATTRIBUTE,
    );
    expect(marker, name).toBeNull();
    total += all.size;
    summary[name] = {
      outcome: 'view',
      declared: plan.refs.loads.length,
      webRequest: blocked.length,
      csp: reported.length,
      preconnect: sessionPreconnects.length,
      scriptMarker: marker !== null || markerLogged,
    };
  }
  // A recorder that records nothing fails here.
  expect(withLoads).toBeGreaterThan(20);
  expect(total).toBeGreaterThan(0);
  expect(pev.consoleMessages.some((m) => m.text === SCRIPT_MARKER)).toBe(false);
  console.log('hostile unsanitized path:', JSON.stringify(summary));
});

test('positive control: the script detector sees the marker where scripts run', async ({ pev }) => {
  const control = await pev.openWindow('script-control');
  const messages: string[] = [];
  control.page.on('console', (m) => messages.push(m.text()));
  await pev.main('loadUrl', control.windowId, 'app://shell/__test/script-control.html');
  await expect
    .poll(() =>
      control.page.evaluate((a) => document.documentElement.getAttribute(a), MARKER_ATTRIBUTE),
    )
    .toBe('ran');
  await expect.poll(() => messages.includes(SCRIPT_MARKER)).toBe(true);
  // Main's record of the frames' console messages sees it too.
  await expect
    .poll(async () =>
      (await pev.main<Requests>('requests', control.windowId)).console.some(
        (m) => m.text === SCRIPT_MARKER,
      ),
    )
    .toBe(true);
});

test('positive control: the preconnect recorder sees a hint that nothing stops @pane', async ({
  pev,
}) => {
  // Unsanitized and without the body's CSP; the resolver rule stays on.
  const plan = corpus().find((p) => nameOf(p) === 'script_markup/link-hints');
  if (!plan) throw new Error('no link-hints fixture');
  const hint = plan.refs.hints.find((h) => h.startsWith('https:'));
  if (!hint) throw new Error('no preconnect hint');
  await source(pev, [plan]);
  expect((await pev.main<{ ok: boolean }>('readerUnsanitized', true)).ok).toBe(true);
  await pev.main('setBodyCsp', false);
  await pev.main('clearRequests');
  const opened = await openRow(pev, 1, 'html');
  if (!opened.ok || opened.outcome !== 'view') throw new Error('no view');
  await show(pev, opened.url);
  await expect
    .poll(async () =>
      (await pev.main<Requests>('requests', 1)).sessionPreconnects.map((u) => new URL(u).origin),
    )
    .toContain(new URL(hint).origin);
});

test('without the resolver rule, the filter and the CSP still stop every IP literal, and nothing loads', async () => {
  test.setTimeout(180_000);
  const pev = await launch('hostile-no-resolver-rule', { args: ['--pev-no-resolver-rule'] });
  try {
    expect(await pev.main('dialogsStubbed')).toBe(true);
    expect(await pev.main('externalStubbed')).toBe(true);
    // The rule is really off in this run, and the other switch is still on.
    expect(await pev.main('switches')).toEqual([
      ['host-resolver-rules', ''],
      ['disable-features', 'Prerender2'],
    ]);
    // IP literals only: no host name may reach the resolver in this run.
    const plans = corpus().filter((p) => categoryOf(p) === 'ip_literals');
    expect(plans.length).toBeGreaterThan(10);
    await source(pev, plans);

    const summary: Record<string, unknown> = {};
    for (const unsanitized of [false, true]) {
      expect((await pev.main<{ ok: boolean }>('readerUnsanitized', unsanitized)).ok).toBe(true);
      for (const csp of [true, false]) {
        await pev.main('setBodyCsp', csp);
        for (const [i, plan] of plans.entries()) {
          const name = `${nameOf(plan)} ${unsanitized ? 'unsanitized' : 'normal'} csp ${csp ? 'on' : 'off'}`;
          await pev.main('clearRequests');
          const opened = await openRow(pev, i + 1, 'html');
          if (!opened.ok || opened.outcome !== 'view') throw new Error(`${name}: no view`);
          const token = tokenOf(opened.url);
          const frame = await show(pev, opened.url);
          const blockedNow = async () =>
            sorted([
              ...new Set(
                (await pev.main<Requests>('requests', 1)).blocked
                  .filter((u) => REMOTE.test(u))
                  .map(normal),
              ),
            ]);
          const loads = sorted(plan.refs.loads.map((l) => normal(l as string)));
          if (unsanitized && csp) {
            // The CSP stops the image before any request.
            await expect
              .poll(async () => sorted(await cspReported(pev, opened.url)), { timeout: 5_000 })
              .toEqual(loads);
          } else if (unsanitized) {
            // Without the CSP, the request filter cancels it.
            await expect.poll(blockedNow, { timeout: 5_000 }).toEqual(loads);
          }
          if (unsanitized) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
          // Read once everything has had time to arrive.
          const seen = await pev.main<Requests>('requests', 1);
          const blocked = await blockedNow();
          const reported = sorted(await cspReported(pev, opened.url));
          if (!unsanitized) {
            // The sanitizer leaves nothing to request.
            expect(opened.remote, name).toBe(plan.refs.rewrite);
            expect(seen.blocked, name).toEqual([]);
            expect(seen.sessionPreconnects, name).toEqual([]);
            expect(reported, name).toEqual([]);
          } else if (csp) {
            expect(reported, name).toEqual(loads);
            expect(seen.blocked, name).toEqual([]);
          } else {
            expect(blocked, name).toEqual(loads);
            expect(reported, name).toEqual([]);
          }
          // Nothing loads but this view's own placeholders.
          const images = await loadedImages(frame);
          expect(
            images.filter((u) => !u.startsWith(`mail-asset://v/${token}/`)),
            name,
          ).toEqual([]);
          expect(
            seen.asset.filter((u) => !u.startsWith(`mail-asset://v/${token}/`)),
            name,
          ).toEqual([]);
          expect(remoteFrames(pev), name).toEqual([]);
          summary[name] = {
            webRequest: blocked.length,
            csp: reported.length,
            preconnect: seen.sessionPreconnects.length,
          };
        }
      }
    }
    expect(await shown(pev)).toEqual([]);
    expect(await pev.main('externalCalls')).toEqual([]);
    console.log('hostile without the resolver rule:', JSON.stringify(summary));

    // The run stayed in the background.
    const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
    expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
    expect(await pev.main('windowEvents')).toEqual([]);
    expect(await pev.main('dialogCalls')).toEqual([]);
    // Every body showed in the reader pane's frame: no stub open, no stub frame.
    expect(await pev.main('stubOpens')).toBe(0);
    expect(await pev.page.locator('iframe.body-frame').count()).toBe(0);
  } finally {
    await pev.close();
  }
});
