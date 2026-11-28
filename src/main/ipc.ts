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
  type CloseViewResult,
  type ErrorKind,
  type IndexResult,
  type LinkActionResult,
  type MessageOpenResult,
  type OpenResult,
  type PingResult,
  type Rejected,
  type RejectCode,
  type SearchResult,
  type SnippetsResult,
  type SourceActionResult,
  type SourcesResult,
  type StateResult,
} from '../shared/api';
import {
  CARDS_AFTER,
  CARDS_BEFORE,
  CARDS_FOLLOW,
  MAX_QUERY_LENGTH,
  MAX_SNIPPET_THREADS,
  WINDOW_AFTER,
  WINDOW_BEFORE,
  type SearchPage,
  type SearchSnippets,
} from '../shared/index-types';
import type { SourceOutcome } from '../shared/sources';
import { STALE, type Stale } from './sources/manager';
import { APP_ORIGIN, LINK_ACTIONS } from '../shared/constants';
import { isRendererLogCode } from '../shared/log/codes';
import { OPEN_MODES } from '../shared/reader-protocol';
import { CoreUnavailableError } from './core-host';
import type { AppContext, AppWindow } from './context';
import { DIALOG_ID_RE } from './link-dialog';
import { sameFrame } from './navigation';
import { OPEN_GAP_MS, OpenPacer } from './open-pacer';
import { PLACEHOLDER } from './placeholder';
import { SUPERSEDED, SearchLanes } from './search-lane';
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
// The shell names the dialog and the choice; main keeps the URL.
const LinkActionArgs = z.tuple([
  z
    .object({
      dialogId: z.string().regex(DIALOG_ID_RE),
      action: z.enum(LINK_ACTIONS),
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

const Rowid = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ListKey = z
  .object({
    time: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    threadId: Rowid,
  })
  .strict();
const ShellQuery = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sidebar') }).strict(),
  z
    .object({
      op: z.literal('window'),
      // A folder or label ID from labels.json; never a path.
      labelId: z.string().min(1).max(256),
      anchor: z
        .object({
          rowid: Rowid.optional(),
          key: ListKey.optional(),
          index: z
            .number()
            .int()
            .nonnegative()
            .max(2 ** 31),
        })
        .strict(),
      before: z.number().int().min(0).max(WINDOW_BEFORE),
      after: z.number().int().min(1).max(WINDOW_AFTER),
      selected: Rowid.nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal('cards'),
      follow: z.array(Rowid).max(CARDS_FOLLOW),
      threadId: Rowid.nullable(),
      anchor: z
        .object({
          rowid: Rowid.optional(),
          key: z
            .object({
              time: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
              rowid: Rowid,
            })
            .strict()
            .optional(),
          index: z
            .number()
            .int()
            .nonnegative()
            .max(2 ** 31),
        })
        .strict(),
      before: z.number().int().min(0).max(CARDS_BEFORE),
      after: z.number().int().min(1).max(CARDS_AFTER),
    })
    .strict(),
]);
const IndexArgs = z.tuple([z.object({ query: ShellQuery, generation: Generation }).strict()]);

// A search: the text, the sort and its keyset, nothing else.
const SearchThreadId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SearchText = z.string().max(MAX_QUERY_LENGTH);
const SearchArgs = z.tuple([
  z.discriminatedUnion('sort', [
    z
      .object({
        text: SearchText,
        sort: z.literal('date'),
        after: z
          .object({
            time: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
            threadId: SearchThreadId,
          })
          .strict()
          .nullable(),
        generation: Generation,
      })
      .strict(),
    z
      .object({
        text: SearchText,
        sort: z.literal('relevance'),
        after: z.object({ rank: z.number(), threadId: SearchThreadId }).strict().nullable(),
        generation: Generation,
      })
      .strict(),
  ]),
]);

// Snippets for result rows: the search they belong to and its conversations.
const SnippetsArgs = z.tuple([
  z
    .object({
      queryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      threadIds: z.array(SearchThreadId).min(1).max(MAX_SNIPPET_THREADS),
      generation: Generation,
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
      // Only a core already up for the open source: a call from the shell
      // never starts one.
      result = await ctx.core.requestRunning(
        { type: 'open', openId, generation, token, stubId: id },
        ctx.sources.stamp(),
      );
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

  /**
   * Closes the reader of this window: its view and any open still under way
   * are revoked, so a late result installs nothing.
   */
  guarded<CloseViewResult>(IPC.closeView, (appWin, raw) => {
    const args = GenerationArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    if (args.data[0].generation !== ctx.generation) return reject('stale_generation', appWin);
    const revoked = appWin.views.close();
    if (revoked > 0) {
      ctx.log.info('view.revoked', { reason: 'closed', count: revoked, windowId: appWin.id });
    }
    return { ok: true };
  });

  const openPacer = new OpenPacer<AppWindow>(() =>
    __PEV_TEST_HOOKS__ ? (ctx.openGapMs ?? OPEN_GAP_MS) : OPEN_GAP_MS,
  );
  guarded<MessageOpenResult>(IPC.open, async (appWin, raw) => {
    const args = MessageOpenArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ rowid, mode, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);

    const { openId, token, revoked } = appWin.views.accept();
    if (revoked > 0) {
      ctx.log.info('view.revoked', { reason: 'replaced', count: revoked, windowId: appWin.id });
    }
    // An export that isn't there can't be read: nothing goes to core.
    if (ctx.sources.isOffline()) {
      appWin.views.abandon(openId);
      return reject('offline', appWin);
    }
    // The body frame's opens are spaced out, and a newer open takes the place
    // of one still waiting, so fast selection can't outrun the frame.
    if (!(await openPacer.turn(appWin))) {
      appWin.views.abandon(openId);
      return reject('superseded', appWin);
    }
    if (appWin.win.isDestroyed()) return reject('superseded', appWin);
    // While it waited, the source may have changed, a newer open come in, or
    // the export gone: then nothing goes to core.
    if (generation !== ctx.generation || openId !== appWin.views.latest) {
      const reason = generation !== ctx.generation ? 'generation' : 'open_id';
      appWin.views.abandon(openId);
      ctx.log.info('open.stale', { reason, openId, windowId: appWin.id });
      return reject(reason === 'generation' ? 'stale_generation' : 'superseded', appWin);
    }
    if (ctx.sources.isOffline()) {
      appWin.views.abandon(openId);
      return reject('offline', appWin);
    }
    let result;
    try {
      result = await ctx.core.requestRunning(
        { type: 'read', openId, generation, token, rowid, mode, lane: appWin.id },
        ctx.sources.stamp(),
      );
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
        if (result.code === 'unavailable') return reject('offline', appWin);
        const known = ['no_source', 'not_found', 'eml_missing', 'superseded'] as const;
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
      // Every remote image shows as the same neutral placeholder.
      assets: Array.from({ length: message.remote }, (_, i) => ({
        id: `r${i + 1}`,
        ...PLACEHOLDER,
      })),
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
      remote: message.remote,
      htmlTooLarge: message.htmlTooLarge,
      cut: message.cut,
      headers: message.headers,
    };
  });

  guarded<LinkActionResult>(IPC.linkAction, async (appWin, raw) => {
    const args = LinkActionArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ dialogId, action, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const refused = await ctx.linkDialog.act(appWin, dialogId, action, ctx.generation);
    return refused === null ? { ok: true } : reject(refused, appWin);
  });

  guarded<SourcesResult>(IPC.sources, (appWin, raw) => {
    const args = GenerationArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    if (args.data[0].generation !== ctx.generation) return reject('stale_generation', appWin);
    return { ok: true, generation: ctx.generation, sources: ctx.sources.view() };
  });

  /**
   * A read from the open export's index. Before its index is open there is
   * nothing to read; that answer isn't logged, as the shell asks again when
   * the index reports.
   */
  guarded<IndexResult<unknown>>(IPC.index, async (appWin, raw) => {
    const args = IndexArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ query, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const result = await ctx.sources.queryIndex(query);
    if (!result) return { ok: false, code: 'no_source' };
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    return { ok: true, generation, answer: result.answer, progress: result.progress };
  });

  /**
   * A search of the open export, one page. Per window, one search runs in
   * core and one waits; a newer request answers the waiting one as
   * superseded, which isn't logged, since it is how typing works.
   */
  const searchLanes = new SearchLanes<AppWindow>();
  let lastQueryId = 0;
  /** Per window, its latest search's text, and the first query ID made with that text. */
  const currentSearch = new WeakMap<
    AppWindow,
    { text: string; firstQueryId: number; generation: number }
  >();
  guarded<SearchResult>(IPC.search, async (appWin, raw) => {
    const args = SearchArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ generation, ...request }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    lastQueryId += 1;
    const queryId = lastQueryId;
    const known = currentSearch.get(appWin);
    if (known?.text !== request.text || known.generation !== generation) {
      currentSearch.set(appWin, { text: request.text, firstQueryId: queryId, generation });
    }
    const outcome = await searchLanes.run(appWin, async () =>
      // A search that waited is checked again when its turn comes.
      generation === ctx.generation
        ? ctx.sources.queryIndex({ op: 'search', queryId, ...request })
        : null,
    );
    if (outcome === SUPERSEDED) return { ok: false, code: 'superseded' };
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    if (!outcome) return { ok: false, code: 'no_source' };
    const page = outcome.answer as SearchPage | null;
    if (page?.queryId !== queryId) return reject('invalid', appWin);
    return { ok: true, generation, queryId, page, progress: outcome.progress };
  });

  /**
   * Snippets for rows of the window's current search, by its query ID: main
   * uses the text that search was made with, so the window can't ask for any
   * other. An older search's ID, or one from another generation, is
   * superseded. One request runs per window and one waits, as for searches.
   */
  const snippetLanes = new SearchLanes<AppWindow>();
  guarded<SnippetsResult>(IPC.searchSnippets, async (appWin, raw) => {
    const args = SnippetsArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ queryId, threadIds, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const search = currentSearch.get(appWin);
    if (
      !search ||
      search.generation !== generation ||
      queryId < search.firstQueryId ||
      queryId > lastQueryId
    ) {
      return { ok: false, code: 'superseded' };
    }
    const outcome = await snippetLanes.run(appWin, async () =>
      generation === ctx.generation
        ? ctx.sources.queryIndex({ op: 'snippets', queryId, text: search.text, threadIds })
        : null,
    );
    if (outcome === SUPERSEDED) return { ok: false, code: 'superseded' };
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    if (!outcome) return { ok: false, code: 'no_source' };
    const answer = outcome.answer as SearchSnippets | null;
    if (answer?.queryId !== queryId) return reject('invalid', appWin);
    return { ok: true, generation, queryId, snippets: answer.snippets };
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
