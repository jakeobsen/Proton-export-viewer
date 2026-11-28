// SPDX-License-Identifier: AGPL-3.0-or-later

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * A size in decimal units with three significant digits: "812 bytes",
 * "12.3 MB", "1.84 GB".
 */
export function byteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 bytes';
  if (bytes < 1000) return bytes === 1 ? '1 byte' : `${Math.round(bytes)} bytes`;
  let value = bytes / 1000;
  let unit = 0;
  // Rounding to three digits can carry into the next unit: 999,999 bytes is "1.00 MB".
  while (unit < UNITS.length - 1 && Number(value.toPrecision(3)) >= 1000) {
    value /= 1000;
    unit += 1;
  }
  const rounded = Number(value.toPrecision(3));
  const digits = rounded >= 100 ? 0 : rounded >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}
