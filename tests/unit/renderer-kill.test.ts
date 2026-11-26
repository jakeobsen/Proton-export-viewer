// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { isSinglePid, killRenderer, type Kill } from '../../src/testhooks/renderer-kill';

describe('killRenderer', () => {
  // These PIDs reach a stand-in only: a real kill() with them would signal
  // this process group, or every process of the user.
  it.each([0, -1])('sends no signal to PID %d', (pid) => {
    const kill = vi.fn<Kill>();
    expect(killRenderer(pid, kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([-2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses %d, which is not one process',
    (pid) => {
      const kill = vi.fn<Kill>();
      expect(killRenderer(pid, kill)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      expect(isSinglePid(pid)).toBe(false);
    },
  );

  it('sends SIGKILL to a valid PID, once', () => {
    const kill = vi.fn<Kill>();
    expect(killRenderer(4242, kill)).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('ends a real process by its PID', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    try {
      expect(killRenderer(pid as number, (p, signal) => process.kill(p, signal))).toBe(true);
      const [code, signal] = await exited;
      expect(code).toBeNull();
      expect(signal).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
