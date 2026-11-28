// SPDX-License-Identifier: AGPL-3.0-or-later
// The source registry: where it's kept, with what permissions, and what of it
// reaches a log.

import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/shared/log/writer';
import { Registry, REGISTRY_FILE } from '../../src/main/sources/registry';
import { testDir } from '../paths';

const SHA = 'ab'.repeat(32);

function logSpy() {
  const lines: Array<{ code: string; data: unknown; meta: unknown }> = [];
  const push = (code: string, data?: unknown, meta?: unknown) => lines.push({ code, data, meta });
  const log: Logger = {
    log: (_l, c, d, m) => push(c, d, m),
    error: push,
    warn: push,
    info: push,
  };
  return { log, lines };
}

const fields = (pickId: string, rel: string, openedAt: number) => ({
  pickId,
  rel,
  runName: 'mail_20250630_120000',
  accountName: 'secret.account@example.com',
  labelsSha256: SHA,
  namesSha256: SHA,
  openedAt,
  offline: false,
});

describe('Registry', () => {
  it('writes sources.json 0600 in a 0700 folder, and reads it back', () => {
    const dir = join(realpathSync(testDir('registry')), 'userData');
    const { log } = logSpy();
    const registry = Registry.load(dir, log);
    const pick = registry.addPick('/exports/secret.account@example.com', 'Ym9va21hcms=');
    const source = registry.addSource(fields(pick.pickId, 'mail_20250630_120000', 5));
    registry.setActive(source.sourceKey);
    registry.save();

    const file = join(dir, REGISTRY_FILE);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);

    const again = Registry.load(dir, log);
    expect(again.active).toBe(source.sourceKey);
    expect(again.source(source.sourceKey)).toEqual(source);
    expect(again.pick(pick.pickId)).toEqual(pick);
  });

  it('keeps one record per picked folder and refreshes its bookmark', () => {
    const { log } = logSpy();
    const registry = Registry.load(realpathSync(testDir('registry-picks')), log);
    const first = registry.addPick('/exports/tool', 'b2xk');
    const again = registry.addPick('/exports/tool', 'bmV3');
    expect(again.pickId).toBe(first.pickId);
    expect(registry.pick(first.pickId)?.bookmark).toBe('bmV3');
    expect(registry.addPick('/exports/tool', null).bookmark).toBe('bmV3');
  });

  it('finds the most recently opened source at a place, and drops picks no source uses', () => {
    const dir = realpathSync(testDir('registry-place'));
    const { log } = logSpy();
    const registry = Registry.load(dir, log);
    const pick = registry.addPick('/exports/tool', null);
    const older = registry.addSource(fields(pick.pickId, 'acct/mail_x', 1));
    const newer = registry.addSource(fields(pick.pickId, 'acct/mail_x', 2));
    expect(registry.sourceAt(pick.pickId, 'acct/mail_x')?.sourceKey).toBe(newer.sourceKey);
    registry.removeSource(newer.sourceKey);
    registry.removeSource(older.sourceKey);
    registry.addPick('/exports/unused', null);
    registry.save();
    expect(JSON.parse(readFileSync(join(dir, REGISTRY_FILE), 'utf8'))).toEqual({
      version: 1,
      picks: [],
      sources: [],
      active: null,
    });
  });

  it('loads a file written without the recent-search fields, and keeps them once set', () => {
    const dir = realpathSync(testDir('registry-recent'));
    const { log } = logSpy();
    const registry = Registry.load(dir, log);
    const pick = registry.addPick('/exports/tool', null);
    const source = registry.addSource(fields(pick.pickId, 'acct/mail_x', 1));
    registry.save();
    // The file has neither field, as one written before them.
    const file = join(dir, REGISTRY_FILE);
    const written = JSON.parse(readFileSync(file, 'utf8')) as { sources: object[] };
    expect(Object.keys(written.sources[0]!)).not.toContain('keepRecentSearches');
    expect(Object.keys(written.sources[0]!)).not.toContain('recentWipePending');
    const loaded = Registry.load(dir, log).source(source.sourceKey);
    expect(loaded).toEqual(source);
    expect(loaded?.keepRecentSearches).toBeUndefined();
    expect(loaded?.recentWipePending).toBeUndefined();

    const again = Registry.load(dir, log);
    again.updateSource(source.sourceKey, { keepRecentSearches: false, recentWipePending: true });
    again.save();
    expect(Registry.load(dir, log).source(source.sourceKey)).toMatchObject({
      keepRecentSearches: false,
      recentWipePending: true,
    });
    // Any other field is still refused: the file starts empty.
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('"recentWipePending"', '"recentWipeOwed"'),
    );
    expect(Registry.load(dir, log).sources()).toEqual([]);
  });

  it('starts empty from an invalid file, and logs only a code', () => {
    const dir = realpathSync(testDir('registry-invalid'));
    writeFileSync(join(dir, REGISTRY_FILE), '{"version":1,"picks":[{"path":"/secret.account@x"}]');
    const { log, lines } = logSpy();
    const registry = Registry.load(dir, log);
    expect(registry.sources()).toEqual([]);
    expect(lines).toEqual([
      { code: 'sources.invalid', data: { reason: 'invalid' }, meta: undefined },
    ]);
    writeFileSync(
      join(dir, REGISTRY_FILE),
      JSON.stringify({
        version: 1,
        picks: [{ pickId: 'x', path: '/secret' }],
        sources: [],
        active: null,
      }),
    );
    expect(Registry.load(dir, log).sources()).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain('secret');
  });
});
