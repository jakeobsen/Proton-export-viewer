// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ViewRegistry, bodyUrl, sourceUrl } from '../../src/main/views';

const body = {
  html: '<p>x</p>',
  assets: [{ id: 'c1', contentType: 'image/png', bytes: new Uint8Array([1]) }],
};

function tokens() {
  let n = 0;
  return () => (n += 1).toString(16).padStart(32, '0');
}

describe('ViewRegistry', () => {
  it('installs the latest open and authorizes its URL', () => {
    const views = new ViewRegistry(tokens());
    const { openId, token } = views.accept();
    const outcome = views.install(openId, token, 1, 1, body);
    expect(outcome.ok).toBe(true);
    expect(views.lookup(token)?.assets.get('c1')?.contentType).toBe('image/png');
    expect(views.authorizedUrl()).toBe(bodyUrl(token));
  });

  it('revokes the live view as soon as the next open is accepted', () => {
    const views = new ViewRegistry(tokens());
    const first = views.accept();
    views.install(first.openId, first.token, 1, 1, body);
    const second = views.accept();
    expect(second.revoked).toBe(1);
    expect(views.lookup(first.token)).toBeUndefined();
    expect(views.authorizedUrl()).toBeNull();
    expect(views.lookup(second.token)).toBeUndefined();
  });

  it('discards a stale openId result', () => {
    const views = new ViewRegistry(tokens());
    const first = views.accept();
    const second = views.accept();
    expect(views.install(first.openId, first.token, 1, 1, body)).toEqual({
      ok: false,
      reason: 'open_id',
    });
    expect(views.install(second.openId, second.token, 1, 1, body).ok).toBe(true);
    expect(views.liveCount).toBe(1);
  });

  it('discards a completion from a previous generation', () => {
    const views = new ViewRegistry(tokens());
    const open = views.accept();
    views.revokeAll();
    expect(views.install(open.openId, open.token, 1, 2, body)).toEqual({
      ok: false,
      reason: 'generation',
    });
    expect(views.liveCount).toBe(0);
  });

  it('close revokes the live view and the open under way, whose view or fallback is then stale', () => {
    const views = new ViewRegistry(tokens());
    const first = views.accept();
    views.install(first.openId, first.token, 1, 1, body);
    const pending = views.accept();
    expect(views.close()).toBe(0);
    expect(views.lookup(first.token)).toBeUndefined();
    expect(views.authorizedUrl()).toBeNull();
    // A late view installs nothing, and a late fallback, checked by open id, is stale too.
    expect(views.install(pending.openId, pending.token, 1, 1, body)).toEqual({
      ok: false,
      reason: 'open_id',
    });
    expect(views.latest).not.toBe(pending.openId);
    // A view that was live when the reader closed is counted.
    const next = views.accept();
    views.install(next.openId, next.token, 1, 1, body);
    expect(views.close()).toBe(1);
    expect(views.lookup(next.token)).toBeUndefined();
  });

  it('ignores lookups that are not 128-bit hex tokens', () => {
    const views = new ViewRegistry(tokens());
    expect(views.lookup('../x')).toBeUndefined();
    expect(views.lookup('A'.repeat(32))).toBeUndefined();
  });

  it('makes 128-bit random tokens by default', () => {
    const views = new ViewRegistry();
    const { token } = views.accept();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('ViewRegistry: loads of the body URL', () => {
  function live() {
    const views = new ViewRegistry(tokens());
    const { openId, token } = views.accept();
    const outcome = views.install(openId, token, 1, 1, body);
    if (!outcome.ok) throw new Error('not installed');
    return { views, view: outcome.view, url: bodyUrl(token) };
  }

  it('allows the first load of the live URL and refuses the next', () => {
    const { views, url } = live();
    expect(views.spendLoad(url)).toBe('load');
    expect(views.spendLoad(url)).toBe('spent');
    expect(views.spendLoad(url)).toBe('spent');
  });

  it('allows one more load per grant: the initial load, one reload, then nothing', () => {
    const { views, view, url } = live();
    expect(views.spendLoad(url)).toBe('load');
    expect(views.grantLoad(view)).toBe(true);
    expect(views.spendLoad(url)).toBe('load');
    expect(views.spendLoad(url)).toBe('spent');
  });

  it('never authorizes another URL, a revoked view, or a grant to a view that is not live', () => {
    const { views, view, url } = live();
    expect(views.spendLoad(bodyUrl('f'.repeat(32)))).toBe('not_authorized');
    expect(views.spendLoad(`${url}/x`)).toBe('not_authorized');
    views.revokeAll();
    expect(views.spendLoad(url)).toBe('not_authorized');
    expect(views.grantLoad(view)).toBe(false);
    expect(view.loads).toBe(1);
  });

  it('spends no load on a source document, and Back allows the body one more load', () => {
    const views = new ViewRegistry(tokens());
    const { openId, token } = views.accept();
    const message = { rowid: 7, file: null, messageId: '', attachments: [] };
    const outcome = views.install(openId, token, 1, 1, { ...body, message });
    if (!outcome.ok) throw new Error('not installed');
    const url = bodyUrl(token);
    expect(views.spendLoad(url)).toBe('load');
    const view = views.beginSource(openId)!;
    const doc = views.showSource(
      view,
      view.source!.session,
      views.select(view)!,
      '<pre>h</pre>',
      'h',
    );
    expect(doc).toBe(sourceUrl(token, 1));
    expect(views.spendLoad(doc!)).toBe('load');
    expect(views.spendLoad(doc!)).toBe('load');
    expect(view.loads).toBe(0);
    expect(views.leaveSource(view)).toBe(url);
    expect(views.spendLoad(url)).toBe('load');
    expect(views.spendLoad(url)).toBe('spent');
  });

  it('gives a source-only view no remote images, and spends nothing on its documents', () => {
    const views = new ViewRegistry(tokens());
    const { openId, token } = views.accept();
    views.markFallback(openId, 1, 17);
    const view = views.beginSource(openId)!;
    expect(view.sourceOnly).toBe(true);
    expect(view.remote.refs).toBeNull();
    expect(view.loads).toBe(0);
    const doc = views.showSource(
      view,
      view.source!.session,
      views.select(view)!,
      '<pre>h</pre>',
      'h',
    );
    expect(views.spendLoad(doc!)).toBe('load');
    expect(views.spendLoad(bodyUrl(token))).toBe('not_authorized');
  });
});

describe('ViewRegistry: remote references and revocation', () => {
  it('keeps a remote list on the view, and none when it is empty or absent', () => {
    const views = new ViewRegistry(tokens());
    const a = views.accept();
    const one = views.install(a.openId, a.token, 1, 1, {
      ...body,
      remoteRefs: ['https://a.test/1.png'],
    });
    expect(one.ok && one.view.remote).toMatchObject({
      refs: ['https://a.test/1.png'],
      consent: 'none',
      viewKey: null,
    });
    const b = views.accept();
    const none = views.install(b.openId, b.token, 1, 1, { ...body, remoteRefs: [] });
    expect(none.ok && none.view.remote.refs).toBeNull();
    const c = views.accept();
    const absent = views.install(c.openId, c.token, 1, 1, body);
    expect(absent.ok && absent.view.remote.refs).toBeNull();
  });

  it('tells the hook about each revoked view once it is no longer live', () => {
    const seen: Array<{ token: string; live: boolean }> = [];
    const views: ViewRegistry = new ViewRegistry(tokens(), (view) =>
      seen.push({ token: view.token, live: views.isLive(view) }),
    );
    const first = views.accept();
    views.install(first.openId, first.token, 1, 1, body);
    expect(seen).toEqual([]);
    const second = views.accept();
    expect(seen).toEqual([{ token: first.token, live: false }]);
    views.install(second.openId, second.token, 1, 1, body);
    views.close();
    expect(seen).toEqual([
      { token: first.token, live: false },
      { token: second.token, live: false },
    ]);
    views.revokeAll();
    expect(seen).toHaveLength(2);
  });

  it('finds the live view by its open id, and nothing for an older open', () => {
    const views = new ViewRegistry(tokens());
    const first = views.accept();
    views.install(first.openId, first.token, 1, 1, body);
    const second = views.accept();
    const outcome = views.install(second.openId, second.token, 1, 1, body);
    expect(views.byOpenId(first.openId)).toBeUndefined();
    expect(outcome.ok && views.byOpenId(second.openId) === outcome.view).toBe(true);
    expect(views.liveViews()).toHaveLength(1);
  });
});
