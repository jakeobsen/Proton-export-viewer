// SPDX-License-Identifier: AGPL-3.0-or-later
// Access to a picked folder: the system folder dialog, and the folder's
// security scope. In the App Sandbox, the dialog's security-scoped bookmark is
// what lets the app reach the folder again after a restart: main starts the
// scope before it spawns core, so core and its workers start with the access,
// and releases it when the source closes. Outside the sandbox the scope is a
// no-op, because the app can already read the folder.

import { app, dialog, type OpenDialogOptions } from 'electron';
import { ScopeError, type Picker, type ScopeHandle, type Scopes } from './scope';

export const systemPicker: Picker = async (win) => {
  const options: OpenDialogOptions = {
    properties: ['openDirectory'],
    securityScopedBookmarks: true,
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;
  return { path, bookmark: result.bookmarks?.[0] || null };
};

const NO_SCOPE: ScopeHandle = { release() {} };

export const systemScopes: Scopes = {
  start(bookmark) {
    if (!process.mas) return NO_SCOPE;
    if (!bookmark) throw new ScopeError('no bookmark');
    let stop: () => void;
    try {
      // Throws when the bookmark can't be resolved or is stale.
      stop = app.startAccessingSecurityScopedResource(bookmark) as () => void;
    } catch {
      throw new ScopeError('bookmark failed');
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        stop();
      },
    };
  },
};
