// SPDX-License-Identifier: AGPL-3.0-or-later
// Shell state: the current generation, the pending link, the exports main
// knows about, the settings, and which screen shows.

import { useSyncExternalStore } from 'react';
import type { DoneResult, LinkActionResult, LinkPrompt, SourceActionResult } from '../shared/api';
import type { LinkAction } from '../shared/constants';
import { DEFAULT_SETTINGS, type AppSettings, type SettingKey } from '../shared/settings';
import type { SourcesView } from '../shared/sources';

export interface ShellState {
  generation: number | null;
  /** The open link dialog. */
  link: LinkPrompt | null;
  /** Null until main has answered. */
  sources: SourcesView | null;
  /** An open, a switch or a Locate is under way. */
  busy: boolean;
  /** A short warning from the last source action. */
  notice: string | null;
  /** The defaults until main has answered. */
  settings: AppSettings;
  /** Mail, or Settings over it. */
  screen: 'mail' | 'settings';
}

let state: ShellState = {
  generation: null,
  link: null,
  sources: null,
  busy: false,
  notice: null,
  settings: { ...DEFAULT_SETTINGS },
  screen: 'mail',
};
const listeners = new Set<() => void>();

function update(patch: Partial<ShellState>): void {
  // A new generation revokes every view, so a link dialog from the old one goes.
  const moved = 'generation' in patch && patch.generation !== state.generation;
  state = { ...state, ...patch, ...(moved ? { link: null } : {}) };
  for (const listener of listeners) listener();
}

export function getShellState(): ShellState {
  return state;
}

export function useShellState(): ShellState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

export async function refreshGeneration(): Promise<number | null> {
  const result = await window.pev.state();
  update({ generation: result.ok ? result.generation : null });
  return result.ok ? result.generation : null;
}

/** Reloads the exports from main, after the generation it's at. */
export async function refreshSources(): Promise<SourcesView | null> {
  let generation = state.generation ?? (await refreshGeneration());
  for (let attempt = 0; attempt < 2 && generation !== null; attempt += 1) {
    const result = await window.pev.sources(generation);
    if (result.ok) {
      update({ generation: result.generation, sources: result.sources });
      return result.sources;
    }
    if (result.code !== 'stale_generation') return null;
    generation = await refreshGeneration();
  }
  return null;
}

/** Reads the settings from main, once at start. */
export async function loadSettings(): Promise<void> {
  let generation = state.generation ?? (await refreshGeneration());
  for (let attempt = 0; attempt < 2 && generation !== null; attempt += 1) {
    const result = await window.pev.settings(generation);
    if (result.ok) {
      update({ settings: result.view.settings });
      return;
    }
    if (result.code !== 'stale_generation') return;
    generation = await refreshGeneration();
  }
}

export function showSettings(): void {
  if (state.screen !== 'settings') update({ screen: 'settings', link: null });
}

/** Back to the mail as it was: the same folder, selection and message. */
export function showMail(): void {
  if (state.screen !== 'mail') update({ screen: 'mail' });
}

/** A reset deleted the app's data: every window goes back to the welcome screen. */
export function appWasReset(): void {
  update({ screen: 'mail', notice: null, link: null });
}

export function settingsChanged(settings: AppSettings): void {
  update({ settings });
}

/** Changes one setting; main's answer is what the shell keeps. */
export async function changeSetting<K extends SettingKey>(
  key: K,
  value: AppSettings[K],
): Promise<void> {
  const generation = state.generation ?? (await refreshGeneration());
  if (generation === null) return;
  const result = await window.pev.setSetting(key, value, generation);
  if (result.ok) update({ settings: result.settings });
  else if (result.code === 'stale_generation') await refreshGeneration();
}

const NOTICES: Partial<Record<string, string>> = {
  no_export: 'No export found',
  unavailable: 'Export not found.',
  forgotten: 'Export forgotten.',
  busy: 'Index in use. Try again.',
  app_data: "This folder is inside the app's data folder.",
};

