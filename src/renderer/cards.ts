// SPDX-License-Identifier: AGPL-3.0-or-later
// The conversation's cards: its messages from every folder, oldest first, with
// one of them expanded in the reader. Like the list, only a window of cards
// around what is on screen is held, read again when the index moves on or the
// view leaves it. Each read follows the expanded message, so a merge or split
// keeps the expansion. If the expanded message is gone, the nearest card
// (the next newer one first) opens in its place; with no card left, the
// reader closes and its view is revoked.

import {
  CARDS_AFTER,
  type CardKey,
  type CardRow,
  type CardsAnchor,
  type CardsQuery,
  type CardsWindow,
} from '../shared/index-types';

/** A collapsed card's height in pixels, the gap below it included. */
export const CARD_HEIGHT = 58;
/** Cards read above the anchor, for scrolling up. */
export const CARDS_ABOVE = 50;
/** Cards beyond the screen that must be held before more are read. */
export const CARD_MARGIN = 10;
/** A position past any conversation's end: the index places it at the last card. */
const PAST_END = 2 ** 31;

export interface CardsSnapshot {
  /** A conversation is shown. */
  shown: boolean;
  threadId: number | null;
  subject: string;
  /** Messages in the conversation. */
  total: number;
  /** The position of the first card held. */
  start: number;
  cards: CardRow[];
  /** The message of the expanded card. */
  expanded: number | null;
  /** No message of the conversation is left in the export. */
  gone: boolean;
  /** Whether the conversation has been read at least once. */
  ready: boolean;
  /** Bumped each time the expanded card's header must scroll to the top. */
  scrollId: number;
  /** Bumped each time the cards must scroll to keep their anchor in place. */
  shiftId: number;
  /** Cards to scroll by for `shiftId`; positive is down. */
  shift: number;
}

export type ReadCards = (query: CardsQuery) => Promise<CardsWindow | null>;

export interface CardActions {
  /** Opens a message in the reader; the reader revokes the view it replaces. */
  open(rowid: number): void;
  /** Closes the reader and revokes its view and any open under way. */
  close(): void;
}

const EMPTY: CardsSnapshot = {
  shown: false,
  threadId: null,
  subject: '',
  total: 0,
  start: 0,
  cards: [],
  expanded: null,
  gone: false,
  ready: false,
  scrollId: 0,
  shiftId: 0,
  shift: 0,
};

export class CardsModel {
  private snap: CardsSnapshot = EMPTY;
  /** The expanded card's place in the conversation, to find the card nearest it once it's gone. */
  private expandedKey: CardKey | null = null;
  /** The message the selection opened, followed after the expanded one. */
  private selected: number | null = null;
  private first = 0;
  private last = 0;
  private reading = false;
  private again = false;
  /** The next read anchors at the expanded card's place, wherever the screen is. */
  private seekExpanded = false;
  /** Conversation changes since the start; a read for an older one is dropped. */
  private epoch = 0;

  constructor(
    private readonly read: ReadCards,
    private readonly onChange: () => void,
    private readonly actions: CardActions,
  ) {}

  get snapshot(): CardsSnapshot {
    return this.snap;
  }

  /**
   * Which showing of a conversation is on screen, or null with none shown.
   * Each show() starts a new one and hide() ends it; expanding a card or a
   * read that finds the conversation merged or split keeps it.
   */
  get showing(): number | null {
    return this.snap.shown ? this.epoch : null;
  }

  private set(patch: Partial<CardsSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.onChange();
  }

  /** The card at a position, if it is held. */
  cardAt(index: number): CardRow | null {
    const i = index - this.snap.start;
    return i >= 0 && i < this.snap.cards.length ? this.snap.cards[i]! : null;
  }

  /** The position of the expanded card, if it is held. */
  expandedIndex(): number | null {
    const { expanded, cards, start } = this.snap;
    if (expanded === null) return null;
    const i = cards.findIndex((c) => c.rowid === expanded);
    return i < 0 ? null : start + i;
  }

  /**
   * Shows the conversation that holds message `rowid`, with that message
   * expanded and opened in the reader. `rowid` is the conversation's newest
   * message, as the list opens it: if it is gone before the first read finds
   * its place, the newest card left takes its place.
   */
  show(rowid: number, threadId: number | null): void {
    this.epoch += 1;
    this.first = 0;
    this.last = 0;
    this.selected = rowid;
    this.expandedKey = null;
    this.seekExpanded = false;
    this.snap = {
      ...EMPTY,
      shown: true,
      threadId,
      expanded: rowid,
      scrollId: this.snap.scrollId + 1,
      shiftId: this.snap.shiftId,
    };
    this.onChange();
    this.actions.open(rowid);
    this.refresh();
  }

  /** Shows no conversation; the reader is closed by whoever closes this. */
  hide(): void {
    this.epoch += 1;
    this.selected = null;
    this.expandedKey = null;
    this.snap = { ...EMPTY, scrollId: this.snap.scrollId, shiftId: this.snap.shiftId };
    this.onChange();
  }

