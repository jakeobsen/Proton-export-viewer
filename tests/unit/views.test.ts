// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ViewRegistry, bodyUrl } from '../../src/main/views';

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
