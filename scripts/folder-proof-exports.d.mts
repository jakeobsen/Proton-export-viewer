// SPDX-License-Identifier: AGPL-3.0-or-later
export interface ExpectedExport {
  path: string;
  digest: string;
}
export function overlaps(a: string, b: string): boolean;
export function expectedExports(value: string | undefined): ExpectedExport[];
