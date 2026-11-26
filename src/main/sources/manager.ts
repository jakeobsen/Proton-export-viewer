// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens and switches export sources, one operation at a time.
//
// Folder access follows the picked folder's security scope: main starts the
// scope, then spawns core, so core and its workers start with the access. A
// switch tears the open source down (new generation, views revoked), stops
// core, releases the old scope, starts the new one and spawns core again.
// Runs found under the same pick share its scope, so a switch between them
// keeps it; core is still restarted and the generation still moves. Before any
// source is open, and while one is unavailable, core runs without a root.
//
// Every result core sends back carries the source and generation it was made
// for, and main drops any that isn't current.

import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreRequest, CoreResult } from '../../shared/core-protocol';
import type { Logger } from '../../shared/log/writer';
import {
  sameStamp,
  type ActiveExport,
  type RunIdentity,
  type ScanSummary,
  type SourceOutcome,
  type SourcesView,
  type Stamp,
} from '../../shared/sources';
import { ScopeError, type Picker, type ScopeHandle, type Scopes } from './scope';
import { discoverRuns, type FoundRun } from './discovery';
import { Registry, type PickRecord, type SourceRecord } from './registry';

/** One step of opening or closing a source, in the order it happened. */
export interface OrderStep {
  step:
    'scope.start' | 'scope.keep' | 'scope.release' | 'scope.failed' | 'core.stop' | 'core.spawn';
  pickId: string | null;
  sourceKey: string | null;
  generation: number;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** The parts of the core host the manager uses. */
export interface CoreControl {
  readonly running: boolean;
  setSource(source: (Stamp & { root: string | null }) | null): void;
  /**
   * Makes sure core runs with exactly this source: a core started with
   * another one in the meantime (by a request) is stopped first. Resolves
   * true if it had to stop one.
   */
  startWith(source: Stamp & { root: string | null }): Promise<boolean>;
  stop(): Promise<void>;
  request(call: DistributiveOmit<CoreRequest, 'reqId'>): Promise<CoreResult>;
}

export interface SourceManagerDeps {
  userData: string;
  log: Logger;
  core: CoreControl;
  /** The current generation. */
  generation(): number;
  /** Moves to the next generation and revokes every view; returns it. */
  bumpGeneration(): number;
  /** Tells the shell that the sources changed. */
  notify(): void;
  picker: Picker;
  scopes: Scopes;
  discover?: typeof discoverRuns;
  /** Test builds: receives every scope and core step. */
  record?: (step: OrderStep) => void;
  /** Test builds: holds a core result before main checks it. */
  hold?: ((next: () => void) => void) | null;
  now?: () => number;
}

interface Run extends FoundRun {
  runId: string;
}

interface Active {
  source: SourceRecord;
  pick: PickRecord;
  online: boolean;
  /** The runs of the pick, for the run picker; empty while unknown. */
  runs: Run[];
  scan: ScanSummary | null;
}

interface Target {
  pick: PickRecord;
  run: FoundRun;
  /** The source this run is believed to be; null for a run never opened. */
  known: SourceRecord | null;
  /** Check the run's identity against `known` before using it. */
  verify: boolean;
  /**
   * When the check fails: open the run found there as its own source (the
   * user picked it), or keep `known` and show it unavailable.
   */
  onMismatch: 'open' | 'offline';
  /** The pick's runs, when discovery just listed them. */
  runs?: FoundRun[];
}

/** The answer to an operation made for a generation that has moved on before it ran. */
export const STALE = 'stale_generation';
export type Stale = typeof STALE;

/**
 * Account folder names agree unless both are known and differ: a run picked by
 * its own folder has no account folder in the pick.
 */
function accountsAgree(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/** A known source and a run found on disk are the same run only if all of this matches. */
export function sameRun(source: SourceRecord, run: FoundRun, identity: RunIdentity): boolean {
  return (
    source.runName === run.runName &&
    accountsAgree(source.accountName, run.accountName) &&
    source.labelsSha256 === identity.labelsSha256 &&
    source.namesSha256 === identity.namesSha256
  );
}

export class SourceManager {
  readonly registry: Registry;
  private active: Active | null = null;
  private scope: { pickId: string; handle: ScopeHandle } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private restoring = false;
  private readonly discover: typeof discoverRuns;
  private readonly now: () => number;

  constructor(private readonly deps: SourceManagerDeps) {
    this.registry = Registry.load(deps.userData, deps.log);
    this.discover = deps.discover ?? discoverRuns;
    this.now = deps.now ?? Date.now;
  }

  /** Replaces the folder dialog and the scopes (test builds). */
  setAccess(access: {
    picker?: Picker;
    scopes?: Scopes;
    record?: (step: OrderStep) => void;
    hold?: ((next: () => void) => void) | null;
  }): void {
    if (access.picker) this.deps.picker = access.picker;
    if (access.scopes) this.deps.scopes = access.scopes;
    if (access.record) this.deps.record = access.record;
    if (access.hold !== undefined) this.deps.hold = access.hold;
  }

  /** The stamp of the open source's work, or null. */
  stamp(): Stamp | null {
    return this.active
      ? { sourceKey: this.active.source.sourceKey, generation: this.deps.generation() }
      : null;
  }

  /** The open source's last scan, when one finished for its current stamp. */
  scanSummary(): ScanSummary | null {
    return this.active?.scan ?? null;
  }

  view(): SourcesView {
    const row = (s: SourceRecord) => ({
      sourceKey: s.sourceKey,
      account: s.accountName,
      runName: s.runName,
    });
    let active: ActiveExport | null = null;
    if (this.active) {
      const current = this.active;
      active = {
        ...row(current.source),
        status: current.online ? 'online' : 'offline',
        runs: current.runs.map((r) => ({
          runId: r.runId,
          account: r.accountName,
          runName: r.runName,
          current: r.rel === current.source.rel,
        })),
      };
    }
    return { restoring: this.restoring, active, recent: this.registry.sources().map(row) };
  }

  // --- Operations (serialized) --------------------------------------------------

  /**
   * Runs operations one at a time. One made for a generation (from the shell)
   * is checked again when its turn comes: if an earlier one moved the
   * generation meanwhile, it does nothing and reports that it's stale.
   */
  private serial<T>(op: () => Promise<T>): Promise<T>;
  private serial<T>(op: () => Promise<T>, expected: number): Promise<T | Stale>;
  private serial<T>(op: () => Promise<T>, expected?: number): Promise<T | Stale> {
    const run = (): Promise<T | Stale> =>
      expected !== undefined && this.deps.generation() !== expected ? Promise.resolve(STALE) : op();
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** At launch: reopens the source that was open at quit. */
  restore(): Promise<SourceOutcome | null> {
    const key = this.registry.active;
    const source = key ? this.registry.source(key) : undefined;
    const pick = source && this.registry.pick(source.pickId);
    if (!source || !pick) return Promise.resolve(null);
    // The shell waits for it instead of showing the welcome screen first.
    this.restoring = true;
    return this.serial(async () => {
      try {
        return await this.activate({
          pick,
          run: runOf(source),
          known: source,
          verify: source.offline,
          onMismatch: 'offline',
        });
      } finally {
        this.restoring = false;
        this.deps.notify();
      }
    });
  }

  /** Shows the folder dialog and opens the newest run found in the folder. */
  chooseFolder(
    win: Electron.BrowserWindow | null,
    expected: number,
  ): Promise<SourceOutcome | Stale> {
    return this.serial(async () => {
      const picked = await this.deps.picker(win);
      if (!picked) return 'canceled';
      const found = await this.discover(picked.path);
      const newest = found.runs[0];
      if (!newest) {
        this.deps.log.info('source.no_runs');
        return 'no_export';
      }
      const known = this.registry.pickByPath(found.root);
      const pick = this.registry.addPick(found.root, picked.bookmark);
      const source = known ? (this.registry.sourceAt(known.pickId, newest.rel) ?? null) : null;
      // Picking a known run again checks that it's still the same run.
      return this.activate({
        pick,
        run: newest,
        known: source,
        verify: source !== null,
        onMismatch: 'open',
        runs: found.runs,
      });
    }, expected);
  }

  /** Opens a source from the recent list. */
  openRecent(sourceKey: string, expected: number): Promise<SourceOutcome | null | Stale> {
    return this.serial(async () => {
      const source = this.registry.source(sourceKey);
      const pick = source && this.registry.pick(source.pickId);
      if (!source || !pick) return null;
      return this.activate({
        pick,
        run: runOf(source),
        known: source,
        verify: source.offline,
        onMismatch: 'offline',
      });
    }, expected);
  }

  /** Switches to another run of the open pick. */
  switchRun(runId: string, expected: number): Promise<SourceOutcome | null | Stale> {
    return this.serial(async () => {
      const current = this.active;
      const run = current?.runs.find((r) => r.runId === runId);
      if (!current || !run) return null;
      const known = this.registry.sourceAt(current.pick.pickId, run.rel) ?? null;
      return this.activate({
        pick: current.pick,
        run,
        known,
        verify: known?.offline ?? false,
        onMismatch: 'open',
        runs: current.runs,
      });
    }, expected);
  }

  /**
   * Picks the folder of the open, unavailable source again. A run there is the
   * same source only if its names and identity all match; anything else opens
   * as a new source and leaves the old one as it is.
   */
  locate(
    win: Electron.BrowserWindow | null,
    expected: number,
  ): Promise<SourceOutcome | null | Stale> {
    return this.serial(async () => {
      const lost = this.active?.source;
      if (!lost) return null;
      const picked = await this.deps.picker(win);
      if (!picked) return 'canceled';
      const found = await this.discover(picked.path);
      if (found.runs.length === 0) {
        this.deps.log.info('source.no_runs', {}, { src: lost.sourceKey });
        return 'no_export';
      }
      const pick = this.registry.addPick(found.root, picked.bookmark);
      const candidate = found.runs.find(
        (r) => r.runName === lost.runName && accountsAgree(r.accountName, lost.accountName),
      );
      if (candidate) {
        const outcome = await this.activate({
          pick,
          run: candidate,
          known: lost,
          verify: true,
          onMismatch: 'open',
          runs: found.runs,
        });
        return outcome;
      }
      this.deps.log.info('source.not_same', { reason: 'unknown' }, { src: lost.sourceKey });
      const outcome = await this.activate({
        pick,
        run: found.runs[0]!,
        known: null,
        verify: false,
        onMismatch: 'open',
        runs: found.runs,
      });
      return outcome === 'opened' ? 'new_source' : outcome;
    }, expected);
  }

  /** At quit: releases the folder scope. */
  close(): void {
    this.releaseScope(this.deps.generation(), 'quit');
  }

  // --- Steps ------------------------------------------------------------------------

  private record(step: OrderStep['step'], fields: Partial<Omit<OrderStep, 'step'>>): void {
    this.deps.record?.({
      step,
      pickId: fields.pickId ?? null,
      sourceKey: fields.sourceKey ?? null,
      generation: fields.generation ?? this.deps.generation(),
    });
  }

  private async stopCore(generation: number): Promise<void> {
    if (!this.deps.core.running) return;
    await this.deps.core.stop();
    this.record('core.stop', { generation, sourceKey: this.active?.source.sourceKey ?? null });
  }

  /** Starts core for the source; a core some request started meanwhile with another is replaced. */
  private async spawnCore(source: Stamp & { root: string | null }, pickId: string): Promise<void> {
    const replaced = await this.deps.core.startWith(source);
    const fields = { pickId, sourceKey: source.sourceKey, generation: source.generation };
    if (replaced) this.record('core.stop', fields);
    this.record('core.spawn', fields);
  }

  private releaseScope(generation: number, reason: 'switch' | 'quit' = 'switch'): void {
    const scope = this.scope;
    if (!scope) return;
    this.scope = null;
    scope.handle.release();
    this.record('scope.release', { pickId: scope.pickId, generation });
    this.deps.log.info('scope.released', {
      generation,
      reason: reason === 'quit' ? 'quit' : 'replaced',
    });
  }

  /**
   * Opens `target` as the active source: the teardown of the old one, the
   * scope, core, and the identity check where it's needed.
   */
  private async activate(target: Target): Promise<SourceOutcome> {
    const generation = this.deps.bumpGeneration();
    await this.stopCore(generation);
    const pickId = target.pick.pickId;
    let scoped = true;
    if (this.scope?.pickId === pickId) {
      this.record('scope.keep', { pickId, generation });
    } else {
      this.releaseScope(generation);
      try {
        this.scope = { pickId, handle: this.deps.scopes.start(target.pick.bookmark) };
        this.record('scope.start', { pickId, generation });
      } catch (err) {
        if (!(err instanceof ScopeError)) throw err;
        scoped = false;
        this.record('scope.failed', { pickId, generation });
        this.deps.log.warn('scope.failed', { generation });
      }
    }
    const root = join(target.pick.path, target.run.rel);
    const online = scoped && (await isRunFolder(root));
    if (scoped && !online) this.releaseScope(generation);

    const sourceKey = target.known?.sourceKey ?? randomUUID();
    const stamp: Stamp = { sourceKey, generation };
    await this.spawnCore({ ...stamp, root: online ? root : null }, pickId);

    let source = target.known;
    if (online && (source === null || target.verify)) {
      const identity = await this.identify(stamp);
      if (identity === null) {
        // The run couldn't be read after all.
        return source
          ? this.showUnavailable(target, source, stamp)
          : this.settle(target, null, stamp, false);
      }
      if (source && !sameRun(source, target.run, identity)) {
        this.deps.log.info('source.not_same', { reason: 'unknown' }, { src: source.sourceKey });
        // A different run is at this place. The known source, with its index,
        // stays as it is; it is checked again the next time it opens.
        this.registry.updateSource(source.sourceKey, { offline: true });
        if (target.onMismatch === 'offline') return this.showUnavailable(target, source, stamp);
        return this.activateOther(target, identity);
      }
      if (!source) {
        // A run picked afresh that the app already knows from another place.
        if (this.registry.sources().some((s) => sameRun(s, target.run, identity))) {
          return this.activateOther(target, identity);
        }
        source = this.registry.addSource({
          sourceKey,
          pickId,
          rel: target.run.rel,
          runName: target.run.runName,
          accountName: target.run.accountName,
          labelsSha256: identity.labelsSha256,
          namesSha256: identity.namesSha256,
          openedAt: this.now(),
          offline: false,
        });
      }
    }
    return this.settle(target, source, stamp, online);
  }

  /**
   * Opens the target's run, whose identity is known, as the source it matches
   * or else as a new one.
   */
  private async activateOther(target: Target, identity: RunIdentity): Promise<SourceOutcome> {
    const generation = this.deps.bumpGeneration();
    await this.stopCore(generation);
    const pickId = target.pick.pickId;
    this.record('scope.keep', { pickId, generation });
    const fields = {
      pickId,
      rel: target.run.rel,
      runName: target.run.runName,
      accountName: target.run.accountName,
      labelsSha256: identity.labelsSha256,
      namesSha256: identity.namesSha256,
      openedAt: this.now(),
      offline: false,
    };
    const match = this.registry
      .sources()
      .find((s) => s.sourceKey !== target.known?.sourceKey && sameRun(s, target.run, identity));
    const source = match ?? this.registry.addSource(fields);
    const stamp: Stamp = { sourceKey: source.sourceKey, generation };
    await this.spawnCore({ ...stamp, root: join(target.pick.path, target.run.rel) }, pickId);
    const outcome = await this.settle({ ...target, known: source }, source, stamp, true);
    return outcome === 'opened' && !match ? 'new_source' : outcome;
  }

  /** Keeps a source whose run isn't at its place, without access to the folder. */
  private async showUnavailable(
    target: Target,
    source: SourceRecord,
    stamp: Stamp,
  ): Promise<SourceOutcome> {
    await this.stopCore(stamp.generation);
    this.releaseScope(stamp.generation);
    await this.spawnCore({ ...stamp, root: null }, target.pick.pickId);
    return this.settle(target, source, stamp, false);
  }

  /** Makes the source active and saves the registry. */
  private async settle(
    target: Target,
    source: SourceRecord | null,
    stamp: Stamp,
    online: boolean,
  ): Promise<SourceOutcome> {
    if (!source) {
      // A run never opened that can't be read: nothing to show.
      await this.stopCore(stamp.generation);
      this.releaseScope(stamp.generation);
      this.deps.core.setSource(null);
      this.active = null;
      this.registry.setActive(null);
      this.registry.save();
      this.deps.notify();
      return 'unavailable';
    }
    this.registry.updateSource(source.sourceKey, {
      pickId: target.pick.pickId,
      rel: target.run.rel,
      // The account folder's name, once a pick shows it.
      accountName: target.run.accountName ?? source.accountName,
      openedAt: this.now(),
      offline: !online,
    });
    this.registry.setActive(source.sourceKey);
    this.registry.save();
    const fresh = this.registry.source(source.sourceKey)!;
    const runs = (target.runs ?? []).map((r) => ({ ...r, runId: randomBytes(8).toString('hex') }));
    this.active = { source: fresh, pick: target.pick, online, runs, scan: null };
    this.deps.log.info(
      online ? 'source.opened' : 'source.offline',
      { generation: stamp.generation },
      { src: source.sourceKey },
    );
    this.deps.notify();
    if (online) {
      if (!target.runs) void this.listRuns(stamp);
      void this.scan(stamp);
    }
    return online ? 'opened' : 'offline';
  }

  /** Lists the open pick's runs for the run picker, if the source is still current. */
  private async listRuns(stamp: Stamp): Promise<void> {
    const active = this.active;
    if (!active) return;
    const found = await this.discover(active.pick.path);
    if (!sameStamp(this.stamp(), stamp) || this.active !== active) return;
    active.runs = found.runs.map((r) => ({ ...r, runId: randomBytes(8).toString('hex') }));
    this.deps.notify();
  }

  /** Accepts a core result only for the current source and generation. */
  private current(result: CoreResult, stamp: Stamp, expectActive: boolean): boolean {
    const live = expectActive ? this.stamp() : { ...stamp, generation: this.deps.generation() };
    if (result.stamp && sameStamp(result.stamp, stamp) && sameStamp(live, stamp)) return true;
    this.deps.log.info(
      'source.stale_result',
      { generation: stamp.generation, reason: 'generation' },
      { src: stamp.sourceKey },
    );
    return false;
  }

  private async identify(stamp: Stamp): Promise<RunIdentity | null> {
    let result: CoreResult;
    try {
      result = await this.deps.core.request({ type: 'identify', stamp });
    } catch {
      return null;
    }
    if (!result.ok || !result.identity) return null;
    return this.current(result, stamp, false) ? result.identity : null;
  }

  private async scan(stamp: Stamp): Promise<void> {
    let result: CoreResult;
    try {
      result = await this.deps.core.request({ type: 'scan', stamp });
    } catch {
      this.deps.log.info(
        'source.stale_result',
        { generation: stamp.generation, reason: 'core_unavailable' },
        { src: stamp.sourceKey },
      );
      return;
    }
    if (!result.ok) {
      if (result.code === 'stale') {
        this.deps.log.info(
          'source.stale_result',
          { generation: stamp.generation, reason: 'stale_generation' },
          { src: stamp.sourceKey },
        );
      }
      return;
    }
    const scan = result.scan;
    if (!scan) return;
    const accept = () => {
      if (this.current(result, stamp, true) && this.active) this.active.scan = scan;
    };
    if (this.deps.hold) this.deps.hold(accept);
    else accept();
  }
}

function runOf(source: SourceRecord): FoundRun {
  return { rel: source.rel, runName: source.runName, accountName: source.accountName };
}

/**
 * True if `path` is a directory reached without any link: its canonical path
 * is the path itself. The picked folder's path is stored canonical, so a link
 * put anywhere on the way to a saved run (an account folder replaced by a
 * link, say) makes the run unavailable instead of redirecting it.
 */
async function isRunFolder(path: string): Promise<boolean> {
  try {
    return (await realpath(path)) === path && (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
