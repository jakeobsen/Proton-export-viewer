// SPDX-License-Identifier: AGPL-3.0-or-later
// Main-process test hook: opens one of the fixed placeholder bodies of the test
// hooks as a view of the sending window. The view follows the rules of a
// message view: the window's previous view goes as soon as the open is
// accepted, and only the newest open of the current generation is installed.

import { z } from 'zod';
import type { OpenResult } from '../shared/api';
import { TEST_IPC } from '../shared/test-ipc';
import type { AppContext } from '../main/context';
import { CoreUnavailableError } from '../main/core-host';
import { Generation, ipcGuard } from '../main/ipc';
import { bodyUrl } from '../main/views';
import { markLoaded } from './marker';

markLoaded();

const OpenStubArgs = z.tuple([
  z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), generation: Generation }).strict(),
]);

let opens = 0;

/** How many stub opens reached main, so a test can show it used none. */
export function stubOpens(): number {
  return opens;
}

export function registerOpenStub(ctx: AppContext): void {
  const { reject, guarded } = ipcGuard(ctx);
  guarded<OpenResult>(TEST_IPC.openStub, async (appWin, raw) => {
    opens += 1;
    const args = OpenStubArgs.safeParse(raw);
    if (!args.success) return reject('invalid', appWin);
    const [{ id, generation }] = args.data;
    if (generation !== ctx.generation) return reject('stale_generation', appWin);

    const { openId, token, revoked } = appWin.views.accept();
    if (revoked > 0) {
      ctx.log.info('view.revoked', { reason: 'replaced', count: revoked, windowId: appWin.id });
    }
    let result;
    try {
      // Only a core already up for the open source: a call from the shell
      // never starts one.
      result = await ctx.core.requestRunning(
        { type: 'open', openId, generation, token, stubId: id },
        ctx.sources.stamp(),
      );
    } catch (err) {
      if (!(err instanceof CoreUnavailableError)) throw err;
      ctx.log.warn('core.unavailable', { openId, windowId: appWin.id });
      return reject('core_unavailable', appWin);
    }
    if (!result.ok) return reject('invalid', appWin);
    if (!result.body || appWin.win.isDestroyed()) return reject('superseded', appWin);

    const outcome = appWin.views.install(openId, token, generation, ctx.generation, result.body);
    if (!outcome.ok) {
      ctx.log.info('open.stale', { reason: outcome.reason, openId, windowId: appWin.id });
      return reject(outcome.reason === 'generation' ? 'stale_generation' : 'superseded', appWin);
    }
    ctx.log.info('view.installed', { openId, windowId: appWin.id });
    return { ok: true, openId, url: bodyUrl(token) };
  });
}
