// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic personal-data strings pushed through every logging path. None of
// them may ever appear in a log file.

export const MARKERS = [
  'alice.marker@example.org',
  'Grüße zum Prüfbericht – Ω',
  '/Users/someone/Mail/bob@example.net/inbox.eml',
  'https://tracker.example.com/pixel?id=4242',
  'mx.marker-host.example',
  'Quarterly-Report-Final.pdf',
] as const;

export const MARKER_TEXT = MARKERS.join(' | ');

/** Every form a marker could take in a JSON log file. */
export function markerForms(marker: string): string[] {
  const escaped = JSON.stringify(marker).slice(1, -1);
  const ascii = escaped.replace(
    /[\u0080-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return [...new Set([marker, escaped, ascii])];
}

/** Returns every marker form, plus `/Users/`, found in the given text. */
export function findMarkers(text: string): string[] {
  const hits: string[] = [];
  for (const marker of MARKERS) {
    for (const form of markerForms(marker)) if (text.includes(form)) hits.push(form);
  }
  if (text.includes('/Users/')) hits.push('/Users/');
  return hits;
}
