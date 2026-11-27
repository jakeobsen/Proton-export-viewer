// SPDX-License-Identifier: AGPL-3.0-or-later
// CoreHost against a fake utility process: a stop always ends, and a call
// from the shell never starts core.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreInit, CoreSource } from '../../src/shared/core-protocol';
import type { Logger } from '../../src/shared/log/writer';

/** A utility process that spawns, and exits, only when the test says so. */
class FakeChild extends EventEmitter {
  pid: number | undefined = undefined;
  /** Once spawned, a kill ends it and it sends `exit`. */
  exitsOnKill = true;
  kills = 0;
  readonly inits: CoreInit[] = [];

  spawn() {
    this.pid = 1000;
    this.emit('spawn');
  }

  kill(): boolean {
    this.kills += 1;
    // Like a utility process with no pid yet: the kill reaches nothing.
    if (this.pid === undefined) return false;
    if (this.exitsOnKill) queueMicrotask(() => this.emit('exit', 15));
    return true;
  }

  postMessage(message: CoreInit) {
    this.inits.push(message);
  }
}

class FakePort extends EventEmitter {
  readonly posted: Array<{ type: string; reqId: number }> = [];
  closed = false;
  start() {}
  close() {
    this.closed = true;
  }
  postMessage(message: { type: string; reqId: number }) {
    this.posted.push(message);
  }
}

const fake = vi.hoisted(() => ({
  children: [] as unknown[],
  ports: [] as unknown[],
}));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
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

const { CoreHost, CoreUnavailableError } = await import('../../src/main/core-host');

const children = () => fake.children as FakeChild[];
const ports = () => fake.ports as FakePort[];

function make(stopTimeoutMs?: number) {
  const codes: string[] = [];
  const push = (code: string) => codes.push(code);
  const log = { log: (_l: unknown, c: string) => push(c), error: push, warn: push, info: push };
  const host = new CoreHost({
    corePath: 'core.js',
    logsDir: 'logs',
    indexDir: 'index',
    appRoot: 'app',
    log: log as unknown as Logger,
    ...(stopTimeoutMs === undefined ? {} : { stopTimeoutMs }),
  });
  return { host, codes };
}

/** Core `i` spawns and says it is ready. */
function ready(i: number) {
  const child = children()[i]!;
  if (child.pid === undefined) child.spawn();
  ports()[i]!.emit('message', { data: { type: 'ready' } });
}

