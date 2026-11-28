// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from 'react';
import type { IndexCondition } from '../shared/index-types';
import { Conversation } from './Conversation';
import { indexChanged, syncMailbox, useCards, useMailbox, useSearch } from './mailbox-state';
import { ConversationList, Sidebar } from './Mailbox';
import { SearchBox, SearchResults } from './SearchResults';
import { LinkDialog } from './LinkDialog';
import { generationChanged, remoteStatus, useReaderState } from './reader';
import { ReaderPane } from './ReaderPane';
import { ReportView } from './Report';
import { Settings } from './Settings';
import { frameKey, shortcutKey, useShortcutsOverlay } from './shortcut-actions';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import {
  appWasReset,
  loadSettings,
  locateExport,
  openExport,
  refreshSources,
  settingsChanged,
  showLink,
  showMail,
  showSettings,
  useShellState,
} from './shell';
import { Welcome } from './Welcome';

/** Index states shown as a banner; "Verifying index…" shows in the sidebar. */
const INDEX_BANNERS: Partial<Record<IndexCondition, string>> = {
  rebuilding: 'Index was damaged; rebuilding',
  damaged: 'Index damaged; it will be rebuilt when the export is available',
};

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function App() {
  const state = useShellState();
  const reader = useReaderState();
  const results = useSearch().active;
  const conversation = useCards();
  const { reportOpen } = useMailbox();
  const shortcutsShown = useShortcutsOverlay();

  useEffect(() => window.pev.onLinkDialog(showLink), []);
  useEffect(() => window.pev.onSourcesChanged(() => void refreshSources()), []);
  useEffect(() => window.pev.onIndexChanged(indexChanged), []);
  useEffect(() => window.pev.onRemoteStatus(remoteStatus), []);
  // Shortcuts: typed in the shell, or in the body frame and passed on by main.
  // The shell's are read before any other handler sees the key (capture), so
  // a dialog's own Escape is still on screen when the dispatch checks for it.
  useEffect(() => window.pev.onFrameKey(frameKey), []);
  useEffect(() => {
    window.addEventListener('keydown', shortcutKey, { capture: true });
    return () => window.removeEventListener('keydown', shortcutKey, { capture: true });
  }, []);
  useEffect(() => window.pev.onSettingsChanged(settingsChanged), []);
  useEffect(() => window.pev.onShowSettings(showSettings), []);
  useEffect(() => window.pev.onAppReset(appWasReset), []);
  useEffect(() => {
    void refreshSources().then(() => loadSettings());
  }, []);
  useEffect(() => generationChanged(state.generation), [state.generation]);

  const active = state.sources?.active ?? null;
  // The list follows the open export and its generation.
  useEffect(syncMailbox, [state.sources, state.generation]);

  // The welcome screen shows while no export is open or being opened again,
  // unless a message is open.
  const welcome =
    state.sources !== null && !state.sources.restoring && active === null && reader.rowid === null;
  const banner = active?.index ? INDEX_BANNERS[active.index] : undefined;
  const showReport = active !== null && reportOpen;
  // Settings shows over the mail, which stays as it was: the same folder,
  // selection and open message when Settings closes.
  const inSettings = state.screen === 'settings';

  // Test builds: a test can make the shell throw while it renders.
  if (
    __PEV_TEST_HOOKS__ &&
    (window as unknown as { __pevTestRenderFault?: boolean }).__pevTestRenderFault
  ) {
    throw new Error('render fault');
  }

  return (
    <div className="shell">
      <header className="bar">
        <span className="bar-title">{__PEV_APP_NAME__}</span>
        {!welcome && active && <SearchBox />}
        <div className="bar-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Settings"
            title="Settings"
            aria-pressed={inSettings}
            onClick={inSettings ? showMail : showSettings}
          >
            <GearIcon />
          </button>
        </div>
      </header>
      {active?.status === 'offline' && (
        <div className="banner" role="alert">
          <span>Export not found.</span>
          <button
            type="button"
            className="btn"
            disabled={state.busy}
            onClick={() => void locateExport()}
          >
            Locate export…
          </button>
        </div>
      )}
      {active?.closed && (
        <div className="banner" role="alert">
          <span>Export closed after an error.</span>
          <button
            type="button"
            className="btn"
            disabled={state.busy}
            onClick={() => void openExport(active.sourceKey)}
          >
            Reopen
          </button>
        </div>
      )}
      {banner !== undefined && (
        <div className="banner index-state" role="status">
          {banner}
        </div>
      )}
      <div className="stage">
        {inSettings && <Settings />}
        {/* Under Settings the mail, or the welcome screen, stays as it was:
            still laid out, but unseen and inert. */}
        <div className="mail-screen" hidden={inSettings} inert={inSettings}>
          {welcome ? (
            <Welcome recent={state.sources?.recent ?? []} busy={state.busy} notice={state.notice} />
          ) : (
            <div className="stage">
              {showReport && <ReportView active={active} />}
              {/* Under the report the mail stays as it was, with its open message:
                  still laid out, but unseen and inert. */}
              <main className="content" hidden={showReport} inert={showReport}>
                {active && <Sidebar active={active} busy={state.busy} />}
                {active && (results ? <SearchResults /> : <ConversationList />)}
                <section className="reader" aria-label="Conversation">
                  {conversation.shown ? <Conversation /> : <ReaderPane />}
                </section>
              </main>
            </div>
          )}
        </div>
      </div>
      {shortcutsShown && <ShortcutsOverlay />}
      {state.link !== null && <LinkDialog key={state.link.dialogId} prompt={state.link} />}
    </div>
  );
}
