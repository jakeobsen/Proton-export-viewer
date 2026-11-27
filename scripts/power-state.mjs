// SPDX-License-Identifier: AGPL-3.0-or-later
// The Mac's lid and sleep state, for test runs. With the lid closed and no
// external display, macOS sleeps (or enters DarkWake) whatever a process
// asserts, and hidden test windows can lose their pages mid-test. A run that
// crossed such a sleep says nothing about the code: it is invalid, not
// failed. Elsewhere than macOS these report nothing.

import { spawnSync } from 'node:child_process';

/**
 * The lid's state from `ioreg -r -k AppleClamshellState -d 1`: closed, and
 * whether closing it sleeps the Mac (no external display). Null when the
 * output names neither, e.g. on a Mac without a lid.
 */
export function parseLidState(text) {
  const value = (key) => {
    const match = new RegExp(`"${key}" = (Yes|No)`).exec(text);
    return match ? match[1] === 'Yes' : null;
  };
  const closed = value('AppleClamshellState');
  const causesSleep = value('AppleClamshellCausesSleep');
  if (closed === null || causesSleep === null) return null;
  return { closed, causesSleep };
}

/** The lid's state now; null off macOS or when it can't be read. */
export function readLidState() {
  if (process.platform !== 'darwin') return null;
  const run = spawnSync('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], {
    encoding: 'utf8',
  });
  return run.status === 0 ? parseLidState(run.stdout) : null;
}

const LINE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (Sleep|DarkWake|Wake) +\t(.*)$/;

/**
 * The sleep, DarkWake and wake events of `pmset -g log` output between two
 * times, oldest first. `reason` is macOS's own quoted reason for a sleep
 * (e.g. "Clamshell Sleep"), else null; nothing else of the line is kept.
 */
export function parsePowerEvents(text, from, to) {
  const events = [];
  for (const line of text.split('\n')) {
    const match = LINE.exec(line.trimEnd());
    if (!match) continue;
    const [, day, time, offsetHours, offsetMinutes, type, message] = match;
    const at = new Date(`${day}T${time}${offsetHours}:${offsetMinutes}`);
    if (Number.isNaN(at.getTime()) || at < from || at > to) continue;
    let kind;
    if (type === 'Wake') kind = 'wake';
    else if (type === 'DarkWake' || /^Entering DarkWake/.test(message)) kind = 'darkwake';
    else kind = 'sleep';
    const reason = type === 'Sleep' ? (/due to '([^']{1,40})'/.exec(message)?.[1] ?? null) : null;
    events.push({ at: at.toISOString(), kind, reason });
  }
  return events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The power events between two times; empty off macOS or when the log can't be read. */
export function readPowerEvents(from, to) {
  if (process.platform !== 'darwin') return [];
  const run = spawnSync('pmset', ['-g', 'log'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return run.status === 0 ? parsePowerEvents(run.stdout, from, to) : [];
}

/** True if the Mac slept or entered DarkWake in these events. */
export function slept(events) {
  return events.some((e) => e.kind === 'sleep' || e.kind === 'darkwake');
}

/** Whether a step that launches the app may start: not while closing the lid has slept the Mac. */
export function mayLaunch(lid) {
  return !(lid?.closed && lid.causesSleep);
}

/** A step's outcome by its exit status, unless the Mac slept during it: then it is invalid. */
export function stepOutcome(status, events) {
  if (slept(events)) return 'INVALID';
  return status === 0 ? 'pass' : 'FAIL';
}

/** One line for a run's output: the lid now and the events, or null with none of either. */
export function describePower(lid, events) {
  const parts = [];
  if (lid)
    parts.push(
      `lid ${lid.closed ? 'closed' : 'open'}${lid.causesSleep ? ', no external display' : ''}`,
    );
  for (const e of events) parts.push(`${e.kind}${e.reason ? ` (${e.reason})` : ''} at ${e.at}`);
  return parts.length > 0 ? parts.join('; ') : null;
}
