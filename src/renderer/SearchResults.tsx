// SPDX-License-Identifier: AGPL-3.0-or-later
// The search box, and the results that take the list's place while it holds
// a query. Snippets are text with marked spans; nothing in them is markup.

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { displayText } from '../shared/header-text';
import { MAX_QUERY_LENGTH, type MarkedSnippet, type SearchSort } from '../shared/index-types';
import type { SidebarModel } from './folders';
import { formatCount, fullDate, listDate, participantsText } from './format';
import {
  clearSearch,
  search,
  selectResult,
  setSearchSort,
  setSearchText,
  useMailbox,
  useSearch,
} from './mailbox-state';
import { Chips } from './Chips';
import { setListStep } from './shortcut-actions';
import {
  RESULT_ROW_HEIGHT,
  conversationsText,
  partialText,
  snippetParts,
  type ResultRow,
} from './search';

export function SearchBox() {
  const { text } = useSearch();
  return (
    <input
      className="search-box"
      type="text"
      placeholder="Search mail"
      aria-label="Search mail"
      spellCheck={false}
      autoComplete="off"
      maxLength={MAX_QUERY_LENGTH}
      value={text}
      onChange={(e) => setSearchText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') clearSearch();
      }}
    />
  );
}

function Snippet({ snippet }: { snippet: MarkedSnippet }) {
  return (
    <>
      {snippetParts(snippet).map((part, i) =>
        part.mark ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

function ResultItem({
  row,
  index,
  total,
  selected,
  sidebar,
}: {
  row: ResultRow;
  index: number;
  total: number;
  selected: boolean;
  sidebar: SidebarModel | null;
}) {
  const unread = row.unread > 0;
  const who = participantsText(row.details?.participants ?? []);
  const subject = displayText(row.details?.subject ?? '');
  return (
    <div
      className={`conv result${unread ? ' unread' : ''}${selected ? ' selected' : ''}`}
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      tabIndex={selected ? 0 : -1}
      data-thread={row.threadId}
      data-rowid={row.anchorRowid}
      onClick={() => selectResult(row)}
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
        <span className="t" title={subject || undefined}>
          {subject}
        </span>
        {row.matching > 1 && (
          <span className="match-n">{`${formatCount(row.matching)} matching`}</span>
        )}
        {row.attachments && (
          <span className="clip" title="Has attachments" aria-label="Has attachments" />
        )}
      </div>
      <div className="snip">{row.snippet && <Snippet snippet={row.snippet} />}</div>
      <Chips labelIds={row.details?.labelIds} sidebar={sidebar} />
    </div>
  );
}

export function SearchResults() {
  const snap = useSearch();
  const { sidebar } = useMailbox();
  const scrollRef = useRef<HTMLDivElement>(null);
  // The virtualizer's methods aren't memoized; nothing below memoizes them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: snap.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => RESULT_ROW_HEIGHT,
    overscan: 8,
  });

  const reportViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollTop + Math.max(el.clientHeight, RESULT_ROW_HEIGHT) - 1;
    search.setViewport(
      Math.floor(el.scrollTop / RESULT_ROW_HEIGHT),
      Math.floor(bottom / RESULT_ROW_HEIGHT),
    );
  }, []);

  // A new search's results start at the top.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    reportViewport();
  }, [snap.shownId, reportViewport]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(reportViewport);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reportViewport]);

  // The next or previous result, from the selected one, or with none
  // selected from the first row on screen: the arrow keys, and `j`/`k` anywhere.
  const step = useCallback(
    (delta: 1 | -1) => {
      const at =
        search.selectedIndex() ??
        Math.floor((scrollRef.current?.scrollTop ?? 0) / RESULT_ROW_HEIGHT);
      const next = Math.max(0, Math.min(search.snapshot.rows.length - 1, at + delta));
      const row = search.rowAt(next);
      if (!row) return;
      selectResult(row);
      virtualizer.scrollToIndex(next);
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-thread="${row.threadId}"]`)
        ?.focus({ preventScroll: true });
    },
    [virtualizer],
  );
  useEffect(() => setListStep(step), [step]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  };

  const selectedThread = snap.selected?.threadId ?? null;
  const items = virtualizer.getVirtualItems();
  const selectedDrawn =
    selectedThread !== null &&
    items.some((item) => snap.rows[item.index]?.threadId === selectedThread);
  const total = snap.total ?? snap.rows.length;
  const partial = partialText(snap.coverage);
  // A query with no words to rank is sorted by date only.
  const sort: SearchSort = snap.ranked ? snap.sort : 'date';
  const empty = !snap.searching && !snap.failed && snap.total === 0;
  return (
    <section className="list results" aria-label="Conversations">
      <div className="list-head">
        <div className="results-head">
          <span className="cnt">{snap.total !== null && conversationsText(snap.total)}</span>
          <select
            className="sort"
            aria-label="Sort"
            value={sort}
            disabled={!snap.ranked}
            onChange={(e) => setSearchSort(e.target.value as SearchSort)}
          >
            <option value="date">Newest first</option>
            {snap.ranked && <option value="relevance">Relevance</option>}
          </select>
        </div>
        {partial !== null && (
          <div className="partial" role="status">
            {partial}
          </div>
        )}
      </div>
      <div
        ref={scrollRef}
        className="list-scroll"
        role="listbox"
        aria-label="Conversations"
        tabIndex={selectedDrawn ? -1 : 0}
        onScroll={reportViewport}
        onKeyDown={onKeyDown}
      >
        {empty && <div className="no-results">No results</div>}
        {snap.failed && (
          <div className="no-results" role="status">
            Couldn&apos;t search
          </div>
        )}
        <div className="list-inner" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = snap.rows[item.index];
            if (!row) return null;
            return (
              <div
                key={`t${row.threadId}`}
                className="slot"
                style={{ transform: `translateY(${item.start}px)`, height: RESULT_ROW_HEIGHT }}
                data-index={item.index}
              >
                <ResultItem
                  row={row}
                  index={item.index}
                  total={total}
                  selected={row.threadId === selectedThread}
                  sidebar={sidebar}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
