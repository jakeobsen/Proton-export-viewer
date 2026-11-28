// SPDX-License-Identifier: AGPL-3.0-or-later
// Main's saves: one at a time and at most four waiting per window; a one-shot
// asset only main's own download may fetch, once; `will-download` accepts only
// that download; a save publishes only a complete, checked download; cancels
// leave nothing behind; nothing names a file in the log.

import { EventEmitter } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_WAITING,
  SaveManager,
  type DownloadLike,
  type SaveAsk,
  type SaveDeps,
} from '../../src/main/saves/manager';
import { Staging } from '../../src/main/saves/staging';
import type { CoreResult } from '../../src/shared/core-protocol';
import { sanitizeEvent } from '../../src/shared/log/schema';
import { testDir } from '../paths';

const BYTES = Buffer.from('attachment bytes, synthetic');
const NAME = 'marker-name-7f3a.pdf';

class FakeItem extends EventEmitter implements DownloadLike {
  savePath = '';
  received = 0;
  cancelled = 0;
  constructor(
    private readonly url: string,
    readonly chain: string[] = [url],
    readonly origin: string | (() => string) = '',
  ) {
    super();
  }
  getURL() {
    return this.url;
  }
  getURLChain() {
    return this.chain;
  }
  getInitiatorOrigin() {
    return typeof this.origin === 'function' ? this.origin() : this.origin;
  }
  setSavePath(path: string) {
    this.savePath = path;
  }
  getReceivedBytes() {
    return this.received;
  }
  cancel() {
    this.cancelled += 1;
    this.emit('done', {}, 'cancelled');
  }
  /** A download that ends complete without the body's last chunk (core's check never came). */
  completeUnread(bytes: Buffer) {
    writeFileSync(this.savePath, bytes);
    this.received = bytes.length;
    this.emit('done', {}, 'completed');
  }
  /** What Chromium does: writes the body to the save path, then reports done. */
  async complete(body: Response, received?: number) {
    const bytes = Buffer.from(await body.arrayBuffer());
    writeFileSync(this.savePath, bytes);
    this.received = received ?? bytes.length;
    this.emit('done', {}, 'completed');
  }
}

interface Logged {
  level: string;
  code: string;
  data: Record<string, unknown>;
}

function setup(
  options: { roots?: (dir: string) => string[]; downloadStartMs?: number; idleMs?: number } = {},
) {
  const dir = testDir('save-manager');
  const userData = join(dir, 'userData');
  const downloads = join(dir, 'Downloads');
  mkdirSync(userData);
  const staging = new Staging(userData);
  const calls: Array<{ type: string }> = [];
  const logged: Logged[] = [];
  let pulls: Array<{ chunk: Uint8Array; done: boolean } | { code: string }> = [
    { chunk: new Uint8Array(BYTES), done: true },
  ];
  let openAnswer: CoreResult = { type: 'result', reqId: 0, ok: true, size: BYTES.length };
  const log =
    (level: string) =>
    (code: string, data: Record<string, unknown> = {}) =>
      logged.push({ level, code, data });
  const deps: SaveDeps = {
    log: {
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    } as unknown as SaveDeps['log'],
    request: (call) => {
      calls.push(call);
      if (call.type === 'save-open') return Promise.resolve(openAnswer);
      if (call.type === 'save-pull') {
        const next = pulls.shift() ?? { code: 'cancelled' };
        return Promise.resolve(
          'code' in next
            ? ({ type: 'result', reqId: 0, ok: false, code: next.code } as CoreResult)
            : { type: 'result', reqId: 0, ok: true, chunk: next.chunk, done: next.done },
        );
      }
      return Promise.resolve({ type: 'result', reqId: 0, ok: true });
    },
    stamp: () => null,
    downloads: () => downloads,
    exportRoots: () => options.roots?.(dir) ?? [join(dir, 'export')],
    staging,
    ...(options.downloadStartMs ? { downloadStartMs: options.downloadStartMs } : {}),
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
  };
  const manager = new SaveManager(deps);
  const urls: string[] = [];
  const win = { id: 3, download: (url: string) => urls.push(url) };
  const ask: SaveAsk = {
    openId: 9,
    generation: 1,
    rowid: 17,
    file: { dev: '1', ino: '2' },
    version: { size: '500', mtimeNs: '1' },
    target: { kind: 'part', path: '1.2', contentType: 'application/pdf', size: BYTES.length },
    assetId: 'a0',
    name: NAME,
  };
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i += 1) await new Promise((r) => setTimeout(r, 2));
    expect(check()).toBe(true);
  };
  /** The token and id of the URL main asked the window to download. */
  const parts = (url: string) => {
    const m = /^mail-asset:\/\/v\/([0-9a-f]{32})\/(\w+)$/.exec(url);
    expect(m).not.toBeNull();
    return { token: m![1]!, id: m![2]! };
  };
  return {
    dir,
    downloads,
    staging,
    calls,
    logged,
    manager,
    win,
    ask,
    urls,
    waitFor,
    parts,
    setPulls: (p: typeof pulls) => {
      pulls = p;
    },
    setOpen: (r: CoreResult) => {
      openAnswer = r;
    },
  };
}

