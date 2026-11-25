// SPDX-License-Identifier: AGPL-3.0-or-later
// Shell state: the current generation, the body URL main authorized, and the pending link.

import { useSyncExternalStore } from 'react';
import type { OpenResult } from '../shared/api';

export interface ShellState {
  generation: number | null;
  bodyUrl: string | null;
  frameKey: number;
  link: string | null;
}

let state: ShellState = { generation: null, bodyUrl: null, frameKey: 0, link: null };
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

export function showLink(url: string): void {
  update({ link: url });
}

export function closeLink(): void {
  update({ link: null });
}
