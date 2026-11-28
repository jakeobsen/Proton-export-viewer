// SPDX-License-Identifier: AGPL-3.0-or-later
// The Theme setting. Electron's theme source sets `prefers-color-scheme` in
// every frame, the body frame included, so the shell's styles and a
// message's own dark-mode rules follow the setting as they follow the system.

import type { Theme } from '../shared/settings';
import type { SettingsStore } from './settings';

/** Where the theme takes effect: Electron's `nativeTheme` in the app. */
export interface ThemeTarget {
  themeSource: Theme;
}

/**
 * Applies the stored theme now, before any window is made, and again after
 * every change of the settings, a reset to the defaults included.
 */
export function followTheme(settings: SettingsStore, target: ThemeTarget): () => void {
  const apply = (theme: Theme) => {
    if (target.themeSource !== theme) target.themeSource = theme;
  };
  apply(settings.get().theme);
  return settings.onChange((next) => apply(next.theme));
}
