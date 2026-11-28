// SPDX-License-Identifier: AGPL-3.0-or-later
// The entitlements each sandboxed flavor's app and helpers are signed with,
// and the files they come from. Packaging signs with these files, and
// check-sandbox compares every signed executable with these sets.

export const APP_ID = 'com.example.pev';
// The local build's bundle ID is also its own app group.
export const LOCAL_APP_ID = `${APP_ID}.viewer`;

// The application group is required by Electron's Mac App Store build: Chromium
// registers the Mach service `<group>.MachPortRendezvousServer.<pid>`, and the
// sandbox only allows names prefixed by one of the app's groups. Outgoing
// connections are for the image fetcher, in every flavor.
export const APP_ENTITLEMENTS = {
  'com.apple.security.app-sandbox': true,
  'com.apple.security.application-groups': [APP_ID],
  'com.apple.security.files.bookmarks.app-scope': true,
  'com.apple.security.files.downloads.read-write': true,
  'com.apple.security.files.user-selected.read-only': true,
  'com.apple.security.network.client': true,
};
// The local build: its own app group, and no Downloads write access.
export const LOCAL_APP_ENTITLEMENTS = {
  'com.apple.security.app-sandbox': true,
  'com.apple.security.application-groups': [LOCAL_APP_ID],
  'com.apple.security.files.bookmarks.app-scope': true,
  'com.apple.security.files.user-selected.read-only': true,
  'com.apple.security.network.client': true,
};
// The folder-access proofs sign with the store set, outgoing connections
// included, so the fetcher's proof runs with the store build's entitlements.
export const APP_ENTITLEMENTS_OF = {
  'mas-selftest': APP_ENTITLEMENTS,
  'mas-release': APP_ENTITLEMENTS,
  'mas-local': LOCAL_APP_ENTITLEMENTS,
  'mas-folderproof': APP_ENTITLEMENTS,
  'mas-fetcherproof': APP_ENTITLEMENTS,
};
/** The flavors only the owner packages and runs: checked when their bundles are there. */
export const PROOF_FLAVORS = ['mas-folderproof', 'mas-fetcherproof'];
export const HELPER_ENTITLEMENTS = {
  'com.apple.security.app-sandbox': true,
  'com.apple.security.inherit': true,
};

/** The file an app is signed with, unless its flavor names another. */
export const APP_PLIST = 'build/entitlements.mas.plist';
export const LOCAL_APP_PLIST = 'build/entitlements.mas-local.plist';
/** The file every helper executable is signed with. */
export const HELPER_PLIST = 'build/entitlements.mas.inherit.plist';
export const APP_PLIST_OF = {
  'mas-selftest': APP_PLIST,
  'mas-release': APP_PLIST,
  'mas-local': LOCAL_APP_PLIST,
  'mas-folderproof': APP_PLIST,
  'mas-fetcherproof': APP_PLIST,
};

/** True when a flavor's app may make outgoing connections. */
export function connectsOut(flavor) {
  return APP_ENTITLEMENTS_OF[flavor]['com.apple.security.network.client'] === true;
}
