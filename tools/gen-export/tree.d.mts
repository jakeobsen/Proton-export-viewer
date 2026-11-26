// SPDX-License-Identifier: AGPL-3.0-or-later
export interface TreeEntry {
  path: string;
  full: string;
  type: 'dir' | 'file' | 'symlink' | 'fifo' | 'other';
  size: number;
  blocks: number;
  mtime: number;
}

export function walk(root: string): TreeEntry[];
export function diskBytes(root: string): number;
export function digest(root: string): string;
