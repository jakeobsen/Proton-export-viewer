// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __PEV_TEST_HOOKS__: 'true',
    __PEV_DEV__: 'false',
    __PEV_APP_NAME__: JSON.stringify('Test App'),
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
