// SPDX-License-Identifier: AGPL-3.0-or-later
// Positive control for the folder-access proof. The unsandboxed test build
// runs the proof's reads and changes on scratch copies of two exports, and all
// of them succeed: so where the sandboxed build gets denials, they come from
// the sandbox, not from the operations.
//
// PEV_PROOF_EXPORTS="<first>:<second>" names two generated exports, each with
// its manifest next to it (<export>.manifest.json). They are copied into one
// fixed scratch folder, replaced on every run, and must match their manifests
// before and after. Without it, the test makes two small exports itself.

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { scanTree } from '../../src/testhooks/proof/fs';
import type { ProofFileRead, ProofOps, ProofScan } from '../../src/shared/core-protocol';
import { TEST_OUTPUT, testDir } from '../paths';
import { expect, test } from './app';

const SCRATCH = join(TEST_OUTPUT, 'folder-proof-control');

interface ControlResult {
  read: { corePid: number; scan: ProofScan; worker: ProofFileRead[] | null };
  change: {
    targets: { main: Record<string, string>; core: Record<string, string> };
    main: ProofOps;
    core: ProofOps;
  };
  corePidBefore: number | undefined;
  corePidAfter: number | undefined;
  secondRead: { corePid: number; scan: ProofScan; worker: ProofFileRead[] | null };
  firstExport: { file: string; core: ProofFileRead; main: ProofFileRead };
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

test('the proof operations all succeed without the sandbox', async ({ pev }) => {
  const named = process.env.PEV_PROOF_EXPORTS?.split(':');
  const originals = named
    ? named
    : (() => {
        const dir = testDir('folder-proof-originals');
        return [makeExport(join(dir, 'first'), 4), makeExport(join(dir, 'second'), 5)];
      })();
  expect(originals).toHaveLength(2);
  const expected = named ? originals.map(manifestDigest) : originals.map((o) => scanTree(o).digest);
  expect(originals.map((o) => scanTree(o).digest)).toEqual(expected);

  // One fixed scratch folder, replaced on every run. A link there is refused.
  if (existsSync(SCRATCH)) {
    expect(lstatSync(SCRATCH).isSymbolicLink()).toBe(false);
    rmSync(SCRATCH, { recursive: true, force: true });
  }
  const copies = originals.map((o, i) => join(SCRATCH, `${i + 1}-${basename(o)}`));
  originals.forEach((o, i) => cpSync(o, copies[i]!, { recursive: true, preserveTimestamps: true }));
  const copyDigests = copies.map((c) => scanTree(c).digest);

  const result = await pev.main<ControlResult>('folderProofControl', copies[0], copies[1]);

  // Step 1: core walked and read the whole first copy; its worker read a pair.
  expect(result.read.scan).toMatchObject({ ok: true, digest: copyDigests[0] });
  expect(result.read.worker?.map((r) => [r.ok, r.sha256])).toEqual(
    result.read.worker?.map((r) => [true, sha256(r.path)]),
  );
  expect(result.read.worker).toHaveLength(2);

  // Step 2: every change succeeds, from main and from core, and really happened.
  for (const ops of [result.change.main, result.change.core]) {
    expect(Object.values(ops)).toEqual(Array(4).fill({ ok: true, code: null }));
  }
  for (const targets of [result.change.targets.main, result.change.targets.core]) {
    expect(existsSync(targets.create!)).toBe(true);
    expect(existsSync(`${targets.rename}.renamed`)).toBe(true);
    expect(existsSync(targets.remove!)).toBe(false);
  }

  // Step 4: after a core restart, core reads the second copy and a file of the first.
  expect(result.corePidBefore).toBeGreaterThan(0);
  expect(result.corePidAfter).toBeGreaterThan(0);
  expect(result.corePidAfter).not.toBe(result.corePidBefore);
  expect(result.secondRead.scan).toMatchObject({ ok: true, digest: copyDigests[1] });
  expect(result.firstExport.core).toMatchObject({
    ok: true,
    sha256: sha256(result.firstExport.file),
  });
  expect(result.firstExport.main.ok).toBe(true);

  // The originals are untouched.
  expect(originals.map((o) => scanTree(o).digest)).toEqual(expected);
});
