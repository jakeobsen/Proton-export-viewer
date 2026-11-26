// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs before every unit test file, in the worker. It lists each folder the
// file makes under test-output/ in the file's task metadata. The reporter in
// scripts/test-dirs-reporter.mjs, in the main process, removes them once the
// file's final result is known. A hook registered here can't decide that,
// because later hooks, the cleanups returned by beforeAll and fixture
// teardown may still fail after it ran.

import { TestRunner } from 'vitest';
import { onTestDir } from '../paths';

declare module 'vitest' {
  interface TaskMeta {
    /** The folders a test file made under test-output/runs/. */
    testDirs?: string[];
  }
}

const dirs: string[] = [];
TestRunner.getCurrentSuite().file.meta.testDirs = dirs;
onTestDir((dir) => dirs.push(dir));
