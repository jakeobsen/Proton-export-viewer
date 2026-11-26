// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { exportLabel } from '../../src/renderer/labels';

describe('exportLabel', () => {
  it('shows a run folder name as the export date and time', () => {
    expect(exportLabel('mail_20261125_093210')).toBe('Export 25 Nov 2026, 09:32');
    expect(exportLabel('mail_20250101_000000')).toBe('Export 1 Jan 2025, 00:00');
  });

  it('shows any other name as it is', () => {
    expect(exportLabel('mail_backup')).toBe('mail_backup');
    expect(exportLabel('mail_20251301_000000')).toBe('mail_20251301_000000');
    expect(exportLabel('mail_20250100_000000')).toBe('mail_20250100_000000');
  });
});
