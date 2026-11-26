// SPDX-License-Identifier: AGPL-3.0-or-later
// Build plugins shared by the main, preload and renderer builds.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** The app's display name: `productName` in package.json, the one place it is set. */
export function appName(root = process.cwd()) {
  const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).productName;
  if (typeof name !== 'string' || name.length === 0) throw new Error('package.json: productName');
  return name;
}

/** Puts the app name into index.html wherever it says %PEV_APP_NAME%. */
export function htmlAppName(name) {
  const escaped = name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return {
    name: 'pev-html-app-name',
    transformIndexHtml: (html) => html.replaceAll('%PEV_APP_NAME%', escaped),
  };
}

/** Returns the package directory for a module id inside node_modules, or null. */
export function packageDirOf(id) {
  const clean = id.replace(/^\0/, '').split('?')[0];
  const marker = `${sep}node_modules${sep}`;
  const at = clean.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = clean.slice(at + marker.length).split(sep);
  const nameParts = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  return clean.slice(0, at + marker.length) + nameParts.join(sep);
}

/**
 * Records every npm package that ends up inside the bundle, so the license
 * check covers bundled code as well as runtime dependencies.
 */
export function bundledPackages(outFile) {
  return {
    name: 'pev-bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const dirs = new Set();
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        const ids = item.moduleIds ?? Object.keys(item.modules ?? {});
        for (const id of ids) {
          const dir = packageDirOf(id);
          if (dir) dirs.add(dir);
        }
      }
      const packages = [...dirs].sort().map((dir) => {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        return { name: pkg.name, version: pkg.version, dir: relative(process.cwd(), dir) };
      });
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, JSON.stringify(packages, null, 2) + '\n');
    },
  };
}

/** Writes a package.json next to the test bundles so they can be launched unpackaged. */
export function writeAppManifest(outRoot) {
  return {
    name: 'pev-app-manifest',
    apply: 'build',
    writeBundle() {
      if (outRoot !== 'out-test') return;
      const root = JSON.parse(readFileSync('package.json', 'utf8'));
      const manifest = {
        name: root.name,
        productName: root.productName,
        version: root.version,
        license: root.license,
        type: 'module',
        main: 'main/index.js',
      };
      writeFileSync(join(outRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    },
  };
}

const SYNC_XHR_IMPL = '/jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js';
const SYNC_XHR_LOOKUP = 'const syncWorkerFile = require.resolve("./xhr-sync-worker.js");';

/**
 * jsdom looks up the file of its synchronous-XMLHttpRequest worker as soon as
 * it loads, and that file isn't part of a bundle. The app never runs scripts
 * in jsdom, so the worker is never used: the lookup becomes null, and a
 * synchronous request would fail instead. The build fails if jsdom changes
 * that line.
 */
export function withoutSyncXhrWorker() {
  return {
    name: 'pev-without-sync-xhr-worker',
    transform(code, id) {
      if (!id.split('?')[0].replaceAll('\\', '/').endsWith(SYNC_XHR_IMPL)) return null;
      if (!code.includes(SYNC_XHR_LOOKUP))
        throw new Error('jsdom: the sync XHR worker lookup changed');
      return { code: code.replace(SYNC_XHR_LOOKUP, 'const syncWorkerFile = null;'), map: null };
    },
  };
}
