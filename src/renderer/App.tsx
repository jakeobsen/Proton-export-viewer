// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from 'react';
import { BODY_IFRAME_SANDBOX } from '../shared/constants';
import type { IndexCondition } from '../shared/index-types';
import { indexChanged, syncMailbox } from './mailbox-state';
import { ConversationList, Sidebar } from './Mailbox';
import { LinkDialog } from './LinkDialog';
import { locateExport, refreshSources, showLink, useShellState } from './shell';
import { Welcome } from './Welcome';

/** Index states shown as a banner; "Verifying index…" shows in the sidebar. */
const INDEX_BANNERS: Partial<Record<IndexCondition, string>> = {
  rebuilding: 'Index was damaged; rebuilding',
  damaged: 'Index damaged; it will be rebuilt when the export is available',
};

export function App() {
  const state = useShellState();

  useEffect(() => window.pev.onLinkDialog(showLink), []);
  useEffect(() => window.pev.onSourcesChanged(() => void refreshSources()), []);
  useEffect(() => window.pev.onIndexChanged(indexChanged), []);
  useEffect(() => {
    void refreshSources();
  }, []);

  const active = state.sources?.active ?? null;
  // The list follows the open export and its generation.
  useEffect(syncMailbox, [state.sources, state.generation]);

  // The welcome screen shows while no export is open or being opened again,
  // unless a body is open.
  const welcome =
    state.sources !== null && !state.sources.restoring && active === null && state.bodyUrl === null;
  const banner = active?.index ? INDEX_BANNERS[active.index] : undefined;

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
            {state.bodyUrl && (
              <iframe
                key={state.frameKey}
                className="body-frame"
                title="Message body"
                sandbox={BODY_IFRAME_SANDBOX}
                referrerPolicy="no-referrer"
                src={state.bodyUrl}
              />
            )}
          </section>
        </main>
      )}
      {state.link !== null && <LinkDialog key={state.link.dialogId} prompt={state.link} />}
    </div>
  );
}
