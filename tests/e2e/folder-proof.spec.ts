// SPDX-License-Identifier: AGPL-3.0-or-later
// Positive control for the folder-access proof. The unsandboxed test build
// runs the proof's reads and changes on scratch copies of two exports, and all
// of them succeed: so where the sandboxed build gets denials, they come from
// the sandbox, not from the operations.
//
// PEV_PROOF_EXPORTS="<first>:<second>" names two generated exports, each with
// its manifest next to it (<export>.manifest.json). They are copied into one
// fixed scratch folder, replaced on every run, and must match their manifests
// before and after, whatever the outcome. Without it, the test makes two
// small exports itself. The copies keep the originals' file permissions: a
// second test shows that a read-only original gives a read-only copy, where
// the changes fail.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, sep } from 'node:path';
import { overlaps } from '../../scripts/folder-proof-exports.mjs';
import { removeOutputDir } from '../../scripts/test-output.mjs';
import type { ProofFileRead, ProofOps, ProofScan } from '../../src/shared/core-protocol';
import { scanTree, walk } from '../../src/testhooks/proof/fs';
import { copyTree, unlockFolders } from '../copy-tree';
import { permissionDenials } from '../permission-check';
import { TEST_OUTPUT, testDir } from '../paths';
import { expect, test } from './app';

const SCRATCH = join(TEST_OUTPUT, 'folder-proof-control');
/** Bytes of file content per scratch copy. */
const COPY_CAP = 20_000_000;

interface Read {
  corePid: number;
  scan: ProofScan;
  worker: ProofFileRead[] | null;
  main: ProofFileRead[];
}

interface Change {
  targets: { main: Record<string, string>; core: Record<string, string> };
  main: ProofOps;
  core: ProofOps | null;
}

interface ControlResult {
  read: Read;
  change: Change;
  corePidBefore: number | undefined;
  corePidAfter: number | undefined;
  secondRead: Read;
  firstExport: { file: string; core: ProofFileRead; main: ProofFileRead };
  secondChange: Change;
}

/** A small export: one account, one run folder, labels and `pairs` messages. */
function makeExport(root: string, pairs: number): string {
  const run = join(root, 'proof@example.com', 'mail_20250101_000000');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'labels.json'), JSON.stringify({ Version: 1, Payload: [] }));
  for (let i = 0; i < pairs; i += 1) {
    const id = `proof-message-${String(i).padStart(3, '0')}`;
    writeFileSync(join(run, `${id}.metadata.json`), JSON.stringify({ Payload: { ID: id } }));
    writeFileSync(
      join(run, `${id}.eml`),
      `Subject: message ${i}\r\nMessage-ID: <${id}@example.com>\r\n\r\nBody ${i}\r\n`,
    );
  }
  return root;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function manifestDigest(original: string): string {
  const manifest = JSON.parse(readFileSync(`${original}.manifest.json`, 'utf8')) as {
    digest: string;
  };
  return manifest.digest;
}

const digestOf = (folder: string) => scanTree(folder).digest;
const modeOf = (path: string) => lstatSync(path).mode & 0o777;

/** Every change succeeded, from main and core, really happened, and stayed in `copy`. */
function expectChanged(change: Change, copy: string) {
  const ok = { ok: true, code: null };
  expect(change.main).toEqual({ write: ok, create: ok, rename: ok, remove: ok });
  expect(change.core).toEqual({ write: ok, create: ok, rename: ok, remove: ok });
  for (const targets of [change.targets.main, change.targets.core]) {
    for (const target of Object.values(targets)) expect(target.startsWith(copy + sep)).toBe(true);
    expect(existsSync(targets.create!)).toBe(true);
    expect(existsSync(`${targets.rename}.renamed`)).toBe(true);
    expect(existsSync(targets.remove!)).toBe(false);
  }
}

/** Core read the whole copy, and its worker read the pair as main did. */
function expectRead(read: Read, digest: string | null) {
  expect(read.scan).toMatchObject({ ok: true, digest });
  expect(read.worker).toHaveLength(2);
  expect(read.worker?.map((r) => [r.ok, r.sha256])).toEqual(
    read.main.map((r) => [true, sha256(r.path)]),
  );
}

/**
 * Removes the scratch folder, a read-only copy included: owner access to the
 * folders inside it is restored first (no link is followed), then the
 * test-output guard removes it.
 */
function removeScratch() {
  unlockFolders(TEST_OUTPUT, SCRATCH);
  removeOutputDir(TEST_OUTPUT, SCRATCH);
  expect(existsSync(SCRATCH)).toBe(false);
}

