// SPDX-License-Identifier: AGPL-3.0-or-later
// The settings file, <userData>/settings.json. Each known field is checked on
// its own: an invalid value goes back to its default, and a key the app
// doesn't know is dropped. It is written atomically, 0600 in a 0700 folder.

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../shared/log/writer';
import {
  DEFAULT_SETTINGS,
  MESSAGE_VIEWS,
  SETTING_KEYS,
  THEMES,
  type AppSettings,
  type SettingKey,
} from '../shared/settings';

export const SETTINGS_FILE = 'settings.json';

/** The largest settings file read; the real one is a few dozen bytes. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

/**
 * The file's text, never through a link and only from a regular file of at
 * most MAX_SETTINGS_BYTES. Null if there is none; 'invalid' for anything else.
 */
function readSettingsFile(path: string): string | null | 'invalid' {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'invalid';
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return 'invalid';
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let read = 0;
    for (;;) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
      if (read > MAX_SETTINGS_BYTES) return 'invalid';
    }
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return 'invalid';
  } finally {
    closeSync(fd);
  }
}

/** One validator per field; a value that fails it is never stored. */
const FIELDS: { [K in SettingKey]: z.ZodType<AppSettings[K]> } = {
  theme: z.enum(THEMES),
  messageView: z.enum(MESSAGE_VIEWS),
};

const KEYS: readonly SettingKey[] = SETTING_KEYS;

export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === 'string' && (KEYS as readonly string[]).includes(key);
}

/** The value if it is valid for that setting, otherwise undefined. */
export function settingValue<K extends SettingKey>(
  key: K,
  value: unknown,
): AppSettings[K] | undefined {
  const result = FIELDS[key].safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Reads settings from parsed JSON: each known field that is valid is kept,
 * every other known field takes its default, and unknown keys are dropped.
 * `reset` counts the known fields that were present but invalid.
 */
export function parseSettings(input: unknown): { settings: AppSettings; reset: number } {
  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { settings, reset: KEYS.length };
  }
  let reset = 0;
  const record = input as Record<string, unknown>;
  for (const key of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = settingValue(key, record[key]);
    if (value === undefined) reset += 1;
    else (settings as unknown as Record<string, unknown>)[key] = value;
  }
  return { settings, reset };
}

export class SettingsStore {
  private current: AppSettings;

  private constructor(
    private readonly dir: string,
    private readonly log: Logger,
    settings: AppSettings,
  ) {
    this.current = settings;
  }

  /** Loads the settings from `dir`; a missing file gives the defaults, an unusable one too, logged. */
  static load(dir: string, log: Logger): SettingsStore {
    const raw = readSettingsFile(join(dir, SETTINGS_FILE));
    if (raw === null) return new SettingsStore(dir, log, { ...DEFAULT_SETTINGS });
    let parsed: unknown;
    try {
      if (raw === 'invalid') throw new Error('not a settings file');
      parsed = JSON.parse(raw);
    } catch {
      log.warn('settings.invalid', { reason: 'invalid', count: KEYS.length });
      return new SettingsStore(dir, log, { ...DEFAULT_SETTINGS });
    }
    const { settings, reset } = parseSettings(parsed);
    if (reset > 0) log.warn('settings.invalid', { reason: 'invalid', count: reset });
    return new SettingsStore(dir, log, settings);
  }

  get file(): string {
    return join(this.dir, SETTINGS_FILE);
  }

  get(): AppSettings {
    return { ...this.current };
  }

  /**
   * Changes one setting and writes the file. False if the key or value isn't
   * valid; nothing changes then. A failed write keeps the new value for this
   * run and is logged.
   */
  set(key: unknown, value: unknown): boolean {
    if (!isSettingKey(key)) return false;
    const checked = settingValue(key, value);
    if (checked === undefined) return false;
    this.current = { ...this.current, [key]: checked };
    try {
      this.save();
    } catch {
      this.log.warn('settings.write_failed');
    }
    return true;
  }

  /** Back to the defaults, in memory only: after a reset deleted the file. */
  clear(): void {
    this.current = { ...DEFAULT_SETTINGS };
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = `${this.file}.tmp`;
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(this.current));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