/**
 * Runs an open, a switch, a Locate, a Forget or a Rebuild, then reloads the
 * exports. `at` is the generation the action was offered under, when it isn't
 * the shell's current one: Settings sends the one it was read under.
 */
async function sourceAction(
  run: (generation: number) => Promise<SourceActionResult>,
  at?: number,
): Promise<SourceActionResult> {
  const generation = at ?? state.generation ?? (await refreshGeneration());
  if (generation === null) return { ok: false, code: 'stale_generation' };
  update({ busy: true, notice: null, link: null });
  let result: SourceActionResult;
  try {
    result = await run(generation);
  } finally {
    update({ busy: false });
  }
  if (result.ok) {
    // The generation moved, so main has revoked the open body.
    update({ generation: result.generation, notice: NOTICES[result.outcome] ?? null });
  } else if (result.code === 'stale_generation') {
    await refreshGeneration();
  }
  await refreshSources();
  return result;
}

export const chooseFolder = () => sourceAction((g) => window.pev.chooseFolder(g));
export const openExport = (sourceKey: string) =>
  sourceAction((g) => window.pev.openExport(sourceKey, g));
export const switchRun = (runId: string) => sourceAction((g) => window.pev.switchRun(runId, g));
export const locateExport = () => sourceAction((g) => window.pev.locateExport(g));
export const forgetExport = (sourceKey: string, at?: number) =>
  sourceAction((g) => window.pev.forgetExport(sourceKey, g), at);
export const rebuildIndex = (sourceKey: string, at: number) =>
  sourceAction((g) => window.pev.rebuildIndex(sourceKey, g), at);

/**
 * Settings' recent-search actions for the export it showed, under the
 * generation it was read under: "Clear recent searches", and the "Keep
 * recent searches" switch.
 */
async function recentAction(run: () => Promise<DoneResult>): Promise<DoneResult> {
  update({ busy: true, notice: null, link: null });
  let result: DoneResult;
  try {
    result = await run();
  } catch {
    result = { ok: false, code: 'core_unavailable' };
  } finally {
    update({ busy: false });
  }
  if (!result.ok && result.code === 'stale_generation') await refreshGeneration();
  return result;
}

export const clearRecentSearches = (sourceKey: string, at: number) =>
  recentAction(() => window.pev.clearRecent(sourceKey, at));
export const setKeepRecentSearches = (sourceKey: string, keep: boolean, at: number) =>
  recentAction(() => window.pev.setKeepRecent(sourceKey, keep, at));

/** Deletes all the app's data, under the generation Settings was read under. */
export async function resetApp(at: number): Promise<DoneResult> {
  update({ busy: true, notice: null, link: null });
  let result: DoneResult;
  try {
    result = await window.pev.resetApp(at);
  } finally {
    update({ busy: false });
  }
  if (result.ok) update({ generation: result.generation, screen: 'mail' });
  else if (result.code === 'not_deleted') {
    // The reset went ahead and every window is back at the start; this one says what stayed.
    update({ screen: 'mail', notice: "Some app files couldn't be deleted." });
    await refreshGeneration();
  } else if (result.code === 'stale_generation') await refreshGeneration();
  await refreshSources();
  return result;
}

export function showLink(prompt: LinkPrompt): void {
  update({ link: prompt });
}

/** Closes the link dialog without a choice. Main refuses its choices once its view is gone. */
export function clearLink(): void {
  if (state.link !== null) update({ link: null });
}

/** Closes the link dialog and tells main the user's choice. */
export async function answerLink(action: LinkAction): Promise<LinkActionResult | null> {
  const prompt = state.link;
  if (prompt === null) return null;
  update({ link: null });
  const generation = state.generation ?? (await refreshGeneration());
  if (generation === null) return null;
  const result = await window.pev.linkAction(prompt.dialogId, action, generation);
  if (!result.ok && result.code === 'stale_generation') await refreshGeneration();
  return result;
}
