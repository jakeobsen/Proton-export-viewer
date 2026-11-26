// SPDX-License-Identifier: AGPL-3.0-or-later
export const REPO_ROOT: string;
export const TEST_OUTPUT: string;
export const TEST_RUNS: string;
export function testOutputOf(root?: string): string;
export function removeTestOutput(root?: string): void;
export function removeOutputDir(parent: string, dir: string, root?: string): void;
