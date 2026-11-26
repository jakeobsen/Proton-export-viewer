// SPDX-License-Identifier: AGPL-3.0-or-later
// Display text for export runs.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Export 25 Nov 2026, 09:32" for a run folder named mail_20261125_093210; other names as they are. */
export function exportLabel(runName: string): string {
  const m = /^mail_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(runName);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month || Number(m[3]) < 1 || Number(m[3]) > 31) return runName;
  return `Export ${Number(m[3])} ${month} ${m[1]}, ${m[4]}:${m[5]}`;
}
