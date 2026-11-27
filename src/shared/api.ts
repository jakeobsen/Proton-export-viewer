// SPDX-License-Identifier: AGPL-3.0-or-later
// The typed surface between the shell renderer and the main process.

import type { LinkAction } from './constants';
import type {
  IndexProgress,
  ListWindow,
  SearchDateKey,
  SearchPage,
  SearchRankKey,
  Sidebar,
  ThreadSnippet,
  WindowQuery,
} from './index-types';
import type { MessageHeaders, OpenMode } from './reader-protocol';
import type { SourceOutcome, SourcesView } from './sources';

export const IPC = {
  state: 'pev:state',
  ping: 'pev:ping',
  openStub: 'pev:open-stub',
  open: 'pev:open',
  log: 'pev:log',
  report: 'pev:report',
  linkDialog: 'pev:link-dialog',
  linkAction: 'pev:link-action',
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
  | 'unknown_dialog';

export type Rejected = { ok: false; code: RejectCode };

export type StateResult = { ok: true; generation: number } | Rejected;
export type PingResult = { ok: true; generation: number } | Rejected;
export type OpenResult = { ok: true; openId: number; url: string } | Rejected;
export type SourcesResult = { ok: true; generation: number; sources: SourcesView } | Rejected;
/** The outcome of an open, a switch, a Locate or a Forget, and the generation it left. */
export type SourceActionResult =
  { ok: true; outcome: SourceOutcome; generation: number } | Rejected;

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
      /** Only the first part of the body's plain text is shown. */
      truncated: boolean;
      headers: MessageHeaders;
    }
  | { ok: true; openId: number; outcome: 'fallback' }
  | Rejected;

/** What the shell reads from the open export's index. */
export type ShellIndexQuery = { op: 'sidebar' } | WindowQuery;

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
  /** Where the host is in `url`, or null when there is none. */
  host: { start: number; end: number } | null;
  /** The title names a host other than the URL's. */
  mismatch: boolean;
  /** The URL's host has non-ASCII characters. */
  lookalike: boolean;
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

/** Snippets for rows of one of this window's searches, named by its query ID. */
export interface SnippetsRequest {
  queryId: number;
  threadIds: number[];
}

export type SnippetsResult =
  { ok: true; generation: number; queryId: number; snippets: ThreadSnippet[] } | Rejected;

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
  open(rowid: number, mode: OpenMode, generation: number): Promise<MessageOpenResult>;
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
