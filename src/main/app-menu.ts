// SPDX-License-Identifier: AGPL-3.0-or-later
// The app menu. It replaces Electron's default one, which has Reload and the
// developer tools: here there's only the app menu with Settings, the standard
// Edit roles (copy and paste in text fields need them on macOS) and Window.

import { Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron';
import { IPC } from '../shared/api';
import type { AppContext } from './context';

/** The id of the "Settings…" item, as test hooks find it. */
export const SETTINGS_ITEM_ID = 'settings';

export function appMenuTemplate(
  appName: string,
  showSettings: (window: BaseWindow | undefined) => void,
): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          id: SETTINGS_ITEM_ID,
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: (_item, window) => showSettings(window),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'close' }],
    },
  ];
}

/** Tells the shell of the given app window to show Settings; any other window is ignored. */
export function showSettingsIn(ctx: AppContext, window: BaseWindow | undefined): void {
  if (!window) return;
  for (const appWin of ctx.windows.values()) {
    if (appWin.win === window && !appWin.win.isDestroyed()) {
      appWin.win.webContents.send(IPC.showSettings);
      return;
    }
  }
}

export function installAppMenu(ctx: AppContext): void {
  const template = appMenuTemplate(__PEV_APP_NAME__, (window) => showSettingsIn(ctx, window));
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
