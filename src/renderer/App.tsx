// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from 'react';
import { BODY_IFRAME_SANDBOX } from '../shared/constants';
import type { IndexCondition } from '../shared/index-types';
import type { ActiveExport } from '../shared/sources';
import { exportLabel } from './labels';
import {
  closeLink,
  locateExport,
  openMessage,
  refreshSources,
  showLink,
  switchRun,
  useShellState,
} from './shell';
import { Welcome } from './Welcome';

const INDEX_STATES: Partial<Record<IndexCondition, string>> = {
  verifying: 'Verifying index…',
  rebuilding: 'Index was damaged; rebuilding',
  damaged: 'Index damaged; it will be rebuilt when the export is available',
};

function ExportBar({ active, busy }: { active: ActiveExport; busy: boolean }) {
  const current = active.runs.find((r) => r.current);
  return (
    <div className="export-bar">
      {active.account !== null && <span className="export-account">{active.account}</span>}
      {active.runs.length > 1 ? (
        <select
          className="run-picker"
          aria-label="Export"
          disabled={busy}
          value={current?.runId ?? ''}
          onChange={(e) => void switchRun(e.target.value)}
        >
          {current === undefined && <option value="">{exportLabel(active.runName)}</option>}
          {active.runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {run.account !== null && run.account !== active.account
                ? `${run.account} · ${exportLabel(run.runName)}`
                : exportLabel(run.runName)}
            </option>
          ))}
        </select>
      ) : (
        <span className="export-run">{exportLabel(active.runName)}</span>
      )}
    </div>
  );
}

export function App() {
  const state = useShellState();

  useEffect(() => window.pev.onLinkDialog(showLink), []);
  useEffect(() => window.pev.onSourcesChanged(() => void refreshSources()), []);
  useEffect(() => {
    void refreshSources();
  }, []);

  const active = state.sources?.active ?? null;
  // The welcome screen shows while no export is open or being opened again,
  // unless a body is open.
  const welcome =
    state.sources !== null && !state.sources.restoring && active === null && state.bodyUrl === null;

  return (
    <div className="shell">
      <header className="bar">
        <span className="bar-title">{__PEV_APP_NAME__}</span>
        {active && <ExportBar active={active} busy={state.busy} />}
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
      {active?.index && INDEX_STATES[active.index] && (
        <div className="index-state" role="status">
          {INDEX_STATES[active.index]}
        </div>
      )}
      {welcome ? (
        <Welcome recent={state.sources?.recent ?? []} busy={state.busy} notice={state.notice} />
      ) : (
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
      )}
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
