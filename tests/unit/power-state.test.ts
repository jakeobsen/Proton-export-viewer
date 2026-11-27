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
import { stderrCodes } from '../app-exit';

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
