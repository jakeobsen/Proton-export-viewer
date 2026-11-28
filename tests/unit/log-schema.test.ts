// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  appFrames,
  errorClassOf,
  errorData,
  sanitizeEvent,
  statusClass,
} from '../../src/shared/log/schema';
import { MARKER_TEXT, MARKERS, findMarkers } from '../markers';

const ROOTS: Array<[string, string]> = [
  ['/Applications/Proton Export Viewer.app/Contents/Resources/app.asar/out/', ''],
  ['app://shell/', 'renderer/'],
];

describe('sanitizeEvent', () => {
  it('keeps allowlisted fields with valid values', () => {
    const event = sanitizeEvent({
      level: 'info',
      proc: 'main',
      code: 'view.installed',
      data: { openId: 3, windowId: 1, reason: 'superseded', scheme: 'https' },
    });
    expect(event?.data).toEqual({ openId: 3, windowId: 1, reason: 'superseded', scheme: 'https' });
  });

  it('an HTTP status as its class only', () => {
    expect([100, 200, 204, 301, 404, 451, 599].map(statusClass)).toEqual([
      '1xx',
      '2xx',
      '2xx',
      '3xx',
      '4xx',
      '4xx',
      '5xx',
    ]);
    expect([null, 99, 600, 200.5, -1].map(statusClass)).toEqual([null, null, null, null, null]);
    const event = sanitizeEvent({
      level: 'info',
      proc: 'fetcher',
      code: 'fetcher.refused',
      data: { reason: 'status', statusClass: '4xx', ms: 3 },
    });
    expect(event?.data).toEqual({ reason: 'status', statusClass: '4xx', ms: 3 });
    const exact = sanitizeEvent({
      level: 'info',
      proc: 'fetcher',
      code: 'fetcher.refused',
      data: { statusClass: '404' },
    });
    expect(exact?.data).toEqual({ dropped: 1 });
  });

  it('drops unknown fields and invalid values, and counts them', () => {
    const event = sanitizeEvent({
      level: 'info',
      proc: 'main',
      code: 'test.log',
      data: {
        subject: MARKER_TEXT,
        path: MARKERS[2],
        reason: MARKERS[0],
        errorClass: MARKERS[5],
        scheme: MARKERS[3],
        frames: [MARKERS[4]],
        count: -1,
      },
    });
    expect(event?.data).toEqual({ dropped: 7 });
    expect(findMarkers(JSON.stringify(event))).toEqual([]);
  });

  it('logs a refused renderer kill with its window and a fixed reason only', () => {
    const event = sanitizeEvent({
      level: 'warn',
      proc: 'main',
      code: 'test.crash_refused',
      data: { windowId: 2, reason: 'invalid', pid: 0 },
    });
    expect(event?.code).toBe('test.crash_refused');
    expect(event?.data).toEqual({ windowId: 2, reason: 'invalid', dropped: 1 });
  });

  it('logs the source events with fixed reasons, counts and the opaque source key only', () => {
    const src = '01234567-89ab-cdef-0123-456789abcdef';
    const rejected = sanitizeEvent({
      level: 'info',
      proc: 'core',
      code: 'scan.rejected',
      src,
      data: { reason: 'fifo', count: 2, path: MARKERS[2] },
    });
    expect(rejected).toMatchObject({ src, data: { reason: 'fifo', count: 2, dropped: 1 } });
    for (const reason of ['symlink', 'directory', 'socket', 'device', 'too_large', 'changed']) {
      expect(
        sanitizeEvent({ level: 'info', proc: 'core', code: 'scan.rejected', data: { reason } })
          ?.data,
      ).toEqual({ reason });
    }
    const opened = sanitizeEvent({
      level: 'info',
      proc: 'main',
      code: 'source.opened',
      src: MARKERS[0],
      data: { generation: 4, account: MARKERS[0], path: MARKERS[2] },
    });
    expect(opened).toMatchObject({ src: null, data: { generation: 4, dropped: 2 } });
    expect(findMarkers(JSON.stringify(opened))).toEqual([]);
    for (const code of [
      'sources.invalid',
      'source.offline',
      'source.unavailable',
      'source.no_runs',
      'source.not_same',
      'source.stale_result',
      'scope.failed',
      'scope.released',
      'scan.done',
      'writer.stale_dropped',
    ]) {
      expect(sanitizeEvent({ level: 'info', proc: 'main', code }), code).not.toBeNull();
    }
  });

  it('rejects unknown codes, levels and processes', () => {
    expect(sanitizeEvent({ level: 'info', proc: 'main', code: MARKERS[0] })).toBeNull();
    expect(sanitizeEvent({ level: 'loud' as 'info', proc: 'main', code: 'app.start' })).toBeNull();
    expect(sanitizeEvent({ level: 'info', proc: 'gpu' as 'main', code: 'app.start' })).toBeNull();
  });

  it('keeps corr and src only when they are opaque ids', () => {
    const good = sanitizeEvent({
      level: 'info',
      proc: 'core',
      code: 'core.ready',
      corr: '0123456789abcdef',
      src: '01234567-89ab-cdef-0123-456789abcdef',
    });
    expect(good?.corr).toBe('0123456789abcdef');
    expect(good?.src).toBe('01234567-89ab-cdef-0123-456789abcdef');
    const bad = sanitizeEvent({
      level: 'info',
      proc: 'core',
      code: 'core.ready',
      corr: MARKERS[0],
      src: MARKERS[2],
    });
    expect(bad?.corr).toBeNull();
    expect(bad?.src).toBeNull();
  });
});

describe('errorData', () => {
  it('keeps the class and app frames, never the message', () => {
    const err = new TypeError(MARKER_TEXT);
    err.stack = [
      `TypeError: ${MARKER_TEXT}`,
      '    at openView (/Applications/Proton Export Viewer.app/Contents/Resources/app.asar/out/main/index.js:12:5)',
      '    at async Promise.all (index 0)',
      '    at /Users/someone/node_modules/x/y.js:1:2',
      '    at app://shell/assets/index-AbC123.js:4:99',
      `    at fake (/Users/x/${MARKERS[0]}:1:1)`,
    ].join('\n');
    const data = errorData(err, ROOTS);
    expect(data).toEqual({
      errorClass: 'TypeError',
      frames: ['main/index.js:12:5', 'renderer/assets/index-AbC123.js:4:99'],
    });
    expect(findMarkers(JSON.stringify(data))).toEqual([]);
  });

  it('keeps no frames when the stack does not start with the exact header', () => {
    const err = new Error('first');
    err.message = MARKER_TEXT;
    expect(appFrames(err, ROOTS)).toEqual([]);
  });

  it('does not trust a renamed error class', () => {
    class Custom extends Error {}
    const err = new Custom('x');
    err.name = MARKERS[0];
    expect(errorClassOf(err)).toBe('Error');
    expect(errorClassOf(MARKER_TEXT)).toBe('NonError');
    expect(errorClassOf(new RangeError('x'))).toBe('RangeError');
  });

  it('ignores message lines that look like frames', () => {
    const err = new Error(
      `x\n    at (/Applications/Proton Export Viewer.app/Contents/Resources/app.asar/out/main/${MARKERS[5]}:1:1)`,
    );
    const frames = appFrames(err, ROOTS);
    expect(frames.join(' ')).not.toContain(MARKERS[5]);
  });
});
