// SPDX-License-Identifier: AGPL-3.0-or-later
// The typed surface between the shell renderer and the main process.

import type { LinkAction } from './constants';
import type {
  CardsQuery,
  CardsWindow,
  IndexProgress,
  IndexReport,
  ListWindow,
  SearchDateKey,
  SearchPage,
  SearchRankKey,
  Sidebar,
  ThreadSnippet,
  WindowQuery,
} from './index-types';
import type { RasterFormat } from './attachment-types';
import type { MessageDetails, MessageHeaders, OpenMode, ReaderMatch } from './reader-protocol';
import type { SourceOutcome, SourcesView } from './sources';

export const IPC = {
  state: 'pev:state',
  ping: 'pev:ping',
  openStub: 'pev:open-stub',
  open: 'pev:open',
  closeView: 'pev:close-view',
  log: 'pev:log',
  report: 'pev:report',
  linkDialog: 'pev:link-dialog',
  linkAction: 'pev:link-action',
  cardKey: 'pev:card-key',
  sources: 'pev:sources',
  chooseFolder: 'pev:choose-folder',
  openExport: 'pev:open-export',
  switchRun: 'pev:switch-run',
  locateExport: 'pev:locate-export',
  forgetExport: 'pev:forget-export',
  sourcesChanged: 'pev:sources-changed',
  index: 'pev:index',
  indexChanged: 'pev:index-changed',
  search: 'pev:search',
  searchSnippets: 'pev:search-snippets',
  showInFolder: 'pev:show-in-folder',
  copyMessageId: 'pev:copy-message-id',
  copyReport: 'pev:copy-report',
} as const;

export type RejectCode =
  | 'invalid'
  | 'unknown_window'
  | 'not_main_frame'
  | 'bad_origin'
  | 'stale_generation'
  | 'superseded'
  | 'unknown_stub'
  | 'core_unavailable'
  | 'unknown_source'
  | 'unknown_run'
  | 'no_source'
  | 'not_found'
  | 'eml_missing'
  | 'offline'
  | 'changed'
  | 'unknown_dialog';

export type Rejected = { ok: false; code: RejectCode };

export type StateResult = { ok: true; generation: number } | Rejected;
export type PingResult = { ok: true; generation: number } | Rejected;
export type CopyResult = { ok: true; generation: number } | Rejected;
export type OpenResult = { ok: true; openId: number; url: string } | Rejected;
export type SourcesResult = { ok: true; generation: number; sources: SourcesView } | Rejected;
/** The outcome of an open, a switch, a Locate or a Forget, and the generation it left. */
export type SourceActionResult =
  { ok: true; outcome: SourceOutcome; generation: number } | Rejected;

/** An attachment as the shell lists it. Actions on it name its `index` in the view's list. */
export interface AttachmentItem {
  index: number;
  name: string;
  label: string;
  size: number;
  risky: boolean;
  imageFormat: RasterFormat | null;
}

/** The outcome of an action on the open message, such as Show in folder. */
export type ReaderActionResult = { ok: true } | Rejected;

/**
 * The outcome of opening a message: its body view, or the fallback when the
 * reader couldn't render it.
 */
export type MessageOpenResult =
  | {
      ok: true;
      openId: number;
      outcome: 'view';
      url: string;
      format: 'plain' | 'html';
      hasHtml: boolean;
      /** How many distinct remote images the body refers to; they show as placeholders. */
      remote: number;
      /** HTML was asked for but is too large to show by default; "html-anyway" shows it. */
      htmlTooLarge: boolean;
      /** Why only part of the body is shown: its size, or its number of parts; null if whole. */
      cut: 'size' | 'parts' | null;
      headers: MessageHeaders;
      /** The attachments, by their index in this view's list; never their place in the message. */
      attachments: AttachmentItem[];
      details: MessageDetails;
      /** The plain body is the indexed text with the search's matches marked. */
      highlighted: boolean;
      /** For an open from search: how the message matched; null otherwise. */
      match: ReaderMatch | null;
    }
  | { ok: true; openId: number; outcome: 'fallback'; match: ReaderMatch | null }
  /** A missing message file opened from search says how the message matched. */
  | { ok: false; code: 'eml_missing'; match: ReaderMatch | null }
  | Rejected;

/** What the shell reads from the open export's index. */
export type ShellIndexQuery = { op: 'sidebar' } | { op: 'report' } | WindowQuery | CardsQuery;

export type IndexResult<T> =
  { ok: true; generation: number; answer: T; progress: IndexProgress } | Rejected;

/** Where the open export's index stands, sent by main as it changes. */
export interface IndexUpdate {
  generation: number;
  progress: IndexProgress;
}

