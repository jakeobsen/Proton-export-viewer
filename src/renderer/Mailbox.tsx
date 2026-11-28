// SPDX-License-Identifier: AGPL-3.0-or-later
// The open export: the sidebar with its folders and labels, and the list of
// the folder's conversations.

import { observeElementOffset, useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { ActiveExport } from '../shared/sources';
import type { SidebarEntry, SidebarModel } from './folders';
import {
  formatCount,
  fullDate,
  fullTextLine,
  fullTextShare,
  listDate,
  loadingText,
  participantsText,
} from './format';
import { exportLabel } from './labels';
import { ROW_HEIGHT, type Row } from './list';
import { list, selectRow, showFolder, useList, useMailbox } from './mailbox-state';
import { openReportFrom } from './Report';
import { attentionText } from '../shared/report-text';
import { switchRun } from './shell';

/** Up to two initials from the account's local part: "sam.rivera@…" gives "SR". */
function initials(account: string | null): string {
  const local = (account ?? '').split('@')[0] ?? '';
  const parts = local.split(/[._+-]+/).filter((p) => p !== '');
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

function AccountBox({ active, busy }: { active: ActiveExport; busy: boolean }) {
  const current = active.runs.find((r) => r.current);
  const run = exportLabel(active.runName);
  return (
    <div
      className="acct-box"
      tabIndex={0}
      title={active.account === null ? run : `${active.account}\n${run}`}
    >
      <span className="avatar" aria-hidden="true">
        {initials(active.account)}
      </span>
      <span className="acct-txt">
        {active.account !== null && <span className="export-account">{active.account}</span>}
        {active.runs.length > 1 ? (
          <select
            className="run-picker"
            aria-label="Export"
            disabled={busy}
            value={current?.runId ?? ''}
            onChange={(e) => void switchRun(e.target.value)}
          >
            {current === undefined && <option value="">{run}</option>}
            {active.runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.account !== null && r.account !== active.account
                  ? `${r.account} · ${exportLabel(r.runName)}`
                  : exportLabel(r.runName)}
              </option>
            ))}
          </select>
        ) : (
          <span className="export-run">{run}</span>
        )}
      </span>
    </div>
  );
}

function FolderLink({ entry, current }: { entry: SidebarEntry; current: boolean }) {
  return (
    <button
      type="button"
      className={current ? 'nav-item active' : 'nav-item'}
      style={{ paddingLeft: 10 + Math.min(entry.depth, 6) * 16 }}
      aria-current={current ? 'true' : undefined}
      data-folder={entry.id}
      onClick={() => showFolder(entry.id)}
    >
      {entry.kind === 'label' && (
        <span
          className={entry.color ? 'dot' : 'dot plain'}
          style={entry.color ? { background: entry.color } : undefined}
          aria-hidden="true"
        />
      )}
      <span className="nav-name" title={entry.name}>
        {entry.name}
      </span>
      {entry.unread > 0 && (
        <span className="nav-count" title="Unread conversations">
          {formatCount(entry.unread)}
        </span>
      )}
    </button>
  );
}

function FolderGroup({
  title,
  entries,
  folder,
}: {
  title: string | null;
  entries: SidebarEntry[];
  folder: string;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      {title !== null && <div className="nav-h">{title}</div>}
      <nav className="nav" aria-label={title ?? 'Folders'}>
        {entries.map((entry) => (
          <FolderLink key={entry.id} entry={entry} current={entry.id === folder} />
        ))}
      </nav>
    </>
  );
}

