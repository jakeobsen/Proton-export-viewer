// SPDX-License-Identifier: AGPL-3.0-or-later
// In-app self-test for the sandboxed build. It needs no debugging port: it runs
// its checks, writes the result into userData and quits.
//
// Arguments: --pev-selftest --pev-selftest-write=<file> --pev-selftest-port=<port>
//            --pev-selftest-nonce=<value echoed into the result>

import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { app } from 'electron';
import type { AppContext } from '../main/context';
import { bodyUrl } from '../main/views';
import { createAppWindow } from '../main/windows';
import { markLoaded } from './marker';

markLoaded();

type Outcome = { ok: boolean; code: string | null };

function argValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function tryWrite(target: string | undefined): Outcome {
  if (!target) return { ok: false, code: 'NO_TARGET' };
  try {
    writeFileSync(target, 'self-test\n');
    return { ok: true, code: null };
  } catch (err) {
    return { ok: false, code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
  }
}

function tryConnect(port: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, code: 'TIMEOUT' });
    }, 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve({ ok: true, code: null });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, code: err.code ?? 'UNKNOWN' });
    });
  });
}

export async function runSelfTest(ctx: AppContext, argv: string[]): Promise<void> {
  const result = {
    nonce: argValue(argv, 'pev-selftest-nonce') ?? null,
    sandboxed: process.mas === true,
    core: false,
    worker: false,
    body: 0,
    asset: 0,
    write: { ok: false, code: 'NOT_RUN' } as Outcome,
    connect: { ok: false, code: 'NOT_RUN' } as Outcome,
    error: null as string | null,
  };
  try {
    const appWin = createAppWindow(ctx, { show: false });
    if (appWin.win.webContents.isLoading()) await once(appWin.win.webContents, 'did-finish-load');

    const ping = await ctx.core.request({ type: 'ping' });
    result.core = ping.ok;
    const { openId, token } = appWin.views.accept();
    const opened = await ctx.core.request({
      type: 'open',
      openId,
      generation: ctx.generation,
      token,
      stubId: 'sample',
    });
    result.worker = opened.ok && !!opened.body;
    if (opened.ok && opened.body) {
      appWin.views.install(openId, token, ctx.generation, ctx.generation, opened.body);
      result.body = (await appWin.session.fetch(bodyUrl(token))).status;
      result.asset = (await appWin.session.fetch(`mail-asset://v/${token}/c1`)).status;
    }

    result.write = tryWrite(argValue(argv, 'pev-selftest-write'));
    const port = Number(argValue(argv, 'pev-selftest-port'));
    result.connect = Number.isInteger(port) && port > 0 ? await tryConnect(port) : result.connect;
  } catch (err) {
    result.error = err instanceof Error ? err.constructor.name : 'NonError';
  }
  writeFileSync(
    join(app.getPath('userData'), 'selftest-result.json'),
    JSON.stringify(result, null, 2),
  );
  ctx.log.info('test.selftest');
  app.exit(0);
}