  /**
   * Expands a card and opens its message, collapsing the one expanded before.
   * Returns false if it already was the expanded card.
   */
  expand(card: CardRow): boolean {
    if (!this.snap.shown || card.rowid === this.snap.expanded) return false;
    this.expandedKey = { time: card.time, rowid: card.rowid };
    this.set({ expanded: card.rowid, scrollId: this.snap.scrollId + 1 });
    this.actions.open(card.rowid);
    return true;
  }

  /** The positions on screen, first and last; reads more cards if they aren't held. */
  setViewport(first: number, last: number): void {
    this.first = Math.max(0, first);
    this.last = Math.max(this.first, last);
    if (!this.covered()) this.refresh();
  }

  private covered(): boolean {
    const { total, start, cards } = this.snap;
    if (!this.snap.ready || total === 0) return true;
    const from = Math.max(0, this.first - CARD_MARGIN);
    const to = Math.min(total - 1, this.last + CARD_MARGIN);
    return from >= start && to < start + cards.length;
  }

  /** Reads the cards again, e.g. because the index moved on. */
  refresh(): void {
    if (!this.snap.shown) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    void this.readOnce()
      .catch(() => false)
      .then((read) => {
        this.reading = false;
        if (this.again) {
          this.again = false;
          this.refresh();
        } else if (read && !this.covered()) {
          this.refresh();
        }
      });
  }

  /**
   * The anchor: the expanded card if it is on screen (or a read must find
   * its place), else the top card on screen.
   */
  private anchor(): { anchor: CardsAnchor; index: number; atExpanded: boolean } {
    const { expanded } = this.snap;
    const at = this.expandedIndex();
    const onScreen = at !== null && at >= this.first && at <= this.last;
    if (expanded !== null && (onScreen || this.seekExpanded || !this.snap.ready)) {
      const index = at ?? this.first;
      return {
        anchor: {
          rowid: expanded,
          // With its place not known yet, the expanded message is the newest.
          ...(this.expandedKey ? { key: this.expandedKey, index } : { index: PAST_END }),
        },
        index,
        atExpanded: true,
      };
    }
    const top = this.cardAt(this.first);
    return top
      ? {
          anchor: {
            rowid: top.rowid,
            key: { time: top.time, rowid: top.rowid },
            index: this.first,
          },
          index: this.first,
          atExpanded: false,
        }
      : { anchor: { index: this.first }, index: this.first, atExpanded: false };
  }

  /** Reads the cards once; false if no answer came. */
  private async readOnce(): Promise<boolean> {
    const epoch = this.epoch;
    const { anchor, index, atExpanded } = this.anchor();
    const expanded = this.snap.expanded;
    const follow = [...new Set([expanded, this.selected].filter((r): r is number => r !== null))];
    const screen = this.last - this.first + 1;
    const answer = await this.read({
      op: 'cards',
      follow,
      threadId: this.snap.threadId,
      anchor,
      before: CARDS_ABOVE,
      after: Math.min(CARDS_AFTER, screen + 2 * CARD_MARGIN + CARDS_ABOVE),
    });
    if (!answer) return false;
    if (epoch !== this.epoch) return true;
    // Expanded elsewhere while this was read: read again for that card.
    if (this.snap.expanded !== expanded) {
      this.again = true;
      return true;
    }
    if (answer.threadId === null) {
      // Nothing of the conversation is left.
      this.seekExpanded = false;
      const hadExpanded = expanded !== null;
      this.set({
        threadId: null,
        subject: '',
        total: 0,
        start: 0,
        cards: [],
        expanded: null,
        gone: true,
        ready: true,
      });
      if (hadExpanded) this.actions.close();
      return true;
    }
    const removed = expanded !== null && answer.followed !== expanded;
    if (removed && !atExpanded) {
      // This window may not hold the place of the card that went: read there.
      // Its view and any open of it are revoked now, not once that read is back.
      this.seekExpanded = true;
      this.again = true;
      this.set({ threadId: answer.threadId });
      this.actions.close();
      return true;
    }
    this.seekExpanded = false;
    const moved = answer.anchorFound && answer.anchor !== null ? answer.anchor - index : 0;
    // Cards on screen stay in place by a shift; on a first read or a new
    // expansion the expanded card's header scrolls to the top instead.
    const shift = moved !== 0 && this.snap.ready && !removed;
    let next = expanded;
    if (removed) {
      // The nearest card takes the expanded one's place.
      const card = answer.anchor === null ? null : answer.cards[answer.anchor - answer.start];
      next = card?.rowid ?? null;
      this.expandedKey = card ? { time: card.time, rowid: card.rowid } : null;
    } else if (expanded !== null) {
      const card = answer.cards.find((c) => c.rowid === expanded);
      if (card) this.expandedKey = { time: card.time, rowid: card.rowid };
    }
    this.set({
      threadId: answer.threadId,
      subject: answer.subject,
      total: answer.total,
      start: answer.start,
      cards: answer.cards,
      expanded: next,
      gone: false,
      ready: true,
      ...(removed ? { scrollId: this.snap.scrollId + 1 } : {}),
      ...(shift ? { shiftId: this.snap.shiftId + 1, shift: moved } : {}),
    });
    this.first = Math.max(0, this.first + moved);
    this.last = Math.max(this.first, this.last + moved);
    if (removed) {
      if (next !== null) this.actions.open(next);
      else this.actions.close();
    }
    return true;
  }
}
