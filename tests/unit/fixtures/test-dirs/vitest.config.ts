// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the fixture files next to this config with the unit tests' setup file
// and folder reporter. Their results go to the JSON file the test names; no
// other reporter runs, so their deliberate failures print nothing.

import { defineConfig } from 'vitest/config';
import { RemovePassedTestDirs } from '../../../../scripts/test-dirs-reporter.mjs';
import { REPO_ROOT } from '../../../../scripts/test-output.mjs';

export default defineConfig({
  root: REPO_ROOT,
  test: {
    include: ['tests/unit/fixtures/test-dirs/*.fixture.ts'],
    setupFiles: ['tests/unit/setup.ts'],
    reporters: [new RemovePassedTestDirs(), 'json'],
    outputFile: process.env.PEV_FIXTURE_RESULTS,
    environment: 'node',
  },
});
