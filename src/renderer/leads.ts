// SPDX-License-Identifier: AGPL-3.0-or-later
// Lead lines for the list's rows or the conversation's cards: the first words
// of each message's body, or, on the cards of a conversation opened from a
// result, the search's snippet for a message that matches it. Only messages
// on screen are asked for, a request at a time. Lines are kept by message for
// the generation; when the index moves on, the messages on screen are asked
// again, and their old lines stay until the new ones replace them, so a line
// whose body wasn't indexed yet appears once it is.

import type { LeadsRequest } from '../shared/api';
import { MAX_LEAD_ROWIDS, type Lead } from '../shared/index-types';

/** What a message's line shows: its snippet if it has one, else its lead text. */
export type LeadLine = Pick<Lead, 'text' | 'snippet'>;

/** Asks for lead lines; null when there is no answer for the current export. */
export type ReadLeads = (request: LeadsRequest) => Promise<Lead[] | null>;

/** The most lines held: past it, only those of messages on screen are kept. */
export const MAX_LINES = 1000;

export class LeadsModel {
  private lines: ReadonlyMap<number, LeadLine> = new Map();
  /** Messages on screen, in order. */
  private onScreen: number[] = [];
  /** Messages answered since the index last moved on: not asked for again until it does. */
  private fresh = new Set<number>();
  /** The search the lines are for: a query ID, or null for plain lead lines. */
  private queryId: number | null = null;
  private reading = false;
  /** Bumped each time the index moves on: an answer read before that is shown but asked again. */
  private moves = 0;
  /** Bumped when the lines held no longer count: a new search or generation. */
  private epoch = 0;

  constructor(
    private readonly requester: LeadsRequest['requester'],
    private readonly read: ReadLeads,
    private readonly onChange: () => void,
  ) {}

  /** The lines held, by message. A new map whenever one changes. */
  get snapshot(): ReadonlyMap<number, LeadLine> {
    return this.lines;
  }

  /**
   * The messages on screen, and the search they were opened from, if any.
   * Messages with no line yet are asked for; a new search starts afresh.
   */
  show(rowids: readonly number[], queryId: number | null = null): void {
    if (queryId !== this.queryId) {
      this.queryId = queryId;
      this.forget();
    }
    this.onScreen = [...new Set(rowids)];
    this.ask();
  }

  /** The index moved on: the messages on screen are asked for again. */
  changed(): void {
    this.moves += 1;
    this.fresh = new Set();
    this.ask();
  }

  /** A new export or generation: nothing held counts any more. */
  reset(): void {
    this.queryId = null;
    this.onScreen = [];
    this.forget();
  }

  private forget(): void {
    this.epoch += 1;
    this.fresh = new Set();
    this.reading = false;
    if (this.lines.size > 0) {
      this.lines = new Map();
      this.onChange();
    }
  }

  /** Asks for the messages on screen that weren't answered since the index moved on. */
  private ask(): void {
    if (this.reading) return;
    const want = this.onScreen.filter((r) => !this.fresh.has(r)).slice(0, MAX_LEAD_ROWIDS);
    if (want.length === 0) return;
    this.reading = true;
    const epoch = this.epoch;
    const moves = this.moves;
    const request: LeadsRequest = {
      requester: this.requester,
      rowids: want,
      ...(this.queryId === null ? {} : { queryId: this.queryId }),
    };
    void this.read(request)
      .catch(() => null)
      .then((leads) => {
        if (epoch !== this.epoch) return;
        this.reading = false;
        // Without an answer, the next change of screen or index asks again.
        if (!leads) return;
        const lines =
          this.lines.size + want.length > MAX_LINES
            ? new Map([...this.lines].filter(([r]) => this.onScreen.includes(r)))
            : new Map(this.lines);
        // A message whose line was let go is asked for again once it is back on screen.
        if (lines.size < this.lines.size) {
          this.fresh = new Set([...this.fresh].filter((r) => lines.has(r)));
        }
        for (const lead of leads) {
          if (!want.includes(lead.rowid)) continue;
          // Read before the index moved on: shown now, and asked for again.
          if (moves === this.moves) this.fresh.add(lead.rowid);
          lines.set(lead.rowid, { text: lead.text, snippet: lead.snippet });
        }
        this.lines = lines;
        this.onChange();
        this.ask();
      });
  }
}
