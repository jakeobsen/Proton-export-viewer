// SPDX-License-Identifier: AGPL-3.0-or-later
export interface ExpectedFolder {
  path: string;
  digest: string;
}
export interface ExpectedExport extends ExpectedFolder {
  account: ExpectedFolder | null;
}
export function overlaps(a: string, b: string): boolean;
export function expectedExports(value: string | undefined, count?: 1 | 2): ExpectedExport[];
