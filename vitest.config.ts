// SPDX-License-Identifier: AGPL-3.0-or-later
import { configDefaults, defineConfig } from 'vitest/config';
import { RemovePassedTestDirs } from './scripts/test-dirs-reporter.mjs';

export default defineConfig({
  define: {
    __PEV_TEST_HOOKS__: 'true',
    __PEV_FOLDER_PROOF__: 'false',
    __PEV_DEV__: 'false',
    __PEV_APP_NAME__: JSON.stringify('Test App'),
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
    reporters: [...configDefaults.reporters, new RemovePassedTestDirs()],
    environment: 'node',
    testTimeout: 30_000,
  },
});
