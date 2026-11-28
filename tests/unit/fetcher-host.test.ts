// SPDX-License-Identifier: AGPL-3.0-or-later
// FetcherHost against a fake utility process: it starts only through the
// guard, with an environment of its own and nothing of main's; a spawn is bounded (a throw, an exit
// before ready and a silent fetcher each fail it, and the guard's finally
// runs); a crash fails pending images and the next fetch spawns again through
// the guard; main trusts nothing the fetcher sends.

import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetcherInit } from '../../src/shared/fetcher-protocol';
import { IMAGE_MAX_BYTES } from '../../src/shared/fetcher-protocol';
import { LogWriter, type Logger } from '../../src/shared/log/writer';
import { paddedPng, solidPng } from '../../tools/gen-export/images.mjs';
import { MARKERS, MARKER_TEXT, findMarkers } from '../markers';
import { testDir } from '../paths';

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined;
  exitsOnKill = true;
  kills = 0;
  readonly inits: FetcherInit[] = [];
  spawn() {
    this.pid = 2000;
    this.emit('spawn');
  }
  kill(): boolean {
    this.kills += 1;
    if (this.pid === undefined) return false;
    if (this.exitsOnKill) queueMicrotask(() => this.emit('exit', 15));
    return true;
  }
  postMessage(message: FetcherInit) {
    this.inits.push(message);
  }
}

class FakePort extends EventEmitter {
  readonly posted: Array<Record<string, unknown>> = [];
  closed = false;
  start() {}
  close() {
    this.closed = true;
  }
  postMessage(message: Record<string, unknown>) {
    this.posted.push(message);
  }
}

const fake = vi.hoisted(() => ({
  children: [] as unknown[],
  ports: [] as unknown[],
  forks: [] as Array<{ path: string; options: Record<string, unknown> }>,
  throwOnFork: false,
}));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (path: string, _args: string[], options: Record<string, unknown>) => {
      if (fake.throwOnFork) throw new Error('fork failed');
      fake.forks.push({ path, options });
      const child = new FakeChild();
      fake.children.push(child);
      return child;
    },
  },
  MessageChannelMain: class {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      fake.ports.push(this.port1);
    }
  },
}));

const { FetcherHost } = await import('../../src/main/fetcher-host');

const children = () => fake.children as FakeChild[];
const ports = () => fake.ports as FakePort[];
const tick = () => new Promise((r) => setTimeout(r, 0));
const PNG = solidPng(2, 2, [1, 2, 3]);

function make(
  options: {
    readyTimeoutMs?: number;
    stopTimeoutMs?: number;
    relayLimit?: { events: number; windowMs: number };
  } = {},
) {
  const codes: string[] = [];
  const relayed: Array<{ level: string; code: string; data: unknown }> = [];
  const guard: string[] = [];
  const killed: number[] = [];
  let now = 0;
  const log = {
    log: (_l: string, c: string) => codes.push(c),
    error: (c: string) => codes.push(c),
    warn: (c: string, d?: unknown) => codes.push(d ? `${c} ${JSON.stringify(d)}` : c),
    info: (c: string) => codes.push(c),
  };
  const relay = {
    log: (level: string, code: string, data: unknown) => relayed.push({ level, code, data }),
  };
  const host = new FetcherHost({
    fetcherPath: 'fetcher.js',
    log: log as unknown as Logger,
    relay: relay as unknown as Logger,
    spawnGuard: async (spawn) => {
      guard.push('release');
      try {
        await spawn();
      } finally {
        guard.push('restart');
      }
    },
    killProcess: (pid) => killed.push(pid),
    now: () => now,
    ...options,
  });
  return { host, codes, relayed, guard, killed, advance: (ms: number) => (now += ms) };
}

/** Fetcher `i` spawns and says it is ready. */
function ready(i: number) {
  const child = children()[i]!;
  if (child.pid === undefined) child.spawn();
  ports()[i]!.emit('message', { data: { type: 'ready' } });
}

/** The fetcher sends a message to main. */
const send = (i: number, data: unknown) => ports()[i]!.emit('message', { data });

beforeEach(() => {
  fake.children.length = 0;
  fake.ports.length = 0;
  fake.forks.length = 0;
  fake.throwOnFork = false;
});

