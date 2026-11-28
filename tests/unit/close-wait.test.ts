// SPDX-License-Identifier: AGPL-3.0-or-later
// A close that can't confirm core's exit fails, with the reason, when an
// index was open; one with no index open returns as before. Whatever main
// answers, the app is closed and the outcome recorded first.

import { describe, expect, it } from 'vitest';
import { closeAndConfirm, closeVerdict, type CloseSteps, type CloseWait } from '../e2e/close-wait';
import { AliveAfterClose, type Waited } from '../e2e/process-wait';

const NONE = { sourceOpen: false, openedAtLaunch: 0, openedAtClose: 0 };

describe('closeVerdict', () => {
  it.each(['gone', 'zombie', 'reused', 'timeout'] as const)(
    'lets a close that ended %s return, whatever was open',
    (state) => {
      expect(
        closeVerdict(state, { sourceOpen: true, openedAtLaunch: 0, openedAtClose: 1 }),
      ).toBeNull();
    },
  );

  it('fails no_core when an export was open, and lets it return when none was', () => {
    expect(closeVerdict('no_core', { ...NONE, sourceOpen: true })).toBe(
      'close_unconfirmed: no_core',
    );
    // An export opened and closed again in this launch: none open at the close.
    expect(
      closeVerdict('no_core', { sourceOpen: false, openedAtLaunch: 0, openedAtClose: 1 }),
    ).toBeNull();
    expect(closeVerdict('no_core', NONE)).toBeNull();
  });

  it("fails no_core by this launch's log when main didn't say whether an export was open", () => {
    const unknown = { sourceOpen: null, openedAtLaunch: 2, openedAtClose: 3 };
    expect(closeVerdict('no_core', unknown)).toBe('close_unconfirmed: no_core');
    expect(closeVerdict('no_core', { ...unknown, openedAtClose: 2 })).toBeNull();
  });

  it('fails no_answer when this launch opened an index, by its own log lines only', () => {
    expect(
      closeVerdict('no_answer', { sourceOpen: null, openedAtLaunch: 0, openedAtClose: 1 }),
    ).toBe('close_unconfirmed: no_answer');
    // An earlier launch with the same user data logged one; this launch didn't.
    expect(
      closeVerdict('no_answer', { sourceOpen: null, openedAtLaunch: 1, openedAtClose: 1 }),
    ).toBeNull();
    expect(closeVerdict('no_answer', NONE)).toBeNull();
  });
});

/** Close steps that record what ran, in order. */
function steps(overrides: Partial<CloseSteps> = {}) {
  const calls: string[] = [];
  const records: CloseWait[] = [];
  let opened = 0;
  const base: CloseSteps = {
    corePid: () => {
      calls.push('corePid');
      return Promise.resolve(4242);
    },
    sourceOpen: () => {
      calls.push('sourceOpen');
      return Promise.resolve(true);
    },
    startTimeOf: () => 'start',
    closeApp: () => {
      calls.push('closeApp');
      return Promise.resolve();
    },
    waitGone: (): Promise<Waited> => {
      calls.push('waitGone');
      return Promise.resolve({ ms: 12, state: 'gone' });
    },
    openedCount: () => {
      calls.push('openedCount');
      return opened;
    },
    openedAtLaunch: 0,
    record: (entry) => {
      calls.push(`record ${entry.state}`);
      records.push(entry);
    },
  };
  return {
    steps: { ...base, ...overrides },
    calls,
    records,
    /** This launch logs `index.opened` this many times before it closes. */
    open: (n: number) => {
      opened = n;
    },
  };
}

describe('closeAndConfirm', () => {
  it('waits for core and returns how it went', async () => {
    const t = steps();
    expect(await closeAndConfirm(t.steps)).toEqual({ ms: 12, state: 'gone' });
    expect(t.calls).toEqual(['corePid', 'sourceOpen', 'closeApp', 'waitGone', 'record gone']);
  });

  it('closes the app and records no_core before it fails, with an export open', async () => {
    const t = steps({ corePid: () => Promise.resolve(undefined) });
    await expect(closeAndConfirm(t.steps)).rejects.toThrow('close_unconfirmed: no_core');
    // corePid is replaced here, so it isn't listed.
    expect(t.calls).toEqual(['sourceOpen', 'closeApp', 'record no_core', 'openedCount']);
    expect(t.records).toEqual([{ state: 'no_core' }]);
  });

  it("with no pid and no answer about the export, still closes, then goes by this launch's log", async () => {
    const t = steps({
      corePid: () => Promise.resolve(undefined),
      sourceOpen: () => Promise.reject(new Error('main gone')),
    });
    t.open(1);
    await expect(closeAndConfirm(t.steps)).rejects.toThrow('close_unconfirmed: no_core');
    // The log is read after the app closed, so this launch's last line counts
    // (corePid and sourceOpen are replaced here, so they aren't listed).
    expect(t.calls).toEqual(['closeApp', 'record no_core', 'openedCount']);
    const quiet = steps({
      corePid: () => Promise.resolve(undefined),
      sourceOpen: () => Promise.reject(new Error('main gone')),
    });
    expect(await closeAndConfirm(quiet.steps)).toEqual({ state: 'no_core' });
    expect(quiet.calls).toContain('closeApp');
  });

  it("records no_answer when main doesn't answer, and fails it after an index opened in this launch", async () => {
    const gone = () => Promise.reject(new Error('main gone'));
    const t = steps({ corePid: gone, sourceOpen: gone, openedAtLaunch: 2 });
    t.open(3);
    await expect(closeAndConfirm(t.steps)).rejects.toThrow('close_unconfirmed: no_answer');
    expect(t.records).toEqual([{ state: 'no_answer' }]);
    expect(t.calls).toContain('closeApp');
    const before = steps({ corePid: gone, sourceOpen: gone, openedAtLaunch: 2 });
    before.open(2);
    expect(await closeAndConfirm(before.steps)).toEqual({ state: 'no_answer' });
  });

  it('closes even when the app is already gone', async () => {
    const t = steps({ closeApp: () => Promise.reject(new Error('closed')) });
    expect(await closeAndConfirm(t.steps)).toEqual({ ms: 12, state: 'gone' });
  });

  it('records a timeout with what it saw, and fails with the wait error', async () => {
    const t = steps({ waitGone: () => Promise.reject(new AliveAfterClose(10_001, [2, 2])) });
    await expect(closeAndConfirm(t.steps)).rejects.toThrow('core_alive_after_close: 10001');
    expect(t.records).toEqual([{ state: 'timeout', ms: 10_001, zTasks: [2, 2] }]);
  });

  it('keeps the thread counts of a Linux zombie wait in the record', async () => {
    const t = steps({
      waitGone: () => Promise.resolve({ ms: 40, state: 'zombie', zTasks: [3, 1] }),
    });
    await closeAndConfirm(t.steps);
    expect(t.records).toEqual([{ ms: 40, state: 'zombie', zTasks: [3, 1] }]);
  });
});
