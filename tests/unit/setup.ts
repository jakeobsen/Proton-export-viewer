// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs in every unit test file. When all of a file's tests passed, the
// folders it made under test-output/ are removed; a file with a failure
// keeps them all as evidence. The unit is the file, not the test, because
// a file may share one folder between its tests (stand-in tools, a corpus
// generated once in beforeAll).

import { afterAll, beforeEach } from 'vitest';
import { removeTestDirs, takeTestDirs } from '../paths';

let failed = false;

beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    failed = true;
  });
});

// Vitest requires an object pattern as the first argument; the file's task is
// the second.
// eslint-disable-next-line no-empty-pattern
afterAll(({}, suite) => {
  const dirs = takeTestDirs();
  // A failed beforeAll fails the file's tests without running them.
  const anyFailure = (task: { result?: { state?: string }; tasks?: unknown[] }): boolean =>
    task.result?.state === 'fail' ||
    (task.tasks ?? []).some((t) => anyFailure(t as Parameters<typeof anyFailure>[0]));
  if (!failed && !anyFailure(suite)) removeTestDirs(dirs);
});
