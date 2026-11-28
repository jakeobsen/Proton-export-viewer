// SPDX-License-Identifier: AGPL-3.0-or-later
// Main test hooks for saves: force the publish's copy, hold it once its file
// is made and then let it finish or fail, hold a save before its download
// starts or before it is published, and record the URLs and staged files of
// saves, so a test can act at each of those points.

import { readdirSync } from 'node:fs';
import { realPublishFs, removeIfSame, type FileId, type PublishFs } from '../main/saves/publish';
import type { SaveManager } from '../main/saves/manager';
import { markLoaded } from './marker';

markLoaded();

/** A gate a hook waits at until a test opens it; it can open as a failure. */
class Gate {
  private waiters: Array<(fail: boolean) => void> = [];
  closed = false;

  get waiting(): number {
    return this.waiters.length;
  }

  /** Waits while closed; resolves true when let through as a failure. */
  pass(): Promise<boolean> {
    if (!this.closed) return Promise.resolve(false);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  open(fail = false): number {
    this.closed = false;
    const waiting = this.waiters.splice(0);
    for (const resolve of waiting) resolve(fail);
    return waiting.length;
  }
}

export interface SaveTestApi {
  saveForceCopy(on: boolean): void;
  saveHoldCopy(): void;
  saveCopiesHeld(): number;
  saveReleaseCopy(fail: boolean): number;
  saveHoldDownload(): void;
  saveDownloadsHeld(): number;
  saveReleaseDownload(): number;
  saveHoldStaged(): void;
  saveStagedHeld(): number;
  saveReleaseStaged(): number;
  /** The URL of the last save main started a download for. */
  saveLastUrl(): string | null;
  /** The nonce of that save, so a test can check that no log or file holds it. */
  saveLastNonce(): string | null;
  /** How the last request for a save's asset compared with its save's nonce. */
  saveLastProof(): string | null;
  /** The file names in the staging folder, or [] when it is gone. */
  stagingFiles(): string[];
  /** Main's memory now. */
  mainMemory(): NodeJS.MemoryUsage;
}

/** Installs the hooks on `saves`; `onStaged` runs too, before the staged gate. */
export function saveTestApi(
  saves: SaveManager,
  stagingDir: string,
  onStaged?: (path: string) => Promise<void>,
): SaveTestApi {
  const copy = new Gate();
  const download = new Gate();
  const staged = new Gate();
  let forceCopy = false;
  let lastUrl: string | null = null;
  let lastNonce: string | null = null;
  let lastProof: string | null = null;
  const publishFs: PublishFs = {
    ...realPublishFs,
    copyNew: async (from, path, created) => {
      let id: FileId | null = null;
      await realPublishFs.copyNew(from, path, (made) => {
        id = made;
        created(made);
      });
      if (await copy.pass()) {
        // A copy that fails once its file is made removes it, as the real one does.
        if (id) removeIfSame(realPublishFs, path, id);
        throw new Error('copy failed');
      }
    },
  };
  const install = () => {
    saves.test = {
      publishFs,
      forceCopy,
      beforeDownload: async (url, nonce) => {
        lastUrl = url;
        lastNonce = nonce;
        await download.pass();
      },
      onProof: (proof) => {
        lastProof = proof;
      },
      onStaged: async (path) => {
        await onStaged?.(path);
        await staged.pass();
      },
    };
  };
  install();
  return {
    saveForceCopy: (on) => {
      forceCopy = on;
      install();
    },
    saveHoldCopy: () => {
      copy.closed = true;
    },
    saveCopiesHeld: () => copy.waiting,
    saveReleaseCopy: (fail) => copy.open(fail),
    saveHoldDownload: () => {
      download.closed = true;
    },
    saveDownloadsHeld: () => download.waiting,
    saveReleaseDownload: () => download.open(),
    saveHoldStaged: () => {
      staged.closed = true;
    },
    saveStagedHeld: () => staged.waiting,
    saveReleaseStaged: () => staged.open(),
    saveLastUrl: () => lastUrl,
    saveLastNonce: () => lastNonce,
    saveLastProof: () => lastProof,
    stagingFiles: () => {
      try {
        return readdirSync(stagingDir);
      } catch {
        return [];
      }
    },
    mainMemory: () => process.memoryUsage(),
  };
}
