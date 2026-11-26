// SPDX-License-Identifier: AGPL-3.0-or-later
// The welcome screen: choose an export folder, or open a recent export.

import type { ExportRow } from '../shared/sources';
import { exportLabel } from './labels';
import { chooseFolder, openExport } from './shell';

function RecentRow({ row, busy }: { row: ExportRow; busy: boolean }) {
  return (
    <li className="recent-row">
      <div className="recent-info">
        <div className="recent-account">{row.account ?? exportLabel(row.runName)}</div>
        {row.account !== null && <div className="recent-sub">{exportLabel(row.runName)}</div>}
      </div>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => void openExport(row.sourceKey)}
      >
        Open
      </button>
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
