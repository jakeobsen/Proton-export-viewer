// SPDX-License-Identifier: AGPL-3.0-or-later
// Vitest reporter that removes the folders a unit test file made under
// test-output/runs/ once the file passed: its tests, its hooks, the cleanups
// its beforeAll hooks returned and its fixtures' teardown. The unit is the
// file, not the test, because a file may share one folder between its tests
// (stand-in tools, a corpus generated once in beforeAll). A file with any
// failure keeps them all as evidence.
//
// It runs in the main Vitest process, which sees each file's final result.
// The worker lists the folders in the file's task metadata, as `testDirs`
// (tests/unit/setup.ts).

import { removeOutputDir, TEST_RUNS } from './test-output.mjs';

export class RemovePassedTestDirs {
  onTestModuleEnd(testModule) {
    const state = testModule.state();
    const passed =
      (state === 'passed' || state === 'skipped') &&
      testModule.ok() &&
      testModule.errors().length === 0;
    if (!passed) return;
    for (const dir of testModule.meta().testDirs ?? []) removeOutputDir(TEST_RUNS, dir);
  }
}
