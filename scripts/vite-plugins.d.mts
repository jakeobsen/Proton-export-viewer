// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Plugin } from 'vite';

export function appName(root?: string): string;
export function htmlAppName(name: string): Plugin;
export function packageDirOf(id: string): string | null;
export function bundledPackages(outFile: string): Plugin;
export function writeAppManifest(outRoot: string): Plugin;
