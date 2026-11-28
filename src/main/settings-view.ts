// SPDX-License-Identifier: AGPL-3.0-or-later
// What Settings shows, and the diagnostics summary it copies, put together
// from the app's state and its own data folder.

import { app } from 'electron';
import type { SettingsView } from '../shared/api';
import type { AppContext } from './context';
import { diagnosticsText, recentCodes } from './diagnostics';
import { accountHome, folderLocation, indexFiles } from './settings-info';

export function settingsView(ctx: AppContext): SettingsView {
  const home = accountHome();
  const active = ctx.sources.view().active;
  return {
    settings: ctx.settings.get(),
    index: active
      ? {
          sourceKey: active.sourceKey,
          account: active.account,
          runName: active.runName,
          ...indexFiles(ctx.dirs.index, active.sourceKey, home),
          keepRecentSearches: ctx.sources.keepsRecent(active.sourceKey),
        }
      : null,
    logsLocation: folderLocation(ctx.dirs.logs, home),
  };
}

export function diagnosticsSummary(ctx: AppContext): string {
  const keys = ctx.sources.sourceKeys();
  return diagnosticsText({
    appName: __PEV_APP_NAME__,
    appVersion: app.getVersion(),
    platform: process.platform,
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    build: {
      mas: process.mas === true,
      packaged: app.isPackaged,
      sandboxed: typeof process.env.APP_SANDBOX_CONTAINER_ID === 'string',
      testHooks: __PEV_TEST_HOOKS__,
    },
    exports: keys.length,
    indexBytes: keys.map((key) => indexFiles(ctx.dirs.index, key, '').bytes),
    codes: recentCodes(ctx.dirs.logs),
  });
}
