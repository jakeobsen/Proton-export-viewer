// SPDX-License-Identifier: AGPL-3.0-or-later
export const ALLOWED_MODULES: string[];
export function specifiers(source: string): string[];
export function checkBundle(dir: string, entry?: string): { files: string[]; failures: string[] };
