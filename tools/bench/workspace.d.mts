// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Stats } from 'node:fs';

export const WORKSPACE_MARK: string;
export const WORKSPACE_DIRS: string[];
export function createWorkspace(path: string, nonce: string, dirs?: string[]): string;
export function checkWorkspace(path: string, nonce: string): string;
export function checkInside(workspace: string, path: string): Stats | null;
export function checkEmptyFolder(workspace: string, path: string): void;
export function checkNewFile(workspace: string, nonce: string, file: string): string;
export function createFileFolder(path: string, nonce: string, name: string): string;
export function removeInside(workspace: string, nonce: string, path: string): boolean;
export function removeWorkspace(workspace: string, nonce: string): void;
