// SPDX-License-Identifier: AGPL-3.0-or-later
// Redaction schema: only allowlisted fields with validated values reach a log file.
// Paths, addresses, subjects, URLs, host names and exception messages never pass.

import { LINK_ACTIONS } from '../constants';
import {
  CAPPED_LIST_NAMES,
  DEVICES,
  PERMISSIONS,
  PROCESS_TYPES,
  REASONS,
  SCHEMES,
  STATUS_CLASSES,
  isLogCode,
  type StatusClass,
} from './codes';

export const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type Level = (typeof LEVELS)[number];

export const PROCS = ['main', 'core', 'worker', 'renderer', 'fetcher'] as const;
export type Proc = (typeof PROCS)[number];

export interface LogInput {
  level: Level;
  proc: Proc;
  code: string;
  corr?: string | undefined;
  src?: string | undefined;
  data?: Record<string, unknown> | undefined;
}

export interface LogEvent {
  ts: string;
  level: Level;
  proc: Proc;
  code: string;
  corr: string | null;
  src: string | null;
  data: Record<string, unknown>;
}

const ERROR_CLASS_RE = /^(?:[A-Z][A-Za-z0-9]{0,40})?(?:Error|Exception)$/;
const FRAME_RE =
  /^(?:main|preload|renderer)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*:\d{1,7}:\d{1,7}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CORR_RE = /^[0-9a-f]{8,32}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,20})?$/;
const MAX_FRAMES = 12;

type Validator = (value: unknown) => boolean;

const isInt = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v);
const isCount = (v: unknown): boolean => isInt(v) && (v as number) >= 0;
const oneOf =
  (values: readonly string[]): Validator =>
  (v) =>
    typeof v === 'string' && values.includes(v);

/** The class of an HTTP status, or null for none or one out of range. */
export function statusClass(status: number | null): StatusClass | null {
  if (status === null || !Number.isInteger(status) || status < 100 || status > 599) return null;
  return STATUS_CLASSES[Math.floor(status / 100) - 1]!;
}

export const isErrorClass = (v: unknown): boolean =>
  typeof v === 'string' && (v === 'NonError' || ERROR_CLASS_RE.test(v));

export const isFrame = (v: unknown): boolean =>
  typeof v === 'string' && v.length <= 200 && FRAME_RE.test(v);

const FIELDS: Record<string, Validator> = {
  count: isCount,
  bytes: isCount,
  ms: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  rowid: isCount,
  fileId: (v) => typeof v === 'string' && UUID_RE.test(v),
  openId: isCount,
  generation: isCount,
  schemaVersion: isCount,
  windowId: isCount,
  exitCode: isInt,
  status: (v) => isInt(v) && (v as number) >= 100 && (v as number) <= 599,
  statusClass: oneOf(STATUS_CLASSES),
  reason: oneOf(REASONS),
  list: oneOf(CAPPED_LIST_NAMES),
  scheme: oneOf(SCHEMES),
  action: oneOf(LINK_ACTIONS),
  processType: oneOf(PROCESS_TYPES),
  permission: oneOf(PERMISSIONS),
  device: oneOf(DEVICES),
  errorClass: isErrorClass,
  frames: (v) => Array.isArray(v) && v.length <= MAX_FRAMES && v.every(isFrame),
  appVersion: (v) => typeof v === 'string' && VERSION_RE.test(v),
  platform: oneOf(['darwin', 'linux', 'win32']),
  arch: oneOf(['arm64', 'x64']),
};

export function isLevel(v: unknown): v is Level {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

/**
 * Validates an event against the schema. Returns null when the code, level or
 * process is not allowed; drops every data field that fails its validator.
 */
export function sanitizeEvent(input: LogInput, now: Date = new Date()): LogEvent | null {
  if (!isLevel(input.level) || !isLogCode(input.code)) return null;
  if (!(PROCS as readonly string[]).includes(input.proc)) return null;
  const data: Record<string, unknown> = {};
  let dropped = 0;
  if (input.data && typeof input.data === 'object') {
    for (const [key, value] of Object.entries(input.data)) {
      const check = Object.prototype.hasOwnProperty.call(FIELDS, key) ? FIELDS[key] : undefined;
      if (check && check(value)) {
        data[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
      } else {
        dropped += 1;
      }
    }
  }
  if (dropped > 0) data.dropped = dropped;
  return {
    ts: now.toISOString(),
    level: input.level,
    proc: input.proc,
    code: input.code,
    corr: typeof input.corr === 'string' && CORR_RE.test(input.corr) ? input.corr : null,
    src: typeof input.src === 'string' && UUID_RE.test(input.src) ? input.src : null,
    data,
  };
}

/** The class name of a thrown value, if it is one the schema accepts. */
export function errorClassOf(err: unknown): string {
  if (err instanceof Error || (typeof err === 'object' && err !== null)) {
    const ctor = (err as { constructor?: { name?: unknown } }).constructor;
    const name = typeof ctor?.name === 'string' ? ctor.name : '';
    return isErrorClass(name) ? name : 'Error';
  }
  return 'NonError';
}

/**
 * Maps a source location to an app-relative path, or null when it is not app code.
 * `roots` maps an absolute prefix to the relative prefix that replaces it.
 */
function relativeLocation(location: string, roots: ReadonlyArray<[string, string]>): string | null {
  let loc = location;
  if (loc.startsWith('file://')) {
    try {
      loc = decodeURIComponent(loc.slice('file://'.length));
    } catch {
      return null;
    }
  }
  for (const [prefix, replacement] of roots) {
    if (prefix && loc.startsWith(prefix)) {
      return replacement + loc.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Extracts app-code frames from a V8 stack without the message, function names
 * or arguments. The message is skipped by removing the exact `Name: message`
 * header; if the stack does not start with it, no frames are kept.
 */
export function appFrames(err: unknown, roots: ReadonlyArray<[string, string]>): string[] {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return [];
  const stack = err.stack;
  const name = String(err.name);
  const message = String(err.message);
  const head = message ? `${name}: ${message}` : name;
  if (!stack.startsWith(head)) return [];
  const frames: string[] = [];
  for (const line of stack.slice(head.length).split('\n')) {
    const location = frameLocation(line);
    if (!location) continue;
    const match = /^(.+):(\d+):(\d+)$/.exec(location);
    if (!match) continue;
    const rel = relativeLocation(match[1] ?? '', roots);
    if (rel) frames.push(`${rel}:${match[2]}:${match[3]}`);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.filter(isFrame);
}

/** The `file:line:col` part of one V8 stack line, or null. */
function frameLocation(line: string): string | null {
  const at = /^\s+at /.exec(line);
  if (!at) return null;
  const rest = line.slice(at[0].length);
  if (rest.endsWith(')')) {
    const open = rest.lastIndexOf(' (');
    return open >= 0 ? rest.slice(open + 2, -1) : null;
  }
  return rest;
}

/** Redacted description of a thrown value: its class and app-code frames only. */
export function errorData(
  err: unknown,
  roots: ReadonlyArray<[string, string]>,
): { errorClass: string; frames: string[] } {
  return { errorClass: errorClassOf(err), frames: appFrames(err, roots) };
}