/** Runs one save to the point where main has asked the window to download it. */
async function started(t: ReturnType<typeof setup>) {
  const outcome = t.manager.request(t.win, t.ask);
  await t.waitFor(() => t.urls.length === 1);
  const url = t.urls[0]!;
  const saves = t.manager.forWindow(t.win.id);
  return { outcome, url, saves, ...t.parts(url) };
}

describe('SaveManager', () => {
  it('saves: one-shot asset, main’s own download, publish under the cleaned name', async () => {
    const t = setup();
    const s = await started(t);
    expect(s.id).toBe('a0');
    const item = new FakeItem(s.url);
    expect(s.saves.willDownload(item, null)).toBe(true);
    expect(item.savePath.startsWith(t.staging.dir)).toBe(true);
    const body = s.saves.serve(s.token, s.id, false);
    expect(body).not.toBeNull();
    expect(body!.headers.get('content-length')).toBe(String(BYTES.length));
    expect(body!.headers.get('content-disposition')).toBe('attachment');
    // Served once.
    expect(s.saves.serve(s.token, s.id, false)).toBeNull();
    await item.complete(body!);
    const outcome = await s.outcome;
    expect(outcome).toEqual({ ok: true, saveId: 1 });
    expect(readFileSync(join(t.downloads, NAME))).toEqual(BYTES);
    expect(readdirSync(t.staging.dir)).toEqual([]);
    expect(s.saves.savedFile(1, t.ask.openId)?.path).toBe(join(t.downloads, NAME));
    expect(s.saves.savedFile(1, t.ask.openId + 1)).toBeNull();
    // The log has codes, sizes and reasons only: no name, path or URL.
    const text = JSON.stringify(t.logged);
    expect(text).not.toContain('marker-name');
    expect(text).not.toContain(s.token);
    for (const entry of t.logged) {
      const clean = sanitizeEvent({
        level: entry.level as 'info',
        proc: 'main',
        code: entry.code,
        data: entry.data,
      });
      expect(clean, entry.code).not.toBeNull();
      expect(clean?.data).toEqual(entry.data);
    }
    expect(t.logged.map((l) => l.code)).toEqual(['save.started', 'save.done']);
  });

  it('a second save of the same name gets " (2)"', async () => {
    const t = setup();
    mkdirSync(t.downloads);
    writeFileSync(join(t.downloads, NAME), 'theirs');
    const s = await started(t);
    const item = new FakeItem(s.url);
    s.saves.willDownload(item, null);
    await item.complete(s.saves.serve(s.token, s.id, false)!);
    expect(await s.outcome).toMatchObject({ ok: true });
    expect(readFileSync(join(t.downloads, NAME), 'utf8')).toBe('theirs');
    expect(readFileSync(join(t.downloads, 'marker-name-7f3a (2).pdf'))).toEqual(BYTES);
  });

  it('a page’s request for the save asset uses it up and fails the save', async () => {
    const t = setup();
    const s = await started(t);
    expect(s.saves.serve(s.token, s.id, true)).toBeNull();
    expect(s.saves.serve(s.token, s.id, false)).toBeNull();
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(t.logged.at(-1)).toMatchObject({ code: 'save.failed', data: { reason: 'foreign' } });
  });

  it('will-download refuses any other URL, and leaves the save waiting', async () => {
    const t = setup({ downloadStartMs: 200 });
    const s = await started(t);
    expect(
      s.saves.willDownload(new FakeItem('mail-asset://v/' + 'f'.repeat(32) + '/a0'), null),
    ).toBe(false);
    const item = new FakeItem(s.url);
    expect(s.saves.willDownload(item, null)).toBe(true);
    await item.complete(s.saves.serve(s.token, s.id, false)!);
    expect(await s.outcome).toMatchObject({ ok: true });
  });

  for (const [label, make] of [
    ['a redirect', (url: string) => new FakeItem(url, ['mail-asset://v/x/a0', url])],
    ['a page as initiator', (url: string) => new FakeItem(url, [url], 'app://shell')],
    ['an opaque initiator', (url: string) => new FakeItem(url, [url], 'null')],
  ] as const) {
    it(`will-download of the save's URL with ${label} is refused and fails the save`, async () => {
      const t = setup();
      const s = await started(t);
      expect(s.saves.willDownload(make(s.url), null)).toBe(false);
      expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    });
  }

  it('will-download started by a frame is refused and fails the save', async () => {
    const t = setup();
    const s = await started(t);
    expect(s.saves.willDownload(new FakeItem(s.url), { frame: true })).toBe(false);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
  });

  it('initiator information that can’t be read never counts as main’s own', async () => {
    const t = setup({ downloadStartMs: 100 });
    const s = await started(t);
    const item = new FakeItem(s.url, [s.url], () => {
      throw new Error('unknown');
    });
    expect(s.saves.willDownload(item, null)).toBe(false);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
  });

  it('a download that ends short publishes nothing and leaves nothing', async () => {
    const t = setup();
    const s = await started(t);
    const item = new FakeItem(s.url);
    s.saves.willDownload(item, null);
    await item.complete(s.saves.serve(s.token, s.id, false)!, BYTES.length - 1);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(existsSync(t.downloads) ? readdirSync(t.downloads) : []).toEqual([]);
    expect(readdirSync(t.staging.dir)).toEqual([]);
  });

  it('a download that completes before core’s last checked chunk publishes nothing', async () => {
    const t = setup();
    const s = await started(t);
    const item = new FakeItem(s.url);
    s.saves.willDownload(item, null);
    expect(s.saves.serve(s.token, s.id, false)).not.toBeNull();
    item.completeUnread(BYTES);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(existsSync(t.downloads) ? readdirSync(t.downloads) : []).toEqual([]);
  });

  it('the export check runs again just before publishing', async () => {
    let exportNow = false;
    // No export at the start; the downloads folder is one by the time it publishes.
    const t = setup({ roots: (dir) => (exportNow ? [join(dir, 'Downloads')] : []) });
    t.manager.test = {
      onStaged: () => {
        exportNow = true;
        return Promise.resolve();
      },
    };
    const s = await started(t);
    const item = new FakeItem(s.url);
    s.saves.willDownload(item, null);
    await item.complete(s.saves.serve(s.token, s.id, false)!);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(readdirSync(t.downloads)).toEqual([]);
    expect(t.logged.at(-1)).toMatchObject({ data: { reason: 'export_root' } });
  });

  it('a file core finds changed errors the body and fails the save', async () => {
    const t = setup();
    t.setPulls([{ code: 'changed' }]);
    const s = await started(t);
    const item = new FakeItem(s.url);
    s.saves.willDownload(item, null);
    const body = s.saves.serve(s.token, s.id, false)!;
    await expect(body.arrayBuffer()).rejects.toThrow();
    expect(item.cancelled).toBe(1);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(t.logged.at(-1)).toMatchObject({ code: 'save.failed', data: { reason: 'changed' } });
  });

  it('a file core refuses to open fails the save before any download', async () => {
    const t = setup();
    t.setOpen({ type: 'result', reqId: 0, ok: false, code: 'changed' });
    expect(await t.manager.request(t.win, t.ask)).toEqual({ ok: false, code: 'save_failed' });
    expect(t.urls).toEqual([]);
  });

  it('a downloads folder inside an export is refused before anything is made', async () => {
    const t = setup({ roots: (dir) => [join(dir, 'Downloads')] });
    expect(await t.manager.request(t.win, t.ask)).toEqual({ ok: false, code: 'save_failed' });
    expect(t.calls).toEqual([]);
    expect(existsSync(t.downloads)).toBe(false);
    expect(existsSync(t.staging.dir)).toBe(false);
    expect(t.logged.at(-1)).toMatchObject({ data: { reason: 'export_root' } });
  });

  it('a staging folder inside an export is refused before anything is made', async () => {
    const t = setup({ roots: (dir) => [join(dir, 'userData')] });
    expect(await t.manager.request(t.win, t.ask)).toEqual({ ok: false, code: 'save_failed' });
    expect(t.calls).toEqual([]);
    expect(existsSync(t.staging.dir)).toBe(false);
    expect(t.logged.at(-1)).toMatchObject({ data: { reason: 'export_root' } });
  });

  it('at quit, a noted fallback copy is kept in a folder inside an export, and removed outside', () => {
    for (const inside of [true, false]) {
      const t = setup({ roots: (dir) => [join(dir, inside ? 'Downloads' : 'export')] });
      mkdirSync(t.downloads);
      const partial = Staging.partialIn(t.downloads);
      t.staging.notePartial(partial);
      writeFileSync(partial, 'copy', { flag: 'wx' });
      const st = lstatSync(partial, { bigint: true });
      t.staging.ownPartial(partial, {
        dev: st.dev.toString(),
        ino: st.ino.toString(),
        birth: st.birthtimeNs.toString(),
      });
      t.manager.quit();
      expect(existsSync(partial)).toBe(inside);
      expect(existsSync(t.staging.dir)).toBe(false);
      const kept = t.logged.filter((l) => l.code === 'save.partial_kept');
      expect(kept.map((l) => l.data)).toEqual(inside ? [{ reason: 'export_root' }] : []);
    }
  });

  it('a download that never starts fails the save', async () => {
    const t = setup({ downloadStartMs: 50 });
    const s = await started(t);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(t.logged.at(-1)).toMatchObject({ data: { reason: 'stalled' } });
    // The one-shot is gone with the save.
    expect(s.saves.serve(s.token, s.id, false)).toBeNull();
  });

  it(`at most ${MAX_WAITING} saves wait per window; the next is refused at once`, async () => {
    const t = setup({ downloadStartMs: 60_000 });
    const first = await started(t);
    const waiting = Array.from({ length: MAX_WAITING }, () => t.manager.request(t.win, t.ask));
    expect(await t.manager.request(t.win, t.ask)).toEqual({ ok: false, code: 'queue_full' });
    expect(t.logged.at(-1)).toMatchObject({ code: 'save.queue_full', data: { windowId: 3 } });
    // Another window has its own room.
    const other = t.manager.request({ id: 4, download: () => undefined }, t.ask);
    t.manager.cancelAll('generation');
    expect(await first.outcome).toEqual({ ok: false, code: 'save_failed' });
    for (const w of waiting) expect(await w).toEqual({ ok: false, code: 'save_failed' });
    expect(await other).toEqual({ ok: false, code: 'save_failed' });
  });

  it('a source change cancels the running download and tells core', async () => {
    const t = setup();
    const s = await started(t);
    const item = new FakeItem(s.url);
    s.saves.willDownload(item, null);
    t.manager.cancelAll('generation');
    expect(item.cancelled).toBe(1);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(t.calls.map((c) => c.type)).toContain('save-cancel');
    expect(readdirSync(t.staging.dir)).toEqual([]);
  });

  it('closing the window cancels its saves only', async () => {
    const t = setup({ downloadStartMs: 60_000 });
    const s = await started(t);
    const queued = t.manager.request(t.win, t.ask);
    t.manager.closeWindow(t.win.id);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(await queued).toEqual({ ok: false, code: 'save_failed' });
  });

  it('the shown file is remembered by save and view, for the last few saves', async () => {
    const t = setup();
    const saves = t.manager.forWindow(1);
    for (let i = 1; i <= 20; i += 1)
      saves.remember(i, { path: `/p${i}`, dev: '1', ino: String(i), openId: 5 });
    expect(saves.savedFile(1, 5)).toBeNull();
    expect(saves.savedFile(20, 5)?.path).toBe('/p20');
  });
});
