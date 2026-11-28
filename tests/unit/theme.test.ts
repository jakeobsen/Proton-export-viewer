// SPDX-License-Identifier: AGPL-3.0-or-later
// The Theme setting reaches Electron's theme source: at start, on every
// change, and back to the default after a reset.

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_FILE, SettingsStore } from '../../src/main/settings';
import { followTheme, type ThemeTarget } from '../../src/main/theme';
import type { Logger } from '../../src/shared/log/writer';
import type { Theme } from '../../src/shared/settings';
import { testDir } from '../paths';

const log: Logger = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

let n = 0;
function userData(): string {
  n += 1;
  const dir = join(realpathSync(testDir('theme')), `u${n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A stand-in for `nativeTheme` that records every value set. */
function target(): ThemeTarget & { sets: Theme[] } {
  let source: Theme = 'system';
  const sets: Theme[] = [];
  return {
    sets,
    get themeSource() {
      return source;
    },
    set themeSource(value: Theme) {
      sets.push(value);
      source = value;
    },
  };
}

describe('followTheme', () => {
  it('applies the stored theme at once', () => {
    const dir = userData();
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ theme: 'dark' }));
    const native = target();
    followTheme(SettingsStore.load(dir, log), native);
    expect(native.themeSource).toBe('dark');
    expect(native.sets).toEqual(['dark']);
  });

  it('leaves the system theme as it is when that is the setting', () => {
    const native = target();
    followTheme(SettingsStore.load(userData(), log), native);
    expect(native.themeSource).toBe('system');
    expect(native.sets).toEqual([]);
  });

  it('follows every change of the setting, and nothing else', () => {
    const settings = SettingsStore.load(userData(), log);
    const native = target();
    followTheme(settings, native);
    expect(settings.set('theme', 'light')).toBe(true);
    expect(native.themeSource).toBe('light');
    expect(settings.set('theme', 'dark')).toBe(true);
    expect(native.themeSource).toBe('dark');
    // Another setting, or a refused value, doesn't touch it.
    settings.set('messageView', 'plain');
    expect(settings.set('theme', 'sepia')).toBe(false);
    expect(native.sets).toEqual(['light', 'dark']);
    // The same theme again sets nothing.
    settings.set('theme', 'dark');
    expect(native.sets).toEqual(['light', 'dark']);
  });

  it('goes back to the system theme after a reset', () => {
    const settings = SettingsStore.load(userData(), log);
    const native = target();
    followTheme(settings, native);
    settings.set('theme', 'dark');
    settings.clear();
    expect(native.themeSource).toBe('system');
    expect(native.sets).toEqual(['dark', 'system']);
  });

  it('stops following once undone', () => {
    const settings = SettingsStore.load(userData(), log);
    const native = target();
    const stop = followTheme(settings, native);
    stop();
    settings.set('theme', 'dark');
    expect(native.themeSource).toBe('system');
  });
});
