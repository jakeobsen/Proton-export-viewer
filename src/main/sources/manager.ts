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
//
// When core finds the open source's index damaged, it tears the index down
// and deletes it, and tells main. Main then reopens the source under a new
// generation, so a fresh index is built, as long as the source is still
// known; while the run is unavailable, that waits until it is back. Forget
// tears the source down if it is open and has core delete its index before it
// leaves the registry. Reset closes the app to every open first, tears down
// the open source, and then deletes the app's own files from its data folder,
// unless an export the app knows overlaps them. An export inside the data
// folder, or holding it, is never opened.

import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreEvent, CoreRequest, CoreResult } from '../../shared/core-protocol';
import type {
  IndexAnswer,
  IndexCondition,
  IndexProgress,
  IndexQuery,
} from '../../shared/index-types';
import type { Logger } from '../../shared/log/writer';
import { overlaps } from '../../shared/overlap';
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
import { appDataPaths, removeAppData } from './app-data';
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
   * Makes sure core runs with exactly this source, or with none: a core
   * started with another one in the meantime (by a request) is stopped
   * first. Resolves true if it had to stop one.
   */
  startWith(source: (Stamp & { root: string | null }) | null): Promise<boolean>;
  stop(): Promise<void>;
  request(call: DistributiveOmit<CoreRequest, 'reqId'>): Promise<CoreResult>;
  /**
   * A request only for a core already started for this stamp (null: no
   * source open). It never starts one.
   */
  requestRunning(
    call: DistributiveOmit<CoreRequest, 'reqId'>,
    stamp: Stamp | null,
  ): Promise<CoreResult>;
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
  /** Stops main's own log files, so a reset leaves no log folder behind. */
  stopLogs?(): void;
  /** Tells the shell where the open source's index stands. */
  indexChanged?(progress: IndexProgress): void;
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
  /** The state of its index, once core reported it. */
  index: IndexCondition | null;
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
  /** Closed for good by a reset: nothing opens any more. */
  private admitting = true;
  /** Sources whose index was found damaged: the next index made for them is a rebuild. */
  private readonly rebuilds = new Set<string>();
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
        index: current.index,
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
    if (!source || !pick) {
      // Nothing to open: core starts without a source, so the calls the
      // shell makes, which never start core, find one up.
      return this.serial(async () => {
        if (this.admitting) await this.deps.core.startWith(null).catch(() => false);
        return null;
      });
    }
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
      if (!this.admitting) return 'closed';
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
      if (!this.admitting) return 'closed';
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
      if (!this.admitting) return 'closed';
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
      if (!this.admitting) return 'closed';
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
    if (!this.admitting) return 'closed';
    const root = join(target.pick.path, target.run.rel);
    // Reset deletes the app's data folder: an export inside it, or around
    // it, is never opened, so nothing the app deletes can be part of one.
    if (overlaps(root, this.deps.userData)) {
      this.deps.log.warn('source.refused', { reason: 'app_data' });
      return 'app_data';
    }
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
    // An index found damaged while the run was unavailable is rebuilt once it is back.
    const index = !online && this.rebuilds.has(source.sourceKey) ? 'damaged' : null;
    this.active = { source: fresh, pick: target.pick, online, runs, scan: null, index };
    this.deps.log.info(
      online ? 'source.opened' : 'source.offline',
      { generation: stamp.generation },
      { src: source.sourceKey },
    );
    this.deps.notify();
    if (online) {
      if (!target.runs) void this.listRuns(stamp);
      void this.scan(stamp);
    } else if (fresh.dbUuid) {
      // An unavailable export can still be browsed from its index.
      void this.openIndex(stamp);
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
      if (this.current(result, stamp, true) && this.active) {
        this.active.scan = scan;
        void this.openIndex(stamp);
      }
    };
    if (this.deps.hold) this.deps.hold(accept);
    else accept();
  }

  /**
   * Has core open the source's index; phase 1 starts there. A new index's
   * identity goes into the source's registry entry.
   */
  private async openIndex(stamp: Stamp): Promise<void> {
    const source = this.active?.source;
    if (!this.admitting || !source || source.sourceKey !== stamp.sourceKey) return;
    const rebuild = this.rebuilds.has(source.sourceKey);
    let result: CoreResult;
    try {
      result = await this.deps.core.request({
        type: 'index',
        stamp,
        dbUuid: source.dbUuid ?? null,
        ...(rebuild ? { rebuild: true } : {}),
      });
    } catch {
      return;
    }
    if (!result.ok || !result.index || !this.current(result, stamp, true)) return;
    if (rebuild && result.index.created) this.rebuilds.delete(source.sourceKey);
    if (result.index.dbUuid !== source.dbUuid) {
      this.registry.updateSource(source.sourceKey, { dbUuid: result.index.dbUuid });
      this.registry.save();
      if (this.active?.source.sourceKey === source.sourceKey) {
        this.active.source = this.registry.source(source.sourceKey)!;
      }
    }
    if (this.active && result.progress) this.active.index = result.progress.condition;
    this.deps.log.info('index.opened', { generation: stamp.generation }, { src: stamp.sourceKey });
    this.deps.notify();
  }

  /**
   * What core reports about the open source's index. A damaged index was
   * already deleted: the source loses its index identity, and is reopened
   * under a new generation to rebuild it, if it is still known and the run is
   * there; otherwise the rebuild waits until the run is back.
   */
  handleCoreEvent(event: CoreEvent): void {
    const active = this.active;
    if (!active || !sameStamp(event.stamp, this.stamp())) {
      this.deps.log.info(
        'source.stale_result',
        { generation: event.stamp.generation, reason: 'generation' },
        { src: event.stamp.sourceKey },
      );
      return;
    }
    const changed = active.index !== event.progress.condition;
    active.index = event.progress.condition;
    this.deps.indexChanged?.(event.progress);
    if (event.damaged) {
      const key = active.source.sourceKey;
      this.rebuilds.add(key);
      this.registry.updateSource(key, { dbUuid: null });
      this.registry.save();
      active.source = this.registry.source(key) ?? active.source;
      if (active.online) {
        void this.serial(() => this.rebuild(event.stamp), event.stamp.generation);
      }
    }
    if (changed || event.damaged) this.deps.notify();
  }

  /** Reopens the open source to rebuild its index, if it is still the open, known source. */
  private async rebuild(stamp: Stamp): Promise<SourceOutcome | null> {
    const active = this.active;
    const source = this.registry.source(stamp.sourceKey);
    if (!this.admitting || !active || !source || active.source.sourceKey !== stamp.sourceKey) {
      return null;
    }
    this.deps.log.info('index.rebuild', { generation: stamp.generation }, { src: stamp.sourceKey });
    return this.activate({
      pick: active.pick,
      run: runOf(source),
      known: source,
      verify: false,
      onMismatch: 'offline',
      runs: active.runs,
    });
  }

  /**
   * Forgets a source: if it is open, it is torn down under a new generation
   * and its folder released; core deletes its index; then it leaves the
   * registry and the recent list. The export's own files are never touched.
   */
  forget(sourceKey: string, expected: number): Promise<SourceOutcome | null | Stale> {
    return this.serial(async () => {
      if (!this.admitting) return 'closed';
      if (!this.registry.source(sourceKey)) return null;
      const open = this.active?.source.sourceKey === sourceKey;
      let generation = this.deps.generation();
      if (open) {
        generation = this.deps.bumpGeneration();
        // From here no result of the open source is taken any more.
        this.active = null;
        this.deps.notify();
      }
      let deleted = await this.coreForget(sourceKey);
      if (open) {
        await this.stopCore(generation);
        this.releaseScope(generation);
        this.deps.core.setSource(null);
        // A core started afresh holds nothing of it.
        if (!deleted) deleted = await this.coreForget(sourceKey);
      }
      if (!deleted) {
        this.deps.log.warn('source.forget_refused', { reason: 'in_use' }, { src: sourceKey });
        if (open) this.registry.setActive(null);
        this.registry.save();
        this.deps.notify();
        return 'busy';
      }
      this.registry.removeSource(sourceKey);
      this.registry.save();
      this.rebuilds.delete(sourceKey);
      this.deps.log.info('source.forgotten', { generation }, { src: sourceKey });
      this.deps.notify();
      return 'forgotten';
    }, expected);
  }

  private async coreForget(sourceKey: string): Promise<boolean> {
    try {
      const result = await this.deps.core.request({ type: 'forget', sourceKey });
      return result.ok;
    } catch {
      return false;
    }
  }

  /**
   * Resets the app: from now on nothing opens. After the operation in
   * progress, the open source is torn down in core and core is stopped; only
   * then is the app's data deleted.
   */
  reset(): Promise<void> {
    this.admitting = false;
    return this.serial(async () => {
      const exports = this.exportRoots();
      const generation = this.deps.bumpGeneration();
      this.active = null;
      if (this.deps.core.running) {
        try {
          await this.deps.core.request({ type: 'reset' });
        } catch {
          // Core ended on its own; it holds nothing any more.
        }
      }
      await this.stopCore(generation);
      this.releaseScope(generation);
      this.deps.core.setSource(null);
      this.rebuilds.clear();
      // Nothing is deleted if any export the app knows overlaps what would be.
      const targets = appDataPaths(this.deps.userData);
      if (targets.some((target) => exports.some((root) => overlaps(root, target)))) {
        this.deps.log.warn('app.reset_refused', { reason: 'overlap' });
        this.deps.notify();
        return;
      }
      this.registry.clear();
      this.deps.log.info('app.reset', { generation });
      this.deps.stopLogs?.();
      removeAppData(this.deps.userData);
      this.deps.notify();
    });
  }

  /** The run folder of every export the app knows, the open one included. */
  exportRoots(): string[] {
    const roots: string[] = [];
    for (const source of this.registry.sources()) {
      const pick = this.registry.pick(source.pickId);
      if (pick) roots.push(join(pick.path, source.rel));
    }
    if (this.active) roots.push(join(this.active.pick.path, this.active.source.rel));
    return roots;
  }

  /**
   * Reads from the open source's index. Null when no source is open, the
   * index isn't open yet, or the answer came back for another generation.
   */
  async queryIndex(
    query: IndexQuery,
  ): Promise<{ answer: IndexAnswer; progress: IndexProgress } | null> {
    const stamp = this.stamp();
    if (!stamp) return null;
    let result: CoreResult;
    try {
      // A read never starts core: during a switch it would start one with
      // the old source, which the switch then has to stop again.
      result = await this.deps.core.requestRunning({ type: 'index-query', stamp, query }, stamp);
    } catch {
      return null;
    }
    if (!result.ok || result.answer === undefined || !result.progress) return null;
    if (!sameStamp(result.stamp, stamp) || !sameStamp(this.stamp(), stamp)) return null;
    return { answer: result.answer, progress: result.progress };
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
