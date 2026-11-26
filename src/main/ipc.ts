// SPDX-License-Identifier: AGPL-3.0-or-later
// IPC from the shell. Every handler checks that the sender is the main frame of
// an app window with the app://shell origin and validates its whole argument
// list. Every request carries the generation it was made for, and a stale one is
// rejected. The one exception is `state`, the bootstrap call: it takes no
// arguments and returns the current generation.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  IPC,
  type ErrorKind,
  type MessageOpenResult,
  type OpenResult,
  type PingResult,
  type Rejected,
  type RejectCode,
  type SourceActionResult,
  type SourcesResult,
  type StateResult,
} from '../shared/api';
import type { SourceOutcome } from '../shared/sources';
import { STALE, type Stale } from './sources/manager';
import { APP_ORIGIN } from '../shared/constants';
import { isRendererLogCode } from '../shared/log/codes';
import { OPEN_MODES } from '../shared/reader-protocol';
import { CoreUnavailableError } from './core-host';
import type { AppContext, AppWindow } from './context';
import { sameFrame } from './navigation';
import { bodyUrl } from './views';

const Generation = z
  .number()
  .int()
  .nonnegative()
  .max(2 ** 31);
// Each schema covers the full argument list, so extra arguments are rejected too.
const StateArgs = z.tuple([]);
const PingArgs = z.tuple([z.object({ generation: Generation }).strict()]);
const OpenArgs = z.tuple([
  z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), generation: Generation }).strict(),
]);
const MessageOpenArgs = z.tuple([
  z
    .object({
      rowid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      mode: z.enum(OPEN_MODES),
      generation: Generation,
    })
    .strict(),
]);
const LogArgs = z.tuple([
  z
    .object({
      generation: Generation,
      level: z.enum(['error', 'warn', 'info']),
      code: z.string().max(64),
      data: z.record(z.string().max(32), z.unknown()).optional(),
    })
    .strict(),
]);
const ReportArgs = z.tuple([
  z
    .object({
      generation: Generation,
      kind: z.enum(['uncaught', 'rejection', 'error']),
      errorClass: z.string().max(64),
      frames: z.array(z.string().max(200)).max(12),
    })
    .strict(),
]);

const SourceKey = z.uuid();
const RunId = z.string().regex(/^[0-9a-f]{16}$/);
const GenerationArgs = z.tuple([z.object({ generation: Generation }).strict()]);
const SourceArgs = z.tuple([z.object({ sourceKey: SourceKey, generation: Generation }).strict()]);
const RunArgs = z.tuple([z.object({ runId: RunId, generation: Generation }).strict()]);

const REPORT_CODES: Record<ErrorKind, string> = {
  uncaught: 'renderer.uncaught',
  rejection: 'renderer.rejection',
  error: 'renderer.error',
};

type Event = IpcMainInvokeEvent | IpcMainEvent;

function isDevOrigin(origin: string): boolean {
  return __PEV_DEV__ && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
}

/** Finds the app window of a trusted sender, or the reason it isn't one. */
export function checkSender(ctx: AppContext, event: Event): AppWindow | RejectCode {
  const appWin = ctx.windows.get(event.sender.id);
  if (!appWin) return 'unknown_window';
  const frame = event.senderFrame;
  if (!frame || !sameFrame(frame, event.sender.mainFrame)) return 'not_main_frame';
  if (frame.origin !== APP_ORIGIN && !isDevOrigin(frame.origin)) return 'bad_origin';
  return appWin;
}

