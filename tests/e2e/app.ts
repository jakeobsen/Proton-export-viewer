// SPDX-License-Identifier: AGPL-3.0-or-later
// Launches the e2e build (production bundles plus test hooks) unpackaged with
// the stock Electron binary. Each launch gets its own userData under test-output/.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  test as base,
  _electron as electron,
  expect,
  type ElectronApplication,
  type Frame,
  type Page,
} from '@playwright/test';
import { REPO_ROOT, testDir } from '../paths';

export interface LogLine {
  ts: string;
  level: string;
  proc: string;
  code: string;
  data: Record<string, unknown>;
}

export class PevApp {
  readonly consoleMessages: Array<{ type: string; text: string }> = [];

  constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
    readonly userData: string,
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

  async close(): Promise<void> {
    await this.app.close().catch(() => undefined);
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

export async function launch(name: string): Promise<PevApp> {
  const userData = testDir(`e2e-${name}`);
  const app = await electron.launch({
    args: [join(REPO_ROOT, 'out-test'), `--pev-user-data=${userData}`],
    cwd: REPO_ROOT,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('load');
  await waitForShell(page);
  return new PevApp(app, page, userData);
}

export const test = base.extend<{ pev: PevApp }>({
  // Playwright requires an object pattern as the first fixture argument.
  // eslint-disable-next-line no-empty-pattern
  pev: async ({}, use, testInfo) => {
    const pev = await launch(testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 40));
    expect(await pev.main('dialogsStubbed')).toBe(true);
    await use(pev);
    // Test runs stay in the background: no window was ever shown or focused,
    // and no native dialog was opened.
    if (testInfo.status === testInfo.expectedStatus) {
      const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
      expect(windows.length).toBeGreaterThan(0);
      expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
      expect(await pev.main('windowEvents')).toEqual([]);
      expect(await pev.main('dialogCalls')).toEqual([]);
    }
    await pev.close();
  },
});

export { expect };

export function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}
