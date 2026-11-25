// SPDX-License-Identifier: AGPL-3.0-or-later
export const ALLOWED_LICENSES: string[];
export function isAllowedExpression(expression: unknown, allowed?: string[]): boolean;
export function declaredLicense(pkg: Record<string, unknown>): string | null;