export function registerIpc(ctx: AppContext): void {
  const reject = (code: RejectCode, appWin?: AppWindow): Rejected => {
    ctx.log.warn('ipc.rejected', appWin ? { reason: code, windowId: appWin.id } : { reason: code });
    return { ok: false, code };
  };

  const guarded = <T>(
    channel: string,
    run: (appWin: AppWindow, args: unknown[]) => Promise<T | Rejected> | T | Rejected,
  ) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const sender = checkSender(ctx, event);
      if (typeof sender === 'string') return reject(sender);
      return run(sender, args);
    });
  };

  guarded<StateResult>(IPC.state, (appWin, raw) => {
    if (!StateArgs.safeParse(raw).success) return reject('invalid', appWin);
    return { ok: true, generation: ctx.generation };
  });

  guarded<PingResult>(IPC.ping, (appWin, raw) => {
    const args = PingArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    if (args.data[0].generation !== ctx.generation) return reject('stale_generation', appWin);
    return { ok: true, generation: ctx.generation };
  });

  guarded<OpenResult>(IPC.openStub, async (appWin, raw) => {
    const args = OpenArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ id, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);

    const { openId, token, revoked } = appWin.views.accept();
    if (revoked > 0) {
      ctx.log.info('view.revoked', { reason: 'replaced', count: revoked, windowId: appWin.id });
    }
    let result;
    try {
      result = await ctx.core.request({ type: 'open', openId, generation, token, stubId: id });
    } catch (err) {
      if (!(err instanceof CoreUnavailableError)) throw err;
      ctx.log.warn('core.unavailable', { openId, windowId: appWin.id });
      return reject('core_unavailable', appWin);
    }
    if (!result.ok)
      return reject(result.code === 'unknown_stub' ? 'unknown_stub' : 'invalid', appWin);
    if (!result.body || appWin.win.isDestroyed()) return reject('superseded', appWin);

    const outcome = appWin.views.install(openId, token, generation, ctx.generation, result.body);
    if (!outcome.ok) {
      ctx.log.info('open.stale', { reason: outcome.reason, openId, windowId: appWin.id });
      return reject(outcome.reason === 'generation' ? 'stale_generation' : 'superseded', appWin);
    }
    ctx.log.info('view.installed', { openId, windowId: appWin.id });
    return { ok: true, openId, url: bodyUrl(token) };
  });

  guarded<MessageOpenResult>(IPC.open, async (appWin, raw) => {
    const args = MessageOpenArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ rowid, mode, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);

    const { openId, token, revoked } = appWin.views.accept();
    if (revoked > 0) {
      ctx.log.info('view.revoked', { reason: 'replaced', count: revoked, windowId: appWin.id });
    }
    let result;
    try {
      result = await ctx.core.request({
        type: 'read',
        openId,
        generation,
        token,
        rowid,
        mode,
        lane: appWin.id,
      });
    } catch (err) {
      if (!(err instanceof CoreUnavailableError)) throw err;
      appWin.views.abandon(openId);
      ctx.log.warn('core.unavailable', { openId, windowId: appWin.id });
      return reject('core_unavailable', appWin);
    }
    if (appWin.win.isDestroyed()) return reject('superseded', appWin);

    if (!result.ok) {
      appWin.views.abandon(openId);
      if (result.code !== 'reader_failed') {
        const known = ['no_source', 'not_found', 'superseded'] as const;
        const code = known.find((c) => c === result.code);
        return reject(code ?? 'invalid', appWin);
      }
      // The fallback stands in for a view, so it follows the same rules.
      if (generation !== ctx.generation || openId !== appWin.views.latest) {
        const reason = generation !== ctx.generation ? 'generation' : 'open_id';
        ctx.log.info('open.stale', { reason, openId, windowId: appWin.id });
        return reject(reason === 'generation' ? 'stale_generation' : 'superseded', appWin);
      }
      ctx.log.info('open.fallback', {
        reason: result.reason ?? 'crash',
        openId,
        windowId: appWin.id,
      });
      return { ok: true, openId, outcome: 'fallback' };
    }
    const message = result.read;
    if (!message) return reject('invalid', appWin);

    const outcome = appWin.views.install(openId, token, generation, ctx.generation, {
      html: message.html,
      assets: [],
      links: message.links,
    });
    if (!outcome.ok) {
      ctx.log.info('open.stale', { reason: outcome.reason, openId, windowId: appWin.id });
      return reject(outcome.reason === 'generation' ? 'stale_generation' : 'superseded', appWin);
    }
    ctx.log.info('view.installed', { openId, windowId: appWin.id });
    return {
      ok: true,
      openId,
      outcome: 'view',
      url: bodyUrl(token),
      format: message.format,
      hasHtml: message.hasHtml,
      headers: message.headers,
    };
  });

  guarded<SourcesResult>(IPC.sources, (appWin, raw) => {
    const args = GenerationArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    if (args.data[0].generation !== ctx.generation) return reject('stale_generation', appWin);
    return { ok: true, generation: ctx.generation, sources: ctx.sources.view() };
  });

  /**
   * An open, a switch, a Locate or a Forget: the outcome and the generation it left.
   * The generation is checked here and again when the action's turn comes,
   * since an action queued behind another may find it moved on.
   */
  const sourceAction = <A extends { generation: number }>(
    channel: string,
    schema: z.ZodType<[A]>,
    missing: RejectCode,
    run: (appWin: AppWindow, args: A) => Promise<SourceOutcome | null | Stale>,
  ) =>
    guarded<SourceActionResult>(channel, async (appWin, raw) => {
      const args = schema.safeParse(raw);
      if (!args.success) return reject('invalid', appWin);
      if (args.data[0].generation !== ctx.generation) return reject('stale_generation', appWin);
      const outcome = await run(appWin, args.data[0]);
      if (outcome === null) return reject(missing, appWin);
      if (outcome === STALE) return reject('stale_generation', appWin);
      return { ok: true, outcome, generation: ctx.generation };
    });

  sourceAction(IPC.chooseFolder, GenerationArgs, 'invalid', (appWin, { generation }) =>
    ctx.sources.chooseFolder(appWin.win, generation),
  );
  sourceAction(IPC.openExport, SourceArgs, 'unknown_source', (_appWin, { sourceKey, generation }) =>
    ctx.sources.openRecent(sourceKey, generation),
  );
  sourceAction(IPC.switchRun, RunArgs, 'unknown_run', (_appWin, { runId, generation }) =>
    ctx.sources.switchRun(runId, generation),
  );
  sourceAction(IPC.locateExport, GenerationArgs, 'no_source', (appWin, { generation }) =>
    ctx.sources.locate(appWin.win, generation),
  );
  sourceAction(
    IPC.forgetExport,
    SourceArgs,
    'unknown_source',
    (_appWin, { sourceKey, generation }) => ctx.sources.forget(sourceKey, generation),
  );

  /** Like `guarded`, for one-way sends; also drops a send made for a stale generation. */
  const guardedSend = <A extends { generation: number }>(
    channel: string,
    schema: z.ZodType<[A]>,
    run: (appWin: AppWindow, args: A) => void,
  ) => {
    ipcMain.on(channel, (event, ...raw: unknown[]) => {
      const sender = checkSender(ctx, event);
      if (typeof sender === 'string') {
        reject(sender);
        return;
      }
      const args = schema.safeParse(raw);
      if (!args.success) {
        reject('invalid', sender);
        return;
      }
      if (args.data[0].generation !== ctx.generation) {
        reject('stale_generation', sender);
        return;
      }
      run(sender, args.data[0]);
    });
  };

  guardedSend(IPC.log, LogArgs, (appWin, { level, code, data }) => {
    if (!isRendererLogCode(code)) {
      reject('invalid', appWin);
      return;
    }
    ctx.rendererLog.log(level, code, { ...data, windowId: appWin.id });
  });

  guardedSend(IPC.report, ReportArgs, (appWin, { kind, errorClass, frames }) => {
    ctx.rendererLog.error(REPORT_CODES[kind], { errorClass, frames, windowId: appWin.id });
  });
}