function IndexStatus() {
  const { progress } = useMailbox();
  if (!progress) return null;
  if (progress.phase === 'loading' || progress.phase === 'opening') {
    // Until the scan has counted the files, the bar shows without numbers.
    const counted = progress.total > 0;
    const share = counted ? progress.loaded / progress.total : 0;
    return (
      <div className="side-foot" role="status">
        {counted && (
          <button
            type="button"
            className="link loading-text"
            onClick={(e) => openReportFrom(e.currentTarget)}
          >
            {loadingText(progress.loaded, progress.total)}
          </button>
        )}
        <div
          className="bar-track"
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
      </div>
    );
  }
  if (progress.condition === 'verifying') {
    return (
      <div className="side-foot" role="status">
        Verifying index…
      </div>
    );
  }
  // Phase 2 over the whole export; nothing once it has ended.
  const share =
    progress.phase === 'done' && progress.bodyPhase === 'indexing' ? fullTextShare(progress) : null;
  if (share !== null) {
    return (
      <div className="side-foot" role="status">
        <button
          type="button"
          className="link full-text"
          onClick={(e) => openReportFrom(e.currentTarget)}
        >
          {fullTextLine(share)}
        </button>
        <div
          className="bar-track"
          role="progressbar"
          aria-label="Full text"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share}
        >
          <span style={{ width: `${share}%` }} />
        </div>
      </div>
    );
  }
  return null;
}

export function Sidebar({ active, busy }: { active: ActiveExport; busy: boolean }) {
  const { sidebar, folder } = useMailbox();
  return (
    <aside className="sidebar" aria-label="Folders and labels">
      <AccountBox active={active} busy={busy} />
      <div className="side-scroll">{sidebar && <Folders sidebar={sidebar} folder={folder} />}</div>
      <IndexStatus />
    </aside>
  );
}

function Folders({ sidebar, folder }: { sidebar: SidebarModel; folder: string }) {
  return (
    <>
      <FolderGroup title={null} entries={sidebar.system} folder={folder} />
      <FolderGroup title="Folders" entries={sidebar.folders} folder={folder} />
      <FolderGroup title="Labels" entries={sidebar.labels} folder={folder} />
    </>
  );
}

/** A conversation's labels, as chips. */
export function Chips({
  labelIds,
  sidebar,
}: {
  labelIds: readonly string[] | undefined;
  sidebar: SidebarModel | null;
}) {
  const labels = (labelIds ?? [])
    .map((id) => sidebar?.byId.get(id))
    .filter((e): e is SidebarEntry => e?.kind === 'label');
  if (labels.length === 0) return null;
  return (
    <div className="chips">
      {labels.map((label) => (
        <span key={label.id} className="chip">
          <span
            className={label.color ? 'dot' : 'dot plain'}
            style={label.color ? { background: label.color } : undefined}
            aria-hidden="true"
          />
          <span className="chip-name">{label.name}</span>
        </span>
      ))}
    </div>
  );
}

function ConversationRow({
  row,
  index,
  total,
  selected,
  sidebar,
}: {
  row: Row;
  index: number;
  total: number;
  selected: boolean;
  sidebar: SidebarModel | null;
}) {
  const unread = row.unreadHere > 0;
  const who = participantsText(row.details?.participants ?? []);
  return (
    <div
      className={`conv${unread ? ' unread' : ''}${selected ? ' selected' : ''}`}
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      tabIndex={selected ? 0 : -1}
      data-thread={row.threadId}
      data-rowid={row.anchorRowid}
      onClick={() => selectRow(row)}
    >
      {unread && <span className="udot" title="Unread" />}
      <div className="l1">
        <span className="from" title={who}>
          {who}
        </span>
        {row.count > 1 && (
          <span className="cnt-badge" title="Messages">
            {formatCount(row.count)}
          </span>
        )}
        <span className="date" title={fullDate(row.time)}>
          {listDate(row.time)}
        </span>
      </div>
      <div className="subj">
        <span className="t" title={row.details?.subject}>
          {row.details?.subject ?? ''}
        </span>
        {row.attachments && (
          <span className="clip" title="Has attachments" aria-label="Has attachments" />
        )}
      </div>
      <Chips labelIds={row.details?.labelIds} sidebar={sidebar} />
    </div>
  );
}

