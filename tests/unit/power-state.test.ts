// SPDX-License-Identifier: AGPL-3.0-or-later
// The lid and sleep state a test run checks, from ioreg's and pmset's output,
// and what a run keeps of an app's stderr.

import { describe, expect, it } from 'vitest';
import {
  describePower,
  mayLaunch,
  parseLidState,
  parsePowerEvents,
  slept,
  stepOutcome,
} from '../../scripts/power-state.mjs';
import { StderrTail, stderrCodes } from '../app-exit';

describe('the lid state', () => {
  it('reads closed and whether closing sleeps the Mac', () => {
    const ioreg = [
      '+-o AppleARMPE  <class IOService, id 0x100000123>',
      '    {',
      '      "AppleClamshellCausesSleep" = Yes',
      '      "AppleClamshellState" = Yes',
      '    }',
    ].join('\n');
    expect(parseLidState(ioreg)).toEqual({ closed: true, causesSleep: true });
    expect(parseLidState('"AppleClamshellState" = No\n"AppleClamshellCausesSleep" = No')).toEqual({
      closed: false,
      causesSleep: false,
    });
  });

  it('is unknown when either key is missing', () => {
    expect(parseLidState('')).toBeNull();
    expect(parseLidState('"AppleClamshellState" = Yes')).toBeNull();
  });
});

describe('the power events', () => {
  const log = [
    "2026-01-10 09:59:59 +0100 Sleep               \tEntering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using AC (Charge:80%) 10 secs",
    '2026-01-10 10:00:05 +0100 Assertions          \tPID 123(tool) Created PreventUserIdleSystemSleep "tool"',
    "2026-01-10 10:00:10 +0100 Sleep               \tEntering DarkWake state due to 'Clamshell Sleep':TCPKeepAlive=active Using AC (Charge:80%)",
    '2026-01-10 10:00:20 +0100 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to some.device Using AC (Charge:80%) 2 secs',
    '2026-01-10 10:00:30 +0100 Wake Requests       \t[process=tool request=Maintenance deltaSecs=7198]',
    '2026-01-10 10:00:40 +0100 Wake                \tDarkWake to FullWake from Deep Idle [CDNVA] : due to UserActivity Assertion Using AC',
    '2026-01-10 10:00:40 +0100 WakeDetails         \tDriverReason:some.reason - DriverDetails:',
    "2026-01-10 10:00:50 +0100 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:59%) 742 secs",
  ].join('\n');
  const from = new Date('2026-01-10T09:00:00Z');
  const to = new Date('2026-01-10T09:00:45Z');

  it('keeps sleeps, DarkWakes and wakes in the window, with the offset applied', () => {
    expect(parsePowerEvents(log, from, to)).toEqual([
      { at: '2026-01-10T09:00:10.000Z', kind: 'darkwake', reason: 'Clamshell Sleep' },
      { at: '2026-01-10T09:00:20.000Z', kind: 'darkwake', reason: null },
      { at: '2026-01-10T09:00:40.000Z', kind: 'wake', reason: null },
    ]);
  });

  it('keeps only the quoted reason of a sleep, never the rest of a line', () => {
    const all = parsePowerEvents(log, new Date(0), new Date('2027-01-01T00:00:00Z'));
    expect(all.map((e) => e.reason)).toEqual([
      'Idle Sleep',
      'Clamshell Sleep',
      null,
      null,
      'Clamshell Sleep',
    ]);
    expect(JSON.stringify(all)).not.toMatch(/Charge|device|UserActivity|Deep Idle/);
  });

  it('counts a sleep or a DarkWake as having slept, a wake alone not', () => {
    const events = parsePowerEvents(log, from, to);
    expect(slept(events)).toBe(true);
    expect(slept(events.filter((e) => e.kind === 'wake'))).toBe(false);
    expect(slept([])).toBe(false);
  });

  it('describes the lid and the events in one line', () => {
    expect(
      describePower({ closed: true, causesSleep: true }, parsePowerEvents(log, from, to)),
    ).toBe(
      'lid closed, no external display; darkwake (Clamshell Sleep) at 2026-01-10T09:00:10.000Z; ' +
        'darkwake at 2026-01-10T09:00:20.000Z; wake at 2026-01-10T09:00:40.000Z',
    );
    expect(describePower({ closed: false, causesSleep: false }, [])).toBe('lid open');
    expect(describePower(null, [])).toBeNull();
  });
});

