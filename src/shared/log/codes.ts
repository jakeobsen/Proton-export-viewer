// SPDX-License-Identifier: AGPL-3.0-or-later
// Every log event carries one of these fixed codes. Anything else is dropped.

export const LOG_CODES = [
  'app.start',
  'app.ready',
  'app.quit',
  'main.uncaught',
  'main.rejection',
  'core.spawn',
  'core.ready',
  'core.exit',
  'core.uncaught',
  'core.rejection',
  'core.unavailable',
  'core.worker_spawn',
  'core.worker_error',
  'core.worker_exit',
  'worker.uncaught',
  'worker.rejection',
  'renderer.uncaught',
  'renderer.rejection',
  'renderer.error',
  'renderer.gone',
  'child.gone',
  'ipc.rejected',
  'nav.denied',
  'nav.redirect_denied',
  'nav.window_open_denied',
  'nav.link_dialog',
  'nav.webview_denied',
  'net.blocked',
  'perm.denied',
  'device.denied',
  'download.cancelled',
  'protocol.not_found',
  'view.installed',
  'view.revoked',
  'open.stale',
] as const;

/** Codes that only exist in builds with test hooks. */
export const TEST_LOG_CODES = ['test.log', 'test.error', 'test.selftest'] as const;

export type LogCode = (typeof LOG_CODES)[number] | (typeof TEST_LOG_CODES)[number];

/** Codes the shell renderer may log through IPC. */
export const RENDERER_LOG_CODES: readonly string[] = [
  'renderer.uncaught',
  'renderer.rejection',
  'renderer.error',
];

export function isLogCode(code: unknown): code is LogCode {
  if (typeof code !== 'string') return false;
  if ((LOG_CODES as readonly string[]).includes(code)) return true;
  return __PEV_TEST_HOOKS__ && (TEST_LOG_CODES as readonly string[]).includes(code);
}

export function isRendererLogCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  if (RENDERER_LOG_CODES.includes(code)) return true;
  return __PEV_TEST_HOOKS__ && (TEST_LOG_CODES as readonly string[]).includes(code);
}

/** Fixed reason values. Free text never reaches a log file. */
export const REASONS = [
  'invalid',
  'unknown_window',
  'not_main_frame',
  'bad_origin',
  'stale_generation',
  'superseded',
  'unknown_stub',
  'core_unavailable',
  'not_authorized',
  'main_frame',
  'subframe',
  'scheme',
  'generation',
  'open_id',
  'bad_host',
  'bad_path',
  'unknown_token',
  'unknown_asset',
  'bad_magic',
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction',
  'window_closed',
  'replaced',
  'unknown',
] as const;

export const SCHEMES = [
  'http',
  'https',
  'ws',
  'wss',
  'ftp',
  'file',
  'data',
  'blob',
  'mailto',
  'app',
  'mail-body',
  'mail-asset',
  'devtools',
  'chrome',
  'chrome-extension',
  'other',
] as const;

export const PROCESS_TYPES = [
  'Browser',
  'Tab',
  'Utility',
  'Zygote',
  'Sandbox helper',
  'GPU',
  'Pepper Plugin',
  'Pepper Plugin Broker',
  'Unknown',
  'other',
] as const;

export const PERMISSIONS = [
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'geolocation',
  'idle-detection',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'pointerLock',
  'keyboardLock',
  'openExternal',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'window-management',
  'fileSystem',
  'hid',
  'serial',
  'usb',
  'bluetooth',
  'unknown',
  'other',
] as const;

export const DEVICES = ['hid', 'serial', 'usb', 'bluetooth', 'display-media'] as const;