export function ConversationList() {
  const { sidebar, folder, progress, report } = useMailbox();
  const snap = useList();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Where the virtualizer learns the scroll offset. A scroll the list makes
  // itself is passed on at once, before the paint, rather than waiting for
  // the scroll event of the next frame.
  const offsetSink = useRef<((offset: number, isScrolling: boolean) => void) | null>(null);
  // The virtualizer's methods aren't memoized; nothing below memoizes them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: snap.total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    observeElementOffset: (instance, cb) => {
      offsetSink.current = cb;
      return observeElementOffset(instance, cb);
    },
  });

  const reportViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = Math.floor(el.scrollTop / ROW_HEIGHT);
    const last = Math.floor(
      (el.scrollTop + Math.max(el.clientHeight, ROW_HEIGHT) - 1) / ROW_HEIGHT,
    );
    list.setViewport(first, last);
  }, []);

  const scrollTo = useCallback(
    (top: number) => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = top;
      offsetSink.current?.(el.scrollTop, false);
      reportViewport();
    },
    [reportViewport],
  );

  // Rows that arrived above the anchor: scroll by as many, before the paint.
  const shiftSeen = useRef(snap.shiftId);
  useLayoutEffect(() => {
    if (snap.shiftId === shiftSeen.current) return;
    shiftSeen.current = snap.shiftId;
    const el = scrollRef.current;
    if (el) scrollTo(el.scrollTop + snap.shift * ROW_HEIGHT);
  }, [snap.shiftId, snap.shift, scrollTo]);

  // A new folder starts at the top.
  useLayoutEffect(() => scrollTo(0), [snap.labelId, scrollTo]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(reportViewport);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reportViewport]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = list.selectedIndex() ?? Math.floor((scrollRef.current?.scrollTop ?? 0) / ROW_HEIGHT);
    const next = Math.max(0, Math.min(snap.total - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    const row = list.rowAt(next);
    if (!row) return;
    selectRow(row);
    virtualizer.scrollToIndex(next);
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-thread="${row.threadId}"]`)
      ?.focus({ preventScroll: true });
  };

  const name = sidebar?.byId.get(folder)?.name ?? '';
  const unread = sidebar?.byId.get(folder)?.unread ?? 0;
  const selectedThread = snap.selected?.threadId ?? null;
  const items = virtualizer.getVirtualItems();
  // The selected row takes Tab focus; while it isn't drawn, the list does.
  const selectedDrawn =
    selectedThread !== null &&
    items.some((item) => list.rowAt(item.index)?.threadId === selectedThread);
  return (
    <section className="list" aria-label="Conversations">
      <div className="list-head">
        <h2>{name}</h2>
        {snap.ready && (
          <span className="cnt">
            {`${formatCount(snap.total)} ${snap.total === 1 ? 'conversation' : 'conversations'}`}
            {unread > 0 && ` · ${formatCount(unread)} unread`}
          </span>
        )}
        {progress?.phase === 'done' && report !== null && report.attention > 0 && (
          <button
            type="button"
            className="link attention"
            onClick={(e) => openReportFrom(e.currentTarget)}
          >
            {attentionText(report.attention)}
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        className="list-scroll"
        role="listbox"
        aria-label={name}
        tabIndex={selectedDrawn ? -1 : 0}
        onScroll={reportViewport}
        onKeyDown={onKeyDown}
      >
        <div className="list-inner" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = list.rowAt(item.index);
            return (
              <div
                key={row ? `t${row.threadId}` : `i${item.index}`}
                className="slot"
                style={{ transform: `translateY(${item.start}px)`, height: ROW_HEIGHT }}
                data-index={item.index}
              >
                {row ? (
                  <ConversationRow
                    row={row}
                    index={item.index}
                    total={snap.total}
                    selected={row.threadId === selectedThread}
                    sidebar={sidebar}
                  />
                ) : (
                  <div className="conv placeholder" aria-hidden="true" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
