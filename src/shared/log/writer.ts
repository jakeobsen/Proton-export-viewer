// SPDX-License-Identifier: AGPL-3.0-or-later
// JSONL log writer for Node-side processes. Synchronous so that events logged
// from crash handlers reach the disk before the process ends.

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_FILE_COUNT, LOG_FILE_MAX_BYTES } from '../constants';
import { sanitizeEvent, type Level, type LogInput, type Proc } from './schema';

export interface LogWriterOptions {
  maxBytes?: number;
  maxFiles?: number;
  minLevel?: Level;
}

const LEVEL_RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type LogMeta = { corr?: string; src?: string };

export interface Logger {
  log(level: Level, code: string, data?: Record<string, unknown>, meta?: LogMeta): void;
  error(code: string, data?: Record<string, unknown>, meta?: LogMeta): void;
  warn(code: string, data?: Record<string, unknown>, meta?: LogMeta): void;
  info(code: string, data?: Record<string, unknown>, meta?: LogMeta): void;
}

export class LogWriter implements Logger {
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly minLevel: Level;
  private size = -1;
  private stopped = false;

  constructor(
    private readonly dir: string,
    private readonly fileStem: string,
    private readonly proc: Proc,
    options: LogWriterOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? LOG_FILE_MAX_BYTES;
    this.maxFiles = Math.max(1, options.maxFiles ?? LOG_FILE_COUNT);
    this.minLevel = options.minLevel ?? 'info';
  }

  /** Path of file number `index`: 0 is the live file, higher numbers are older. */
  fileAt(index: number): string {
    return join(
      this.dir,
      index === 0 ? `${this.fileStem}.jsonl` : `${this.fileStem}.${index}.jsonl`,
    );
  }

  /** A writer for another process kind that shares this file, such as a worker thread. */
  forProc(proc: Proc): Logger {
    const write = (level: Level, code: string, data?: Record<string, unknown>, meta?: LogMeta) =>
      this.write({ level, proc, code, data, ...meta });
    return {
      log: write,
      error: (c, d, m) => write('error', c, d, m),
      warn: (c, d, m) => write('warn', c, d, m),
      info: (c, d, m) => write('info', c, d, m),
    };
  }

  log(level: Level, code: string, data?: Record<string, unknown>, meta?: LogMeta): void {
    this.write({ level, proc: this.proc, code, data, ...meta });
  }

  error(code: string, data?: Record<string, unknown>, meta?: LogMeta): void {
    this.log('error', code, data, meta);
  }

  warn(code: string, data?: Record<string, unknown>, meta?: LogMeta): void {
    this.log('warn', code, data, meta);
  }

  info(code: string, data?: Record<string, unknown>, meta?: LogMeta): void {
    this.log('info', code, data, meta);
  }

  /** Writes nothing from now on, so the log folder isn't made again. */
  stop(): void {
    this.stopped = true;
  }

  /** Writes again after a stop, starting a new file if the old one is gone. */
  resume(): void {
    this.stopped = false;
    this.size = -1;
  }

  write(input: LogInput): void {
    if (this.stopped) return;
    if (LEVEL_RANK[input.level] > LEVEL_RANK[this.minLevel]) return;
    const event = sanitizeEvent(input);
    if (!event) return;
    this.append(JSON.stringify(event) + '\n');
  }

  private append(line: string): void {
    try {
      this.ensureDir();
      const live = this.fileAt(0);
      if (this.size < 0) this.size = existsSync(live) ? statSync(live).size : 0;
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      const created = this.size === 0 && !existsSync(live);
      appendFileSync(live, line, { mode: 0o600 });
      if (created) chmodSync(live, 0o600);
      this.size += bytes;
    } catch {
      // Logging must never take the process down.
    }
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  /** Shifts every file one place older; renaming onto the oldest name discards it. */
  private rotate(): void {
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const from = this.fileAt(i - 1);
      if (existsSync(from)) renameSync(from, this.fileAt(i));
    }
    this.size = 0;
  }
}
