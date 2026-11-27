// SPDX-License-Identifier: AGPL-3.0-or-later
export interface LidState {
  closed: boolean;
  causesSleep: boolean;
}
export interface PowerEvent {
  at: string;
  kind: 'sleep' | 'darkwake' | 'wake';
  reason: string | null;
}
export function parseLidState(text: string): LidState | null;
export function readLidState(): LidState | null;
export function parsePowerEvents(text: string, from: Date, to: Date): PowerEvent[];
export function readPowerEvents(from: Date, to: Date): PowerEvent[];
export function slept(events: PowerEvent[]): boolean;
export function mayLaunch(lid: LidState | null): boolean;
export function stepOutcome(
  status: number | null,
  events: PowerEvent[],
): 'pass' | 'FAIL' | 'INVALID';
export function describePower(lid: LidState | null, events: PowerEvent[]): string | null;
