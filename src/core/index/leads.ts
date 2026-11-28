// SPDX-License-Identifier: AGPL-3.0-or-later
// Lead lines: the first words of a message's stored body, as a list row or a
// card shows them under its name or subject. A line is cleaned as the shell
// cleans header text, so nothing in it can reorder or hide the text around
// it. When the messages were opened from a search with words, those that
// match it get the search's snippet in place of their lead.

import { lineText } from '../../shared/header-text';
import {
  LEAD_UNITS,
  MAX_LEAD_ROWIDS,
  type Lead,
  type LeadsAnswer,
  type LeadsQuery,
  type MarkedSnippet,
} from '../../shared/index-types';
import { BODY_STATE } from './schema';
import { matchedSnippets } from './search';
import { asNumber, type Db } from './sql';

/**
 * The characters of a stored body read for its lead. Ten times the line's
 * length leaves room for the white space and invisible characters cleaning
 * takes out; a body that starts with a longer run of them gives a shorter
 * line, or none, rather than more reading.
 */
export const LEAD_READ = 2000;

/**
 * A body's lead line: cleaned for one line, then at most LEAD_UNITS UTF-16
 * units, one fewer when the cut would split a surrogate pair. No ellipsis:
 * the shell clips the line. Null when nothing is left.
 */
export function leadText(body: string): string | null {
  const line = lineText(body);
  if (line === '') return null;
  if (line.length <= LEAD_UNITS) return line;
  const last = line.charCodeAt(LEAD_UNITS - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? LEAD_UNITS - 1 : LEAD_UNITS;
  return line.slice(0, cut);
}

/**
 * The lead lines of up to MAX_LEAD_ROWIDS distinct messages, read from one
 * snapshot, in the order asked. A message whose body isn't indexed (yet, or
 * at all), or that is gone, has none.
 */
export function leads(db: Db, query: Omit<LeadsQuery, 'op'>): LeadsAnswer {
  const rowids = [...new Set(query.rowids)];
  if (rowids.length > MAX_LEAD_ROWIDS) throw new Error('INVALID');
  if (rowids.length === 0) return { leads: [], dropped: 0 };
  const found = new Map<number, string | null>();
  for (const r of db
    .stmt(
      `SELECT m.rowid AS rowid, p.body_state AS state, substr(t.body, 1, ${LEAD_READ}) AS lead
       FROM messages m JOIN pairs p ON p.proton_id = m.proton_id
       LEFT JOIN message_text t ON t.rowid = m.rowid
       WHERE m.rowid IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(rowids))) {
    const state = asNumber(r.state);
    const indexed = state === BODY_STATE.indexed || state === BODY_STATE.truncated;
    found.set(asNumber(r.rowid), indexed && typeof r.lead === 'string' ? leadText(r.lead) : null);
  }
  let snipped = { byRowid: new Map<number, MarkedSnippet>(), dropped: 0 };
  if (query.text !== undefined) snipped = matchedSnippets(db, query.text, [...found.keys()]);
  const answer: Lead[] = rowids.map((rowid) => ({
    rowid,
    text: found.get(rowid) ?? null,
    snippet: snipped.byRowid.get(rowid) ?? null,
  }));
  return { leads: answer, dropped: snipped.dropped };
}
