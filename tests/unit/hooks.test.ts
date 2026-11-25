// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the real pre-commit hook in throwaway repositories.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, testDir } from '../paths';

function repo(): string {
  const dir = join(testDir('hook-repo'), 'repo');
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'mainline');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Hook Test');
  git('config', 'commit.gpgsign', 'false');
  cpSync(join(REPO_ROOT, '.githooks'), join(dir, '.githooks'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO_ROOT, 'scripts', 'repo-rules.mjs'), join(dir, 'scripts', 'repo-rules.mjs'));
  execFileSync('node', [join(REPO_ROOT, 'scripts', 'setup-hooks.mjs')], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'test\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return dir;
}

function write(dir: string, path: string, content: string | Buffer): void {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function tryCommit(dir: string, ...addArgs: string[][]): { ok: boolean; stderr: string } {
  for (const args of addArgs) execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const result = spawnSync('git', ['commit', '-q', '-m', 'change'], { cwd: dir, encoding: 'utf8' });
  return { ok: result.status === 0, stderr: result.stderr };
}

const SIX_MB = Buffer.alloc(6 * 1024 * 1024, 0x61);

describe('pre-commit hook', () => {
  it('is activated by the setup script', () => {
    const dir = repo();
    const hooksPath = execFileSync('git', ['config', 'core.hooksPath'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(hooksPath.trim()).toBe('.githooks');
  });

  it('blocks a path under data-sample/', () => {
    const dir = repo();
    write(dir, 'data-sample/note.txt', 'x');
    const result = tryCommit(dir, ['add', '-f', 'data-sample/note.txt']);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('data-sample');
  });

  it('blocks a rename into data-sample/', () => {
    const dir = repo();
    write(dir, 'notes/a.txt', 'x');
    tryCommit(dir, ['add', 'notes/a.txt']);
    mkdirSync(join(dir, 'data-sample'), { recursive: true });
    const result = tryCommit(dir, ['mv', 'notes/a.txt', 'data-sample/a.txt']);
    expect(result.ok).toBe(false);
  });

  it('blocks a staged blob over 5 MB', () => {
    const dir = repo();
    write(dir, 'big.bin', SIX_MB);
    expect(tryCommit(dir, ['add', 'big.bin']).ok).toBe(false);
  });

  it('judges the staged blob, not the working tree', () => {
    const dir = repo();
    write(dir, 'grows.bin', SIX_MB);
    execFileSync('git', ['add', 'grows.bin'], { cwd: dir });
    write(dir, 'grows.bin', 'small now');
    expect(tryCommit(dir).ok).toBe(false);

    const dir2 = repo();
    write(dir2, 'shrinks.bin', 'small');
    execFileSync('git', ['add', 'shrinks.bin'], { cwd: dir2 });
    write(dir2, 'shrinks.bin', SIX_MB);
    expect(tryCommit(dir2).ok).toBe(true);
  });

  it('blocks .eml and .metadata.json outside fixtures/', () => {
    const dir = repo();
    write(dir, 'mail/a.eml', 'Subject: x\n\nbody\n');
    expect(tryCommit(dir, ['add', 'mail/a.eml']).ok).toBe(false);
    const dir2 = repo();
    write(dir2, 'mail/a.metadata.json', '{}');
    expect(tryCommit(dir2, ['add', 'mail/a.metadata.json']).ok).toBe(false);
  });

  it('allows .eml under fixtures/', () => {
    const dir = repo();
    write(dir, 'fixtures/synthetic/a.eml', 'Subject: x\n\nbody\n');
    expect(tryCommit(dir, ['add', 'fixtures/synthetic/a.eml']).ok).toBe(true);
  });
});
