// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import {
  appName,
  bundledPackages,
  htmlAppName,
  withoutSyncXhrWorker,
  writeAppManifest,
} from './scripts/vite-plugins.mjs';
import { expectedExports } from './scripts/folder-proof-exports.mjs';

// PEV_TEST_HOOKS=1 compiles the test hooks in and writes to out-test/.
// Without it the hooks are removed at build time and the output goes to out/.
// PEV_FOLDER_PROOF=1 (with PEV_TEST_HOOKS=1) builds the folder-proof app into
// out-proof/: it runs the folder-access proof at launch and may show the
// system folder picker, so it is never part of the test runs. It accepts only
// the two exports named in PEV_FOLDER_PROOF_EXPORTS (see
// scripts/folder-proof-exports.mjs).
const testHooks = process.env.PEV_TEST_HOOKS === '1';
const folderProof = process.env.PEV_FOLDER_PROOF === '1';
if (folderProof && !testHooks) throw new Error('PEV_FOLDER_PROOF=1 needs PEV_TEST_HOOKS=1');
const outRoot = folderProof ? 'out-proof' : testHooks ? 'out-test' : 'out';
const proofExports = folderProof ? expectedExports(process.env.PEV_FOLDER_PROOF_EXPORTS) : [];

export default defineConfig(({ command }) => {
  const name = appName();
  const define = {
    __PEV_TEST_HOOKS__: JSON.stringify(testHooks),
    __PEV_FOLDER_PROOF__: JSON.stringify(folderProof),
    __PEV_FOLDER_PROOF_EXPORTS__: JSON.stringify(JSON.stringify(proofExports)),
    __PEV_DEV__: JSON.stringify(command === 'serve'),
    __PEV_APP_NAME__: JSON.stringify(name),
  };
  return {
    main: {
      define,
      plugins: [
        withoutSyncXhrWorker(),
        bundledPackages(resolve(outRoot, 'bundled-main.json')),
        writeAppManifest(outRoot),
      ],
      build: {
        outDir: `${outRoot}/main`,
        externalizeDeps: false,
        minify: false,
        sourcemap: false,
        rolldownOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            core: resolve('src/core/index.ts'),
            'core-worker': resolve('src/core/worker.ts'),
            'index-worker': resolve('src/core/index/thread.ts'),
            // The index bench's worker threads exist only in builds with test hooks.
            ...(testHooks ? { 'bench-worker': resolve('src/testhooks/bench/worker.ts') } : {}),
          },
        },
      },
    },
    preload: {
      define,
      plugins: [bundledPackages(resolve(outRoot, 'bundled-preload.json'))],
      build: {
        outDir: `${outRoot}/preload`,
        externalizeDeps: false,
        minify: false,
        sourcemap: false,
        rolldownOptions: {
          input: { index: resolve('src/preload/index.ts') },
          output: { format: 'cjs', entryFileNames: '[name].cjs' },
        },
      },
    },
    renderer: {
      define,
      root: resolve('src/renderer'),
      base: './',
      plugins: [
        react(),
        htmlAppName(name),
        bundledPackages(resolve(outRoot, 'bundled-renderer.json')),
      ],
      build: {
        outDir: resolve(outRoot, 'renderer'),
        emptyOutDir: true,
        sourcemap: false,
        modulePreload: { polyfill: false },
        rolldownOptions: {
          input: { index: resolve('src/renderer/index.html') },
        },
      },
    },
  };
});
