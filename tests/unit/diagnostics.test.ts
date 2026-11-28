// SPDX-License-Identifier: AGPL-3.0-or-later
// The diagnostics summary: a fixed set of fields, and only fixed codes from the logs.

import { appendFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  diagnosticsText,
  recentCodes,
  RECENT_MS,
  TAIL_BYTES,
  type DiagnosticsInput,
} from '../../src/main/diagnostics';
import { findMarkers, MARKER_TEXT, MARKERS } from '../markers';
import { testDir } from '../paths';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');

function input(patch: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appName: 'Test App',
    appVersion: '0.4.1',
    platform: 'darwin',
    osVersion: '26.1.0',
    arch: 'arm64',
    build: { mas: true, packaged: true, sandboxed: true, testHooks: false },
    exports: 2,
    indexBytes: [1_840_000_000, 12_300_000],
    codes: new Map(),
    ...patch,
  };
}

function logsDir(): string {
  const dir = join(realpathSync(testDir('diagnostics')), `l${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const line = (fields: Record<string, unknown>) => JSON.stringify(fields) + '\n';
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('diagnosticsText', () => {
  it('lists versions, the build, counts, sizes and codes, and nothing else', () => {
    const text = diagnosticsText(
      input({
        codes: new Map([
          ['core.worker_error', 3],
          ['ipc.rejected', 1],
        ]),
      }),
    );
    expect(text).toBe(
      [
        'Test App 0.4.1',
        'macOS 26.1.0 (arm64)',
        'Build: App Store, sandboxed, packaged',
        'Exports: 2',
        'Index sizes: 1.84 GB, 12.3 MB',
        'Errors and warnings, last 24 h:',
        '  core.worker_error ×3',
        '  ipc.rejected ×1',
        '',
      ].join('\n'),
    );
  });

  it('says when there is nothing to list, and names a build with test hooks', () => {
    const text = diagnosticsText(
      input({
        exports: 0,
        indexBytes: [],
        build: { mas: false, packaged: false, sandboxed: false, testHooks: true },
      }),
    );
    expect(text).toContain('Build: standard, not sandboxed, not packaged, test hooks\n');
    expect(text).toContain('Exports: 0\n');
    expect(text).toContain('Index sizes: none\n');
    expect(text).toContain('Errors and warnings, last 24 h: none\n');
  });

  it('never passes through a value that is not a version, platform or arch', () => {
    const text = diagnosticsText(
      input({
        appVersion: `1.0 ${MARKERS[2]}`,
        osVersion: MARKERS[0],
        platform: MARKERS[4],
        arch: MARKERS[5],
      }),
    );
    expect(text).toContain('Test App unknown\n');
    expect(text).toContain('unknown unknown (unknown)\n');
    expect(findMarkers(text)).toEqual([]);
  });

  it('lists the 20 most frequent codes and sums the rest', () => {
    const codes = new Map<string, number>();
    for (let i = 0; i < 25; i += 1) codes.set(`code.${String(i).padStart(2, '0')}`, 100 - i);
    const lines = diagnosticsText(input({ codes })).split('\n');
    const listed = lines.filter((l) => l.startsWith('  code.'));
    expect(listed).toHaveLength(20);
    expect(listed[0]).toBe('  code.00 ×100');
    expect(listed[19]).toBe('  code.19 ×81');
    expect(lines).toContain(`  more ×${80 + 79 + 78 + 77 + 76}`);
  });
});

describe('recentCodes', () => {
  it('counts errors and warnings of the last 24 h, by fixed code only', () => {
    const dir = logsDir();
    writeFileSync(
      join(dir, 'main.jsonl'),
      line({ ts: at(1000), level: 'error', code: 'main.uncaught', data: { x: MARKER_TEXT } }) +
        line({ ts: at(2000), level: 'warn', code: 'ipc.rejected' }) +
        line({ ts: at(3000), level: 'info', code: 'app.start' }) +
        line({ ts: at(RECENT_MS + 1000), level: 'error', code: 'main.rejection' }) +
        line({ ts: new Date(NOW + 60_000).toISOString(), level: 'error', code: 'main.rejection' }),
    );
    writeFileSync(
      join(dir, 'core.jsonl'),
      line({ ts: at(5000), level: 'warn', code: 'ipc.rejected' }) +
        // A code that isn't in the list, holding mail data, counts as "other".
        line({ ts: at(5000), level: 'error', code: MARKERS[0] }) +
        line({ ts: at(5000), level: 'error', code: MARKERS[3] }) +
        line({ ts: 'yesterday', level: 'error', code: 'core.uncaught' }) +
        '{"ts":"' +
        at(10) +
        '","level":"error","code":"core.unc',
    );
    writeFileSync(join(dir, 'renderer.jsonl'), 'not json\n[1,2]\nnull\n');
    const counts = recentCodes(dir, NOW);
    expect([...counts].sort()).toEqual([
      ['ipc.rejected', 2],
      ['main.uncaught', 1],
      ['other', 2],
    ]);
    expect(findMarkers(diagnosticsText(input({ codes: counts })))).toEqual([]);
  });

  it('reads only the whole lines at the end of a long file', () => {
    const dir = logsDir();
    /** A line of exactly `length` bytes. */
    const sized = (code: string, length: number) => {
      const bare = line({ ts: at(1000), level: 'error', code, p: '' });
      return line({ ts: at(1000), level: 'error', code, p: 'x'.repeat(length - bare.length) });
    };
    // In main's file the tail starts exactly at a line: every line in it counts.
    const whole = sized('main.rejection', 128);
    expect(whole.length).toBe(128);
    appendFileSync(join(dir, 'main.jsonl'), whole.repeat(TAIL_BYTES / 128 + 100));
    // In core's file the tail starts inside a line: that one is dropped.
    const cut = sized('core.uncaught', 100);
    expect(cut.length).toBe(100);
    appendFileSync(join(dir, 'core.jsonl'), cut.repeat(Math.ceil(TAIL_BYTES / 100) + 100));
    const counts = recentCodes(dir, NOW);
    expect(counts.get('main.rejection')).toBe(TAIL_BYTES / 128);
    expect(counts.get('core.uncaught')).toBe(Math.floor(TAIL_BYTES / 100));
  });

  it('never follows a link and reads nothing but the three live files', () => {
    const dir = logsDir();
    const elsewhere = join(dir, 'elsewhere.jsonl');
    writeFileSync(elsewhere, line({ ts: at(1000), level: 'error', code: 'main.uncaught' }));
    symlinkSync(elsewhere, join(dir, 'main.jsonl'));
    writeFileSync(
      join(dir, 'main.1.jsonl'),
      line({ ts: at(1000), level: 'error', code: 'main.uncaught' }),
    );
    expect(recentCodes(dir, NOW).size).toBe(0);
  });

  it('gives nothing for a missing folder', () => {
    expect(recentCodes(join(logsDir(), 'missing'), NOW).size).toBe(0);
  });
});
