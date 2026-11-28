// SPDX-License-Identifier: AGPL-3.0-or-later
// The selected conversation: its subject and message count, then one card per
// message from every folder, oldest first. One card is expanded, with the
// open message and its body frame; the others show the sender, the date and
// a Spam or Trash badge. The cards are a virtual list, so a conversation of
// any length draws only what is on screen.

import {
  defaultRangeExtractor,
  observeElementOffset,
  useVirtualizer,
} from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { displayText } from '../shared/header-text';
import type { CardRow } from '../shared/index-types';
import { CARD_HEIGHT } from './cards';
import { formatCount } from './format';
import { cards, expandCard, useCards } from './mailbox-state';
import { useReaderState } from './reader';
import { avatarColor, initialsOf, shortDate } from './reader-format';
import { MessageBody } from './ReaderPane';
import './conversation.css';

/** Room an expanded card takes besides its frame: header, switch, recipients, lines. */
const EXPANDED_EXTRA = 200;

function cardDate(time: number): string {
  const date = new Date(time * 1000);
  return Number.isNaN(date.getTime()) ? '' : shortDate(date.toISOString());
}

function Card({ card, expanded }: { card: CardRow; expanded: boolean }) {
  const reader = useReaderState();
  const address = displayText(card.senderAddress);
  const name = displayText(card.senderName) || address;
  return (
    <article
      className={expanded ? 'card expanded' : 'card'}
      data-rowid={card.rowid}
      aria-busy={expanded && reader.pending}
    >
      <button
        type="button"
        className="card-h"
        aria-expanded={expanded}
        onClick={() => expandCard(card)}
      >
        <span
          className="rp-avatar"
          style={{ background: avatarColor(card.senderAddress || card.senderName) }}
          aria-hidden="true"
        >
          {initialsOf(name)}
        </span>
        <span className="ch-l1">
          <span className="ch-name" title={address || undefined}>
            {name}
          </span>
          {card.spam && <span className="pill">Spam</span>}
          {card.trash && <span className="pill">Trash</span>}
          <span className="ch-date">{cardDate(card.time)}</span>
        </span>
      </button>
      {expanded && reader.rowid === card.rowid && (
        <div className="card-body">
          <MessageBody />
        </div>
      )}
    </article>
  );
}

export function Conversation() {
  const snap = useCards();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paneHeight, setPaneHeight] = useState(0);
  const expandedIndex = cards.expandedIndex();
  // Where the cards are scrolled, as the virtualizer knows it: set at once
  // after a scroll of ours, since its scroll event may come late or not at all.
  const offsetSink = useRef<((offset: number, isScrolling: boolean) => void) | null>(null);
  // The virtualizer's methods aren't memoized; nothing below memoizes them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: snap.total,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (i === expandedIndex ? paneHeight + EXPANDED_EXTRA : CARD_HEIGHT),
    getItemKey: (i) => {
      const card = cards.cardAt(i);
      return card ? `m${card.rowid}` : `i${i}`;
    },
    overscan: 6,
    // The expanded card stays drawn while it is held, so its frame isn't
    // loaded again each time it scrolls out of view and back.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (expandedIndex === null || indexes.includes(expandedIndex)) return indexes;
      return [...indexes, expandedIndex].sort((a, b) => a - b);
    },
    observeElementOffset: (instance, cb) => {
      offsetSink.current = cb;
      return observeElementOffset(instance, cb);
    },
  });

  // The cards on screen, where the pane is scrolled now; the expanded card
  // drawn out of view doesn't count.
  const reportViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = virtualizer.getVirtualItemForOffset(el.scrollTop);
    const last = virtualizer.getVirtualItemForOffset(
      el.scrollTop + Math.max(el.clientHeight, 1) - 1,
    );
    if (first && last) cards.setViewport(first.index, last.index);
  }, [virtualizer]);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setPaneHeight(el.clientHeight);
    measure();
    const observer = new ResizeObserver(() => {
      measure();
      reportViewport();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [reportViewport]);

  // Sizes depend on which card is expanded and on the pane's height.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, expandedIndex, paneHeight, snap.cards]);

  // On expansion, the expanded card's header scrolls to the top.
  const scrollSeen = useRef(-1);
  useLayoutEffect(() => {
    if (expandedIndex === null || snap.scrollId === scrollSeen.current) return;
    scrollSeen.current = snap.scrollId;
    const target = virtualizer.getOffsetForIndex(expandedIndex, 'start');
    if (target) scrollTo(target[0]);
  }, [snap.scrollId, expandedIndex, virtualizer, scrollTo]);

  // Cards that arrived above the anchor: scroll by as many, before the paint.
  const shiftSeen = useRef(snap.shiftId);
  useLayoutEffect(() => {
    if (snap.shiftId === shiftSeen.current) return;
    shiftSeen.current = snap.shiftId;
    const el = scrollRef.current;
    if (el) scrollTo(el.scrollTop + snap.shift * CARD_HEIGHT);
  }, [snap.shiftId, snap.shift, scrollTo]);

  if (snap.gone) {
    return (
      <div className="rp">
        <div className="rp-line rp-state" role="status">
          <b>Message no longer in the export</b>
        </div>
      </div>
    );
  }
  return (
    <div className="rp cv">
      <div className="cv-head">
        <h1 className="rp-subject">{displayText(snap.subject)}</h1>
        {snap.ready && (
          <div className="chips">
            <span className="chip">
              {`${formatCount(snap.total)} ${snap.total === 1 ? 'message' : 'messages'}`}
            </span>
          </div>
        )}
      </div>
      <div ref={scrollRef} className="cv-scroll" onScroll={reportViewport}>
        <div className="cv-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const card = cards.cardAt(item.index);
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                className="cv-slot"
                data-index={item.index}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {card ? (
                  <Card card={card} expanded={card.rowid === snap.expanded} />
                ) : (
                  <div className="card placeholder" aria-hidden="true" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
