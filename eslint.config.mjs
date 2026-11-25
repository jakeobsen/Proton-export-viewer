// SPDX-License-Identifier: AGPL-3.0-or-later
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// App code may not open sockets or start processes. Only src/fetcher/ (the
// remote-image fetcher) and src/testhooks/ (test-only code) are exempt.
const NETWORK_MODULES = ['net', 'http', 'https', 'http2', 'dns', 'tls', 'dgram', 'child_process'];
const BANNED_MODULES = NETWORK_MODULES.flatMap((name) => [name, `node:${name}`]);
const MESSAGE = 'Network and process APIs are only allowed in src/fetcher/.';
const bannedSource = `/^(?:node:)?(?:${NETWORK_MODULES.join('|')})$/`;

export const networkBan = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        ...BANNED_MODULES.map((name) => ({ name, message: MESSAGE })),
        { name: 'electron', importNames: ['net'], message: MESSAGE },
      ],
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'fetch', message: MESSAGE },
    { name: 'XMLHttpRequest', message: MESSAGE },
    { name: 'WebSocket', message: MESSAGE },
    { name: 'EventSource', message: MESSAGE },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'globalThis', property: 'fetch', message: MESSAGE },
    { object: 'window', property: 'fetch', message: MESSAGE },
    { object: 'electron', property: 'net', message: MESSAGE },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: `ImportExpression[source.value=${bannedSource}]`,
      message: MESSAGE,
    },
    {
      selector: `CallExpression[callee.name='require'][arguments.0.value=${bannedSource}]`,
      message: MESSAGE,
    },
    {
      selector: `ExportAllDeclaration[source.value=${bannedSource}], ExportNamedDeclaration[source.value=${bannedSource}]`,
      message: MESSAGE,
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['out/**', 'out-test/**', 'dist/**', 'build/**', 'node_modules/**', 'test-output/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: networkBan,
  },
  {
    files: ['src/fetcher/**', 'src/testhooks/**'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/testhooks/renderer.ts'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: reactHooks.configs.recommended.rules,
  },
);
