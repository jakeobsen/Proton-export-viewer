// SPDX-License-Identifier: AGPL-3.0-or-later
// The body frame loads its view's URL as often as the view allows: once,
// then once more per granted consent. A reload past that is refused and
// logged as such; no other frame spends a load.

import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { guardNavigation } from '../../src/main/navigation';
import { ViewRegistry, bodyUrl } from '../../src/main/views';
import type { Logger } from '../../src/shared/log/writer';

function setUp() {
  const events: Array<{ code: string; data: unknown }> = [];
  const keep = (code: string, data?: unknown) => events.push({ code, data });
  const log: Logger = {
    log: (_l, code, data) => keep(code, data),
    info: keep,
    warn: keep,
    error: keep,
  };
  const handlers = new Map<string, (event: unknown) => void>();
  const mainFrame = { processId: 1, frameToken: 'main' };
  const contents = {
    mainFrame,
    on: (name: string, run: (event: unknown) => void) => handlers.set(name, run),
    setWindowOpenHandler: () => undefined,
  } as unknown as WebContents;
  const views = new ViewRegistry();
  guardNavigation(contents, { views, windowId: 1, log, openLink: () => null });
  const { openId, token } = views.accept();
  const outcome = views.install(openId, token, 1, 1, { html: '', assets: [] });
  if (!outcome.ok) throw new Error('not installed');
  const url = bodyUrl(token);
  /** A navigation of a frame whose parent is `parent`; true when it may go ahead. */
  const navigate = (to: string, parent: object = mainFrame) => {
    const event = { url: to, isMainFrame: false, frame: { parent }, preventDefault: vi.fn() };
    handlers.get('will-frame-navigate')!(event);
    return event.preventDefault.mock.calls.length === 0;
  };
  return { views, view: outcome.view, url, navigate, events };
}

describe('body frame loads', () => {
  it('loads the view once, refuses a reload, and allows one more after a grant', () => {
    const t = setUp();
    expect(t.navigate(t.url)).toBe(true);
    expect(t.navigate(t.url)).toBe(false);
    expect(t.events).toEqual([
      {
        code: 'nav.denied',
        data: { reason: 'reload_spent', scheme: 'mail-body', windowId: 1 },
      },
    ]);
    t.views.grantLoad(t.view);
    expect(t.navigate(t.url)).toBe(true);
    expect(t.navigate(t.url)).toBe(false);
  });

  it('refuses another URL as not authorized, and a nested frame spends no load', () => {
    const t = setUp();
    expect(t.navigate(bodyUrl('e'.repeat(32)))).toBe(false);
    expect(t.navigate(t.url, { processId: 1, frameToken: 'other' })).toBe(false);
    expect(t.events.map((e) => (e.data as { reason: string }).reason)).toEqual([
      'not_authorized',
      'not_authorized',
    ]);
    expect(t.navigate(t.url)).toBe(true);
  });
});
