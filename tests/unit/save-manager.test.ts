// SPDX-License-Identifier: AGPL-3.0-or-later
// Main's saves: one at a time and at most four waiting per window; a one-shot
// asset only main's own download (a GET with the save's nonce) may fetch,
// once; `will-download` accepts only that download, after its body was served;
// a save publishes only a complete, checked download; cancels leave nothing
// behind; nothing names a file in the log, or holds the nonce.

import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_WAITING,
  SAVE_PROOF_HEADER,
  SaveManager,
  checkProof,
  type DownloadLike,
  type PreviewAsk,
  type Proof,
  type SaveAsk,
  type SaveDeps,
  type SaveRequestProof,
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
  const heads: Array<Record<string, string>> = [];
  const win = {
    id: 3,
    download: (url: string, headers: Record<string, string>) => {
      urls.push(url);
      heads.push(headers);
    },
  };
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
    heads,
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
  const nonce = t.heads[0]![SAVE_PROOF_HEADER]!;
  const saves = t.manager.forWindow(t.win.id);
  /** Main's own download request, as the handler sees it. */
  const main: SaveRequestProof = { method: 'GET', header: nonce };
  return { outcome, url, nonce, main, saves, ...t.parts(url) };
}

/** Main's download as Chromium runs it: the request is served, then `will-download`, then the body. */
async function download(
  s: Awaited<ReturnType<typeof started>>,
  item: FakeItem,
  received?: number,
): Promise<void> {
  const body = s.saves.serve(s.token, s.id, s.main);
  expect(body).not.toBeNull();
  expect(s.saves.willDownload(item, null)).toBe(true);
  await item.complete(body!, received);
}

