// SPDX-License-Identifier: AGPL-3.0-or-later
// Launches the e2e build (production bundles plus test hooks) unpackaged with
// the stock Electron binary. Each launch gets its own userData under test-output/,
// removed again when the test passes.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  test as base,
  _electron as electron,
  expect,
  type ElectronApplication,
  type Frame,
  type Page,
} from '@playwright/test';
import type { MessageOpenResult } from '../../src/shared/api';
import type { OpenMode } from '../../src/shared/reader-protocol';
import { REPO_ROOT, TEST_OUTPUT, removeTestDirs, takeTestDirs, testDir } from '../paths';
import { closeAndConfirm, type CloseWait } from './close-wait';
import { startTimeOf, waitGone } from './process-wait';

/** How long a close waits for core to exit after main has. */
export const CORE_EXIT_MS = 10_000;

/** Adds one close's wait for core to test-output/close-waits.jsonl: numbers and fixed words only. */
function recordCloseWait(entry: CloseWait): void {
  try {
    mkdirSync(TEST_OUTPUT, { recursive: true });
    appendFileSync(join(TEST_OUTPUT, 'close-waits.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch {
    // The record is for reading afterwards; a test never depends on it.
  }
}

/**
 * The tag, in its title, of a test that runs on the reader pane's body frame,
 * the one the shell ships. After it passes, the fixture checks that it used no
 * stub open and that no window has the test hooks' stub frame.
 */
const PANE = '@pane';

export interface LogLine {
  ts: string;
  level: string;
  proc: string;
  code: string;
  data: Record<string, unknown>;
}

/** The `index.opened` lines in the logs under `userData`, from every launch that used it. */
function indexOpenedIn(userData: string): number {
  const dir = join(userData, 'logs');
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.includes('"index.opened"')) continue;
      try {
        if ((JSON.parse(line) as LogLine).code === 'index.opened') count += 1;
      } catch {
        // A line cut short by an app that was killed while writing it.
      }
    }
  }
  return count;
}

export class PevApp {
  readonly consoleMessages: Array<{ type: string; text: string }> = [];
  private closing: Promise<void> | null = null;
  /** How the close's wait for core ended, once the close has finished. */
  closeWait: CloseWait | null = null;

  constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
    readonly userData: string,
    /** `index.opened` lines in this user data's logs before this launch. */
    private readonly openedAtLaunch = 0,
  ) {
    page.on('console', (m) => this.consoleMessages.push({ type: m.type(), text: m.text() }));
  }

  /** Calls a main-process test hook. */
  main<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    return this.app.evaluate(
      async (_electron, [hook, hookArgs]) => {
        const api = (
          globalThis as unknown as { __pevTest: Record<string, (...a: unknown[]) => unknown> }
        ).__pevTest;
        const fn = api[hook as string];
        if (typeof fn !== 'function') throw new Error(`no main hook ${String(hook)}`);
        return fn(...(hookArgs as unknown[]));
      },
      [name, args] as const,
    ) as Promise<T>;
  }

  /** Calls a shell (renderer) test hook in the given page. */
  shell<T = unknown>(name: string, args: unknown[] = [], page: Page = this.page): Promise<T> {
    return page.evaluate(
      async ([hook, hookArgs]) => {
        const api = (
          window as unknown as { __pevTest: Record<string, (...a: unknown[]) => unknown> }
        ).__pevTest;
        return api[hook as string]?.(...(hookArgs as unknown[]));
      },
      [name, args] as const,
    ) as Promise<T>;
  }

  async open(stubId: string, page: Page = this.page) {
    return this.shell<{ ok: boolean; url?: string; code?: string; openId?: number }>(
      'open',
      [stubId],
      page,
    );
  }

  /** Opens a message in the reader pane, as the shell does. */
  paneOpen(rowid: number, mode?: OpenMode, page: Page = this.page): Promise<MessageOpenResult> {
    return this.shell<MessageOpenResult>('openInReader', mode ? [rowid, mode] : [rowid], page);
  }

  /**
   * The reader pane's body frame once it shows the given URL and has loaded
   * it. The frame is taken from the pane's own iframe element, so a test that
   * uses it runs on the frame the shell ships.
   */
  async paneFrame(url: string, page: Page = this.page): Promise<Frame> {
    const element = page.locator('.reader iframe.rp-frame');
    await expect(element).toHaveAttribute('src', url, { timeout: 10_000 });
    const frame = await (await element.elementHandle())?.contentFrame();
    if (!frame) throw new Error('reader pane frame missing');
    await expect.poll(() => frame.url(), { timeout: 10_000 }).toBe(url);
    await frame.waitForLoadState('load');
    return frame;
  }

  /**
   * Opens a message in the reader pane and waits until the pane's frame has
   * loaded its view.
   */
  async showInPane(rowid: number, mode?: OpenMode, page: Page = this.page) {
    const result = await this.paneOpen(rowid, mode, page);
    if (!result.ok || result.outcome !== 'view')
      throw new Error(`no view: ${JSON.stringify(result)}`);
    const frame = await this.paneFrame(result.url, page);
    return { result, url: result.url, token: tokenOf(result.url), frame };
  }

  /** The body frame once it has loaded the given URL. */
  async bodyFrame(url: string, page: Page = this.page): Promise<Frame> {
    await expect
      .poll(() => page.frames().some((f) => f.url() === url), { timeout: 10_000 })
      .toBe(true);
    const frame = page.frames().find((f) => f.url() === url);
    if (!frame) throw new Error('body frame missing');
    await frame.waitForLoadState('load');
    return frame;
  }

  /** Opens a new app window of the given kind and returns its id and page. */
  async openWindow(kind: 'shell' | 'subframe' | 'script-control' | 'fetch') {
    const pagePromise = this.app.waitForEvent('window');
    const windowId = await this.main<number>('openWindow', kind);
    const page = await pagePromise;
    await page.waitForLoadState('load');
    if (kind === 'shell') await waitForShell(page);
    return { windowId, page };
  }

  logsDir(): string {
    return join(this.userData, 'logs');
  }

  logs(file?: 'main' | 'core' | 'renderer'): LogLine[] {
    const dir = this.logsDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(
      (f) => f.endsWith('.jsonl') && (!file || f.startsWith(`${file}.`)),
    );
    return files.flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LogLine),
    );
  }

  hasLog(code: string, match: Partial<{ proc: string } & Record<string, unknown>> = {}): boolean {
    return this.logs().some(
      (l) =>
        l.code === code &&
        Object.entries(match).every(([k, v]) => (k === 'proc' ? l.proc === v : l.data[k] === v)),
    );
  }

  /**
   * Closes the app, and returns once its core process has exited too: core
   * can outlive main for a moment, with the index still open. A core still
   * there after CORE_EXIT_MS is killed, and the close fails; so does a close
   * that can't confirm core's exit while an index was open. Every caller
   * waits for the same close.
   */
  close(): Promise<void> {
    this.closing ??= this.closeAndWait();
    return this.closing;
  }

  private async closeAndWait(): Promise<void> {
    await closeAndConfirm({
      corePid: () => this.main<number | undefined>('corePid'),
      sourceOpen: async () => (await this.main<unknown>('sourceStamp')) !== null,
      startTimeOf,
      closeApp: () => this.app.close(),
      waitGone: (pid, startTime) => waitGone(pid, { timeoutMs: CORE_EXIT_MS, startTime }),
      openedCount: () => indexOpenedIn(this.userData),
      openedAtLaunch: this.openedAtLaunch,
      record: (entry) => {
        this.closeWait = entry;
        recordCloseWait(entry);
      },
    });
  }
}

async function waitForShell(page: Page): Promise<void> {
  // Hidden windows get no animation frames, so poll on a timer.
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __pevTest?: { state(): { generation: number | null } } })
        .__pevTest;
      return !!api && api.state().generation !== null;
    },
    undefined,
    { polling: 100 },
  );
}

