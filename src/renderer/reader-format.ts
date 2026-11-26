// SPDX-License-Identifier: AGPL-3.0-or-later
// How the reader pane shows a message's header fields.

export interface Sender {
  /** The display name, or the address when there is none. */
  name: string;
  /** The address, or '' when the field has none. */
  address: string;
}

const ADDRESS_RE = /^(.*?)\s*<([^<>]*)>\s*$/s;

/** Splits the first mailbox of a From field into its name and address. */
export function senderOf(from: string): Sender {
  const first = from.trim();
  const match = ADDRESS_RE.exec(first);
  if (!match) return { name: first, address: first.includes('@') ? first : '' };
  const address = (match[2] ?? '').trim();
  const name = (match[1] ?? '')
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .trim();
  return { name: name || address, address };
}

/** One or two letters for the sender's avatar. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter((w) => /\p{L}|\p{N}/u.test(w));
  const letters = words.slice(0, 2).map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, '')][0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

const AVATAR_COLORS = ['#6d4aff', '#b04fb0', '#1da583', '#415df0', '#f78400', '#ea7666'];

/** A stable avatar color for an address. */
export function avatarColor(key: string): string {
  let hash = 0;
  for (const c of key.toLowerCase()) hash = (hash * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? '#6d4aff';
}

/** The short date by the sender's name, e.g. "Wed 25 Nov, 08:02". */
export function shortDate(iso: string | null, timeZone?: string): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(date);
  return `${part({ weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')}, ${part({
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })}`;
}

/** The full date in Details, e.g. "Wed, 25 Nov 2026 08:02:11 GMT+1". */
export function fullDate(iso: string | null, timeZone?: string): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(date);
  const day = part({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(
    /^(\w+) /,
    '$1, ',
  );
  const time = part({
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
  return `${day} ${time}`;
}

/** "N external images blocked", for N > 0. */
export function blockedImages(count: number): string {
  return count === 1 ? '1 external image blocked' : `${count} external images blocked`;
}
