// SPDX-License-Identifier: AGPL-3.0-or-later
// File-system operations of the folder-access proof, shared by main, core and
// the reader worker. Every outcome carries the error code of the operation
// itself, so a sandbox denial (EPERM or EACCES) can't be confused with a
// missing file (ENOENT).

import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ProofExpect,
  ProofFileRead,
  ProofOpName,
  ProofOps,
  ProofOutcome,
  ProofScan,
  ProofTargets,
} from '../../shared/core-protocol';
import { markLoaded } from '../marker';

markLoaded();

export interface TreeEntry {
  /** Relative to the walked folder, "/" separated. */
  path: string;
  full: string;
  type: 'symlink' | 'dir' | 'fifo' | 'file' | 'other';
  /** Whole seconds. */
  mtime: number;
}

function codeOf(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN';
}

/** Runs `fn` and reports whether it succeeded, or the error code it failed with. */
export function attempt(fn: () => void): ProofOutcome {
  try {
    fn();
    return { ok: true, code: null };
  } catch (err) {
    return { ok: false, code: codeOf(err) };
  }
}

/** True for the errors a sandbox denial gives: EPERM or EACCES. */
export function isDenial(outcome: ProofOutcome | null): boolean {
  return outcome !== null && !outcome.ok && (outcome.code === 'EPERM' || outcome.code === 'EACCES');
}

/** True if `outcome` is what `expect` asks for: a denial, or a success. */
export function asExpected(outcome: ProofOutcome | null, expect: ProofExpect): boolean {
  if (outcome === null) return false;
  return expect === 'denied' ? isDenial(outcome) : outcome.ok;
}

/** The change checks, in the order they run. */
export const PROOF_OPS: readonly ProofOpName[] = ['write', 'create', 'rename', 'remove'];

/**
 * Every entry below `root`, depth first, names in byte order. Symbolic links
 * are never followed and FIFOs never opened.
 */
export function walk(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const visit = (dir: string, prefix: string) => {
    const names = readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const name of names) {
      const full = join(dir, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      const type = st.isSymbolicLink()
        ? 'symlink'
        : st.isDirectory()
          ? 'dir'
          : st.isFIFO()
            ? 'fifo'
            : st.isFile()
              ? 'file'
              : 'other';
      out.push({ path, full, type, mtime: Math.floor(st.mtimeMs / 1000) });
      if (type === 'dir') visit(full, path);
    }
  };
  visit(root, '');
  return out;
}

/**
 * Reads every entry below `root` and digests it: SHA-256 over one line per
 * entry, in walk order, "<type> <path> <mtime> <SHA-256 of the content |
 * link target | ->". This is the digest the synthetic export generator writes
 * into its manifest, so a match shows the whole folder was listed and read.
 */
export function scanTree(root: string): ProofScan {
  try {
    const hash = createHash('sha256');
    let files = 0;
    const entries = walk(root);
    for (const entry of entries) {
      let detail = '-';
      if (entry.type === 'file') {
        detail = createHash('sha256').update(readFileSync(entry.full)).digest('hex');
        files += 1;
      } else if (entry.type === 'symlink') {
        detail = readlinkSync(entry.full);
      }
      hash.update(`${entry.type} ${entry.path} ${entry.mtime} ${detail}\n`);
    }
    return { ok: true, code: null, digest: hash.digest('hex'), entries: entries.length, files };
  } catch (err) {
    return { ok: false, code: codeOf(err), digest: null, entries: 0, files: 0 };
  }
}

/** Reads one file: its size and SHA-256, or the error code. */
export function readFile(path: string): ProofFileRead {
  try {
    const bytes = readFileSync(path);
    return {
      ok: true,
      code: null,
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (err) {
    return { ok: false, code: codeOf(err), path, bytes: null, sha256: null };
  }
}

/**
 * The four changes the proof expects the sandbox to deny inside an export, in
 * this order: append to an existing file, create a new file, rename a file and
 * delete a file. They run one at a time, and the first outcome that is not
 * what `expect` asks for ends them: the later ones stay null and never run.
 * Where they succeed (the unsandboxed control), they really change the
 * folder, so they only ever run on a sacrificial pair or a scratch copy.
 */
export function changeOps(targets: ProofTargets, expect: ProofExpect): ProofOps {
  const run: Record<ProofOpName, () => void> = {
    write: () => {
      const fd = openSync(targets.write, 'r+');
      try {
        writeSync(fd, '\n', fstatSync(fd).size);
      } finally {
        closeSync(fd);
      }
    },
    create: () => writeFileSync(targets.create, 'created\n', { flag: 'wx' }),
    rename: () => renameSync(targets.rename, `${targets.rename}.renamed`),
    remove: () => unlinkSync(targets.remove),
  };
  const ops: ProofOps = { write: null, create: null, rename: null, remove: null };
  for (const name of PROOF_OPS) {
    const outcome = attempt(run[name]);
    ops[name] = outcome;
    if (!asExpected(outcome, expect)) break;
  }
  return ops;
}

/** True if every change check ran and gave what `expect` asks for. */
export function allAsExpected(ops: ProofOps, expect: ProofExpect): boolean {
  return PROOF_OPS.every((name) => asExpected(ops[name], expect));
}

export interface ExportTargets {
  /** The message pair the reads use: its .metadata.json and .eml. */
  read: [string, string];
  /** Change targets for main and for core, each on its own sacrificial pair. */
  main: ProofTargets;
  core: ProofTargets;
}

/**
 * Picks the files the proof uses in an export: the first complete message
 * pair (metadata and .eml) in path order for the reads, and the last two for
 * main's and core's change checks. `tag` makes the created files' names unique.
 */
export function exportTargets(root: string, tag: string): ExportTargets {
  const entries = walk(root);
  const files = new Set(entries.filter((e) => e.type === 'file').map((e) => e.full));
  const pairs = entries
    .filter((e) => e.type === 'file' && e.path.endsWith('.metadata.json'))
    .map((e) => [e.full, e.full.slice(0, -'.metadata.json'.length) + '.eml'] as const)
    .filter(([, eml]) => files.has(eml));
  const first = pairs[0];
  const mainPair = pairs[pairs.length - 2];
  const corePair = pairs[pairs.length - 1];
  if (pairs.length < 3 || !first || !mainPair || !corePair) {
    throw new Error('the export needs at least three complete message pairs');
  }
  const dir = dirname(first[0]);
  const targets = (pair: readonly [string, string], who: string): ProofTargets => ({
    write: pair[1],
    create: join(dir, `proof-${who}-${tag}.created`),
    rename: pair[0],
    remove: pair[1],
  });
  return {
    read: [first[0], first[1]],
    main: targets(mainPair, 'main'),
    core: targets(corePair, 'core'),
  };
}
