// SPDX-License-Identifier: AGPL-3.0-or-later
// The source registry, <userData>/sources.json: the folders you picked (path
// and security-scoped bookmark) and the export runs opened from them. It holds
// paths and account names, so it is written 0600 in a 0700 folder, and nothing
// from it reaches a log except the opaque source keys.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../../shared/log/writer';

export const REGISTRY_FILE = 'sources.json';

const Uuid = z.uuid();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const PickSchema = z
  .object({
    pickId: Uuid,
    path: z.string().min(1).max(4096),
    /** Base64 security-scoped bookmark; null where the platform has none. */
    bookmark: z.string().min(1).max(65536).nullable(),
  })
  .strict();

const SourceSchema = z
  .object({
    sourceKey: Uuid,
    pickId: Uuid,
    /** The run folder relative to the pick; '' when the pick is the run. */
    rel: z.string().max(4096),
    runName: z.string().min(1).max(255),
    accountName: z.string().min(1).max(255).nullable(),
    labelsSha256: Sha256.nullable(),
    namesSha256: Sha256,
    openedAt: z.number().int().nonnegative(),
    /** Whether the run was unavailable when it was last opened. */
    offline: z.boolean(),
    /** The identity of this source's index, written when the index is created. */
    dbUuid: Uuid.nullable().optional(),
    /** "Keep recent searches"; absent means on. */
    keepRecentSearches: z.boolean().optional(),
    /** The switch was turned off and no wipe of its recent searches has committed since. */
    recentWipePending: z.boolean().optional(),
  })
  .strict();

const FileSchema = z
  .object({
    version: z.literal(1),
    picks: z.array(PickSchema).max(1000),
    sources: z.array(SourceSchema).max(1000),
    active: Uuid.nullable(),
  })
  .strict();

export type PickRecord = z.infer<typeof PickSchema>;
export type SourceRecord = z.infer<typeof SourceSchema>;
type RegistryData = z.infer<typeof FileSchema>;

const empty = (): RegistryData => ({ version: 1, picks: [], sources: [], active: null });

export class Registry {
  private data: RegistryData;

  private constructor(
    private readonly dir: string,
    data: RegistryData,
  ) {
    this.data = data;
  }

  /** Loads the registry from `dir`; a missing or invalid file gives an empty one. */
  static load(dir: string, log: Logger): Registry {
    let raw: string;
    try {
      raw = readFileSync(join(dir, REGISTRY_FILE), 'utf8');
    } catch {
      return new Registry(dir, empty());
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn('sources.invalid', { reason: 'invalid' });
      return new Registry(dir, empty());
    }
    const result = FileSchema.safeParse(parsed);
    if (!result.success) {
      log.warn('sources.invalid', { reason: 'invalid' });
      return new Registry(dir, empty());
    }
    const data = result.data;
    // Keep only records that hang together.
    const picks = new Set(data.picks.map((p) => p.pickId));
    data.sources = data.sources.filter((s) => picks.has(s.pickId));
    if (data.active && !data.sources.some((s) => s.sourceKey === data.active)) data.active = null;
    return new Registry(dir, data);
  }

  get file(): string {
    return join(this.dir, REGISTRY_FILE);
  }

  get active(): string | null {
    return this.data.active;
  }

  /** Every source, most recently opened first. */
  sources(): SourceRecord[] {
    return [...this.data.sources].sort((a, b) => b.openedAt - a.openedAt);
  }

  source(sourceKey: string): SourceRecord | undefined {
    return this.data.sources.find((s) => s.sourceKey === sourceKey);
  }

  pick(pickId: string): PickRecord | undefined {
    return this.data.picks.find((p) => p.pickId === pickId);
  }

  pickByPath(path: string): PickRecord | undefined {
    return this.data.picks.find((p) => p.path === path);
  }

  /** The source most recently opened from this run folder of this pick, if any. */
  sourceAt(pickId: string, rel: string): SourceRecord | undefined {
    return this.sources().find((s) => s.pickId === pickId && s.rel === rel);
  }

  /** Records a pick; picking the same folder again refreshes its bookmark. */
  addPick(path: string, bookmark: string | null): PickRecord {
    const known = this.pickByPath(path);
    if (known) {
      if (bookmark) known.bookmark = bookmark;
      return known;
    }
    const pick: PickRecord = { pickId: randomUUID(), path, bookmark };
    this.data.picks.push(pick);
    return pick;
  }

  /** Adds a source under the given key, or a new random one. */
  addSource(fields: Omit<SourceRecord, 'sourceKey'> & { sourceKey?: string }): SourceRecord {
    const source: SourceRecord = { ...fields, sourceKey: fields.sourceKey ?? randomUUID() };
    this.data.sources.push(source);
    return source;
  }

  updateSource(sourceKey: string, patch: Partial<Omit<SourceRecord, 'sourceKey'>>): void {
    const source = this.source(sourceKey);
    if (source) Object.assign(source, patch);
  }

  /** Removes a source, and its pick once no source uses it. */
  removeSource(sourceKey: string): void {
    const source = this.source(sourceKey);
    if (!source) return;
    this.data.sources = this.data.sources.filter((s) => s.sourceKey !== sourceKey);
    if (this.data.active === sourceKey) this.data.active = null;
    this.prunePicks();
  }

  setActive(sourceKey: string | null): void {
    this.data.active = sourceKey && this.source(sourceKey) ? sourceKey : null;
  }

  /** Forgets every pick and source, in memory only. */
  clear(): void {
    this.data = empty();
  }

  /** Drops picks that no source uses. */
  prunePicks(): void {
    const used = new Set(this.data.sources.map((s) => s.pickId));
    this.data.picks = this.data.picks.filter((p) => used.has(p.pickId));
  }

  /** Writes the registry atomically: 0600 file in a 0700 folder. */
  save(): void {
    this.prunePicks();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = `${this.file}.tmp`;
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(this.data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
