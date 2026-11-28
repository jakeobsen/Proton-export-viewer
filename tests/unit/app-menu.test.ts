// SPDX-License-Identifier: AGPL-3.0-or-later
// The app menu: Settings with ⌘, and no Reload or developer tools.

import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ Menu: {} }));

const { appMenuTemplate, showSettingsIn, SETTINGS_ITEM_ID } =
  await import('../../src/main/app-menu');
const { IPC } = await import('../../src/shared/api');

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((top) => [
    top,
    ...(Array.isArray(top.submenu) ? (top.submenu as MenuItemConstructorOptions[]) : []),
  ]);
}

describe('appMenuTemplate', () => {
  it('has Settings… with ⌘, in the app menu, and it shows Settings in that window', () => {
    const shown: unknown[] = [];
    const template = appMenuTemplate('Test App', (window) => shown.push(window));
    expect(template.map((t) => t.label)).toEqual(['Test App', 'Edit', 'Window']);
    const settings = items(template).find((i) => i.id === SETTINGS_ITEM_ID)!;
    expect(settings).toMatchObject({ label: 'Settings…', accelerator: 'CmdOrCtrl+,' });
    expect((template[0]!.submenu as MenuItemConstructorOptions[]).indexOf(settings)).toBe(2);
    const window = { id: 1 };
    (settings.click as (item: unknown, window: unknown) => void)({}, window);
    expect(shown).toEqual([window]);
  });

  it('has only the standard app, edit and window roles: no reload or developer tools', () => {
    const roles = items(appMenuTemplate('Test App', () => {}))
      .map((i) => i.role)
      .filter((r) => r !== undefined);
    expect(roles).toEqual([
      'about',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'selectAll',
      'minimize',
      'zoom',
      'close',
    ]);
  });
});

describe('showSettingsIn', () => {
  const appWindow = (destroyed = false) => {
    const sent: string[] = [];
    const win = {
      isDestroyed: () => destroyed,
      webContents: { send: (channel: string) => sent.push(channel) },
    };
    return { win, sent };
  };

  it('tells only the chosen app window', () => {
    const a = appWindow();
    const b = appWindow();
    const ctx = {
      windows: new Map([
        [1, { win: a.win }],
        [2, { win: b.win }],
      ]),
    };
    showSettingsIn(ctx as never, b.win as never);
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([IPC.showSettings]);
  });

  it('ignores no window, another window and a closed one', () => {
    const a = appWindow();
    const gone = appWindow(true);
    const ctx = {
      windows: new Map([
        [1, { win: a.win }],
        [2, { win: gone.win }],
      ]),
    };
    showSettingsIn(ctx as never, undefined);
    showSettingsIn(ctx as never, { other: true } as never);
    showSettingsIn(ctx as never, gone.win as never);
    expect(a.sent).toEqual([]);
    expect(gone.sent).toEqual([]);
  });
});
