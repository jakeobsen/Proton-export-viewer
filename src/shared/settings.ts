// SPDX-License-Identifier: AGPL-3.0-or-later
// The app's settings, as main keeps them and the shell shows them. They hold
// no mail content.

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** How a newly opened message is shown. */
export const MESSAGE_VIEWS = ['html', 'plain'] as const;
export type MessageView = (typeof MESSAGE_VIEWS)[number];

export interface AppSettings {
  theme: Theme;
  messageView: MessageView;
}

export const SETTING_KEYS = ['theme', 'messageView'] as const satisfies ReadonlyArray<
  keyof AppSettings
>;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  theme: 'system',
  messageView: 'html',
});