describe('starting the fetcher', () => {
  it('spawns only through the guard, with an environment of its own, and waits for ready', async () => {
    const { host, guard, codes } = make();
    const started = host.ensure();
    expect(guard).toEqual(['release']);
    // One fixed entry and nothing else: an empty map would make Electron pass
    // main's whole environment on.
    expect(fake.forks).toEqual([
      {
        path: 'fetcher.js',
        options: { serviceName: 'Fetcher', stdio: 'ignore', env: { PEV_PROCESS: 'fetcher' } },
      },
    ]);
    ready(0);
    await started;
    expect(guard).toEqual(['release', 'restart']);
    expect(codes).toEqual(['fetcher.spawn', 'fetcher.ready']);
    expect(children()[0]!.inits).toEqual([{ type: 'init' }]);
    // A second ensure uses the running fetcher.
    await host.ensure();
    expect(fake.forks).toHaveLength(1);
  });

  it('passes the test init only when one is set', async () => {
    const { host } = make();
    host.testInit = { loopbackAllow: { address: '127.0.0.1', port: 4000 }, recordConnects: true };
    const started = host.ensure();
    ready(0);
    await started;
    expect(children()[0]!.inits[0]).toEqual({
      type: 'init',
      test: { loopbackAllow: { address: '127.0.0.1', port: 4000 }, recordConnects: true },
    });
  });

  it('a fork that throws fails the spawn, and the guard restarts the scope', async () => {
    const { host, guard } = make();
    fake.throwOnFork = true;
    await expect(host.ensure()).rejects.toThrow();
    expect(guard).toEqual(['release', 'restart']);
    fake.throwOnFork = false;
    const again = host.ensure();
    ready(0);
    await again;
    expect(guard).toEqual(['release', 'restart', 'release', 'restart']);
  });

  it('an exit before ready fails the spawn, and the guard restarts the scope', async () => {
    const { host, guard } = make();
    const started = host.ensure();
    children()[0]!.spawn();
    children()[0]!.emit('exit', 1);
    await expect(started).rejects.toThrow();
    expect(guard).toEqual(['release', 'restart']);
    expect(host.running).toBe(false);
  });

  it('a fetcher that never says ready is killed after the timeout, and the guard restarts the scope', async () => {
    const { host, guard, codes } = make({ readyTimeoutMs: 20, stopTimeoutMs: 20 });
    const started = host.ensure();
    children()[0]!.spawn();
    await expect(started).rejects.toThrow();
    expect(codes).toContain('fetcher.ready_timeout {"ms":20}');
    expect(children()[0]!.kills).toBeGreaterThan(0);
    expect(guard).toEqual(['release', 'restart']);
  });

  it('a silent fetcher that also ignores its kill is ended for good, and the spawn still ends', async () => {
    const { host, guard, killed } = make({ readyTimeoutMs: 20, stopTimeoutMs: 20 });
    const started = host.ensure();
    children()[0]!.exitsOnKill = false;
    children()[0]!.spawn();
    await expect(started).rejects.toThrow();
    expect(killed).toEqual([2000]);
    expect(guard).toEqual(['release', 'restart']);
  });
});