/** What the link dialog shows. Main keeps the URL it acts on. */
export interface LinkPrompt {
  dialogId: string;
  /** The link's text. */
  title: string;
  /** The URL, with any non-ASCII host in punycode. */
  url: string;
  /** Where the host, or a mail link's first domain, is in `url`; null when there is none. */
  host: { start: number; end: number } | null;
  /** The title names a host other than the URL's. */
  mismatch: boolean;
  /** The URL's host, or a mail recipient's domain, has non-ASCII characters. */
  lookalike: boolean;
  /** The link writes an email: the open choice goes to the mail app. */
  mail: boolean;
  /** A mail recipient's address can be read more than one way. */
  unclear: boolean;
}

export type LinkActionResult = { ok: true } | Rejected;

/** A search of the open export: the text, the sort, and where the page continues. */
export type SearchRequest =
  | { text: string; sort: 'date'; after: SearchDateKey | null }
  | { text: string; sort: 'relevance'; after: SearchRankKey | null };

/** One page of results; `queryId` names the request it answers. */
export type SearchResult =
  | { ok: true; generation: number; queryId: number; page: SearchPage; progress: IndexProgress }
  | Rejected;

/** The keys that move the expanded card: `n` to the next newer, `p` to the next older. */
export type CardKeyName = 'n' | 'p';

/** Snippets for rows of one of this window's searches, named by its query ID. */
export interface SnippetsRequest {
  queryId: number;
  threadIds: number[];
}

export type SnippetsResult =
  { ok: true; generation: number; queryId: number; snippets: ThreadSnippet[] } | Rejected;

export type CloseViewResult = { ok: true } | Rejected;

export type ErrorKind = 'uncaught' | 'rejection' | 'error';

export interface ErrorReport {
  generation: number;
  kind: ErrorKind;
  errorClass: string;
  frames: string[];
}

export interface PevApi {
  state(): Promise<StateResult>;
  ping(generation: number): Promise<PingResult>;
  openStub(id: string, generation: number): Promise<OpenResult>;
  /**
   * Opens a message; with `queryId`, as part of that search's results, so its
   * matches are marked or listed. Only the ID goes to main, never the text.
   */
  open(
    rowid: number,
    mode: OpenMode,
    generation: number,
    queryId?: number,
  ): Promise<MessageOpenResult>;
  /** Closes the reader: its view and any open still under way are revoked. */
  closeView(generation: number): Promise<CloseViewResult>;
  /** Shows the open message's file in Finder. */
  showInFolder(openId: number, generation: number): Promise<ReaderActionResult>;
  /** Copies the open message's Message-ID. */
  copyMessageId(openId: number, generation: number): Promise<ReaderActionResult>;
  log(
    level: 'error' | 'warn' | 'info',
    code: string,
    generation: number,
    data?: Record<string, unknown>,
  ): void;
  reportError(report: ErrorReport): void;
  /** Called when main opens the link dialog. */
  onLinkDialog(listener: (prompt: LinkPrompt) => void): () => void;
  /** The user's choice in the link dialog. Only the dialog's id goes to main. */
  linkAction(dialogId: string, action: LinkAction, generation: number): Promise<LinkActionResult>;
  /** Called with `n` or `p` typed while the body frame has the focus. */
  onCardKey(listener: (key: CardKeyName) => void): () => void;
  sources(generation: number): Promise<SourcesResult>;
  chooseFolder(generation: number): Promise<SourceActionResult>;
  openExport(sourceKey: string, generation: number): Promise<SourceActionResult>;
  switchRun(runId: string, generation: number): Promise<SourceActionResult>;
  locateExport(generation: number): Promise<SourceActionResult>;
  /** Removes an export from the app and deletes its index; its files stay as they are. */
  forgetExport(sourceKey: string, generation: number): Promise<SourceActionResult>;
  /** Called when the open export or the list of exports changed. */
  onSourcesChanged(listener: () => void): () => void;
  /** The open export's folders and labels, with their counts. */
  sidebar(generation: number): Promise<IndexResult<Sidebar>>;
  /** A stretch of a folder's or label's conversations. */
  listWindow(query: WindowQuery, generation: number): Promise<IndexResult<ListWindow>>;
  /** A stretch of one conversation's cards. */
  cards(query: CardsQuery, generation: number): Promise<IndexResult<CardsWindow>>;
  /** The open export's index report. */
  indexReport(generation: number): Promise<IndexResult<IndexReport>>;
  /** Copies the open export's index report as plain text. */
  copyReport(generation: number): Promise<CopyResult>;
  /** Called as indexing moves on or the index's state changes. */
  onIndexChanged(listener: (update: IndexUpdate) => void): () => void;
  /**
   * Searches the open export. A request made while this window's previous
   * search is still running waits for it, and a newer one answers it as
   * 'superseded'.
   */
  search(request: SearchRequest, generation: number): Promise<SearchResult>;
  /**
   * Snippets for result rows that came without one, for a search this window
   * made; one of an older search is answered as 'superseded'.
   */
  searchSnippets(request: SnippetsRequest, generation: number): Promise<SnippetsResult>;
}
