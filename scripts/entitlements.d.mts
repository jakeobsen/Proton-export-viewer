// SPDX-License-Identifier: AGPL-3.0-or-later
export type Entitlements = Record<string, boolean | string[]>;
export type SandboxFlavor =
  'mas-selftest' | 'mas-release' | 'mas-local' | 'mas-folderproof' | 'mas-fetcherproof';
export const APP_ID: string;
export const LOCAL_APP_ID: string;
export const APP_ENTITLEMENTS: Entitlements;
export const LOCAL_APP_ENTITLEMENTS: Entitlements;
export const APP_ENTITLEMENTS_OF: Record<SandboxFlavor, Entitlements>;
export const PROOF_FLAVORS: SandboxFlavor[];
export const HELPER_ENTITLEMENTS: Entitlements;
export const APP_PLIST: string;
export const LOCAL_APP_PLIST: string;
export const HELPER_PLIST: string;
export const APP_PLIST_OF: Record<SandboxFlavor, string>;
export function connectsOut(flavor: SandboxFlavor): boolean;