describe('fetching', () => {
  async function running() {
    const t = make();
    const started = t.host.ensure();
    ready(0);
    await started;
    return t;
  }

  it('sends the request and serves main’s own check of the bytes', async () => {
    const { host } = await running();
    const result = host.fetch('v1', 'r1', 'https://example.com/a.png');
    await tick();
    expect(ports()[0]!.posted).toEqual([
      { type: 'fetch', viewKey: 'v1', ref: 'r1', url: 'https://example.com/a.png' },
    ]);
    // The fetcher claims GIF; main's check finds PNG and serves that.
    send(0, {
      type: 'result',
      viewKey: 'v1',
      ref: 'r1',
      ok: true,
      bytes: new Uint8Array(PNG),
      format: 'gif',
      insecure: false,
    });
    expect(await result).toMatchObject({
      ok: true,
      format: 'png',
      contentType: 'image/png',
      insecure: false,
    });
  });

  it('main refuses bytes its own raster check refuses, whatever the fetcher said', async () => {
    const { host } = await running();
    const result = host.fetch('v1', 'r1', 'https://example.com/a.png');
    await tick();
    send(0, {
      type: 'result',
      viewKey: 'v1',
      ref: 'r1',
      ok: true,
      bytes: new TextEncoder().encode('<svg/>'),
      format: 'png',
      insecure: false,
    });
    expect(await result).toEqual({ ok: false, reason: 'format', insecure: false });
  });

  it('drops results for no pending image, and refuses malformed ones for a pending image', async () => {
    const { host } = await running();
    const a = host.fetch('v1', 'a', 'https://example.com/a.png');
    const b = host.fetch('v1', 'b', 'https://example.com/b.png');
    const c = host.fetch('v1', 'c', 'https://example.com/c.png');
    const d = host.fetch('v1', 'd', 'https://example.com/d.png');
    await tick();
    // Not pending: dropped.
    send(0, {
      type: 'result',
      viewKey: 'v2',
      ref: 'a',
      ok: true,
      bytes: new Uint8Array(PNG),
      insecure: false,
    });
    send(0, {
      type: 'result',
      viewKey: 'v1',
      ref: 'zz',
      ok: false,
      reason: 'status',
      insecure: false,
    });
    send(0, 'junk');
    send(0, null);
    send(0, { type: 'mystery' });
    // Pending, but malformed.
    send(0, {
      type: 'result',
      viewKey: 'v1',
      ref: 'a',
      ok: true,
      bytes: 'not bytes',
      insecure: false,
    });
    send(0, {
      type: 'result',
      viewKey: 'v1',
      ref: 'b',
      ok: true,
      bytes: new Uint8Array(paddedPng(IMAGE_MAX_BYTES + 1)),
      insecure: false,
    });
    send(0, {
      type: 'result',
      viewKey: 'v1',
      ref: 'c',
      ok: false,
      reason: 'made-up',
      insecure: true,
    });
    send(0, { type: 'result', viewKey: 'v1', ref: 'd', ok: true, bytes: new Uint8Array(PNG) });
    expect(await a).toEqual({ ok: false, reason: 'invalid', insecure: false });
    expect(await b).toEqual({ ok: false, reason: 'invalid', insecure: false });
    expect(await c).toEqual({ ok: false, reason: 'invalid', insecure: true });
    expect(await d).toEqual({ ok: false, reason: 'invalid', insecure: false });
  });

  it('takes an image of exactly IMAGE_MAX_BYTES', async () => {
    const { host } = await running();
    const result = host.fetch('v1', 'r1', 'https://example.com/a.png');
    await tick();
    send(0, {
      type: 'result',
      viewKey: 'v1',
      ref: 'r1',
      ok: true,
      bytes: new Uint8Array(paddedPng(IMAGE_MAX_BYTES)),
      insecure: true,
    });
    expect(await result).toMatchObject({ ok: true, insecure: true });
  });

  it('passes a known refusal through', async () => {
    const { host } = await running();
    const result = host.fetch('v1', 'r1', 'https://example.com/a.png');
    await tick();
    send(0, {
      type: 'result',
      viewKey: 'v1',
      ref: 'r1',
      ok: false,
      reason: 'tls',
      insecure: false,
    });
    expect(await result).toEqual({ ok: false, reason: 'tls', insecure: false });
  });

  it('an abort resolves the view’s images at once and tells the fetcher', async () => {
    const { host } = await running();
    const a = host.fetch('v1', 'a', 'https://example.com/a.png');
    const b = host.fetch('v2', 'b', 'https://example.com/b.png');
    await tick();
    host.abort('v1');
    expect(await a).toEqual({ ok: false, reason: 'aborted', insecure: false });
    expect(ports()[0]!.posted.at(-1)).toEqual({ type: 'abort', viewKey: 'v1' });
    expect([...host.pendingViews()]).toEqual(['v2']);
    // A late result for the aborted image is dropped; the other view goes on.
    send(0, {
      type: 'result',
      viewKey: 'v1',
      ref: 'a',
      ok: true,
      bytes: new Uint8Array(PNG),
      insecure: false,
    });
    send(0, {
      type: 'result',
      viewKey: 'v2',
      ref: 'b',
      ok: true,
      bytes: new Uint8Array(PNG),
      insecure: false,
    });
    expect(await b).toMatchObject({ ok: true });
  });

  it('a crash fails pending images with crashed; the next fetch spawns again through the guard', async () => {
    const { host, guard } = await running();
    const a = host.fetch('v1', 'a', 'https://example.com/a.png');
    await tick();
    children()[0]!.emit('exit', 9);
    expect(await a).toEqual({ ok: false, reason: 'crashed', insecure: false });
    expect(host.running).toBe(false);
    const b = host.fetch('v1', 'b', 'https://example.com/b.png');
    expect(guard).toEqual(['release', 'restart', 'release']);
    ready(1);
    await tick();
    expect(guard).toEqual(['release', 'restart', 'release', 'restart']);
    expect(ports()[1]!.posted).toEqual([
      { type: 'fetch', viewKey: 'v1', ref: 'b', url: 'https://example.com/b.png' },
    ]);
    send(1, {
      type: 'result',
      viewKey: 'v1',
      ref: 'b',
      ok: true,
      bytes: new Uint8Array(PNG),
      insecure: false,
    });
    expect(await b).toMatchObject({ ok: true });
  });

  it('a fetch while the fetcher can’t start resolves crashed', async () => {
    const { host } = make();
    fake.throwOnFork = true;
    expect(await host.fetch('v1', 'a', 'https://example.com/a.png')).toEqual({
      ok: false,
      reason: 'crashed',
      insecure: false,
    });
  });

  it('a stop resolves pending images aborted and ends the process', async () => {
    const { host } = await running();
    const a = host.fetch('v1', 'a', 'https://example.com/a.png');
    await tick();
    await host.stop();
    expect(await a).toEqual({ ok: false, reason: 'aborted', insecure: false });
    expect(host.running).toBe(false);
  });

  it('a result from an earlier fetcher is dropped', async () => {
    const { host } = await running();
    const old = ports()[0]!;
    children()[0]!.emit('exit', 9);
    const b = host.fetch('v1', 'b', 'https://example.com/b.png');
    ready(1);
    await tick();
    old.emit('message', {
      data: {
        type: 'result',
        viewKey: 'v1',
        ref: 'b',
        ok: false,
        reason: 'status',
        insecure: false,
      },
    });
    send(1, {
      type: 'result',
      viewKey: 'v1',
      ref: 'b',
      ok: true,
      bytes: new Uint8Array(PNG),
      insecure: false,
    });
    expect(await b).toMatchObject({ ok: true });
  });
});

