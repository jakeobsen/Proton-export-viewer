// SPDX-License-Identifier: AGPL-3.0-or-later
// Shell state: the current generation, the body URL main authorized, the
// pending link, and the exports main knows about.

import { useSyncExternalStore } from 'react';
import type { OpenResult, SourceActionResult } from '../shared/api';
import type { SourcesView } from '../shared/sources';

export interface ShellState {
  generation: number | null;
  bodyUrl: string | null;
  frameKey: number;
  link: string | null;
  /** Null until main has answered. */
  sources: SourcesView | null;
  /** An open, a switch or a Locate is under way. */
  busy: boolean;
  /** A short warning from the last source action. */
  notice: string | null;
}

let state: ShellState = {
  generation: null,
  bodyUrl: null,
  frameKey: 0,
  link: null,
  sources: null,
  busy: false,
  notice: null,
};
const listeners = new Set<() => void>();

function update(patch: Partial<ShellState>): void {
  state = { ...state, ...patch };
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

/** Opens a message body. The old body is cleared at once; main has already revoked it. */
export async function openMessage(id: string): Promise<OpenResult> {
  const generation = state.generation ?? (await refreshGeneration());
  update({ bodyUrl: null });
  if (generation === null) return { ok: false, code: 'stale_generation' };
  const result = await window.pev.openStub(id, generation);
  if (result.ok) {
    update({ bodyUrl: result.url, frameKey: state.frameKey + 1 });
  } else if (result.code === 'stale_generation') {
    await refreshGeneration();
  }
  return result;
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

const NOTICES: Partial<Record<string, string>> = {
  no_export: 'No export found',
  unavailable: 'Export not found.',
  forgotten: 'Export forgotten.',
  busy: 'Index in use. Try again.',
};

/** Runs an open, a switch, a Locate or a Forget, then reloads the exports. */
async function sourceAction(
  run: (generation: number) => Promise<SourceActionResult>,
): Promise<SourceActionResult> {
  const generation = state.generation ?? (await refreshGeneration());
  if (generation === null) return { ok: false, code: 'stale_generation' };
  update({ busy: true, notice: null });
  let result: SourceActionResult;
  try {
    result = await run(generation);
  } finally {
    update({ busy: false });
  }
  if (result.ok) {
    // The generation moved, so main has revoked the open body.
    update({
      generation: result.generation,
      bodyUrl: null,
      notice: NOTICES[result.outcome] ?? null,
    });
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
export const forgetExport = (sourceKey: string) =>
  sourceAction((g) => window.pev.forgetExport(sourceKey, g));

export function showLink(url: string): void {
  update({ link: url });
}

export function closeLink(): void {
  update({ link: null });
}
