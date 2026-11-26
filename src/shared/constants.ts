// SPDX-License-Identifier: AGPL-3.0-or-later

export const APP_SCHEME = 'app';
export const APP_HOST = 'shell';
export const APP_ORIGIN = 'app://shell';
export const SHELL_URL = 'app://shell/index.html';

export const BODY_SCHEME = 'mail-body';
export const ASSET_SCHEME = 'mail-asset';
export const VIEW_HOST = 'v';

/** Schemes the default-deny request filter lets through. Everything else is cancelled. */
export const ALLOWED_REQUEST_SCHEMES: readonly string[] = [
  'app:',
  'mail-body:',
  'mail-asset:',
  'data:',
  'blob:',
];

/** Content-Security-Policy of the application shell in production builds. */
export const SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' mail-asset:; font-src 'self'; frame-src mail-body:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** The shell CSP under the Vite dev server: adds what hot reload needs. Never used in builds. */
export function devShellCsp(): string {
  return SHELL_CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace(
    "connect-src 'none'",
    'connect-src ws://localhost:*',
  );
}

/** Content-Security-Policy sent with every message body. */
export const BODY_CSP =
  "default-src 'none'; img-src mail-asset: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors app:";

export const BODY_IFRAME_SANDBOX = 'allow-popups';

/** Link schemes that may be offered to the user for opening outside the app. */
export const LINK_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:'];

/** What the user can choose in the link dialog. */
export const LINK_ACTIONS = ['open', 'copy', 'cancel'] as const;
export type LinkAction = (typeof LINK_ACTIONS)[number];

export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_FILE_COUNT = 5;
