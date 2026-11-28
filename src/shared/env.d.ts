// SPDX-License-Identifier: AGPL-3.0-or-later

/** True only in builds made with PEV_TEST_HOOKS=1. Release builds compile it to false. */
declare const __PEV_TEST_HOOKS__: boolean;

/**
 * True only in the folder-proof build (PEV_FOLDER_PROOF=1, which also turns
 * the test hooks on). It runs the folder-access proof at launch and may show
 * the system folder picker.
 */
declare const __PEV_FOLDER_PROOF__: boolean;

/**
 * The folder-proof build's accepted exports, as JSON: [{ path, digest }] with
 * each folder's physical path and manifest digest, first and second. "[]" in
 * every other build.
 */
declare const __PEV_FOLDER_PROOF_EXPORTS__: string;

/**
 * Which proof the folder-proof build runs: "folders" (the folder-access
 * proof, two exports) or "fetcher" (the fetcher's proof, one export).
 * "folders" in every other build.
 */
declare const __PEV_FOLDER_PROOF_STEP__: 'folders' | 'fetcher';

/** True only when running under the Vite dev server. */
declare const __PEV_DEV__: boolean;

/** The app's display name, from productName in package.json. */
declare const __PEV_APP_NAME__: string;
