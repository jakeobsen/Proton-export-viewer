// SPDX-License-Identifier: AGPL-3.0-or-later
// Remote images of a view: consent is per view and single-flight, grants
// exactly one reload, and only once the fetcher is ready; images are fetched
// on their first request and shared; revocation aborts and drops them; the
// fetcher stops when no live view has consent; the shell gets counts only,
// at most every 250 ms, with the last one always sent.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageResult } from '../../src/main/fetcher-host';
import {
  RemoteImages,
  STATUS_INTERVAL_MS,
  checkRemoteRefs,
  type ViewOwner,
} from '../../src/main/remote-images';
import { ViewRegistry, bodyUrl, type View } from '../../src/main/views';
import { MAX_BODY_REFERENCES, MAX_REMOTE_URL_LENGTH } from '../../src/shared/constants';
import type { Logger } from '../../src/shared/log/writer';

const REFS = ['https://a.test/1.png', 'http://b.test/2.png', 'https://a.test/3.png'];
const PNG: ImageResult = {
  ok: true,
  bytes: new Uint8Array([1, 2, 3]),
  format: 'png',
  contentType: 'image/png',
  insecure: false,
};
const HTTP_PNG: ImageResult = { ...PNG, insecure: true };
const REFUSED: ImageResult = { ok: false, reason: 'status', insecure: false };

function recording(): Logger & { events: Array<{ code: string; data: unknown }> } {
  const events: Array<{ code: string; data: unknown }> = [];
  const keep = (code: string, data?: unknown) => events.push({ code, data });
  return {
    events,
    log: (_level, code, data) => keep(code, data),
    error: keep,
    warn: keep,
    info: keep,
  };
}

interface Held {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface Fetch {
  viewKey: string;
  ref: string;
  url: string;
  resolve: (result: ImageResult) => void;
}

function fakeFetcher() {
  let mode: 'ready' | 'hold' | 'fail' = 'ready';
  const held: Held[] = [];
  const fetches: Fetch[] = [];
  const fetcher = {
    running: false,
    ensure: vi.fn(() => {
      if (mode === 'fail') return Promise.reject(new Error('unavailable'));
      if (mode === 'ready') {
        fetcher.running = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) =>
        held.push({
          resolve: () => {
            fetcher.running = true;
            resolve();
          },
          reject,
        }),
      );
    }),
    fetch: vi.fn(
      (viewKey: string, ref: string, url: string) =>
        new Promise<ImageResult>((resolve) => fetches.push({ viewKey, ref, url, resolve })),
    ),
    abort: vi.fn(),
    stop: vi.fn(() => {
      fetcher.running = false;
      return Promise.resolve();
    }),
  };
  return {
    fetcher,
    held,
    fetches,
    setMode: (next: typeof mode) => {
      mode = next;
    },
  };
}

let keySeq = 0;
const keys = () => (keySeq += 1).toString(16).padStart(32, 'a');

function tokens(prefix: string) {
  let n = 0;
  return () => prefix + (n += 1).toString(16).padStart(31, '0');
}

