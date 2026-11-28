// SPDX-License-Identifier: AGPL-3.0-or-later
// The index report: how far loading the messages got, what was indexed, and
// each file that needs attention. File names are relative to the export's
// folder.

import { useEffect, useRef, useState } from 'react';
import type { IndexProgress, IndexReport } from '../shared/index-types';
import { RESULT_TEXT, attentionText, count, reasonText, tookText } from '../shared/report-text';
import type { ActiveExport } from '../shared/sources';
import { loadingText } from './format';
import { exportLabel } from './labels';
import { closeReport, openReport, useMailbox } from './mailbox-state';
import { getShellState } from './shell';

/** The control that opened the report: focus goes back to it on close. */
let opener: HTMLElement | null = null;

/** Opens the report from `from`, which gets focus back when the report closes. */
export function openReportFrom(from: HTMLElement): void {
  opener = from;
  openReport();
}

/**
 * Where focus goes when the report closes: its opener, or, if that is gone
 * (the loading line goes when loading ends), the list header's link.
 */
function focusBack(): void {
  const back =
    opener?.isConnected && opener.closest('[hidden]') === null
      ? opener
      : document.querySelector<HTMLElement>('.list-head .attention');
  back?.focus();
}

const PILL: Record<string, string> = {
  skipped: 'pill warn',
  listed: 'pill neutral',
  truncated: 'pill neutral',
};

/** "9fKq2Vd0…Xw7a==.eml": the start and end of a long name; the full one is its title. */
export function shortName(name: string): string {
  const dot = name.indexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  if (stem.length <= 16) return name;
  return `${stem.slice(0, 8)}…${stem.slice(-6)}${ext}`;
}

function Messages({
  progress,
  report,
}: {
  progress: IndexProgress | null;
  report: IndexReport | null;
}) {
  const loading = progress?.phase === 'loading' || progress?.phase === 'opening';
  const done = progress?.phase === 'done';
  // Until the scan has counted the files, the bar shows without numbers.
  const counted = progress !== null && progress.total > 0;
  const share = counted ? Math.min(1, progress.loaded / progress.total) : 0;
  return (
    <div className="phase">
      <span className={`st ${done ? 'done' : 'run'}`} aria-hidden="true">
        {done ? '✓' : ''}
      </span>
      <div className="phase-body">
        <h3>
          Messages
          {done && <span className="pill ok">Done</span>}
          {loading && counted && <span className="pill accent">{Math.floor(share * 100)}%</span>}
        </h3>
        {loading && progress && (
          <div
            className="progress"
            role="progressbar"
            aria-label="Loading"
            {...(counted
              ? {
                  'aria-valuemin': 0,
                  'aria-valuemax': progress.total,
                  'aria-valuenow': progress.loaded,
                }
              : {})}
          >
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
        )}
        <div className="ix-stats">
          {loading && progress
            ? counted && <span>{loadingText(progress.loaded, progress.total)}</span>
            : report && (
                <span>
                  <b>{count(report.messages)}</b> messages
                </span>
              )}
          {report && (
            <span>
              <b>{count(report.folders)}</b> folders and labels
            </span>
          )}
          {done && report !== null && report.took !== null && (
            <span>
              took <b>{tookText(report.took)}</b>
            </span>
          )}
          {report !== null && report.hiddenLabelIds > 0 && (
            <span>
              <b>{count(report.hiddenLabelIds)}</b> unknown labels hidden
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Files({ report }: { report: IndexReport }) {
  return (
    <div className="report">
      <h2>{attentionText(report.attention)}</h2>
      <table>
        <colgroup>
          <col className="c-result" />
          <col className="c-file" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Result</th>
            <th>File</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, i) => (
            <tr key={`${i}:${row.file}`}>
              <td>
                <span className={PILL[row.result]}>{RESULT_TEXT[row.result]}</span>
              </td>
              <td className="file" dir="auto" title={row.file}>
                {shortName(row.file)}
              </td>
              <td className="rs">{reasonText(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.more > 0 && <p className="more">and {count(report.more)} more</p>}
    </div>
  );
}

export function ReportView({ active }: { active: ActiveExport }) {
  const { progress, report } = useMailbox();
  const [note, setNote] = useState('');
  const loading = progress?.phase === 'loading' || progress?.phase === 'opening';
  const heading = useRef<HTMLHeadingElement>(null);

  // The control that opened the report is hidden under it: focus moves to the
  // card's heading, and back when the report closes.
  useEffect(() => {
    heading.current?.focus();
    return focusBack;
  }, []);

  const copy = async () => {
    const generation = getShellState().generation;
    if (generation === null) return;
    const result = await window.pev.copyReport(generation);
    setNote(result.ok ? 'Report copied.' : '');
  };

  return (
    <main className="center">
      <section className="ix-card" aria-label="Index report">
        <div className="ix-head">
          <h1 ref={heading} tabIndex={-1}>
            {loading ? 'Indexing' : 'Index report'}
          </h1>
          <div className="sub">{exportLabel(active.runName)}</div>
        </div>
        <Messages progress={progress} report={report} />
        {report !== null && report.attention > 0 && <Files report={report} />}
        <div className="ix-foot">
          <span className="note" role="status">
            {note}
          </span>
          <button
            type="button"
            className="btn"
            disabled={report === null}
            onClick={() => void copy()}
          >
            Copy report
          </button>
          <button type="button" className="btn primary" onClick={closeReport}>
            Start browsing
          </button>
        </div>
      </section>
    </main>
  );
}
