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
// small exports itself.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { overlaps } from '../../scripts/folder-proof-exports.mjs';
import { removeOutputDir } from '../../scripts/test-output.mjs';
import type { ProofFileRead, ProofOps, ProofScan } from '../../src/shared/core-protocol';
import { scanTree } from '../../src/testhooks/proof/fs';
import { copyTree } from '../copy-tree';
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
  const [first, second] = originals as [string, string];
  const expected = named ? named.map(manifestDigest) : originals.map(digestOf);

  // Nothing here may touch an original: neither lies in or around the scratch
  // folder (checked before it is removed), nor in or around the other.
  mkdirSync(TEST_OUTPUT, { recursive: true });
  const physicalScratch = join(realpathSync(TEST_OUTPUT), basename(SCRATCH));
  for (const original of originals) {
    expect(overlaps(original, physicalScratch), `${original} and the scratch folder`).toBe(false);
  }
  expect(overlaps(first, second), 'the two originals').toBe(false);
  expect(originals.map(digestOf)).toEqual(expected);

  try {
    // One fixed scratch folder, replaced on every run, removed only through
    // the guard that refuses links on the way.
    removeOutputDir(TEST_OUTPUT, SCRATCH);
    expect(existsSync(SCRATCH)).toBe(false);
    mkdirSync(SCRATCH);
    const [copyA, copyB] = originals.map((o, i) => join(SCRATCH, `${i + 1}-${basename(o)}`)) as [
      string,
      string,
    ];
    copyTree(first, copyA, COPY_CAP);
    copyTree(second, copyB, COPY_CAP);
    expect([copyA, copyB].map(digestOf)).toEqual(expected);

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
  if (test.info().errors.length === 0) removeOutputDir(TEST_OUTPUT, SCRATCH);
});
