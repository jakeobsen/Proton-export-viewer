// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, RUNS, TEST_OUTPUT, removeTestDirs, takeTestDirs, testDir } from '../paths';

describe('test directories', () => {
  it('are listed once and removed on request', () => {
    takeTestDirs();
    const first = testDir('paths-first');
    const second = testDir('paths-second');
    expect(takeTestDirs()).toEqual([first, second]);
    expect(takeTestDirs()).toEqual([]);
    removeTestDirs([first]);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    removeTestDirs([second]);
    expect(existsSync(second)).toBe(false);
  });

  it('are removed only directly inside test-output/runs', () => {
    const inside = testDir('paths-inside');
    for (const path of [
      TEST_OUTPUT,
      RUNS,
      join(RUNS, '..', '..', 'src'),
      join(inside, '..', '..', 'runs-sibling'),
      join(inside, 'nested'),
      REPO_ROOT,
    ]) {
      expect(() => removeTestDirs([path]), path).toThrow('refusing to remove');
    }
    expect(existsSync(join(REPO_ROOT, 'src'))).toBe(true);
    expect(existsSync(inside)).toBe(true);
  });
});

interface FileResult {
  name: string;
  status: string;
}

describe('a unit test file', () => {
  it('keeps its folders unless its final result, cleanups included, is a pass', () => {
    const tag = `fixture-${process.pid}-${Date.now()}`;
    const results = join(testDir('paths-fixture-results'), 'results.json');
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
    );
    const run = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        join(REPO_ROOT, 'tests', 'unit', 'fixtures', 'test-dirs', 'vitest.config.ts'),
      ],
      {
        cwd: REPO_ROOT,
        env: { ...env, PEV_FIXTURE_TAG: tag, PEV_FIXTURE_RESULTS: results },
        encoding: 'utf8',
      },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).toBe(1);

    // Every fixture ran; only the one without a failure passed.
    const files = (JSON.parse(readFileSync(results, 'utf8')) as { testResults: FileResult[] })
      .testResults;
    expect(
      Object.fromEntries(files.map((f) => [basename(f.name, '.fixture.ts'), f.status])),
    ).toEqual({
      passes: 'passed',
      'test-fails': 'failed',
      'before-all-fails': 'failed',
      'cleanup-throws': 'failed',
      'after-all-fails': 'failed',
      'teardown-fails': 'failed',
    });

    const marker = `-${tag}-`;
    const left = readdirSync(RUNS).filter((name) => name.includes(marker));
    expect(left.map((name) => name.slice(name.indexOf(marker) + marker.length)).sort()).toEqual([
      'after-all-fails-test',
      'before-all-fails-hook',
      'cleanup-throws-hook',
      'teardown-fails-fixture',
      'test-fails-test',
    ]);
    // The failures were deliberate, so their evidence goes too.
    removeTestDirs(left.map((name) => join(RUNS, name)));
  });
});