describe('SaveManager', () => {
  it('saves: one-shot asset, main’s own download, publish under the cleaned name', async () => {
    const t = setup();
    const s = await started(t);
    expect(s.id).toBe('a0');
    // The proof header is the only one, with a fresh 128-bit nonce of its own.
    expect(Object.keys(t.heads[0]!)).toEqual([SAVE_PROOF_HEADER]);
    expect(s.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(s.nonce).not.toBe(s.token);
    expect(s.url).not.toContain(s.nonce);
    const body = s.saves.serve(s.token, s.id, s.main);
    expect(body).not.toBeNull();
    expect(body!.headers.get('content-length')).toBe(String(BYTES.length));
    expect(body!.headers.get('content-disposition')).toBe('attachment');
    // Served once.
    expect(s.saves.serve(s.token, s.id, s.main)).toBeNull();
    const item = new FakeItem(s.url);
    expect(s.saves.willDownload(item, null)).toBe(true);
    expect(item.savePath.startsWith(t.staging.dir)).toBe(true);
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
    expect(text).not.toContain(s.nonce);
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
    await download(s, new FakeItem(s.url));
    expect(await s.outcome).toMatchObject({ ok: true });
    expect(readFileSync(join(t.downloads, NAME), 'utf8')).toBe('theirs');
    expect(readFileSync(join(t.downloads, 'marker-name-7f3a (2).pdf'))).toEqual(BYTES);
  });

  for (const [label, request, proof] of [
    ['no proof header (a page’s request)', () => ({ method: 'GET', header: null }), 'missing'],
    ['an empty proof header', () => ({ method: 'GET', header: '' }), 'missing'],
    [
      'another nonce of the same length',
      (n: string) => ({ method: 'GET', header: n.replace(/^./, (c) => (c === '0' ? '1' : '0')) }),
      'wrong',
    ],
    [
      'the nonce with one more character',
      (n: string) => ({ method: 'GET', header: `${n}0` }),
      'wrong',
    ],
    ['the nonce cut short', (n: string) => ({ method: 'GET', header: n.slice(0, -1) }), 'wrong'],
    ['a HEAD with the nonce', (n: string) => ({ method: 'HEAD', header: n }), 'match'],
    [
      'an OPTIONS with the nonce (a CORS preflight)',
      (n: string) => ({ method: 'OPTIONS', header: n }),
      'match',
    ],
  ] as const) {
    it(`a request for the save asset with ${label} uses it up and fails the save`, async () => {
      const t = setup();
      const proofs: Proof[] = [];
      t.manager.test = { onProof: (p) => proofs.push(p) };
      const s = await started(t);
      expect(s.saves.serve(s.token, s.id, request(s.nonce))).toBeNull();
      // Main's own request comes too late: the asset is gone.
      expect(s.saves.serve(s.token, s.id, s.main)).toBeNull();
      expect(proofs).toEqual([proof]);
      expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
      expect(t.logged.at(-1)).toMatchObject({ code: 'save.failed', data: { reason: 'foreign' } });
      expect(JSON.stringify(t.logged)).not.toContain(s.nonce);
    });
  }

  it('compares the proof header in constant time, and calls any other length wrong', () => {
    const nonce = 'ab'.repeat(16);
    expect(checkProof(nonce, nonce)).toBe('match');
    expect(checkProof(null, nonce)).toBe('missing');
    expect(checkProof('', nonce)).toBe('missing');
    expect(checkProof('ba'.repeat(16), nonce)).toBe('wrong');
    expect(checkProof(nonce.slice(1), nonce)).toBe('wrong');
    expect(checkProof(`${nonce}a`, nonce)).toBe('wrong');
    // Same number of characters, more bytes.
    expect(checkProof(`${nonce.slice(1)}é`, nonce)).toBe('wrong');
  });

  it('will-download refuses any other URL, and leaves the save waiting', async () => {
    const t = setup({ downloadStartMs: 200 });
    const s = await started(t);
    expect(
      s.saves.willDownload(new FakeItem('mail-asset://v/' + 'f'.repeat(32) + '/a0'), null),
    ).toBe(false);
    await download(s, new FakeItem(s.url));
    expect(await s.outcome).toMatchObject({ ok: true });
  });

  for (const [label, origin, frame] of [
    ['no initiator and no frame', '', null],
    [
      'the shell as initiator, from the top-level frame (as Chromium reports it)',
      'app://shell',
      { parent: null },
    ],
  ] as const) {
    it(`will-download of main's served download with ${label} is accepted`, async () => {
      const t = setup();
      const s = await started(t);
      const body = s.saves.serve(s.token, s.id, s.main)!;
      const item = new FakeItem(s.url, [s.url], origin);
      expect(s.saves.willDownload(item, frame)).toBe(true);
      await item.complete(body);
      expect(await s.outcome).toMatchObject({ ok: true });
    });
  }

  it('will-download of the save’s URL before its body was served is refused and fails the save', async () => {
    const t = setup();
    const s = await started(t);
    expect(s.saves.willDownload(new FakeItem(s.url), null)).toBe(false);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(t.logged.at(-1)).toMatchObject({ code: 'save.failed', data: { reason: 'foreign' } });
    expect(s.saves.serve(s.token, s.id, s.main)).toBeNull();
  });

  for (const [label, make, frame] of [
    ['a redirect', (url: string) => new FakeItem(url, ['mail-asset://v/x/a0', url]), null],
    ['an opaque initiator', (url: string) => new FakeItem(url, [url], 'null'), null],
    ['a body frame’s origin', (url: string) => new FakeItem(url, [url], 'mail-body://v'), null],
    ['a web origin', (url: string) => new FakeItem(url, [url], 'https://example.com'), null],
    ['a subframe', (url: string) => new FakeItem(url, [url], 'app://shell'), { parent: {} }],
    ['a frame of unknown place', (url: string) => new FakeItem(url, [url], ''), { frame: true }],
    [
      'a frame that can’t be read',
      (url: string) => new FakeItem(url, [url], ''),
      {
        get parent(): unknown {
          throw new Error('gone');
        },
      },
    ],
  ] as const) {
    it(`will-download of the save's URL with ${label} is refused and fails the save`, async () => {
      // Serving the body restarts the idle timer: a refusal that can't fail the save ends it there.
      const t = setup({ downloadStartMs: 200, idleMs: 200 });
      const s = await started(t);
      expect(s.saves.serve(s.token, s.id, s.main)).not.toBeNull();
      expect(s.saves.willDownload(make(s.url), frame)).toBe(false);
      expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    });
  }

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
    await download(s, new FakeItem(s.url), BYTES.length - 1);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(existsSync(t.downloads) ? readdirSync(t.downloads) : []).toEqual([]);
    expect(readdirSync(t.staging.dir)).toEqual([]);
  });

  it('a download that completes before core’s last checked chunk publishes nothing', async () => {
    const t = setup();
    const s = await started(t);
    const item = new FakeItem(s.url);
    expect(s.saves.serve(s.token, s.id, s.main)).not.toBeNull();
    s.saves.willDownload(item, null);
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
    await download(s, new FakeItem(s.url));
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(readdirSync(t.downloads)).toEqual([]);
    expect(t.logged.at(-1)).toMatchObject({ data: { reason: 'export_root' } });
  });

  it('a file core finds changed errors the body and fails the save', async () => {
    const t = setup();
    t.setPulls([{ code: 'changed' }]);
    const s = await started(t);
    const item = new FakeItem(s.url);
    const body = s.saves.serve(s.token, s.id, s.main)!;
    s.saves.willDownload(item, null);
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

  // Root can remove a folder from a read-only parent, so the failure can't be made there.
  it.skipIf(process.getuid?.() === 0)(
    'at quit, a staging folder that can’t be removed is logged, and quit doesn’t throw',
    () => {
      const t = setup();
      t.staging.ensure();
      writeFileSync(t.staging.newFile(), 'staged');
      const userData = dirname(t.staging.dir);
      chmodSync(userData, 0o555);
      try {
        expect(() => t.manager.quit()).not.toThrow();
      } finally {
        chmodSync(userData, 0o755);
      }
      expect(t.logged.filter((l) => l.code === 'save.staging_failed')).toEqual([
        { level: 'warn', code: 'save.staging_failed', data: {} },
      ]);
    },
  );

  it('a download that never starts fails the save', async () => {
    const t = setup({ downloadStartMs: 50 });
    const s = await started(t);
    expect(await s.outcome).toEqual({ ok: false, code: 'save_failed' });
    expect(t.logged.at(-1)).toMatchObject({ data: { reason: 'stalled' } });
    // The one-shot is gone with the save.
    expect(s.saves.serve(s.token, s.id, s.main)).toBeNull();
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
    expect(s.saves.serve(s.token, s.id, s.main)).not.toBeNull();
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

describe('SaveManager previews', () => {
  const IMAGE = Buffer.from('image bytes, synthetic, as core checked them');
  const previewAsk = (t: ReturnType<typeof setup>): PreviewAsk => ({
    openId: t.ask.openId,
    generation: t.ask.generation,
    rowid: t.ask.rowid,
    file: t.ask.file,
    version: t.ask.version,
    target: {
      kind: 'preview',
      path: '1.3',
      contentType: 'image/png',
      size: IMAGE.length,
      format: 'png',
    },
  });
  const opened = (size: number): CoreResult => ({ type: 'result', reqId: 0, ok: true, size });

  it('pulls the part into memory: no staging, no download, nothing published', async () => {
    const t = setup();
    t.setOpen(opened(IMAGE.length));
    t.setPulls([
      { chunk: new Uint8Array(IMAGE.subarray(0, 10)), done: false },
      { chunk: new Uint8Array(IMAGE.subarray(10)), done: true },
    ]);
    const outcome = await t.manager.preview(t.win, previewAsk(t));
    expect(outcome).toEqual({ ok: true, bytes: new Uint8Array(IMAGE) });
    expect(t.calls).toEqual([
      expect.objectContaining({ type: 'save-open', target: previewAsk(t).target }),
      expect.objectContaining({ type: 'save-pull' }),
      expect.objectContaining({ type: 'save-pull' }),
    ]);
    expect(t.urls).toEqual([]);
    expect(existsSync(t.staging.dir) ? readdirSync(t.staging.dir) : []).toEqual([]);
    expect(existsSync(t.downloads)).toBe(false);
    // The view logs the preview once it holds it.
    expect(t.logged).toEqual([]);
  });

  for (const [label, pulls, reason] of [
    [
      'more bytes than the view listed, at once',
      [{ chunk: new Uint8Array(IMAGE.length + 1), done: false }],
      'refused',
    ],
    [
      'more bytes than the view listed, over two chunks',
      [
        { chunk: new Uint8Array(IMAGE.length), done: false },
        { chunk: new Uint8Array(1), done: true },
      ],
      'refused',
    ],
    ['core’s refusal of the bytes', [{ code: 'refused' }], 'refused'],
    ['a changed file', [{ code: 'changed' }], 'changed'],
    ['fewer bytes than listed', [{ chunk: new Uint8Array(IMAGE.length - 1), done: true }], 'short'],
  ] as const) {
    it(`a preview with ${label} fails, logs “${reason}” and tells core`, async () => {
      const t = setup();
      t.setOpen(opened(IMAGE.length));
      t.setPulls(pulls.map((p) => ({ ...p })));
      expect(await t.manager.preview(t.win, previewAsk(t))).toEqual({
        ok: false,
        code: 'preview_failed',
      });
      expect(t.logged).toEqual([
        { level: 'info', code: 'preview.refused', data: { reason, windowId: 3 } },
      ]);
      // Core is told to stop, unless its last chunk came and was taken.
      expect(t.calls.some((c) => c.type === 'save-cancel')).toBe(reason !== 'short');
    });
  }

  it('a preview core won’t open, or opens at another size, fails before any pull', async () => {
    for (const [answer, reason] of [
      [{ type: 'result', reqId: 0, ok: false, code: 'refused' }, 'refused'],
      [{ type: 'result', reqId: 0, ok: false, code: 'unreadable' }, 'unreadable'],
      [{ type: 'result', reqId: 0, ok: false, code: 'eml_missing' }, 'not_found'],
      [opened(IMAGE.length + 1), 'refused'],
    ] as const) {
      const t = setup();
      t.setOpen(answer as CoreResult);
      expect(await t.manager.preview(t.win, previewAsk(t))).toEqual({
        ok: false,
        code: 'preview_failed',
      });
      expect(t.calls.some((c) => c.type === 'save-pull')).toBe(false);
      expect(t.logged.at(-1)).toEqual({
        level: 'info',
        code: 'preview.refused',
        data: { reason, windowId: 3 },
      });
    }
  });

  it('a preview waits behind a running save, and runs after it', async () => {
    const t = setup();
    const s = await started(t);
    const preview = t.manager.preview(t.win, previewAsk(t));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.calls.filter((c) => c.type === 'save-open')).toHaveLength(1);
    t.setOpen(opened(IMAGE.length));
    t.setPulls([
      { chunk: new Uint8Array(BYTES), done: true },
      { chunk: new Uint8Array(IMAGE), done: true },
    ]);
    await download(s, new FakeItem(s.url));
    expect(await s.outcome).toMatchObject({ ok: true });
    expect(await preview).toEqual({ ok: true, bytes: new Uint8Array(IMAGE) });
    expect(t.calls.filter((c) => c.type === 'save-open')).toHaveLength(2);
  });

  it(`previews count towards the ${MAX_WAITING} waiting; a source change drops a waiting one`, async () => {
    const t = setup({ downloadStartMs: 60_000 });
    const first = await started(t);
    const waiting = Array.from({ length: MAX_WAITING }, () =>
      t.manager.preview(t.win, previewAsk(t)),
    );
    expect(await t.manager.preview(t.win, previewAsk(t))).toEqual({
      ok: false,
      code: 'queue_full',
    });
    expect(t.logged.at(-1)).toEqual({
      level: 'info',
      code: 'preview.refused',
      data: { reason: 'queue_full', windowId: 3 },
    });
    expect(await t.manager.request(t.win, t.ask)).toEqual({ ok: false, code: 'queue_full' });
    t.manager.cancelAll('generation');
    expect(await first.outcome).toEqual({ ok: false, code: 'save_failed' });
    for (const w of waiting) expect(await w).toEqual({ ok: false, code: 'preview_failed' });
    expect(
      t.logged.filter((l) => l.code === 'preview.refused' && l.data.reason === 'generation'),
    ).toHaveLength(MAX_WAITING);
    // Every event passes the log's allowlist as it is.
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
  });

  it('a running preview stops at a source change, and tells core', async () => {
    const t = setup();
    t.setOpen(opened(IMAGE.length));
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    t.setPulls([{ chunk: new Uint8Array(IMAGE), done: true }]);
    const request = t.manager['deps'].request;
    t.manager['deps'].request = async (call, stamp) => {
      if (call.type === 'save-pull') await held;
      return request(call, stamp);
    };
    const preview = t.manager.preview(t.win, previewAsk(t));
    await t.waitFor(() => t.calls.some((c) => c.type === 'save-open'));
    await new Promise((r) => setTimeout(r, 5));
    t.manager.cancelAll('generation');
    release();
    expect(await preview).toEqual({ ok: false, code: 'preview_failed' });
    expect(t.calls.map((c) => c.type)).toContain('save-cancel');
    expect(t.logged.at(-1)).toMatchObject({
      code: 'preview.refused',
      data: { reason: 'generation' },
    });
  });
});
