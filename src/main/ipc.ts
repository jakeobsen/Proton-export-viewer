// SPDX-License-Identifier: AGPL-3.0-or-later
// IPC from the shell. Every handler checks that the sender is the main frame of
// an app window with the app://shell origin and validates its whole argument
// list. Every request carries the generation it was made for, and a stale one is
// rejected. The one exception is `state`, the bootstrap call: it takes no
// arguments and returns the current generation.

import { lstatSync, mkdirSync } from 'node:fs';
import { clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  IPC,
  type AllowRemoteResult,
  type CloseViewResult,
  type CopyResult,
  type DoneResult,
  type ErrorKind,
  type IndexResult,
  type LeadsResult,
  type LinkActionResult,
  type MessageOpenResult,
  type ReaderActionResult,
  type SourceBackResult,
  type SourceResult,
  type SourceTreeResult,
  type OpenResult,
  type PingResult,
  type Rejected,
  type RejectCode,
  type RemoteStatusUpdate,
  type RecentSearchesResult,
  type SearchResult,
  type SnippetsResult,
  type SetSettingResult,
  type SettingsResult,
  type SourceActionResult,
  type SourcesResult,
  type StateResult,
} from '../shared/api';
import {
  CARDS_AFTER,
  CARDS_BEFORE,
  CARDS_FOLLOW,
  MAX_LEAD_ROWIDS,
  MAX_QUERY_LENGTH,
  MAX_SNIPPET_THREADS,
  WINDOW_AFTER,
  WINDOW_BEFORE,
  type IndexQuery,
  type IndexReport,
  type LeadsAnswer,
  type SearchPage,
  type SearchSnippets,
} from '../shared/index-types';
import { ChipsSchema } from '../shared/recent-search';
import { reportText } from '../shared/report-text';
import {
  isEmptySearch,
  normalizeSearch,
  searchKey,
  type Chip,
  type SearchSpec,
} from '../shared/search-chips';
import { SETTING_KEYS } from '../shared/settings';
import type { SourceOutcome } from '../shared/sources';
import { RESET_FAILED, STALE, type Stale } from './sources/manager';
import { APP_ORIGIN, LINK_ACTIONS } from '../shared/constants';
import { isRendererLogCode } from '../shared/log/codes';
import {
  OPEN_MODES,
  PART_PATH_RE,
  SOURCE_HEADER_BYTES,
  type RenderedMessage,
  type SourcePart,
  type SourceWhat,
} from '../shared/reader-protocol';
import { CoreUnavailableError } from './core-host';
import { notifySettings, type AppContext, type AppWindow } from './context';
import { DIALOG_ID_RE } from './link-dialog';
import { sameFrame } from './navigation';
import { OPEN_GAP_MS, OpenPacer } from './open-pacer';
import { PLACEHOLDER } from '../shared/placeholder';
import { checkRemoteRefs } from './remote-images';
import { SUPERSEDED, SearchLanes } from './search-lane';
import { diagnosticsSummary, settingsView } from './settings-view';
import { headerDocument } from './source-doc';
import { sourceNodes } from './source-parts';
import { bodyUrl, type View, type ViewBody } from './views';

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
const QueryId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const MessageOpenArgs = z.tuple([
  z
    .object({
      rowid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      mode: z.enum(OPEN_MODES),
      generation: Generation,
      queryId: QueryId.optional(),
    })
    .strict(),
]);
// An action on the open message names its view by the open that installed it.
const ViewActionArgs = z.tuple([
  z
    .object({
      openId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      generation: Generation,
    })
    .strict(),
]);
// A part is named by its dotted path only, and only one from main's own tree.
const SourcePartArgs = z.tuple([
  z
    .object({
      openId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      path: z.string().regex(PART_PATH_RE).nullable(),
      generation: Generation,
    })
    .strict(),
]);
// The parts core read, checked before any of it reaches the shell.
const MAX_SOURCE_PARTS = 200_000;
const SourcePartsReply = z
  .array(
    z
      .object({
        path: z.string().regex(PART_PATH_RE),
        parent: z.number().int().min(-1),
        contentType: z.string().max(1024),
        charset: z.string().max(1024).nullable(),
        name: z.string().max(1024),
        inline: z.boolean(),
        size: z.number().int().nonnegative(),
        cut: z.boolean(),
      })
      .strict(),
  )
  .max(MAX_SOURCE_PARTS)
  .refine((parts) => parts.every((p, i) => p.parent < i && (i === 0) === (p.parent === -1)));
