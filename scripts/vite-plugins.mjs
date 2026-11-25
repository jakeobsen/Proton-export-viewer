// SPDX-License-Identifier: AGPL-3.0-or-later
// Build plugins shared by the main, preload and renderer builds.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

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
