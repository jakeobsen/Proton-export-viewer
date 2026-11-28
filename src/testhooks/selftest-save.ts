// SPDX-License-Identifier: AGPL-3.0-or-later
// The self-test's save check, for the sandboxed build. In a new folder of its
// own inside the app's container, marked with the run's nonce, it writes a
// synthetic message, makes that folder's `downloads` the downloads folder,
// and saves the message's attachment twice through the real save path: once
// as a user would, and once with the publish forced to its copy. Each staged
// download is hard-linked into the folder before it is published, so the
// runner can read the attributes macOS gave it. The runner reads the
// quarantine attribute of every file from outside the app, then removes the
// folder.

import { createHash } from 'node:crypto';
import { linkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { MessageOpenResult, SaveResult } from '../shared/api';
import type { AppContext, AppWindow } from '../main/context';
import { createWorkspace } from '../../tools/bench/workspace.mjs';
import { markLoaded } from './marker';
import { READER_SOURCE_ACTION } from './reader-source';

markLoaded();

export const SAVE_CHECK_PREFIX = 'save-check-';

export interface SavedCheck {
  publish: 'link' | 'copy' | null;
  path: string | null;
  /** A hard link to the staged download, made before it was published. */
  staged: string | null;
  bytes: number | null;
  sha256: string | null;
}

export interface SaveCheck {
  folder: string | null;
  expectedSha256: string;
  saves: SavedCheck[];
  error: string | null;
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The attachment's bytes, and a message that carries them. */
function syntheticMessage(): { eml: string; bytes: Buffer } {
  const bytes = Buffer.from('self-test attachment\n'.repeat(64));
  const lines = (bytes.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  const eml = [
    'Subject: Save check',
    'From: <sender@example.org>',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain',
    '',
    'One attachment.',
    '--m',
    'Content-Type: application/octet-stream; name="check.bin"',
    'Content-Disposition: attachment; filename="check.bin"',
    'Content-Transfer-Encoding: base64',
    '',
    lines,
    '--m--',
    '',
  ].join('\r\n');
  return { eml, bytes };
}

export async function runSaveCheck(
  ctx: AppContext,
  appWin: AppWindow,
  nonce: string,
): Promise<SaveCheck> {
  const { eml, bytes } = syntheticMessage();
  const check: SaveCheck = { folder: null, expectedSha256: sha(bytes), saves: [], error: null };
  const saves = ctx.saves;
  try {
    if (!saves) throw new Error('no saves');
    const folder = createWorkspace(
      join(app.getPath('userData'), `${SAVE_CHECK_PREFIX}${nonce}`),
      nonce,
      ['source', 'downloads', 'staged'],
    );
    check.folder = folder;
    writeFileSync(join(folder, 'source', 'check.eml'), eml);
    const set = await ctx.core.request({
      type: 'test',
      action: READER_SOURCE_ACTION,
      payload: { root: join(folder, 'source'), entries: [[1, { file: 'check.eml' }]] },
    });
    if (!set.ok) throw new Error('reader source');
    // Never the real downloads folder: the check's own, before any save.
    app.setPath('downloads', join(folder, 'downloads'));

    const shell = <T>(code: string) => appWin.win.webContents.executeJavaScript(code) as Promise<T>;
    const opened = await shell<MessageOpenResult>('window.__pevTest.openInReader(1, "plain")');
    if (!opened.ok || opened.outcome !== 'view') throw new Error('open');

    for (const forceCopy of [false, true]) {
      const entry: SavedCheck = {
        publish: null,
        path: null,
        staged: null,
        bytes: null,
        sha256: null,
      };
      check.saves.push(entry);
      saves.test = {
        ...(forceCopy ? { forceCopy: true } : {}),
        onStaged: (path) => {
          entry.staged = join(folder, 'staged', `${check.saves.length}.part`);
          linkSync(path, entry.staged);
          return Promise.resolve();
        },
        onPublished: (method, path) => {
          entry.publish = method;
          entry.path = path;
        },
      };
      const saved = await shell<SaveResult>('window.__pevTest.saveAttachment(0)');
      if (!saved.ok) throw new Error(`save: ${saved.code}`);
      if (entry.path) {
        const written = readFileSync(entry.path);
        entry.bytes = written.length;
        entry.sha256 = sha(written);
      }
    }
  } catch (err) {
    check.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (saves) saves.test = {};
  }
  return check;
}