// The shell names the dialog and the choice; main keeps the URL.
// The shell names the view by its open; main keeps the URLs.
const AllowRemoteArgs = z.tuple([
  z
    .object({
      openId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      generation: Generation,
    })
    .strict(),
]);
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
  z.object({ op: z.literal('report') }).strict(),
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
      // The search the conversation was opened from, by its query ID only:
      // main puts in the text that search was made with.
      search: z
        .object({
          queryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          countRev: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
const IndexArgs = z.tuple([z.object({ query: ShellQuery, generation: Generation }).strict()]);

// A search: the text, its chips, the sort and its keyset, nothing else.
const SearchThreadId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SearchText = z.string().max(MAX_QUERY_LENGTH);
const SearchArgs = z.tuple([
  z.discriminatedUnion('sort', [
    z
      .object({
        text: SearchText,
        chips: ChipsSchema,
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
        chips: ChipsSchema,
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
      queryId: QueryId,
      threadIds: z.array(SearchThreadId).min(1).max(MAX_SNIPPET_THREADS),
      generation: Generation,
    })
    .strict(),
]);

// Lead lines for messages on screen: who asks, the messages, and the search
// the cards were opened from, by its query ID.
const LeadsArgs = z.tuple([
  z
    .object({
      requester: z.enum(['list', 'cards']),
      rowids: z.array(Rowid).min(1).max(MAX_LEAD_ROWIDS),
      queryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      generation: Generation,
    })
    .strict(),
]);

const SourceKey = z.uuid();
const RunId = z.string().regex(/^[0-9a-f]{16}$/);
const GenerationArgs = z.tuple([z.object({ generation: Generation }).strict()]);
const SourceArgs = z.tuple([z.object({ sourceKey: SourceKey, generation: Generation }).strict()]);
const RunArgs = z.tuple([z.object({ runId: RunId, generation: Generation }).strict()]);
const CommitArgs = z.tuple([z.object({ queryId: QueryId, generation: Generation }).strict()]);
const KeepRecentArgs = z.tuple([
  z.object({ sourceKey: SourceKey, keep: z.boolean(), generation: Generation }).strict(),
]);
// Main checks the value against the setting's own rule.
const SettingArgs = z.tuple([
  z.object({ key: z.enum(SETTING_KEYS), value: z.unknown(), generation: Generation }).strict(),
]);

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

/**
 * The assets a rendered body's view serves: every remote image as the same
 * neutral placeholder, and each inline image (`c<n>`) as its checked bytes,
 * or the placeholder when it has none.
 */
function viewAssets(message: RenderedMessage): ViewBody['assets'] {
  const remote = Array.from({ length: message.remote }, (_, i) => ({
    id: `r${i + 1}`,
    ...PLACEHOLDER,
  }));
  const images = new Map(message.images.map((image) => [image.id, image]));
  const inline = Array.from({ length: message.cids }, (_, i) => {
    const id = `c${i + 1}`;
    const image = images.get(id);
    return image
      ? { id, contentType: image.contentType, bytes: image.bytes }
      : { id, ...PLACEHOLDER };
  });
  return [...remote, ...inline];
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

  let lastQueryId = 0;
  /**
   * Per window, its latest search (text and chips) with its canonical key,
   * and the first query ID made with that key.
   */
  const currentSearch = new WeakMap<
    AppWindow,
    { search: SearchSpec; key: string; firstQueryId: number; generation: number }
  >();
  /**
   * The window's current search, if `queryId` is one of its IDs in this
   * generation; null for an older search's ID or an unknown one.
   */
  const searchOf = (appWin: AppWindow, queryId: number, generation: number): SearchSpec | null => {
    const current = currentSearch.get(appWin);
    if (
      !current ||
      current.generation !== generation ||
      queryId < current.firstQueryId ||
      queryId > lastQueryId
    ) {
      return null;
    }
    return current.search;
  };

  const openPacer = new OpenPacer<AppWindow>(() =>
    __PEV_TEST_HOOKS__ ? (ctx.openGapMs ?? OPEN_GAP_MS) : OPEN_GAP_MS,
  );
  guarded<MessageOpenResult>(IPC.open, async (appWin, raw) => {
    const args = MessageOpenArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ rowid, mode, generation, queryId }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    // From an older search, or an unknown one, the message still opens, without its matches.
    const search = queryId === undefined ? null : searchOf(appWin, queryId, generation);

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
        {
          type: 'read',
          openId,
          generation,
          token,
          rowid,
          mode,
          lane: appWin.id,
          ...(search === null ? {} : { search }),
        },
        ctx.sources.stamp(),
      );
    } catch (err) {
      if (!(err instanceof CoreUnavailableError)) throw err;
      appWin.views.abandon(openId);
      ctx.log.warn('core.unavailable', { openId, windowId: appWin.id });
      return reject('core_unavailable', appWin);
    }
    if (appWin.win.isDestroyed()) return reject('superseded', appWin);

    // Only an open from search has a match, and only a view, the fallback and a missing file carry it.
    const match = search === null ? null : (result.match ?? null);
    if (!result.ok) {
      if (result.code === 'eml_missing') {
        appWin.views.abandon(openId);
        reject('eml_missing', appWin);
        return { ok: false, code: 'eml_missing', match };
      }
      if (result.code !== 'reader_failed') {
        appWin.views.abandon(openId);
        if (result.code === 'unavailable') return reject('offline', appWin);
        const known = ['no_source', 'not_found', 'superseded'] as const;
        const code = known.find((c) => c === result.code);
        return reject(code ?? 'invalid', appWin);
      }
      // The fallback stands in for a view, so it follows the same rules.
      if (generation !== ctx.generation || openId !== appWin.views.latest) {
        appWin.views.abandon(openId);
        const reason = generation !== ctx.generation ? 'generation' : 'open_id';
        ctx.log.info('open.stale', { reason, openId, windowId: appWin.id });
        return reject(reason === 'generation' ? 'stale_generation' : 'superseded', appWin);
      }
      ctx.log.info('open.fallback', {
        reason: result.reason ?? 'crash',
        openId,
        windowId: appWin.id,
      });
      // View source still works for it: the open's token is kept for that,
      // and is never installed as a view.
      appWin.views.markFallback(openId, generation, rowid);
      return {
        ok: true,
        openId,
        outcome: 'fallback',
        match,
        fileRefused: result.reason === 'file',
      };
    }
    const message = result.read;
    if (!message) return reject('invalid', appWin);

    // The view keeps the remote URLs for its life; only their count goes to the shell.
    const remoteRefs = checkRemoteRefs(message.remoteRefs, message.remote);
    if (message.remote > 0 && remoteRefs === null) {
      ctx.log.warn('remote.refs_invalid', { openId, windowId: appWin.id });
    }
    const outcome = appWin.views.install(openId, token, generation, ctx.generation, {
      html: message.html,
      assets: viewAssets(message),
      links: message.links,
      remoteRefs,
      message: {
        rowid,
        file: result.file ?? null,
        messageId: message.details.messageId,
        attachments: message.attachments.map((a) => ({
          path: a.path,
          name: a.name,
          contentType: a.contentType,
          size: a.size,
        })),
      },
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
      remoteLoadable: remoteRefs !== null,
      htmlTooLarge: message.htmlTooLarge,
      cut: message.cut,
      headers: message.headers,
      // The shell names an attachment by its index in this list, never by its part.
      attachments: message.attachments.map((a, index) => ({
        index,
        name: a.name,
        label: a.label,
        size: a.size,
        risky: a.risky,
        imageFormat: a.imageFormat,
      })),
      details: message.details,
      highlighted: message.highlighted,
      match,
    };
  });

  /**
   * Consent to the remote images of this window's live view, named by its
   * open. A stale generation or an open whose view isn't live can't consent.
   */
  guarded<AllowRemoteResult>(IPC.allowRemote, async (appWin, raw) => {
    const args = AllowRemoteArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ openId, generation }] = args.data;
    if (generation !== ctx.generation) {
      ctx.log.info('remote.refused', { reason: 'stale', windowId: appWin.id });
      return { ok: false, code: 'stale_generation' };
    }
    const view = appWin.views.byOpenId(openId);
    if (!view) {
      ctx.log.info('remote.refused', { reason: 'not_live', windowId: appWin.id });
      return { ok: false, code: 'not_live' };
    }
    if (view.remote.refs === null) return reject('invalid', appWin);
    const outcome = await ctx.remote.allow(
      {
        views: appWin.views,
        windowId: appWin.id,
        send: (shown, counts) => {
          if (appWin.win.isDestroyed()) return;
          const update: RemoteStatusUpdate = {
            generation: shown.generation,
            openId: shown.openId,
            ...counts,
          };
          appWin.win.webContents.send(IPC.remoteStatus, update);
        },
      },
      view,
    );
    return outcome.ok ? { ok: true, reload: outcome.reload } : { ok: false, code: outcome.code };
  });

  /** The live view an action names, by the open that installed it, or why there is none. */
  const actionView = (appWin: AppWindow, raw: unknown[]) => {
    const args = ViewActionArgs.safeParse(raw);
    if (!args.success) return 'invalid' as const;
    const [{ openId, generation }] = args.data;
    if (generation !== ctx.generation) return 'stale_generation' as const;
    const view = appWin.views.byOpenId(openId);
    if (!view?.message || view.generation !== ctx.generation) return 'superseded' as const;
    return { view, message: view.message };
  };

  guarded<ReaderActionResult>(IPC.showInFolder, async (appWin, raw) => {
    const live = actionView(appWin, raw);
    if (typeof live === 'string') return reject(live, appWin);
    const { view, message } = live;
    if (ctx.sources.isOffline()) return reject('offline', appWin);
    if (!message.file) return reject('not_found', appWin);
    let result;
    try {
      result = await ctx.core.requestRunning(
        { type: 'locate', generation: ctx.generation, rowid: message.rowid, file: message.file },
        ctx.sources.stamp(),
      );
    } catch (err) {
      if (!(err instanceof CoreUnavailableError)) throw err;
      return reject('core_unavailable', appWin);
    }
    // The answer counts only while the view it was asked for is still live:
    // after a switch or a newer open, nothing is revealed.
    if (
      appWin.win.isDestroyed() ||
      view.generation !== ctx.generation ||
      appWin.views.byOpenId(view.openId) !== view
    ) {
      return reject('superseded', appWin);
    }
    if (!result.ok) {
      const known = ['changed', 'eml_missing', 'no_source', 'not_found', 'superseded'] as const;
      const code = known.find((c) => c === result.code);
      return reject(result.code === 'unavailable' ? 'offline' : (code ?? 'invalid'), appWin);
    }
    if (!result.path) return reject('superseded', appWin);
    shell.showItemInFolder(result.path);
    ctx.log.info('reader.show_in_folder', { windowId: appWin.id });
    return { ok: true };
  });

  guarded<ReaderActionResult>(IPC.copyMessageId, (appWin, raw) => {
    const live = actionView(appWin, raw);
    if (typeof live === 'string') return reject(live, appWin);
    const { message } = live;
    if (message.messageId === '') return reject('not_found', appWin);
    clipboard.writeText(message.messageId);
    ctx.log.info('reader.copy_message_id', { windowId: appWin.id });
    return { ok: true };
  });

  // --- The source view ----------------------------------------------------------

  /** Asks core to read for the source view of `view`; null when core isn't up for the source. */
  const askSource = async (appWin: AppWindow, view: View, what: SourceWhat, order?: number) => {
    const source = view.source;
    if (!source) return null;
    try {
      return await ctx.core.requestRunning(
        {
          type: 'source',
          openId: view.openId,
          generation: ctx.generation,
          rowid: source.rowid,
          file: source.file,
          what,
          lane: appWin.id,
          ...(order !== undefined ? { order } : {}),
        },
        ctx.sources.stamp(),
      );
    } catch (err) {
      if (!(err instanceof CoreUnavailableError)) throw err;
      return null;
    }
  };

  /**
   * True while `view` is live in a window still there, for the current
   * generation, in the showing of its source named `session`: a read started
   * for an earlier showing never counts in a later one.
   */
  const stillShowing = (appWin: AppWindow, view: View, session: number) =>
    !appWin.win.isDestroyed() &&
    view.generation === ctx.generation &&
    appWin.views.inSession(view, session);

  /** The view in the source view for an action on it, with its showing, or why there is none. */
  const sourceView = (appWin: AppWindow, openId: number, generation: number) => {
    if (generation !== ctx.generation) return 'stale_generation' as const;
    const view = appWin.views.byOpenId(openId);
    const session = view?.source?.session;
    if (!view || session === undefined || !stillShowing(appWin, view, session)) {
      return 'superseded' as const;
    }
    return { view, session };
  };

  /**
   * Reads a header block and shows it as the view's next source document,
   * for selection `seq` of the showing `session`.
   */
  const showBlock = async (
    appWin: AppWindow,
    view: View,
    session: number,
    seq: number,
    what: SourceWhat,
  ): Promise<SourceResult> => {
    const result = await askSource(appWin, view, what, what.kind === 'part' ? seq : undefined);
    if (!stillShowing(appWin, view, session)) return reject('superseded', appWin);
    if (!result) return reject('core_unavailable', appWin);
    if (!result.ok) {
      const known = ['changed', 'eml_missing', 'not_found', 'superseded'] as const;
      const code = known.find((c) => c === result.code);
      return reject(result.code === 'unavailable' ? 'offline' : (code ?? 'not_found'), appWin);
    }
    const headers = result.headers;
    if (!headers) return reject('not_found', appWin);
    if (!(headers.bytes instanceof Uint8Array) || headers.bytes.length > SOURCE_HEADER_BYTES) {
      return reject('invalid', appWin);
    }
    const { html, text } = headerDocument(headers.bytes, headers.truncated === true);
    const url = appWin.views.showSource(view, session, seq, html, text);
    if (url === null) return reject('superseded', appWin);
    return { ok: true, url, truncated: headers.truncated === true };
  };

  guarded<SourceResult>(IPC.viewSource, async (appWin, raw) => {
    const args = ViewActionArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ openId, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    if (ctx.sources.isOffline()) return reject('offline', appWin);
    const view = appWin.views.beginSource(openId);
    if (!view?.source || view.generation !== ctx.generation) return reject('superseded', appWin);
    const { session } = view.source;
    const seq = appWin.views.select(view);
    if (seq === null) return reject('superseded', appWin);
    ctx.log.info('reader.source', { windowId: appWin.id });
    return showBlock(appWin, view, session, seq, { kind: 'headers' });
  });

  guarded<SourceTreeResult>(IPC.sourceTree, async (appWin, raw) => {
    const args = ViewActionArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ openId, generation }] = args.data;
    const shown = sourceView(appWin, openId, generation);
    if (typeof shown === 'string') return reject(shown, appWin);
    const { view, session } = shown;
    const result = await askSource(appWin, view, { kind: 'structure' });
    if (!stillShowing(appWin, view, session)) return reject('superseded', appWin);
    if (!result) return reject('core_unavailable', appWin);
    if (!result.ok) {
      if (result.code === 'changed') return reject('changed', appWin);
      if (result.code === 'superseded') return reject('superseded', appWin);
      // The structure couldn't be read within the limits: the headers stand alone.
      return { ok: true, parts: null };
    }
    const parts = SourcePartsReply.safeParse(result.parts);
    if (!parts.success || parts.data.length === 0) return { ok: true, parts: null };
    const read: SourcePart[] = parts.data;
    // Still the showing that asked: checked above, with nothing awaited since.
    if (view.source) view.source.paths = new Set(read.map((p) => p.path));
    return { ok: true, parts: sourceNodes(read) };
  });

  guarded<SourceResult>(IPC.sourcePart, async (appWin, raw) => {
    const args = SourcePartArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ openId, path, generation }] = args.data;
    const shown = sourceView(appWin, openId, generation);
    if (typeof shown === 'string') return reject(shown, appWin);
    const { view, session } = shown;
    // The message's own block is read as it is, without a parse.
    const message = path === null || path === '1';
    if (!message && !view.source?.paths?.has(path)) return reject('invalid', appWin);
    const seq = appWin.views.select(view);
    if (seq === null) return reject('superseded', appWin);
    return showBlock(
      appWin,
      view,
      session,
      seq,
      message ? { kind: 'headers' } : { kind: 'part', path },
    );
  });

  guarded<ReaderActionResult>(IPC.copyHeaders, (appWin, raw) => {
    const args = ViewActionArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ openId, generation }] = args.data;
    const shown = sourceView(appWin, openId, generation);
    if (typeof shown === 'string') return reject(shown, appWin);
    const text = appWin.views.shownText(shown.view);
    if (text === null) return reject('superseded', appWin);
    clipboard.writeText(text);
    ctx.log.info('reader.copy_headers', { windowId: appWin.id });
    return { ok: true };
  });

  guarded<SourceBackResult>(IPC.sourceBack, (appWin, raw) => {
    const args = ViewActionArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ openId, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const view = appWin.views.byOpenId(openId);
    if (!view || view.source === null) return reject('superseded', appWin);
    return { ok: true, url: appWin.views.leaveSource(view) };
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
   * the index reports. Cards that name an older or unknown search are read
   * without it.
   */
  guarded<IndexResult<unknown>>(IPC.index, async (appWin, raw) => {
    const args = IndexArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ query: asked, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    let query: IndexQuery = asked;
    if (asked.op === 'cards' && asked.search) {
      const { search: named, ...plain } = asked;
      const search = searchOf(appWin, named.queryId, generation);
      query =
        search === null
          ? plain
          : {
              ...plain,
              search: { ...named, text: search.text, chips: normalizeSearch(search).chips },
            };
    }
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
  guarded<SearchResult>(IPC.search, async (appWin, raw) => {
    const args = SearchArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ generation, chips, ...request }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    lastQueryId += 1;
    const queryId = lastQueryId;
    const search: SearchSpec = { text: request.text, chips: chips as Chip[] };
    const key = searchKey(search);
    // Any change of the text or the chips, as their canonical form, makes a
    // new search: the older one's IDs no longer name it.
    const known = currentSearch.get(appWin);
    if (known?.key !== key || known.generation !== generation) {
      currentSearch.set(appWin, { search, key, firstQueryId: queryId, generation });
    }
    const normalChips = normalizeSearch(search).chips;
    const outcome = await searchLanes.run(appWin, async () =>
      // A search that waited is checked again when its turn comes.
      generation === ctx.generation
        ? ctx.sources.queryIndex({ op: 'search', queryId, ...request, chips: normalChips })
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
   * uses the text and chips that search was made with, so the window can't
   * ask for any other. An older search's ID, or one from another generation, is
   * superseded. One request runs per window and one waits, as for searches.
   */
  const snippetLanes = new SearchLanes<AppWindow>();
  guarded<SnippetsResult>(IPC.searchSnippets, async (appWin, raw) => {
    const args = SnippetsArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ queryId, threadIds, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const search = searchOf(appWin, queryId, generation);
    if (search === null) return { ok: false, code: 'superseded' };
    const outcome = await snippetLanes.run(appWin, async () =>
      generation === ctx.generation
        ? ctx.sources.queryIndex({
            op: 'snippets',
            queryId,
            text: search.text,
            chips: normalizeSearch(search).chips,
            threadIds,
          })
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
   * Lead lines for messages on screen, asked for by the list or the cards.
   * Per window, one request runs in core, and each requester has one waiting:
   * a newer request from the same requester answers its waiting one as
   * superseded, and the list and the cards never take each other's place.
   * Cards opened from a result name that search by its query ID; an older or
   * unknown one gives plain lead lines.
   */
  const leadLanes = new SearchLanes<AppWindow>();
  guarded<LeadsResult>(IPC.leads, async (appWin, raw) => {
    const args = LeadsArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ requester, rowids, queryId, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const search = queryId === undefined ? null : searchOf(appWin, queryId, generation);
    const named =
      search === null ? {} : { text: search.text, chips: normalizeSearch(search).chips };
    const outcome = await leadLanes.run(
      appWin,
      async () =>
        generation === ctx.generation
          ? ctx.sources.queryIndex({ op: 'leads', rowids, ...named })
          : null,
      requester,
    );
    if (outcome === SUPERSEDED) return { ok: false, code: 'superseded' };
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    if (!outcome) return { ok: false, code: 'no_source' };
    const answer = outcome.answer as LeadsAnswer | null;
    if (!answer) return reject('invalid', appWin);
    return { ok: true, generation, leads: answer.leads };
  });

  /**
   * Copies the open export's index report as plain text. Main reads the
   * report itself; the shell sends nothing but the generation.
   */
  guarded<CopyResult>(IPC.copyReport, async (appWin, raw) => {
    const args = GenerationArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const result = await ctx.sources.queryIndex({ op: 'report' });
    if (!result) return { ok: false, code: 'no_source' };
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const report = result.answer as IndexReport;
    clipboard.writeText(reportText(report));
    ctx.log.info('report.copied', { count: report.attention, windowId: appWin.id });
    return { ok: true, generation };
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

  /**
   * Settings: what it shows, the settings themselves, and its actions. Every
   * action carries the generation Settings was read under; Rebuild and Forget
   * also the export it showed.
   */
  guarded<SettingsResult>(IPC.settings, (appWin, raw) => {
    const args = GenerationArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    if (args.data[0].generation !== ctx.generation) return reject('stale_generation', appWin);
    return { ok: true, generation: ctx.generation, view: settingsView(ctx) };
  });

  guarded<SetSettingResult>(IPC.setSetting, (appWin, raw) => {
    const args = SettingArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ key, value, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    if (!ctx.settings.set(key, value)) return reject('invalid', appWin);
    notifySettings(ctx);
    return { ok: true, settings: ctx.settings.get() };
  });

  /**
   * A committed search (Enter, or a result opened): main records the search
   * it ran as `queryId`, never text from the window. Checked, timed and
   * queued in one step, so the switch it is checked against is the one in
   * force when it arrived.
   */
  guarded<DoneResult>(IPC.commitSearch, (appWin, raw) => {
    const args = CommitArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ queryId, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const search = searchOf(appWin, queryId, generation);
    if (search === null) return { ok: false, code: 'superseded' };
    if (!isEmptySearch(search)) ctx.sources.recordSearch(searchKey(search), Date.now());
    return { ok: true, generation };
  });

  guarded<RecentSearchesResult>(IPC.recentSearches, async (appWin, raw) => {
    const args = GenerationArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const entries = await ctx.sources.recentSearches();
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    return { ok: true, generation, entries };
  });

  guarded<DoneResult>(IPC.keepRecent, (appWin, raw) => {
    const args = KeepRecentArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ sourceKey, keep, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    if (ctx.sources.setKeepRecent(sourceKey, keep, generation) === STALE) {
      return reject('stale_generation', appWin);
    }
    return { ok: true, generation };
  });

  guarded<DoneResult>(IPC.clearRecent, async (appWin, raw) => {
    const args = SourceArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ sourceKey, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);
    const outcome = await ctx.sources.clearRecent(sourceKey, generation);
    if (outcome === STALE) return reject('stale_generation', appWin);
    if (outcome === 'failed') return reject('core_unavailable', appWin);
    return { ok: true, generation: ctx.generation };
  });

  sourceAction(
    IPC.rebuildIndex,
    SourceArgs,
    'unknown_source',
    (_appWin, { sourceKey, generation }) => ctx.sources.rebuildIndex(sourceKey, generation),
  );

  guarded<DoneResult>(IPC.resetApp, async (appWin, raw) => {
    const args = GenerationArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    if (args.data[0].generation !== ctx.generation) return reject('stale_generation', appWin);
    // Checked again when its turn comes: an operation queued before it may move the generation on.
    const done = await ctx.sources.reset(args.data[0].generation);
    if (done === STALE) return reject('stale_generation', appWin);
    if (done === RESET_FAILED) return reject('not_deleted', appWin);
    if (!done) return reject('refused', appWin);
    return { ok: true, generation: ctx.generation };
  });

  guarded<DoneResult>(IPC.openLogs, async (appWin, raw) => {
    const args = GenerationArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    if (args.data[0].generation !== ctx.generation) return reject('stale_generation', appWin);
    // Only the app's own folder: never a link, or anything but a folder.
    let folder = false;
    try {
      mkdirSync(ctx.dirs.logs, { recursive: true, mode: 0o700 });
      folder = lstatSync(ctx.dirs.logs).isDirectory();
    } catch {
      // Refused below.
    }
    if (!folder || (await ctx.openPath(ctx.dirs.logs)) !== '') {
      ctx.log.warn('logs.open_failed', { windowId: appWin.id });
      return { ok: false, code: 'failed' };
    }
    return { ok: true, generation: ctx.generation };
  });

  guarded<DoneResult>(IPC.copyDiagnostics, (appWin, raw) => {
    const args = GenerationArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    if (args.data[0].generation !== ctx.generation) return reject('stale_generation', appWin);
    ctx.writeClipboard(diagnosticsSummary(ctx));
    return { ok: true, generation: ctx.generation };
  });

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