/**
 * Replaces the scratch folder with bounded copies of the two originals.
 * Neither may lie in or around the scratch folder (checked before it is
 * removed), nor in or around the other.
 */
function copyIntoScratch(originals: string[]): [string, string] {
  mkdirSync(TEST_OUTPUT, { recursive: true });
  const physicalScratch = join(realpathSync(TEST_OUTPUT), basename(SCRATCH));
  for (const original of originals) {
    expect(overlaps(original, physicalScratch), `${original} and the scratch folder`).toBe(false);
  }
  expect(overlaps(originals[0]!, originals[1]!), 'the two originals').toBe(false);
  removeScratch();
  mkdirSync(SCRATCH);
  const copies = originals.map((original, i) => {
    const copy = join(SCRATCH, `${i + 1}-${basename(original)}`);
    copyTree(original, copy, COPY_CAP);
    return copy;
  });
  return copies as [string, string];
}

/** Gives every folder (`dirs`) and file (`files`) in `root`, and `root`, that mode. */
function setModes(root: string, dirs: number, files: number) {
  for (const entry of walk(root).reverse()) {
    chmodSync(entry.full, entry.type === 'dir' ? dirs : files);
  }
  chmodSync(root, dirs);
}

test('the proof operations all succeed without the sandbox', async ({ pev }) => {
  const named = process.env.PEV_PROOF_EXPORTS?.split(':');
  const originals = (
    named ??
    (() => {
      const dir = testDir('folder-proof-originals');
      return [makeExport(join(dir, 'first'), 4), makeExport(join(dir, 'second'), 5)];
    })()
  ).map((o) => realpathSync(o));
  expect(originals).toHaveLength(2);
  const expected = named ? named.map(manifestDigest) : originals.map(digestOf);
  expect(originals.map(digestOf)).toEqual(expected);
  // Ordinary permissions must allow every read and change in the originals,
  // and the copies keep them: so the denials of the sandboxed build can only
  // come from the sandbox.
  expect(originals.map(permissionDenials)).toEqual([[], []]);

  try {
    const [copyA, copyB] = copyIntoScratch(originals);
    expect([copyA, copyB].map(digestOf)).toEqual(expected);
    expect([copyA, copyB].map(permissionDenials)).toEqual([[], []]);

    const result = await pev.main<ControlResult>('folderProofControl', copyA, copyB);

    // Steps 1 and 2 on copy A.
    expectRead(result.read, expected[0]!);
    expectChanged(result.change, copyA);

    // Step 4: after a core restart, core reads copy B and a file of copy A,
    // and main and core change copy B too.
    expect(result.corePidBefore).toBeGreaterThan(0);
    expect(result.corePidAfter).toBeGreaterThan(0);
    expect(result.corePidAfter).not.toBe(result.corePidBefore);
    expectRead(result.secondRead, expected[1]!);
    expect(result.firstExport.file.startsWith(copyA + sep)).toBe(true);
    expect(result.firstExport.core).toMatchObject({
      ok: true,
      sha256: sha256(result.firstExport.file),
    });
    expect(result.firstExport.main.ok).toBe(true);
    expectChanged(result.secondChange, copyB);
  } finally {
    expect
      .soft(originals.map(digestOf), 'the originals still match their manifests')
      .toEqual(expected);
  }
  if (test.info().errors.length === 0) removeScratch();
});

test('a read-only original gives a read-only copy, where the changes fail', async ({ pev }) => {
  test.skip(process.getuid?.() === 0, 'file modes do not bind root');
  const dir = testDir('folder-proof-read-only');
  const locked = realpathSync(makeExport(join(dir, 'locked'), 4));
  const open = realpathSync(makeExport(join(dir, 'open'), 4));
  setModes(locked, 0o555, 0o444);
  try {
    expect(permissionDenials(locked)).not.toEqual([]);
    const [copyA, copyB] = copyIntoScratch([locked, open]);
    for (const entry of [{ full: locked, path: '' }, ...walk(locked)]) {
      const copy = join(copyA, ...entry.path.split('/'));
      expect([entry.path, modeOf(copy)]).toEqual([entry.path, modeOf(entry.full)]);
    }

    const result = await pev.main<ControlResult>('folderProofControl', copyA, copyB);

    // The first change on copy A fails with the copy's own permissions, so
    // the checks end there and core never tries; copy B still changes.
    expect(result.change.main).toEqual({
      write: { ok: false, code: 'EACCES' },
      create: null,
      rename: null,
      remove: null,
    });
    expect(result.change.core).toBeNull();
    expectChanged(result.secondChange, copyB);

    // The read-only copy is removed with the rest of the scratch folder.
    removeScratch();
  } finally {
    setModes(locked, 0o755, 0o644);
  }
});
