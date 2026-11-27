// SPDX-License-Identifier: AGPL-3.0-or-later
// The harness itself: an app that ends under a test is reported with how it
// ended, and with codes only from its stderr.

import { expect, launch, test } from './app';

test('an app that ends under a test is reported with its signal and stderr codes only', async () => {
  const since = new Date(Date.now() - 1000);
  const app = await launch('exit-report');
  try {
    expect(app.exited()).toBeNull();
    const pid = app.app.process().pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, 'SIGKILL');
    await expect.poll(() => app.exited()).toEqual({ code: null, signal: 'SIGKILL' });
    const report = app.closedReport(since);
    expect(report.exit).toEqual({ code: null, signal: 'SIGKILL' });
    for (const code of report.stderr.codes) {
      expect(code).toMatch(/^(VERBOSE\d|INFO|WARNING|ERROR|FATAL) [\w.-]+\(\d+\)$/);
    }
    expect(report.stderr.dropped).toBeGreaterThanOrEqual(0);
  } finally {
    await app.close();
  }
});