describe('relayed log events', () => {
  async function running(relayLimit?: { events: number; windowMs: number }) {
    const t = make(relayLimit ? { relayLimit } : {});
    const started = t.host.ensure();
    ready(0);
    await started;
    return t;
  }

  it('relays only fetcher codes at known levels, with plain data', async () => {
    const { relayed } = await running();
    send(0, {
      type: 'log',
      level: 'info',
      code: 'fetcher.fetched',
      data: { status: 200, bytes: 10, ms: 3 },
    });
    send(0, { type: 'log', level: 'info', code: 'app.reset' });
    send(0, { type: 'log', level: 'info', code: 'fetcher.not-a-code' });
    send(0, { type: 'log', level: 'debug', code: 'fetcher.fetched' });
    send(0, { type: 'log', level: 'info', code: 'fetcher.fetched', data: [1, 2] });
    send(0, {
      type: 'log',
      level: 'info',
      code: 'fetcher.fetched',
      data: 'https://marker.example/',
    });
    expect(relayed).toEqual([
      { level: 'info', code: 'fetcher.fetched', data: { status: 200, bytes: 10, ms: 3 } },
    ]);
  });

  it('caps the rate, and says how many it dropped', async () => {
    const { relayed, codes, advance } = await running({ events: 3, windowMs: 1000 });
    for (let i = 0; i < 5; i += 1)
      send(0, { type: 'log', level: 'info', code: 'fetcher.refused', data: { reason: 'status' } });
    expect(relayed).toHaveLength(3);
    advance(1000);
    send(0, { type: 'log', level: 'info', code: 'fetcher.refused', data: { reason: 'status' } });
    expect(relayed).toHaveLength(4);
    expect(codes).toContain('fetcher.relay_dropped {"count":2}');
  });

  it('a marker the fetcher puts in an event reaches no log file: main’s schema drops it', async () => {
    const dir = testDir('fetcher-relay');
    const writer = new LogWriter(dir, 'main', 'main');
    const host = new FetcherHost({
      fetcherPath: 'fetcher.js',
      log: writer,
      relay: writer.forProc('fetcher'),
      spawnGuard: (spawn) => spawn(),
    });
    const started = host.ensure();
    ready(0);
    await started;
    const [, , , tracker, hostName] = MARKERS;
    send(0, {
      type: 'log',
      level: 'info',
      code: 'fetcher.refused',
      data: {
        reason: tracker,
        url: tracker,
        host: hostName,
        text: MARKER_TEXT,
        status: 404,
        ms: 3,
      },
    });
    send(0, {
      type: 'log',
      level: 'warn',
      code: 'fetcher.uncaught',
      data: { errorClass: hostName },
    });
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toEqual(['main.jsonl']);
    const text = readFileSync(join(dir, 'main.jsonl'), 'utf8');
    expect(findMarkers(text)).toEqual([]);
    const lines = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { proc: string; code: string; data: Record<string, unknown> });
    const relayed = lines.filter((l) => l.proc === 'fetcher');
    expect(relayed.map((l) => [l.code, l.data])).toEqual([
      ['fetcher.refused', { status: 404, ms: 3, dropped: 4 }],
      ['fetcher.uncaught', { dropped: 1 }],
    ]);
  });
});
