// SPDX-License-Identifier: AGPL-3.0-or-later
// The settings file: defaults, how each field is checked, and how it's written.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/shared/log/writer';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { parseSettings, SETTINGS_FILE, SettingsStore } from '../../src/main/settings';
import { findMarkers, MARKERS } from '../markers';
import { testDir } from '../paths';

function logSpy() {
  const lines: Array<{ code: string; data: unknown }> = [];
  const push = (code: string, data?: unknown) => lines.push({ code, data });
  const log: Logger = { log: (_l, c, d) => push(c, d), error: push, warn: push, info: push };
  return { log, lines };
}

let n = 0;
function userData(): string {
  n += 1;
  const dir = join(realpathSync(testDir('settings')), `u${n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('parseSettings', () => {
  it('keeps valid fields, resets invalid ones and drops unknown keys', () => {
    expect(parseSettings({ theme: 'dark', messageView: 'plain' })).toEqual({
      settings: { theme: 'dark', messageView: 'plain' },
      reset: 0,
    });
    expect(parseSettings({ theme: 'dark', extra: 1, __proto__x: 'y' })).toEqual({
      settings: { theme: 'dark', messageView: 'html' },
      reset: 0,
    });
    expect(parseSettings({ theme: 'blue', messageView: 'plain' })).toEqual({
      settings: { theme: 'system', messageView: 'plain' },
      reset: 1,
    });
    expect(parseSettings({ theme: 'light', messageView: 7 })).toEqual({
      settings: { theme: 'light', messageView: 'html' },
      reset: 1,
    });
  });

  it('gives the defaults for anything but an object', () => {
    for (const input of [null, 3, 'dark', [], ['theme']]) {
      expect(parseSettings(input).settings).toEqual(DEFAULT_SETTINGS);
      expect(parseSettings(input).reset).toBe(2);
    }
  });

  it('never reads an inherited key', () => {
    const input = Object.create({ theme: 'dark' }) as object;
    expect(parseSettings(input)).toEqual({ settings: DEFAULT_SETTINGS, reset: 0 });
  });
});

describe('SettingsStore', () => {
  it('starts from the defaults without a file, and writes nothing until a change', () => {
    const dir = userData();
    const { log, lines } = logSpy();
    const store = SettingsStore.load(dir, log);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(join(dir, SETTINGS_FILE))).toBe(false);
    expect(lines).toEqual([]);
  });

  it('writes settings.json 0600 in a 0700 folder, atomically, and reads it back', () => {
    const dir = join(userData(), 'nested');
    const { log } = logSpy();
    const store = SettingsStore.load(dir, log);
    expect(store.set('theme', 'dark')).toBe(true);
    expect(store.set('messageView', 'plain')).toBe(true);
    const file = join(dir, SETTINGS_FILE);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'dark', messageView: 'plain' });
    expect(SettingsStore.load(dir, log).get()).toEqual({ theme: 'dark', messageView: 'plain' });
  });

  it('refuses an unknown key or an invalid value, and changes nothing', () => {
    const dir = userData();
    const { log } = logSpy();
    const store = SettingsStore.load(dir, log);
    expect(store.set('theme', 'blue')).toBe(false);
    expect(store.set('fontSize', 12)).toBe(false);
    expect(store.set('__proto__', 'dark')).toBe(false);
    expect(store.set('messageView', ['plain'])).toBe(false);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(join(dir, SETTINGS_FILE))).toBe(false);
  });

  it('falls back to the defaults for a corrupt file, with a fixed code and no content', () => {
    const dir = userData();
    writeFileSync(join(dir, SETTINGS_FILE), `{"theme": "dark", ${JSON.stringify(MARKERS[0])}`);
    const { log, lines } = logSpy();
    expect(SettingsStore.load(dir, log).get()).toEqual(DEFAULT_SETTINGS);
    expect(lines).toEqual([{ code: 'settings.invalid', data: { reason: 'invalid', count: 2 } }]);
  });

  it('resets each invalid field on its own and logs how many', () => {
    const dir = userData();
    writeFileSync(
      join(dir, SETTINGS_FILE),
      JSON.stringify({ theme: MARKERS[1], messageView: 'plain', path: MARKERS[2] }),
    );
    const { log, lines } = logSpy();
    expect(SettingsStore.load(dir, log).get()).toEqual({ theme: 'system', messageView: 'plain' });
    expect(lines).toEqual([{ code: 'settings.invalid', data: { reason: 'invalid', count: 1 } }]);
    expect(findMarkers(JSON.stringify(lines))).toEqual([]);
  });

  it('reads only a regular file of at most 64 KiB, never through a link', () => {
    const { log, lines } = logSpy();
    const big = userData();
    writeFileSync(
      join(big, SETTINGS_FILE),
      JSON.stringify({ theme: 'dark', pad: 'x'.repeat(70_000) }),
    );
    expect(SettingsStore.load(big, log).get()).toEqual(DEFAULT_SETTINGS);
    const linked = userData();
    writeFileSync(join(linked, 'elsewhere.json'), JSON.stringify({ theme: 'dark' }));
    symlinkSync(join(linked, 'elsewhere.json'), join(linked, SETTINGS_FILE));
    expect(SettingsStore.load(linked, log).get()).toEqual(DEFAULT_SETTINGS);
    const folder = userData();
    mkdirSync(join(folder, SETTINGS_FILE));
    expect(SettingsStore.load(folder, log).get()).toEqual(DEFAULT_SETTINGS);
    expect(lines.map((l) => l.code)).toEqual([
      'settings.invalid',
      'settings.invalid',
      'settings.invalid',
    ]);
  });

  it('drops unknown keys on the next write', () => {
    const dir = userData();
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ theme: 'light', extra: 'x' }));
    const { log, lines } = logSpy();
    const store = SettingsStore.load(dir, log);
    expect(lines).toEqual([]);
    store.set('messageView', 'plain');
    expect(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), 'utf8'))).toEqual({
      theme: 'light',
      messageView: 'plain',
    });
  });

  it('replaces a leftover temporary file', () => {
    const dir = userData();
    writeFileSync(join(dir, `${SETTINGS_FILE}.tmp`), 'partial');
    const { log } = logSpy();
    const store = SettingsStore.load(dir, log);
    expect(store.set('theme', 'light')).toBe(true);
    expect(existsSync(join(dir, `${SETTINGS_FILE}.tmp`))).toBe(false);
    expect(SettingsStore.load(dir, log).get().theme).toBe('light');
  });

  it('keeps a change for this run when the write fails, and logs it', () => {
    const dir = userData();
    // A folder where the file should go makes the rename fail.
    mkdirSync(join(dir, SETTINGS_FILE));
    writeFileSync(join(dir, SETTINGS_FILE, 'keep'), '');
    const { log, lines } = logSpy();
    const store = SettingsStore.load(dir, log);
    expect(store.set('theme', 'dark')).toBe(true);
    expect(store.get().theme).toBe('dark');
    // Read as unusable at start, then the write fails too.
    expect(lines.map((l) => l.code)).toEqual(['settings.invalid', 'settings.write_failed']);
  });

  it('goes back to the defaults in memory on clear', () => {
    const dir = userData();
    const { log } = logSpy();
    const store = SettingsStore.load(dir, log);
    store.set('theme', 'dark');
    store.clear();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    // The file is left to the reset that deleted it.
    expect(existsSync(join(dir, SETTINGS_FILE))).toBe(true);
  });
});