/** One app: windows, each with a registry, sharing one RemoteImages. */
function app(windowCount = 1) {
  const log = recording();
  const f = fakeFetcher();
  const registries: ViewRegistry[] = [];
  const sent: Array<{ windowId: number; openId: number; insecure: number; refused: number }> = [];
  const remote = new RemoteImages({
    fetcher: f.fetcher,
    log,
    liveViews: () => registries.flatMap((views) => views.liveViews()),
    newKey: keys,
  });
  const owners: ViewOwner[] = [];
  for (let i = 0; i < windowCount; i += 1) {
    const views = new ViewRegistry(tokens(String(i + 1)), (view) => remote.revoked(view));
    registries.push(views);
    owners.push({
      views,
      windowId: i + 1,
      send: (view, counts) => sent.push({ windowId: i + 1, openId: view.openId, ...counts }),
    });
  }
  /** Opens a view in a window, with the given remote list. */
  const open = (win = 0, refs: readonly string[] | null = REFS): View => {
    const views = registries[win]!;
    const { openId, token } = views.accept();
    const outcome = views.install(openId, token, 1, 1, {
      html: '<p>x</p>',
      assets: [],
      remoteRefs: refs,
    });
    if (!outcome.ok) throw new Error('not installed');
    return outcome.view;
  };
  return { log, ...f, remote, registries, owners, sent, open };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('checkRemoteRefs', () => {
  it('keeps a list of absolute http and https URLs, one per remote id', () => {
    expect(checkRemoteRefs(REFS, 3)).toEqual(REFS);
  });

  it.each([
    ['no remote ids', [], 0],
    ['fewer URLs than ids', REFS.slice(0, 2), 3],
    ['more URLs than ids', REFS, 2],
    ['not a list', 'https://a.test/', 1],
    ['a URL that is not a string', [1], 1],
    ['a relative URL', ['/a.png'], 1],
    ['another scheme', ['ftp://a.test/a.png'], 1],
    ['a data URL', ['data:image/png;base64,AA=='], 1],
    ['a URL that does not parse', ['https://a b.test/a.png'], 1],
    ['a URL too long', [`https://a.test/${'a'.repeat(MAX_REMOTE_URL_LENGTH)}`], 1],
  ])('refuses %s', (_name, refs, count) => {
    expect(checkRemoteRefs(refs, count)).toBeNull();
  });

  it('accepts a list at the sanitizer limit, so a body at that limit still gets consent', () => {
    const refs = Array.from({ length: MAX_BODY_REFERENCES }, (_, i) => `https://a.test/${i}.png`);
    expect(checkRemoteRefs(refs, MAX_BODY_REFERENCES)).toHaveLength(MAX_BODY_REFERENCES);
    expect(checkRemoteRefs([...refs, 'https://a.test/x.png'], MAX_BODY_REFERENCES + 1)).toBeNull();
    const longest = `https://a.test/${'a'.repeat(MAX_REMOTE_URL_LENGTH - 15)}`;
    expect(longest).toHaveLength(MAX_REMOTE_URL_LENGTH);
    expect(checkRemoteRefs([longest], 1)).toEqual([longest]);
  });
});

describe('consent', () => {
  it('allows that view only, gives it a key that is not its token, and one more load', async () => {
    const a = app();
    const view = a.open();
    const url = bodyUrl(view.token);
    expect(a.registries[0]!.spendLoad(url)).toBe('load');
    expect(await a.remote.allow(a.owners[0]!, view)).toEqual({ ok: true, reload: true });
    expect(view.remote.consent).toBe('allowed');
    expect(view.remote.viewKey).toMatch(/^[0-9a-f]{32}$/);
    expect(view.remote.viewKey).not.toBe(view.token);
    expect(a.registries[0]!.spendLoad(url)).toBe('load');
    expect(a.registries[0]!.spendLoad(url)).toBe('spent');
    expect(a.log.events).toContainEqual({
      code: 'remote.allowed',
      data: { openId: view.openId, windowId: 1 },
    });
    // The next open is back to none.
    const next = a.open();
    expect(next.remote).toMatchObject({ consent: 'none', viewKey: null });
  });

  it('makes a new key when the first one it draws is the token', async () => {
    const a = app();
    const view = a.open();
    const draws = [view.token, 'b'.repeat(32)];
    const remote = new RemoteImages({
      fetcher: a.fetcher,
      log: a.log,
      liveViews: () => a.registries[0]!.liveViews(),
      newKey: () => draws.shift() ?? 'c'.repeat(32),
    });
    await remote.allow(a.owners[0]!, view);
    expect(view.remote.viewKey).toBe('b'.repeat(32));
  });

  it('is single-flight: two requests while the fetcher starts make one start, one reload and one key', async () => {
    const a = app();
    a.setMode('hold');
    const view = a.open();
    const url = bodyUrl(view.token);
    expect(a.registries[0]!.spendLoad(url)).toBe('load');
    const first = a.remote.allow(a.owners[0]!, view);
    const key = view.remote.viewKey;
    const second = a.remote.allow(a.owners[0]!, view);
    expect(view.remote.consent).toBe('pending');
    expect(a.fetcher.ensure).toHaveBeenCalledTimes(1);
    a.held[0]!.resolve();
    const answers = await Promise.all([first, second]);
    expect(answers).toEqual([
      { ok: true, reload: true },
      { ok: true, reload: false },
    ]);
    expect(a.fetcher.ensure).toHaveBeenCalledTimes(1);
    expect(view.remote.viewKey).toBe(key);
    expect(a.registries[0]!.spendLoad(url)).toBe('load');
    expect(a.registries[0]!.spendLoad(url)).toBe('spent');
  });

  it('answers a request after consent with no reload, no load and the same key', async () => {
    const a = app();
    const view = a.open();
    await a.remote.allow(a.owners[0]!, view);
    const key = view.remote.viewKey;
    const loads = view.loads;
    expect(await a.remote.allow(a.owners[0]!, view)).toEqual({ ok: true, reload: false });
    expect(a.fetcher.ensure).toHaveBeenCalledTimes(1);
    expect(view.loads).toBe(loads);
    expect(view.remote.viewKey).toBe(key);
  });

  it('goes back to none when the fetcher could not start; a retry starts it again with the same key', async () => {
    const a = app();
    a.setMode('fail');
    const view = a.open();
    expect(await a.remote.allow(a.owners[0]!, view)).toEqual({ ok: false, code: 'unavailable' });
    expect(view.remote.consent).toBe('none');
    expect(view.loads).toBe(1);
    expect(a.log.events).toContainEqual({
      code: 'remote.refused',
      data: { reason: 'unavailable', windowId: 1 },
    });
    const key = view.remote.viewKey;
    a.setMode('ready');
    expect(await a.remote.allow(a.owners[0]!, view)).toEqual({ ok: true, reload: true });
    expect(a.fetcher.ensure).toHaveBeenCalledTimes(2);
    expect(view.remote.viewKey).toBe(key);
    expect(view.loads).toBe(2);
  });

  it('a joined request gets the failure too, and the next one starts again', async () => {
    const a = app();
    a.setMode('hold');
    const view = a.open();
    const first = a.remote.allow(a.owners[0]!, view);
    const second = a.remote.allow(a.owners[0]!, view);
    a.held[0]!.reject(new Error('spawn failed'));
    expect(await Promise.all([first, second])).toEqual([
      { ok: false, code: 'unavailable' },
      { ok: false, code: 'unavailable' },
    ]);
    expect(view.remote).toMatchObject({ consent: 'none', attempt: null });
  });

  it('answers not_live when the view is revoked while the fetcher starts, and stops the fetcher', async () => {
    const a = app();
    a.setMode('hold');
    const view = a.open();
    const answer = a.remote.allow(a.owners[0]!, view);
    a.open();
    a.held[0]!.resolve();
    expect(await answer).toEqual({ ok: false, code: 'not_live' });
    expect(view.loads).toBe(1);
    expect(view.remote.consent).toBe('none');
    expect(a.fetcher.stop).toHaveBeenCalled();
    expect(a.fetcher.running).toBe(false);
    expect(a.log.events).toContainEqual({ code: 'fetcher.stopped', data: { reason: 'idle' } });
  });

  it('serves the placeholder and fetches nothing while consent is pending', async () => {
    const a = app();
    a.setMode('hold');
    const view = a.open();
    void a.remote.allow(a.owners[0]!, view);
    expect(await a.remote.serve(a.registries[0]!, view, 'r1')).toEqual({ kind: 'placeholder' });
    expect(a.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('waits for an idle stop under way before it starts the fetcher again', async () => {
    const a = app();
    let finishStop: () => void = () => undefined;
    a.fetcher.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = () => {
            a.fetcher.running = false;
            resolve();
          };
        }),
    );
    const first = a.open();
    await a.remote.allow(a.owners[0]!, first);
    const second = a.open();
    expect(a.fetcher.stop).toHaveBeenCalledTimes(1);
    const answer = a.remote.allow(a.owners[0]!, second);
    await flush();
    expect(a.fetcher.ensure).toHaveBeenCalledTimes(1);
    finishStop();
    expect(await answer).toEqual({ ok: true, reload: true });
    expect(a.fetcher.ensure).toHaveBeenCalledTimes(2);
  });
});

describe('serving r<n>', () => {
  async function allowed(windowCount = 1) {
    const a = app(windowCount);
    const view = a.open();
    await a.remote.allow(a.owners[0]!, view);
    return { a, view, views: a.registries[0]! };
  }

  it('is the placeholder before consent, and the fetcher is never touched', async () => {
    const a = app();
    const view = a.open();
    expect(await a.remote.serve(a.registries[0]!, view, 'r1')).toEqual({ kind: 'placeholder' });
    expect(a.fetcher.fetch).not.toHaveBeenCalled();
    expect(a.fetcher.ensure).not.toHaveBeenCalled();
  });

  it('fetches an image on its first request, with the view key and its own URL, and serves the bytes and type', async () => {
    const { a, view, views } = await allowed();
    expect(a.fetcher.fetch).not.toHaveBeenCalled();
    const served = a.remote.serve(views, view, 'r2');
    expect(a.fetcher.fetch).toHaveBeenCalledWith(view.remote.viewKey, 'r2', REFS[1]);
    a.fetches[0]!.resolve({ ...PNG, format: 'gif', contentType: 'image/gif' });
    expect(await served).toEqual({
      kind: 'image',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/gif',
    });
  });

  it('shares one fetch between concurrent requests, and reuses its result after', async () => {
    const { a, view, views } = await allowed();
    const one = a.remote.serve(views, view, 'r1');
    const two = a.remote.serve(views, view, 'r1');
    expect(a.fetcher.fetch).toHaveBeenCalledTimes(1);
    a.fetches[0]!.resolve(PNG);
    expect((await one).kind).toBe('image');
    expect((await two).kind).toBe('image');
    expect((await a.remote.serve(views, view, 'r1')).kind).toBe('image');
    expect(a.fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('serves the placeholder for an image that could not load', async () => {
    const { a, view, views } = await allowed();
    const served = a.remote.serve(views, view, 'r1');
    a.fetches[0]!.resolve(REFUSED);
    expect(await served).toEqual({ kind: 'placeholder' });
  });

  it.each(['r0', 'r4', 'r10000', 'c1', 'r01'])(
    'serves the placeholder for %s, which names no URL, and fetches nothing',
    async (ref) => {
      const { a, view, views } = await allowed();
      expect(await a.remote.serve(views, view, ref)).toEqual({ kind: 'placeholder' });
      expect(a.fetcher.fetch).not.toHaveBeenCalled();
    },
  );

  it('gives nothing to a request whose view was revoked while it waited', async () => {
    const { a, view, views } = await allowed();
    const served = a.remote.serve(views, view, 'r1');
    a.open();
    a.fetches[0]!.resolve(PNG);
    expect(await served).toEqual({ kind: 'revoked' });
  });
});

describe('revocation and stopping', () => {
  it('aborts the view by its key, drops its images and URLs, and stops the idle fetcher', async () => {
    const a = app();
    const view = a.open();
    await a.remote.allow(a.owners[0]!, view);
    const served = a.remote.serve(a.registries[0]!, view, 'r1');
    a.fetches[0]!.resolve(PNG);
    await served;
    expect(view.remote.images.size).toBe(1);
    const key = view.remote.viewKey;
    a.open();
    expect(a.fetcher.abort).toHaveBeenCalledWith(key);
    expect(view.remote.images.size).toBe(0);
    expect(view.remote.refs).toBeNull();
    expect(a.fetcher.stop).toHaveBeenCalledTimes(1);
    expect(a.log.events).toContainEqual({ code: 'remote.served', data: { count: 1 } });
  });

  it('does not abort a view that never had consent', () => {
    const a = app();
    a.open();
    a.open();
    expect(a.fetcher.abort).not.toHaveBeenCalled();
    expect(a.fetcher.stop).not.toHaveBeenCalled();
  });

  it('stops a fetcher left running when no live view has consent', () => {
    const a = app();
    a.fetcher.running = true;
    a.open();
    a.open();
    expect(a.fetcher.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the fetcher while a view in another window has consent', async () => {
    const a = app(2);
    const one = a.open(0);
    const two = a.open(1);
    await a.remote.allow(a.owners[0]!, one);
    await a.remote.allow(a.owners[1]!, two);
    a.registries[0]!.close();
    expect(a.fetcher.abort).toHaveBeenCalledWith(one.remote.viewKey);
    expect(a.fetcher.stop).not.toHaveBeenCalled();
    a.registries[1]!.revokeAll();
    expect(a.fetcher.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the fetcher while a view in another window has consent pending', async () => {
    const a = app(2);
    const one = a.open(0);
    await a.remote.allow(a.owners[0]!, one);
    a.setMode('hold');
    const two = a.open(1);
    const pending = a.remote.allow(a.owners[1]!, two);
    a.registries[0]!.revokeAll();
    expect(a.fetcher.stop).not.toHaveBeenCalled();
    a.held[0]!.resolve();
    expect(await pending).toEqual({ ok: true, reload: true });
    expect(a.fetcher.stop).not.toHaveBeenCalled();
  });

  it('does not stop a fetcher that is not running', async () => {
    const a = app();
    const view = a.open();
    await a.remote.allow(a.owners[0]!, view);
    a.fetcher.running = false;
    a.open();
    expect(a.fetcher.stop).not.toHaveBeenCalled();
  });
});

describe('counts for the shell', () => {
  it('sends counts only, for that view: insecure for http images, refused for failures', async () => {
    const a = app();
    const view = a.open();
    await a.remote.allow(a.owners[0]!, view);
    const served = a.remote.serve(a.registries[0]!, view, 'r2');
    a.fetches[0]!.resolve(HTTP_PNG);
    await served;
    expect(a.sent).toEqual([{ windowId: 1, openId: view.openId, insecure: 1, refused: 0 }]);
    expect(Object.keys(a.sent[0]!).sort()).toEqual(['insecure', 'openId', 'refused', 'windowId']);
  });

  it('counts a refused image as refused only, even one that came over http', async () => {
    const a = app();
    const view = a.open();
    await a.remote.allow(a.owners[0]!, view);
    const served = a.remote.serve(a.registries[0]!, view, 'r2');
    a.fetches[0]!.resolve({ ok: false, reason: 'status', insecure: true });
    await served;
    expect(a.sent).toEqual([{ windowId: 1, openId: view.openId, insecure: 0, refused: 1 }]);
  });

  it('sends at most one update per interval, and the last count at its end', async () => {
    vi.useFakeTimers();
    const a = app();
    const view = a.open();
    await a.remote.allow(a.owners[0]!, view);
    const views = a.registries[0]!;
    const all = ['r1', 'r2', 'r3'].map((ref) => a.remote.serve(views, view, ref));
    a.fetches[0]!.resolve(PNG);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.sent).toHaveLength(1);
    a.fetches[1]!.resolve(HTTP_PNG);
    a.fetches[2]!.resolve(REFUSED);
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS - 1);
    expect(a.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.sent).toHaveLength(2);
    expect(a.sent.at(-1)).toEqual({ windowId: 1, openId: view.openId, insecure: 1, refused: 1 });
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS * 4);
    expect(a.sent).toHaveLength(2);
    await Promise.all(all);
  });

  it('sends nothing for a view once it is revoked', async () => {
    vi.useFakeTimers();
    const a = app();
    const view = a.open();
    await a.remote.allow(a.owners[0]!, view);
    const views = a.registries[0]!;
    void a.remote.serve(views, view, 'r1');
    void a.remote.serve(views, view, 'r2');
    a.fetches[0]!.resolve(PNG);
    await vi.advanceTimersByTimeAsync(0);
    a.fetches[1]!.resolve(PNG);
    await vi.advanceTimersByTimeAsync(0);
    a.open();
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS * 2);
    expect(a.sent).toHaveLength(1);
  });
});
