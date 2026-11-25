// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from 'react';
import { BODY_IFRAME_SANDBOX } from '../shared/constants';
import { closeLink, openMessage, showLink, useShellState } from './shell';

export function App() {
  const state = useShellState();

  useEffect(() => window.pev.onLinkDialog(showLink), []);

  return (
    <div className="shell">
      <header className="bar">
        <span className="bar-title">Proton Export Viewer</span>
      </header>
      <main className="content">
        <nav className="list" aria-label="Messages">
          <button type="button" className="row" onClick={() => void openMessage('sample')}>
            Sample message
          </button>
        </nav>
        <section className="reader">
          {state.bodyUrl ? (
            <iframe
              key={state.frameKey}
              className="body-frame"
              title="Message body"
              sandbox={BODY_IFRAME_SANDBOX}
              referrerPolicy="no-referrer"
              src={state.bodyUrl}
            />
          ) : (
            <p className="empty">No message selected</p>
          )}
        </section>
      </main>
      {state.link !== null && (
        <div className="dialog" role="dialog" aria-label="Open link">
          <p className="dialog-title">Open link?</p>
          <p className="dialog-url">{state.link}</p>
          <button type="button" className="dialog-button" onClick={closeLink}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
