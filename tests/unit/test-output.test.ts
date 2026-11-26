// SPDX-License-Identifier: AGPL-3.0-or-later
// The removal guard, on stand-in repositories under test-output/runs/.

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeOutputDir, removeTestOutput } from '../../scripts/test-output.mjs';
import { testDir } from '../paths';

/** A stand-in repository root with an empty folder outside its test-output/. */
function stage(name: string) {
  const root = testDir(`output-guard-${name}`);
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'victim'), { recursive: true });
  writeFileSync(join(outside, 'victim', 'canary'), 'keep');
  return { root, outside, canary: join(outside, 'victim', 'canary') };
}

describe('removeOutputDir', () => {
  it('removes a folder directly inside a folder of test-output/', () => {
    const { root } = stage('plain');
    const runs = join(root, 'test-output', 'runs');
    mkdirSync(join(runs, 'done', 'deep'), { recursive: true });
    writeFileSync(join(runs, 'done', 'deep', 'file'), 'x');
    removeOutputDir(runs, join(runs, 'done'), root);
    expect(existsSync(join(runs, 'done'))).toBe(false);
    expect(existsSync(runs)).toBe(true);
    expect(() => removeOutputDir(runs, join(runs, 'missing'), root)).not.toThrow();
  });

  it('works when the repository itself is reached through a link', () => {
    const { root } = stage('linked-root');
    const runs = join(root, 'test-output', 'runs');
    mkdirSync(join(runs, 'done'), { recursive: true });
    const viaLink = join(testDir('output-guard-root-link'), 'repo');
    symlinkSync(root, viaLink);
    removeOutputDir(
      join(viaLink, 'test-output', 'runs'),
      join(viaLink, 'test-output', 'runs', 'done'),
      viaLink,
    );
    expect(existsSync(join(runs, 'done'))).toBe(false);
  });

  it('refuses a folder that is not directly inside the given folder of test-output/', () => {
    const { root, outside, canary } = stage('lexical');
    const output = join(root, 'test-output');
    const runs = join(output, 'runs');
    mkdirSync(join(runs, 'a', 'b'), { recursive: true });
    for (const [parent, dir] of [
      [root, outside],
      [runs, output],
      [runs, runs],
      [runs, join(runs, 'a', 'b')],
      [runs, join(runs, '..', '..', 'outside')],
      [join(output, '..'), join(output, '..', 'outside')],
    ]) {
      expect(() => removeOutputDir(parent!, dir!, root), dir).toThrow('refusing to remove');
    }
    expect(existsSync(canary)).toBe(true);
    expect(existsSync(join(runs, 'a', 'b'))).toBe(true);
  });

  it('refuses a folder that is a link', () => {
    const { root, outside, canary } = stage('link-target');
    const runs = join(root, 'test-output', 'runs');
    mkdirSync(runs, { recursive: true });
    symlinkSync(join(outside, 'victim'), join(runs, 'victim'));
    expect(() => removeOutputDir(runs, join(runs, 'victim'), root)).toThrow('is a symbolic link');
    expect(existsSync(canary)).toBe(true);
    expect(existsSync(join(runs, 'victim'))).toBe(true);
  });

  it('refuses when runs/ is a link', () => {
    const { root, outside, canary } = stage('link-runs');
    mkdirSync(join(root, 'test-output'));
    symlinkSync(outside, join(root, 'test-output', 'runs'));
    const runs = join(root, 'test-output', 'runs');
    expect(() => removeOutputDir(runs, join(runs, 'victim'), root)).toThrow('is a symbolic link');
    expect(existsSync(canary)).toBe(true);
  });

  it('refuses when test-output/ is a link', () => {
    const { root, outside, canary } = stage('link-output');
    mkdirSync(join(outside, 'runs', 'victim'), { recursive: true });
    writeFileSync(join(outside, 'runs', 'victim', 'canary'), 'keep');
    symlinkSync(outside, join(root, 'test-output'));
    const runs = join(root, 'test-output', 'runs');
    expect(() => removeOutputDir(runs, join(runs, 'victim'), root)).toThrow('is a symbolic link');
    expect(() => removeTestOutput(root)).toThrow('is a symbolic link');
    expect(existsSync(canary)).toBe(true);
    expect(existsSync(join(outside, 'runs', 'victim', 'canary'))).toBe(true);
  });

  it('refuses when a folder on the way is a file', () => {
    const { root } = stage('file-runs');
    mkdirSync(join(root, 'test-output'));
    writeFileSync(join(root, 'test-output', 'runs'), 'not a folder');
    const runs = join(root, 'test-output', 'runs');
    expect(() => removeOutputDir(runs, join(runs, 'x'), root)).toThrow('is not a folder');
    expect(existsSync(runs)).toBe(true);
  });
});

describe('removeTestOutput', () => {
  it('removes test-output/ and accepts a missing one', () => {
    const { root, canary } = stage('all');
    mkdirSync(join(root, 'test-output', 'runs', 'x'), { recursive: true });
    removeTestOutput(root);
    expect(existsSync(join(root, 'test-output'))).toBe(false);
    expect(() => removeTestOutput(root)).not.toThrow();
    expect(existsSync(canary)).toBe(true);
  });
});
