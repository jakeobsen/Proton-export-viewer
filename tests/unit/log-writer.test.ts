// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LogWriter } from '../../src/shared/log/writer';
import { MARKER_TEXT, findMarkers } from '../markers';
import { testDir } from '../paths';

describe('LogWriter', () => {
  it('writes JSONL with private permissions', () => {
    const dir = join(testDir('log-writer'), 'logs');
    const log = new LogWriter(dir, 'main', 'main');
    log.info('app.start', { appVersion: '1.2.3', platform: 'darwin' });
    log.info('test.log', { subject: MARKER_TEXT });
    const lines = readFileSync(join(dir, 'main.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '{}');
    expect(Object.keys(first)).toEqual(['ts', 'level', 'proc', 'code', 'corr', 'src', 'data']);
    expect(first.code).toBe('app.start');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'main.jsonl')).mode & 0o777).toBe(0o600);
    expect(findMarkers(readFileSync(join(dir, 'main.jsonl'), 'utf8'))).toEqual([]);
  });

  it('rotates through a fixed number of files', () => {
    const dir = join(testDir('log-rotate'), 'logs');
    mkdirSync(dir, { recursive: true });
    const log = new LogWriter(dir, 'core', 'core', { maxBytes: 400, maxFiles: 5 });
    for (let i = 0; i < 100; i += 1) log.info('core.ready');
    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      'core.1.jsonl',
      'core.2.jsonl',
      'core.3.jsonl',
      'core.4.jsonl',
      'core.jsonl',
    ]);
    for (const file of files) {
      expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(400);
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
  });

  it('respects the minimum level', () => {
    const dir = join(testDir('log-level'), 'logs');
    const log = new LogWriter(dir, 'main', 'main', { minLevel: 'warn' });
    log.info('app.start');
    log.warn('net.blocked', { scheme: 'https' });
    const text = readFileSync(join(dir, 'main.jsonl'), 'utf8');
    expect(text).toContain('net.blocked');
    expect(text).not.toContain('app.start');
  });
});
