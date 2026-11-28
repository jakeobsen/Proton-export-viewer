// SPDX-License-Identifier: AGPL-3.0-or-later
// The typed surface between the shell renderer and the main process.

import type { LinkAction } from './constants';
import type {
  CardsQuery,
  CardsWindow,
  IndexProgress,
  IndexReport,
  Lead,
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
import type { AppSettings, SettingKey } from './settings';
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
  leads: 'pev:leads',
  showInFolder: 'pev:show-in-folder',
  copyMessageId: 'pev:copy-message-id',
  copyReport: 'pev:copy-report',
  settings: 'pev:settings',
  setSetting: 'pev:set-setting',
  settingsChanged: 'pev:settings-changed',
  showSettings: 'pev:show-settings',
  appReset: 'pev:app-reset',
  rebuildIndex: 'pev:rebuild-index',
  resetApp: 'pev:reset-app',
  openLogs: 'pev:open-logs',
  copyDiagnostics: 'pev:copy-diagnostics',
  viewSource: 'pev:source',
  sourceTree: 'pev:source-tree',
  sourcePart: 'pev:source-part',
  copyHeaders: 'pev:copy-headers',
  sourceBack: 'pev:source-back',
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
  | 'unknown_dialog'
  | 'refused'
  | 'not_deleted'
  | 'failed';

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

/** One part of the open message in the source view's tree. Main has checked every field. */
export interface SourceNode {
  /** Dotted path: `1` is the message. A part is named to main only by it. */
  path: string;
  /** The parent's index in the list, or -1 for the message. */
  parent: number;
  /** A lower-case `type/subtype`, or "unknown type". */
  type: string;
  charset: string | null;
  /** The cleaned file name, or ''. */
  name: string;
  inline: boolean;
  /** Decoded bytes; a container's is the sum of its parts'. */
  size: number;
  /** The read stopped inside this part: `size` is only what was read. */
  cut: boolean;
  risky: boolean;
}

/** A header block shown in the body frame: the URL to load there. */
export type SourceResult = { ok: true; url: string; truncated: boolean } | Rejected;
/** The tree, or null when the message's structure couldn't be read within the limits. */
export type SourceTreeResult = { ok: true; parts: SourceNode[] | null } | Rejected;
/** Back to the message: its body URL, or null for a message the reader couldn't render. */
export type SourceBackResult = { ok: true; url: string | null } | Rejected;

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
  | {
      ok: true;
      openId: number;
      outcome: 'fallback';
      match: ReaderMatch | null;
      /** The message file itself couldn't be opened, so no other view of it opens either. */
      fileRefused: boolean;
    }
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

/**
 * Lead lines for messages on screen, asked for by the list or by the cards.
 * The cards of a conversation opened from a result name that search by its
 * query ID, so the messages that match it get its snippet.
 */
export interface LeadsRequest {
  requester: 'list' | 'cards';
  rowids: number[];
  queryId?: number;
}

export type LeadsResult = { ok: true; generation: number; leads: Lead[] } | Rejected;

export type CloseViewResult = { ok: true } | Rejected;
/** The open export's index, as Settings shows it. Paths have home as `~`. */
export interface SettingsIndex {
  sourceKey: string;
  account: string | null;
  runName: string;
  /** The index database's full path. */
  location: string;
  /** The database and its sidecars. */
  bytes: number;
  /** When the index last changed, in ms since the epoch. */
  updatedAt: number | null;
}

/** What Settings shows. */
export interface SettingsView {
  settings: AppSettings;
  /** Null when no export is open. */
  index: SettingsIndex | null;
  /** The logs folder. */
  logsLocation: string;
}

export type SettingsResult = { ok: true; generation: number; view: SettingsView } | Rejected;
export type SetSettingResult = { ok: true; settings: AppSettings } | Rejected;
/** An action that leaves no outcome but the generation it left. */
export type DoneResult = { ok: true; generation: number } | Rejected;

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
  /**
   * Shows the source of the open `openId`, or of its fallback: the message's
   * raw headers in the body frame.
   */
  viewSource(openId: number, generation: number): Promise<SourceResult>;
  /** The message's parts for the source view's tree. */
  sourceTree(openId: number, generation: number): Promise<SourceTreeResult>;
  /** Shows the raw headers of one part, by its path from the tree; null for the message's. */
  sourcePart(openId: number, path: string | null, generation: number): Promise<SourceResult>;
  /** Copies the header block the source view shows. */
  copyHeaders(openId: number, generation: number): Promise<ReaderActionResult>;
  /** Leaves the source view. */
  sourceBack(openId: number, generation: number): Promise<SourceBackResult>;
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
  /**
   * Lead lines for messages on screen. A request waits while this window's
   * previous one runs, and a newer one from the same requester answers it as
   * 'superseded'.
   */
  leads(request: LeadsRequest, generation: number): Promise<LeadsResult>;
  /** What Settings shows, for the current generation. */
  settings(generation: number): Promise<SettingsResult>;
  /** Changes one setting; main checks the value. */
  setSetting<K extends SettingKey>(
    key: K,
    value: AppSettings[K],
    generation: number,
  ): Promise<SetSettingResult>;
  /** Called with the new settings when one changes, from any window. */
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;
  /** Called when the app menu's "Settings…" is chosen in this window. */
  onShowSettings(listener: () => void): () => void;
  /** Called when the app's data was deleted by a reset, in every window. */
  onAppReset(listener: () => void): () => void;
  /**
   * Deletes the open export's index and builds it again. The key and
   * generation are the ones Settings showed; a stale one changes nothing.
   */
  rebuildIndex(sourceKey: string, generation: number): Promise<SourceActionResult>;
  /** Deletes all the app's data; the export files stay as they are. */
  resetApp(generation: number): Promise<DoneResult>;
  /** Shows the logs folder in the file manager. */
  openLogs(generation: number): Promise<DoneResult>;
  /** Copies the diagnostics summary; main builds it, and the shell never sees it. */
  copyDiagnostics(generation: number): Promise<DoneResult>;
}
