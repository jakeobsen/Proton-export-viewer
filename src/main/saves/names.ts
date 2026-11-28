// SPDX-License-Identifier: AGPL-3.0-or-later
// The names a save publishes under: the attachment's cleaned name, or for a
// whole message its cleaned subject plus `.eml`; then, while a name is taken,
// the same with " (2)", " (3)"… before the extension.

import { FALLBACK_NAME, boundedName, cleanFilename } from '../../shared/filename';

/** The most characters of a subject a message file's name keeps. */
export const EML_SUBJECT_CHARS = 100;
/** The name of a message file whose subject cleans to nothing. */
export const EML_FALLBACK_NAME = 'message.eml';
/** The highest collision number tried before a save gives up. */
export const MAX_SUFFIX = 999;

/** Whether a name has nothing left once cleaning removes what it would remove at its ends. */
function cleansToNothing(raw: string): boolean {
  return (
    raw
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .replace(/^[.\-\s]+/, '')
      .replace(/[.\s]+$/, '') === ''
  );
}

/** The name a message file is saved under: its subject, cleaned and cut, plus `.eml`. */
export function emlName(subject: string): string {
  if (cleansToNothing(subject)) return EML_FALLBACK_NAME;
  const cleaned = cleanFilename(subject);
  const stem = [...cleaned]
    .slice(0, EML_SUBJECT_CHARS)
    .join('')
    .replace(/[.\s]+$/, '');
  return boundedName(`${stem === '' ? FALLBACK_NAME : stem}.eml`);
}

/** The name an attachment is saved under. */
export function attachmentName(name: string): string {
  return cleanFilename(name);
}

/** The names to try, in order: the name itself, then " (2)" up to MAX_SUFFIX. */
export function* candidates(name: string): Generator<string> {
  yield boundedName(name);
  for (let n = 2; n <= MAX_SUFFIX; n += 1) yield boundedName(name, ` (${n})`);
}
