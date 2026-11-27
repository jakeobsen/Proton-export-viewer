// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from 'react';
import type { IndexCondition } from '../shared/index-types';
import { indexChanged, syncMailbox } from './mailbox-state';
import { ConversationList, Sidebar } from './Mailbox';
import { LinkDialog } from './LinkDialog';
import { generationChanged, useReaderState } from './reader';
import { ReaderPane } from './ReaderPane';
import { locateExport, openExport, refreshSources, showLink, useShellState } from './shell';
import { Welcome } from './Welcome';

/** Index states shown as a banner; "Verifying index…" shows in the sidebar. */
const INDEX_BANNERS: Partial<Record<IndexCondition, string>> = {
  rebuilding: 'Index was damaged; rebuilding',
  damaged: 'Index damaged; it will be rebuilt when the export is available',
};

export function App() {
  const state = useShellState();
  const reader = useReaderState();

  useEffect(() => window.pev.onLinkDialog(showLink), []);
  useEffect(() => window.pev.onSourcesChanged(() => void refreshSources()), []);
  useEffect(() => window.pev.onIndexChanged(indexChanged), []);
  useEffect(() => {
    void refreshSources();
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
      {welcome ? (
        <Welcome recent={state.sources?.recent ?? []} busy={state.busy} notice={state.notice} />
      ) : (
        <main className="content">
          {active && <Sidebar active={active} busy={state.busy} />}
          {active && <ConversationList />}
          <section className="reader" aria-label="Conversation">
            <ReaderPane />
          </section>
        </main>
      )}
      {state.link !== null && <LinkDialog key={state.link.dialogId} prompt={state.link} />}
    </div>
  );
}