/** Core `i` answers its latest request. */
function answer(i: number) {
  const port = ports()[i]!;
  const request = port.posted.at(-1)!;
  port.emit('message', { data: { type: 'result', reqId: request.reqId, ok: true } });
  return request;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const A1: CoreSource = { sourceKey: 'a', generation: 1, root: 'run-a' };
const A2: CoreSource = { sourceKey: 'a', generation: 2, root: 'run-a' };
const B2: CoreSource = { sourceKey: 'b', generation: 2, root: 'run-b' };
const stampOf = ({ sourceKey, generation }: CoreSource) => ({ sourceKey, generation });

/** A message open from the shell, for generation 2. */
const READ = {
  type: 'read',
  openId: 1,
  generation: 2,
  token: 't',
  rowid: 1,
  mode: 'plain',
  lane: 1,
} as const;

beforeEach(() => {
  fake.children.length = 0;
  fake.ports.length = 0;
});

describe('stopping core', () => {
  it('kills a core that had not spawned yet once it has, and the switch goes on', async () => {
    const { host, codes } = make();
    host.setSource(A1);
    const first = host.start();
    const switched = host.startWith(B2);
    await tick();
    // The kill reached nothing: the stop waits for the spawn.
    expect(children()).toHaveLength(1);
    expect(children()[0]!.kills).toBe(1);

    children()[0]!.spawn();
    await expect(first).rejects.toBeInstanceOf(CoreUnavailableError);
    await vi.waitFor(() => expect(children()).toHaveLength(2));
    expect(children()[0]!.kills).toBe(2);
    ready(1);
    expect(await switched).toBe(true);
    expect(children()[1]!.inits[0]!.source).toEqual(B2);
    expect(codes).toContain('core.exit');
    expect(codes).not.toContain('core.stop_timeout');
  });

  it('gives up on a core whose kill is lost and that never exits, and the switch still ends', async () => {
    const { host, codes } = make(30);
    host.setSource(A1);
    const first = host.start();
    // It never spawns, so its kill() returns false, and it never sends exit.
    const switched = host.startWith(B2);
    await expect(first).rejects.toBeInstanceOf(CoreUnavailableError);
    await vi.waitFor(() => expect(children()).toHaveLength(2));
    expect(codes).toContain('core.stop_timeout');
    expect(ports()[0]!.closed).toBe(true);
    ready(1);
    expect(await switched).toBe(true);
    expect(children()[1]!.inits[0]!.source).toEqual(B2);

    // A late exit of the core given up on changes nothing for the new one.
    children()[0]!.emit('exit', 0);
    expect(host.running).toBe(true);
    const asked = host.requestRunning({ type: 'ping' }, stampOf(B2));
    await tick();
    answer(1);
    expect(await asked).toMatchObject({ ok: true });
  });

  it('kills a core given up on before it spawned when it spawns late, and sends it nothing', async () => {
    const { host, codes } = make(30);
    host.setSource(A1);
    const first = host.start();
    const switched = host.startWith(B2);
    await expect(first).rejects.toBeInstanceOf(CoreUnavailableError);
    expect(codes).toContain('core.stop_timeout');
    await vi.waitFor(() => expect(children()).toHaveLength(2));
    ready(1);
    expect(await switched).toBe(true);

    // The old core spawns after all: it is killed and gets no init with the old source.
    const old = children()[0]!;
    old.exitsOnKill = false;
    old.spawn();
    expect(old.kills).toBe(2);
    expect(old.inits).toEqual([]);
    expect(codes.filter((c) => c === 'core.spawn')).toHaveLength(1);
    expect(children()[1]!.inits.map((i) => i.source)).toEqual([B2]);
    // The new core still answers.
    const asked = host.requestRunning({ type: 'ping' }, stampOf(B2));
    await tick();
    answer(1);
    expect(await asked).toMatchObject({ ok: true });
    expect(host.running).toBe(true);
  });

  it('fails the requests a core given up on still had', async () => {
    const { host } = make(30);
    host.setSource(A1);
    const first = host.start();
    children()[0]!.exitsOnKill = false;
    ready(0);
    await first;
    const pending = host.request({ type: 'ping' });
    await host.stop();
    await expect(pending).rejects.toBeInstanceOf(CoreUnavailableError);
    expect(host.running).toBe(false);
  });
});

describe('a call from the shell', () => {
  it('never starts core, and is refused while no core is up for its source', async () => {
    const { host } = make();
    await expect(host.requestRunning(READ, null)).rejects.toBeInstanceOf(CoreUnavailableError);
    await expect(host.requestRunning(READ, stampOf(A2))).rejects.toBeInstanceOf(
      CoreUnavailableError,
    );
    expect(children()).toHaveLength(0);
  });

  it('made during a switch starts no core and is refused', async () => {
    const { host } = make();
    host.setSource(A1);
    const first = host.start();
    ready(0);
    await first;

    // A rebuild of the same source under generation 2 stops the old core
    // first. While it is still up, it isn't the core for generation 2.
    children()[0]!.exitsOnKill = false;
    const stopping = host.stop();
    await expect(host.requestRunning(READ, stampOf(A2))).rejects.toBeInstanceOf(
      CoreUnavailableError,
    );
    expect(ports()[0]!.posted).toEqual([]);
    children()[0]!.emit('exit', 15);
    await stopping;
    await expect(host.requestRunning(READ, stampOf(A2))).rejects.toBeInstanceOf(
      CoreUnavailableError,
    );
    // A shell with no source open doesn't reach a core started with one.
    expect(children()).toHaveLength(1);

    // The switch starts the new core; a call for it waits until it is ready.
    const switched = host.startWith(A2);
    const read = host.requestRunning(READ, stampOf(A2));
    await expect(host.requestRunning(READ, null)).rejects.toBeInstanceOf(CoreUnavailableError);
    ready(1);
    await switched;
    await tick();
    expect(answer(1)).toMatchObject({ type: 'read', rowid: 1 });
    expect(await read).toMatchObject({ ok: true });
    expect(children()).toHaveLength(2);
    expect(ports()[0]!.posted).toEqual([]);
  });

  it('reaches a core started without a source only while no source is open', async () => {
    const { host } = make();
    const started = host.startWith(null);
    ready(0);
    await started;
    const open = { type: 'open', openId: 1, generation: 1, token: 't', stubId: 'x' } as const;
    await expect(host.requestRunning(open, stampOf(A1))).rejects.toBeInstanceOf(
      CoreUnavailableError,
    );
    const asked = host.requestRunning(open, null);
    await tick();
    expect(answer(0)).toMatchObject({ type: 'open', stubId: 'x' });
    expect(await asked).toMatchObject({ ok: true });
    expect(children()).toHaveLength(1);
  });
});
