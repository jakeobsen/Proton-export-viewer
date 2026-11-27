// SPDX-License-Identifier: AGPL-3.0-or-later
// The harness itself: when an app ends under a test, the `pev` fixture
// reports how it ended, with codes only from its stderr. The first test fails
// on purpose; the second reads what the fixture wrote once the first ended.

import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type ClosedReport } from './app';

// A Chromium log line, written in two pieces split inside its prefix, then a
// line of another kind. Only the first one's level and source position may
// reach the report.
const PROBE_TEXT = 'probe text that stays out of the report';
const PROBE_LINE = `[4242:4243:1127/120000.000001:ERROR:harness_probe.cc(42)] ${PROBE_TEXT}\n`;
const OTHER_TEXT = 'another line that stays out of the report';
const PROBE_CODE = 'ERROR harness_probe.cc(42)';

let reportPath: string | null = null;

test.describe.serial('an app that ends under a test', () => {
  test('is killed, so the test fails with the app closed', async ({ pev }) => {
    test.fail();
    reportPath = test.info().outputPath('app-closed.json');
    const write = (text: string) =>
      pev.app.evaluate((_electron, t) => {
        process.stderr.write(t);
      }, text);
    const cut = PROBE_LINE.indexOf(':ERR') + 4;
    await write(PROBE_LINE.slice(0, cut));
    await write(`${PROBE_LINE.slice(cut)}${OTHER_TEXT}\n`);
    await expect.poll(() => pev.stderrReport().codes).toContain(PROBE_CODE);

    const pid = pev.app.process().pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, 'SIGKILL');
    await expect.poll(() => pev.exited()).toEqual({ code: null, signal: 'SIGKILL' });
    // A call into the app that is gone fails the test, as a lost page would.
    await pev.main('dialogsStubbed');
  });

  test('is reported with its signal and stderr codes only', () => {
    expect(reportPath).not.toBeNull();
    expect(existsSync(reportPath!)).toBe(true);
    const text = readFileSync(reportPath!, 'utf8');
    const report = JSON.parse(text) as ClosedReport;
    expect(report.exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(report.stderr.codes).toContain(PROBE_CODE);
    for (const code of report.stderr.codes) {
      expect(code).toMatch(/^(VERBOSE\d|INFO|WARNING|ERROR|FATAL) [\w.-]+\(\d+\)$/);
    }
    expect(report.stderr.dropped).toBeGreaterThanOrEqual(1);
    expect(text).not.toContain(PROBE_TEXT);
    expect(text).not.toContain(OTHER_TEXT);
  });
});