describe('a step that launches the app', () => {
  it('starts unless the lid is closed with no external display', () => {
    expect(mayLaunch({ closed: true, causesSleep: true })).toBe(false);
    expect(mayLaunch({ closed: true, causesSleep: false })).toBe(true);
    expect(mayLaunch({ closed: false, causesSleep: true })).toBe(true);
    expect(mayLaunch(null)).toBe(true);
  });

  it('is invalid, not failed or passed, when the Mac slept during it', () => {
    const sleep = [{ at: '2026-01-10T09:00:10.000Z', kind: 'darkwake' as const, reason: null }];
    const wake = [{ at: '2026-01-10T09:00:40.000Z', kind: 'wake' as const, reason: null }];
    expect(stepOutcome(1, sleep)).toBe('INVALID');
    expect(stepOutcome(0, sleep)).toBe('INVALID');
    expect(stepOutcome(0, wake)).toBe('pass');
    expect(stepOutcome(1, [])).toBe('FAIL');
    expect(stepOutcome(null, [])).toBe('FAIL');
  });
});

describe("an app's stderr in a report", () => {
  it('keeps Chromium log lines by level and source position, and counts the rest', () => {
    const lines = [
      '[38477:1127/195842.857:ERROR:gpu_process_host.cc(1007)] GPU process exited unexpectedly: exit_code=15',
      '[38477:1127/195842.900:WARNING:render_frame_host_impl.cc(42)] some text with /a/path/name',
      'a line of the app that names something',
      '',
      '[1:2:3] not a Chromium line',
    ];
    expect(stderrCodes(lines)).toEqual({
      codes: ['ERROR gpu_process_host.cc(1007)', 'WARNING render_frame_host_impl.cc(42)'],
      dropped: 2,
    });
  });

  it('keeps the last lines only', () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `[1:2:1127/195842.${String(i).padStart(3, '0')}:INFO:file.cc(${i})] text`,
    );
    const { codes } = stderrCodes(lines, 3);
    expect(codes).toEqual(['INFO file.cc(47)', 'INFO file.cc(48)', 'INFO file.cc(49)']);
  });
});

describe("an app's stderr as it arrives", () => {
  const LINE = '[38477:1127/195842.857:ERROR:gpu_process_host.cc(1007)] some text';

  const tailOf = (chunks: Array<string | Buffer>, max?: number, maxLine?: number) => {
    const tail = new StderrTail(max, maxLine);
    for (const chunk of chunks) tail.push(chunk);
    return tail;
  };

  it('matches a prefix split over two chunks once its line is complete', () => {
    for (let cut = 1; cut < LINE.length; cut += 1) {
      const tail = tailOf([LINE.slice(0, cut), `${LINE.slice(cut)}\n`]);
      expect(stderrCodes(tail.lines()), String(cut)).toEqual({
        codes: ['ERROR gpu_process_host.cc(1007)'],
        dropped: 0,
      });
    }
  });

  it('never takes a chunk that starts inside a line for the start of one', () => {
    const tail = tailOf(['text before it, then ', `${LINE}\n`, 'and a line ', LINE]);
    expect(tail.lines()).toEqual([`text before it, then ${LINE}`, `and a line ${LINE}`]);
    expect(stderrCodes(tail.lines())).toEqual({ codes: [], dropped: 2 });
  });

  it('keeps the line under way, which starts a line too', () => {
    const tail = tailOf([`${LINE}\n`, LINE.slice(0, 30)]);
    expect(tail.lines()).toEqual([LINE, LINE.slice(0, 30)]);
    tail.push(`${LINE.slice(30)}\n`);
    expect(stderrCodes(tail.lines()).codes).toHaveLength(2);
  });

  it('decodes a character split over two chunks', () => {
    const bytes = Buffer.from('é\n', 'utf8');
    const tail = tailOf([bytes.subarray(0, 1), bytes.subarray(1)]);
    expect(tail.lines()).toEqual(['é']);
  });

  it('keeps at most max lines, each cut to maxLine characters, the line under way included', () => {
    const many = tailOf([Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join('')], 3);
    expect(many.lines()).toEqual(['line 7', 'line 8', 'line 9']);
    const long = tailOf([LINE, 'x'.repeat(10_000), 'y'.repeat(10_000)], 3, 100);
    expect(long.lines()).toEqual([`${LINE}${'x'.repeat(100 - LINE.length)}`]);
    long.push('\nnext');
    expect(long.lines()).toEqual([`${LINE}${'x'.repeat(100 - LINE.length)}`, 'next']);
    expect(stderrCodes(long.lines()).codes).toEqual(['ERROR gpu_process_host.cc(1007)']);
    const whole = tailOf([`${'z'.repeat(200)}\nlast\n`], 3, 100);
    expect(whole.lines()).toEqual(['z'.repeat(100), 'last']);
    const under = tailOf(
      [`${Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join('')}tail`],
      3,
    );
    expect(under.lines()).toEqual(['line 8', 'line 9', 'tail']);
  });
});
