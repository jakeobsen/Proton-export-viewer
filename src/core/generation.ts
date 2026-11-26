// SPDX-License-Identifier: AGPL-3.0-or-later
// Source generations in core. Every piece of async work is stamped with the
// source and generation it was started for. The writer applies a result only
// while that stamp is still current, so nothing from before an open or a
// switch can land afterwards.

import { sameStamp, type Stamp } from '../shared/sources';

export { sameStamp, type Stamp };

export class GenerationGate {
  private stamp: Stamp | null = null;

  /** The stamp new work is started with; null while no source is open. */
  get current(): Stamp | null {
    return this.stamp;
  }

  set(stamp: Stamp | null): void {
    this.stamp = stamp ? { ...stamp } : null;
  }

  isCurrent(stamp: Stamp): boolean {
    return sameStamp(this.stamp, stamp);
  }
}

/**
 * Applies results in the order they arrive, and drops each one whose stamp is
 * no longer current.
 */
export class Writer<T> {
  dropped = 0;

  constructor(
    private readonly gate: GenerationGate,
    private readonly apply: (item: T, stamp: Stamp) => void,
  ) {}

  /** Applies the item; false when it was dropped as stale. */
  submit(stamp: Stamp, item: T): boolean {
    if (!this.gate.isCurrent(stamp)) {
      this.dropped += 1;
      return false;
    }
    this.apply(item, stamp);
    return true;
  }
}
