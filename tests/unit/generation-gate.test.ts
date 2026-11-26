// SPDX-License-Identifier: AGPL-3.0-or-later
// The writer in core applies a result only for the current source and generation.

import { describe, expect, it } from 'vitest';
import { GenerationGate, Writer } from '../../src/core/generation';

describe('the writer', () => {
  it('drops a result from before a switch, to another source or to another generation', () => {
    const gate = new GenerationGate();
    const applied: string[] = [];
    const writer = new Writer<string>(gate, (item) => applied.push(item));

    expect(writer.submit({ sourceKey: 'A', generation: 1 }, 'no source open')).toBe(false);
    gate.set({ sourceKey: 'A', generation: 2 });
    expect(writer.submit({ sourceKey: 'A', generation: 2 }, 'A at 2')).toBe(true);

    // A switch to another run: new source, next generation.
    gate.set({ sourceKey: 'B', generation: 3 });
    expect(writer.submit({ sourceKey: 'A', generation: 2 }, 'late A at 2')).toBe(false);
    expect(writer.submit({ sourceKey: 'A', generation: 3 }, 'A at 3')).toBe(false);
    expect(writer.submit({ sourceKey: 'B', generation: 2 }, 'B at 2')).toBe(false);
    expect(writer.submit({ sourceKey: 'B', generation: 3 }, 'B at 3')).toBe(true);

    // The same source opened again: still a new generation.
    gate.set({ sourceKey: 'B', generation: 4 });
    expect(writer.submit({ sourceKey: 'B', generation: 3 }, 'late B at 3')).toBe(false);

    expect(applied).toEqual(['A at 2', 'B at 3']);
    expect(writer.dropped).toBe(5);
  });

  it('keeps its own copy of the stamp', () => {
    const gate = new GenerationGate();
    const stamp = { sourceKey: 'A', generation: 1 };
    gate.set(stamp);
    stamp.generation = 9;
    expect(gate.current).toEqual({ sourceKey: 'A', generation: 1 });
    expect(gate.isCurrent({ sourceKey: 'A', generation: 9 })).toBe(false);
  });
});
