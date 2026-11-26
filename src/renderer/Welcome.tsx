// SPDX-License-Identifier: AGPL-3.0-or-later
// The welcome screen: choose an export folder, or open or forget a recent export.

import { useState } from 'react';
import type { ExportRow } from '../shared/sources';
import { exportLabel } from './labels';
import { chooseFolder, forgetExport, openExport } from './shell';

function RecentRow({ row, busy }: { row: ExportRow; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="recent-row">
      <div className="recent-info">
        <div className="recent-account">{row.account ?? exportLabel(row.runName)}</div>
        {row.account !== null && <div className="recent-sub">{exportLabel(row.runName)}</div>}
      </div>
      {confirming ? (
        <div className="recent-confirm" role="group" aria-label="Forget">
          <span>
            Removes this export from the app and deletes its index. Export files stay intact.
          </span>
          <span className="recent-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void forgetExport(row.sourceKey);
              }}
            >
              Forget
            </button>
          </span>
        </div>
      ) : (
        <span className="recent-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void openExport(row.sourceKey)}
          >
            Open
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Forget
          </button>
        </span>
      )}
    </li>
  );
}

export function Welcome({
  recent,
  busy,
  notice,
}: {
  recent: ExportRow[];
  busy: boolean;
  notice: string | null;
}) {
  return (
    <main className="welcome">
      <h1 className="welcome-title">Open a Proton Mail export</h1>
      <div className="welcome-grid">
        <section className="welcome-pick" aria-label="Choose folder">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void chooseFolder()}
          >
            Choose folder…
          </button>
          {notice !== null && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
        </section>
        {recent.length > 0 && (
          <section className="welcome-recent" aria-label="Recent exports">
            <h2>Recent exports</h2>
            <ul className="recent-list">
              {recent.map((row) => (
                <RecentRow key={row.sourceKey} row={row} busy={busy} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
