// SPDX-License-Identifier: AGPL-3.0-or-later
export interface MachOKind {
  filetype: number;
  executable: boolean;
}
export function machOKind(read: (offset: number, length: number) => Buffer): MachOKind | null;
export function bundleContents(app: string): {
  bundles: string[];
  machO: Array<{ path: string } & MachOKind>;
};
