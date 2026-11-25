// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { contentProblem } from '../../scripts/repo-rules.mjs';

// Built from pieces, so this file does not trip the rule it tests.
const off = (...parts: string[]) => parts.join('');

describe('contentProblem: the Chromium sandbox stays on', () => {
  it.each([
    off('electron . --no', '-sandbox'),
    off("app.commandLine.appendSwitch('no", "-sandbox')"),
    off('ELECTRON_DISABLE', '_SANDBOX=1 npx playwright test'),
    off('--no-zygote', '-sandbox'),
    off('--disable-setuid', '-sandbox'),
    off('--disable-seccomp-filter', '-sandbox'),
    off('--disable-gpu', '-sandbox'),
    off('webPreferences: { sandbox', ': false }'),
    off('electron.launch({ chromiumSandbox', ': false })'),
    off('{ "sandbox"', ': false }'),
    off('prefs.sandbox ', '= false;'),
  ])('rejects %s', (text) => {
    expect(contentProblem(`first line\n${text}\n`)).toMatch(/sandbox off \(line 2: /);
  });

  it.each([
    'webPreferences: { sandbox: true }',
    'electron.launch({ chromiumSandbox: true })',
    'app.enableSandbox();',
    'sandbox={BODY_IFRAME_SANDBOX}',
    "export const BODY_IFRAME_SANDBOX = 'allow-popups';",
    'com.apple.security.app-sandbox',
  ])('accepts %s', (text) => {
    expect(contentProblem(text)).toBeNull();
  });
});
