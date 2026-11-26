// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Reporter, TestModule } from 'vitest/node';

export class RemovePassedTestDirs implements Reporter {
  onTestModuleEnd(testModule: TestModule): void;
}
