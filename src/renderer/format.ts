// SPDX-License-Identifier: AGPL-3.0-or-later
// Display text for the list and Settings: counts, dates and participants.

import { displayText } from '../shared/header-text';
import type { IndexProgress, Participant } from '../shared/index-types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COUNT = new Intl.NumberFormat('en-US');

/** "20,000". */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

const pad = (n: number) => String(n).padStart(2, '0');

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * A list row's date, in local time: "09:14" today, "Tue" in the six days
 * before, "22 Nov" earlier this year, "22 Nov 2024" before that. `time` is in
 * seconds.
 */
export function listDate(time: number, now: Date = new Date()): string {
  const date = new Date(time * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (days > 0 && days < 7) return DAYS[date.getDay()]!;
  const dayMonth = `${date.getDate()} ${MONTHS[date.getMonth()]!}`;
  return date.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth} ${date.getFullYear()}`;
}

/** The full date and time, for a row's tooltip: "Tue 24 Nov 2026, 21:40". */
export function fullDate(time: number): string {
  const date = new Date(time * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${DAYS[date.getDay()]!} ${date.getDate()} ${MONTHS[date.getMonth()]!} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A conversation's senders, oldest first: each by name, or by address when it
 * has none, each cleaned for display.
 */
export function participantsText(participants: readonly Participant[]): string {
  return participants
    .map((p) => displayText(p.name) || displayText(p.address))
    .filter((s) => s !== '')
    .join(', ');
}

/** "Reading export… 42,000 of 300,000 files". */
export function readingText(read: number, total: number): string {
  return `Reading export… ${formatCount(read)} of ${formatCount(total)} files`;
}

/** "Loading 4,100 of 20,000…". */
export function loadingText(loaded: number, total: number): string {
  return `Loading ${formatCount(loaded)} of ${formatCount(total)}…`;
}

/**
 * How far phase 2 has got over the whole export, as a whole percent from 0 to
 * 100: the message files handled in earlier runs and in this one, over all
 * the files it reads. A file whose text couldn't be read counts as handled,
 * so this isn't the share of bodies indexed, which the index report gives.
 * Null while there is no file to read.
 */
export function fullTextShare(progress: IndexProgress): number | null {
  const all = progress.bodiesBefore + progress.bodiesTotal;
  if (all <= 0) return null;
  const share = Math.floor(((progress.bodiesBefore + progress.bodiesDone) * 100) / all);
  return Math.min(100, Math.max(0, share));
}

/** "Full text 40% · search is partial". */
export function fullTextLine(share: number): string {
  return `Full text ${share}% · search is partial`;
}

/** A conversation's header count: "4 messages", or from a result "4 messages · 2 matching". */
export function countText(total: number, matching: number | null): string {
  const messages = `${formatCount(total)} ${total === 1 ? 'message' : 'messages'}`;
  return matching === null ? messages : `${messages} · ${formatCount(matching)} matching`;
}

/**
 * When something last changed, in local time: "Today, 09:58",
 * "Yesterday, 18:20", "24 Nov 2026, 09:58". `time` is in milliseconds.
 */
export function changedAt(time: number, now: Date = new Date()): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `Today, ${clock}`;
  if (days === 1) return `Yesterday, ${clock}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]!} ${date.getFullYear()}, ${clock}`;
}

/**
 * The index's Status in Settings: "Complete" once the text of every message
 * file is indexed, else "Full text N%" of this run's files, rounded down.
 */
export function fullTextStatus(progress: IndexProgress): string {
  if (progress.bodyPhase === 'done') return 'Complete';
  const { bodiesDone, bodiesTotal } = progress;
  const percent = bodiesTotal > 0 ? Math.floor((bodiesDone / bodiesTotal) * 100) : 0;
  return `Full text ${percent}%`;
}