export interface LaunchOptions {
  /** Start with this userData, e.g. to launch again after a quit. */
  userData?: string;
  args?: string[];
  /**
   * Pages take the colour scheme the app gives them. Playwright otherwise
   * emulates a light one in every page, whatever the app's theme.
   */
  appColorScheme?: boolean;
}

export async function launch(name: string, options: LaunchOptions = {}): Promise<PevApp> {
  const userData = options.userData ?? testDir(`e2e-${name}`);
  // Counted before the launch: a reopened export logs its own line at start.
  const openedAtLaunch = indexOpenedIn(userData);
  const app = await electron.launch({
    args: [
      join(REPO_ROOT, 'out-test'),
      `--pev-user-data=${userData}`,
      // Screenshots in sRGB on every OS, so pixel checks compare like with like:
      // macOS otherwise converts them to the display's colour profile.
      '--force-color-profile=srgb',
      ...(options.args ?? []),
    ],
    cwd: REPO_ROOT,
    // Without this, Playwright turns Chromium's sandbox off on Linux.
    chromiumSandbox: true,
    ...(options.appColorScheme ? { colorScheme: null } : {}),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('load');
  await waitForShell(page);
  return new PevApp(app, page, userData, openedAtLaunch);
}

/**
 * The log lines of every app launch under `dirs`, oldest first, as
 * "proc code data". Logs hold fixed codes and redacted data only.
 */
function logLinesUnder(dirs: string[]): string[] {
  const lines: LogLine[] = [];
  const visit = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (name === 'logs') {
        for (const file of readdirSync(path).filter((f) => f.endsWith('.jsonl'))) {
          for (const line of readFileSync(join(path, file), 'utf8').split('\n')) {
            if (line) lines.push(JSON.parse(line) as LogLine);
          }
        }
      } else if (depth < 3) {
        visit(path, depth + 1);
      }
    }
  };
  for (const dir of dirs) visit(dir, 0);
  return lines
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .map((l) => `${l.proc} ${l.code} ${JSON.stringify(l.data)}`);
}

export const test = base.extend<{ pev: PevApp; testDirs: void }>({
  // Removes the folders the test made under test-output/ once it passed,
  // after every other fixture (the app included) has been torn down. A
  // failed test keeps them as evidence.
  testDirs: [
    // Playwright requires an object pattern as the first fixture argument.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      takeTestDirs();
      await use();
      const dirs = takeTestDirs();
      if (testInfo.status === testInfo.expectedStatus && testInfo.errors.length === 0) {
        removeTestDirs(dirs);
      } else {
        // The apps' logs, for a failure seen only where the test output isn't kept.
        const lines = logLinesUnder(dirs).slice(-300);
        console.log(`app logs of "${testInfo.title}":\n${lines.join('\n')}`);
      }
    },
    { auto: true },
  ],
  // eslint-disable-next-line no-empty-pattern
  pev: async ({}, use, testInfo) => {
    const pev = await launch(testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 40));
    expect(await pev.main('dialogsStubbed')).toBe(true);
    expect(await pev.main('externalStubbed')).toBe(true);
    await use(pev);
    // Test runs stay in the background: no window was ever shown or focused,
    // and no native dialog was opened.
    if (testInfo.status === testInfo.expectedStatus) {
      const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
      expect(windows.length).toBeGreaterThan(0);
      expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
      expect(await pev.main('windowEvents')).toEqual([]);
      expect(await pev.main('dialogCalls')).toEqual([]);
      if (testInfo.tags.includes(PANE)) {
        expect(await pev.main('stubOpens')).toBe(0);
        for (const page of pev.app.windows()) {
          expect(await page.locator('iframe.body-frame').count()).toBe(0);
        }
      }
    }
    await pev.close();
  },
});

export { expect };

export function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}
