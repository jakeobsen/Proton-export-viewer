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
import { REASONS } from '../../shared/log/codes';
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
import type { SearchSpec } from '../../shared/search-chips';
import { RecentJobs } from './recent-jobs';
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
  /**
   * After a reset deleted the app's data: main's log files start again, and
   * settings go back to their defaults.
   */
  afterReset?(): void;
  /** Tells the shell where the open source's index stands. */
  indexChanged?(progress: IndexProgress): void;
  /** Whether an export root lies in the Downloads folder (real paths and identities). */
  inDownloads?(root: string): boolean;
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
  /** Core kept exiting, so it is no longer restarted until the export is opened again. */
  closed: boolean;
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
  /** Opened again by main itself (a restart or a rebuild): the restart count carries over. */
  again?: true;
}

/** Restarts of core allowed within RESTART_WINDOW_MS before it is left down. */
export const RESTART_LIMIT = 3;
export const RESTART_WINDOW_MS = 60_000;

/** The answer to an operation made for a generation that has moved on before it ran. */
export const STALE = 'stale_generation';
export type Stale = typeof STALE;
/** A Reset that couldn't delete every file of the app's. */
export const RESET_FAILED = 'reset_failed';
export type ResetFailed = typeof RESET_FAILED;

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
  /** When core was restarted for the open source, within the last window. */
  private restarts: number[] = [];
  private scope: { pickId: string; handle: ScopeHandle } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private restoring = false;
  /** Closed while a reset runs: nothing opens. */
  private admitting = true;
  /** Closed at quit: final, so a Reset that ends afterwards neither admits opens nor starts core. */
  private closed = false;
  /** Sources whose index was found damaged: the next index made for them is a rebuild. */
  private readonly rebuilds = new Set<string>();
  private readonly discover: typeof discoverRuns;
  private readonly now: () => number;

  /** The open export's recent searches: one queue of recordings, reads and wipes. */
  readonly recent: RecentJobs;

  constructor(private readonly deps: SourceManagerDeps) {
    this.registry = Registry.load(deps.userData, deps.log);
    this.discover = deps.discover ?? discoverRuns;
    this.now = deps.now ?? Date.now;
    this.recent = new RecentJobs({
      log: deps.log,
      generation: () => this.deps.generation(),
      send: (stamp, job) => this.deps.core.requestRunning({ type: 'recent', stamp, job }, stamp),
      keeps: (sourceKey) => this.registry.source(sourceKey)?.keepRecentSearches !== false,
      owes: (sourceKey) => this.registry.source(sourceKey)?.recentWipePending === true,
      clearOwed: (sourceKey) => {
        this.registry.updateSource(sourceKey, { recentWipePending: false });
        this.registry.save();
      },
    });
  }

  /** Moves to the next generation; the recent searches' jobs of older ones end at once. */
  private bump(): number {
    const generation = this.deps.bumpGeneration();
    this.recent.settle();
    return generation;
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

  /** True while the open source's run is unavailable: its messages can't be opened. */
  isOffline(): boolean {
    return this.active !== null && !this.active.online;
  }

  /** The open source's last scan, when one finished for its current stamp. */
  scanSummary(): ScanSummary | null {
    return this.active?.scan ?? null;
  }

  /** The key of every source the app knows. */
  sourceKeys(): string[] {
    return this.registry.sources().map((s) => s.sourceKey);
  }

  view(): SourcesView {
    const inDownloads = (s: SourceRecord) => {
      const pick = this.registry.pick(s.pickId);
      return pick !== undefined && (this.deps.inDownloads?.(join(pick.path, s.rel)) ?? false);
    };
    const row = (s: SourceRecord) => ({
      sourceKey: s.sourceKey,
      account: s.accountName,
      runName: s.runName,
      inDownloads: inDownloads(s),
    });
    let active: ActiveExport | null = null;
    if (this.active) {
      const current = this.active;
      active = {
        ...row(current.source),
        status: current.online ? 'online' : 'offline',
        index: current.index,
        closed: current.closed,
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

  /** At quit: nothing opens or restarts any more, and the folder scope is released. */
  close(): void {
    this.closed = true;
    this.admitting = false;
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
    if (!target.again) this.restarts = [];
    const generation = this.bump();
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
    const generation = this.bump();
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
      this.recent.deactivated();
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
    this.active = {
      source: fresh,
      pick: target.pick,
      online,
      runs,
      scan: null,
      index,
      closed: false,
    };
    this.deps.log.info(
      online ? 'source.opened' : 'source.offline',
      { generation: stamp.generation },
      { src: source.sourceKey },
    );
    // Every activation wipes the recent searches first while the switch is
    // off or a wipe is owed: one that a crash, a switch or a core exit
    // dropped is paid before anything is read or recorded.
    this.recent.activated(stamp);
    if (fresh.keepRecentSearches === false || fresh.recentWipePending === true) {
      void this.recent.wipe(stamp);
    }
    this.deps.notify();
    if (online && !target.runs) void this.listRuns(stamp);
    // The index first, so a stored list shows at once; the scan follows it.
    // An unavailable export can still be browsed from its index.
    if (online || fresh.dbUuid) void this.openIndex(stamp);
    else this.recent.noIndex(stamp);
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

  /**
   * The run's identity, from core; null if core couldn't give it, which is
   * logged with core's answer. The open then shows the run as unavailable.
   */
  private async identify(stamp: Stamp): Promise<RunIdentity | null> {
    let result: CoreResult;
    const failed = (answer: string) => {
      this.deps.log.warn(
        'source.identify_failed',
        { generation: stamp.generation, reason: reasonOf(answer) },
        { src: stamp.sourceKey },
      );
      return null;
    };
    try {
      result = await this.deps.core.requestRunning({ type: 'identify', stamp }, stamp);
    } catch {
      return failed('core_unavailable');
    }
    if (!result.ok) return failed(result.code);
    if (!result.identity) return failed('invalid');
    return this.current(result, stamp, false) ? result.identity : null;
  }

  private async scan(stamp: Stamp): Promise<void> {
    let result: CoreResult;
    try {
      result = await this.deps.core.requestRunning({ type: 'scan', stamp }, stamp);
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
        return;
      }
      this.failed(stamp, 'source.scan_failed', result.code);
      return;
    }
    const scan = result.scan;
    if (!scan) {
      this.failed(stamp, 'source.scan_failed', 'invalid');
      return;
    }
    const accept = () => {
      if (this.current(result, stamp, true) && this.active) this.active.scan = scan;
    };
    if (this.deps.hold) this.deps.hold(accept);
    else accept();
  }

  /**
   * Has core open the source's index, then, for a run that is there, scan it:
   * core starts phase 1 once it has both. A new index's identity goes into
   * the source's registry entry.
   */
  private async openIndex(stamp: Stamp): Promise<void> {
    const source = this.active?.source;
    if (!this.admitting || !source || source.sourceKey !== stamp.sourceKey) return;
    const rebuild = this.rebuilds.has(source.sourceKey);
    let result: CoreResult;
    try {
      result = await this.deps.core.requestRunning(
        {
          type: 'index',
          stamp,
          dbUuid: source.dbUuid ?? null,
          ...(rebuild ? { rebuild: true } : {}),
        },
        stamp,
      );
    } catch {
      // Core ended: its exit restarts the source, or closes it past the limit.
      return;
    }
    if (!result.ok) {
      if (result.code !== 'stale') this.recent.noIndex(stamp);
      // A damaged index comes with its own event and is rebuilt; a stale
      // answer was for an open that a newer one replaced.
      if (result.code !== 'damaged' && result.code !== 'stale') {
        this.failed(stamp, 'index.open_failed', result.code);
      }
      return;
    }
    if (!result.index) {
      this.recent.noIndex(stamp);
      this.failed(stamp, 'index.open_failed', 'invalid');
      return;
    }
    if (!this.current(result, stamp, true)) return;
    if (rebuild && result.index.created) this.rebuilds.delete(source.sourceKey);
    if (result.index.dbUuid !== source.dbUuid) {
      this.registry.updateSource(source.sourceKey, { dbUuid: result.index.dbUuid });
      this.registry.save();
      if (this.active?.source.sourceKey === source.sourceKey) {
        this.active.source = this.registry.source(source.sourceKey)!;
      }
    }
    if (this.active && result.progress) this.active.index = result.progress.condition;
    this.recent.ready(stamp);
    this.deps.log.info('index.opened', { generation: stamp.generation }, { src: stamp.sourceKey });
    this.deps.notify();
    if (this.active?.online) void this.scan(stamp);
  }

  /**
   * The open source's scan, index open or phase 1 failed. Nothing would show
   * it, so the source is closed under a new generation, as when core keeps
   * failing: the shell says so and offers to open it again. Core is stopped;
   * the folder's scope stays for that. `code` logs core's answer, if any. An
   * unavailable source, browsed from its index, shows that state instead.
   */
  private failed(
    stamp: Stamp,
    code: 'source.scan_failed' | 'index.open_failed' | null,
    answer: string | null,
  ): void {
    void this.serial(async () => {
      // An answer for an older generation is no longer about the open source.
      if (!sameStamp(stamp, this.stamp())) return;
      // Logged even when the source stays as it is: unavailable, or already closed.
      if (code !== null) {
        this.deps.log.warn(
          code,
          { generation: stamp.generation, reason: reasonOf(answer ?? '') },
          { src: stamp.sourceKey },
        );
      }
      const active = this.active;
      if (!this.admitting || !active?.online || active.closed) return;
      const generation = this.bump();
      active.closed = true;
      await this.stopCore(generation);
      this.deps.notify();
    });
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
    // Phase 1 stopped short (core logged why); a damaged index is rebuilt instead.
    if (event.progress.phase === 'failed' && !event.damaged) this.failed(event.stamp, null, null);
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
      again: true,
    });
  }

  /**
   * Core exited without being stopped. If it was the core of the open source
   * under the current generation, main opens the source again: a new
   * generation, core, the index with its checks, and reconcile. At most
   * RESTART_LIMIT times within RESTART_WINDOW_MS; after that the export stays
   * closed until it is opened again.
   */
  coreExited(source: Stamp | null): void {
    if (!this.admitting || !this.active || !source || !sameStamp(source, this.stamp())) return;
    void this.serial(async () => {
      // Only if nothing moved on meanwhile: no switch, Forget, Reset or quit.
      // The open source is compared by its stamp: an open that settled since
      // made a new entry for the same one.
      const active = this.active;
      if (!this.admitting || !active || !sameStamp(source, this.stamp())) return;
      const record = this.registry.source(source.sourceKey);
      if (!record) return;
      const at = { generation: source.generation };
      const now = performance.now();
      this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (this.restarts.length >= RESTART_LIMIT) {
        // The open views go with the core that served them.
        this.bump();
        active.closed = true;
        this.deps.log.warn('core.restart_gave_up', at, { src: source.sourceKey });
        this.deps.notify();
        return;
      }
      this.restarts.push(now);
      this.deps.log.warn('core.restart', at, { src: source.sourceKey });
      try {
        await this.activate({
          pick: active.pick,
          run: runOf(record),
          known: record,
          verify: false,
          onMismatch: 'offline',
          runs: active.runs,
          again: true,
        });
      } catch {
        // The new core ended before it was ready. Its exit was reported too,
        // and is next in the queue: another restart, or the end of them.
        this.deps.log.warn('core.restart_failed', at, { src: source.sourceKey });
      }
    });
  }

  /**
   * Builds the open source's index again, by hand. Under the lifecycle lock,
   * the source's views are revoked under a new generation, core tears its
   * index down and deletes it, and the source opens again with a fresh index.
   * Only for the open, known source while its run is there. If core can't
   * delete the index, the source opens again with it, and that is 'busy'.
   */
  rebuildIndex(sourceKey: string, expected: number): Promise<SourceOutcome | null | Stale> {
    return this.serial(async () => {
      if (!this.admitting) return 'closed';
      const active = this.active;
      const source = this.registry.source(sourceKey);
      if (!active || !source || active.source.sourceKey !== sourceKey) return null;
      if (!active.online) return 'offline';
      const generation = this.bump();
      this.deps.notify();
      // The index loses its identity before its files go, so an index found
      // after a crash in between is never taken for this one.
      const dbUuid = source.dbUuid ?? null;
      this.registry.updateSource(sourceKey, { dbUuid: null });
      this.registry.save();
      let deleted = await this.coreForget(sourceKey);
      if (!deleted) {
        // A core started afresh holds nothing of it.
        await this.stopCore(generation);
        this.deps.core.setSource(null);
        deleted = await this.coreForget(sourceKey);
      }
      if (deleted) {
        this.deps.log.info('index.rebuild', { generation, reason: 'manual' }, { src: sourceKey });
      } else {
        // The index is still there and still this one.
        this.registry.updateSource(sourceKey, { dbUuid });
        this.registry.save();
        this.deps.log.warn('index.rebuild_refused', { reason: 'in_use' }, { src: sourceKey });
      }
      // Core retired the key when it deleted the index: the source opens in a
      // new core, as after a switch.
      const known = this.registry.source(sourceKey);
      if (!known) return null;
      const outcome = await this.activate({
        pick: active.pick,
        run: runOf(known),
        known,
        verify: false,
        onMismatch: 'offline',
        runs: active.runs,
      });
      return deleted || outcome !== 'opened' ? outcome : 'busy';
    }, expected);
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
        generation = this.bump();
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
   * Resets the app. From now until it's done nothing opens. After the
   * operation in progress, the open source is torn down in core and core is
   * stopped; only then is the app's data deleted. Then the app starts afresh,
   * as at a launch with nothing to reopen. True if the data was deleted,
   * false if an export overlaps it (nothing is deleted), RESET_FAILED if a
   * file of the app's couldn't be deleted.
   *
   * The generation it is made for is checked again when its turn comes: if
   * an operation before it moved the generation on (another Reset too), it is
   * stale, nothing is deleted, and opens are admitted again. Null skips that
   * check.
   */
  reset(expected: number | null): Promise<boolean | Stale | ResetFailed> {
    this.admitting = false;
    return this.serial(async () => {
      if (expected !== null && this.deps.generation() !== expected) {
        if (!this.closed) this.admitting = true;
        return STALE;
      }
      try {
        return await this.resetNow();
      } finally {
        if (!this.closed) {
          this.admitting = true;
          if (!this.deps.core.running) await this.deps.core.startWith(null).catch(() => false);
        }
      }
    });
  }

  private async resetNow(): Promise<boolean | ResetFailed> {
    const exports = this.exportRoots();
    const generation = this.bump();
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
      return false;
    }
    this.registry.clear();
    this.deps.log.info('app.reset', { generation });
    this.deps.stopLogs?.();
    const left = removeAppData(this.deps.userData);
    this.deps.afterReset?.();
    // Logged once the logs have started again.
    if (left > 0) this.deps.log.warn('app.reset_failed', { count: left });
    this.deps.notify();
    return left === 0 ? true : RESET_FAILED;
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

  /** Whether the export that is open now; its sourceKey and generation are the ones given. */
  private shown(sourceKey: string, expected: number): Stamp | null {
    const stamp = this.stamp();
    return stamp && stamp.sourceKey === sourceKey && stamp.generation === expected ? stamp : null;
  }

  /**
   * Records a search committed in the open export, received at `at`. It is
   * dropped at once while the export's switch is off, or while a wipe is
   * owed and none is queued to pay it.
   */
  recordSearch(q: string, at: number): void {
    const stamp = this.stamp();
    if (stamp) this.recent.record(stamp, q, at);
  }

  /** The open export's recent searches, newest first; none while its switch is off or a wipe is owed. */
  recentSearches(): Promise<SearchSpec[]> {
    const stamp = this.stamp();
    return stamp ? this.recent.list(stamp) : Promise.resolve([]);
  }

  /**
   * "Keep recent searches" for the export Settings showed. Off saves the
   * switch and the owed wipe in one save, then queues the wipe, in one
   * synchronous step. On saves only the switch: a wipe still owed stays owed.
   */
  setKeepRecent(sourceKey: string, keep: boolean, expected: number): true | Stale {
    const stamp = this.shown(sourceKey, expected);
    if (!stamp) return STALE;
    if (keep) {
      this.registry.updateSource(sourceKey, { keepRecentSearches: true });
      this.registry.save();
      this.deps.notify();
      return true;
    }
    this.registry.updateSource(sourceKey, { keepRecentSearches: false, recentWipePending: true });
    this.registry.save();
    void this.recent.wipe(stamp);
    this.deps.notify();
    return true;
  }

  /** "Clear recent searches" for the export Settings showed: resolves once the wipe has ended. */
  async clearRecent(sourceKey: string, expected: number): Promise<'ok' | 'failed' | Stale> {
    const stamp = this.shown(sourceKey, expected);
    if (!stamp) return STALE;
    const outcome = await this.recent.wipe(stamp);
    return outcome === 'stale' ? STALE : outcome;
  }

  /** The "Keep recent searches" switch of a source the app knows: absent means on. */
  keepsRecent(sourceKey: string): boolean {
    return this.registry.source(sourceKey)?.keepRecentSearches !== false;
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

/** Core's answer code as a log reason: one the log knows, else 'unknown'. */
function reasonOf(answer: string): string {
  if (answer === 'stale') return 'stale_generation';
  return (REASONS as readonly string[]).includes(answer) ? answer : 'unknown';
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
