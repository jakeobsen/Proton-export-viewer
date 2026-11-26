// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes one synthetic export corpus.
//
//   node tools/gen-export/gen-export.mjs <perf|small|stress|hostile> --seed <n> --out <dir>
//       [--nonce <id>] [--dry-run]
//
// --out must not exist yet; its parent folder holds all corpora. The hostile
// profile needs --nonce (6 to 32 lowercase letters and digits): every
// external reference in it names leak-<nonce>.test.
//
// Before writing, it prints the projected size and refuses (exit 75) when all
// corpora in that parent folder would pass 600 MiB, counting 40 MiB kept for
// scratch and container copies, or when less than 20 GiB of disk would stay
// free. While writing, it stops at the same limit, removes what it wrote and
// exits 75. The 10 MB and 50 MB messages and the 200 MB parts are never
// written: tests stream them with largeMessage() from stream.mjs.
//
// File times: folders and labels.json carry the export start
// (2025-06-30 12:00:00 UTC); message files carry one second later for every
// 20 pairs, in file-name order.
//
// It writes <out>.manifest.json with the seed, nonce, destination, counts per
// category, total bytes and the digest from tree.mjs.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  rmSync,
  statfsSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { METADATA_BYTES, PROFILES, RUN_FOLDER, entries } from './generator.mjs';
import { diskBytes, digest } from './tree.mjs';

const MIB = 1024 * 1024;
/** All corpora together, scratch and container copies included. */
export const CORPORA_CAP = 600 * MIB;
/** Kept for the scratch copies of the small exports and a container corpus. */
export const COPIES_RESERVE = 40 * MIB;
/** Disk space that must stay free. */
export const MIN_FREE = 20 * 1024 * MIB;

/** The corpus's size before writing: {files, bytes, disk, summary}. */
export function project(profile, options, blockSize = 4096) {
  let files = 0;
  let bytes = 0;
  let disk = 0;
  let summary = null;
  for (const entry of entries(profile, options)) {
    if (entry.meta) {
      summary = entry;
      continue;
    }
    files += 1;
    if (entry.type === 'file') {
      bytes += entry.data.length;
      disk += Math.ceil(entry.data.length / blockSize) * blockSize;
    } else {
      disk += blockSize;
    }
  }
  return { files, bytes, disk, summary };
}

/** Whether a corpus of `projected` bytes fits; with the reason when not. */
export function checkBudget({ projected, corporaBytes, freeBytes }) {
  const total = corporaBytes + projected + COPIES_RESERVE;
  if (total > CORPORA_CAP) {
    return {
      ok: false,
      total,
      reason: `all corpora would take ${mib(total)} MiB (limit ${mib(CORPORA_CAP)} MiB)`,
    };
  }
  if (freeBytes - projected < MIN_FREE) {
    return {
      ok: false,
      total,
      reason: `only ${gib(freeBytes - projected)} GiB of disk would stay free (need ${gib(MIN_FREE)})`,
    };
  }
  return { ok: true, total, reason: null };
}

function mib(bytes) {
  return (bytes / MIB).toFixed(1);
}

function gib(bytes) {
  return (bytes / 1024 / MIB).toFixed(1);
}

class LimitReached extends Error {}

function write(profile, options, out, allowance) {
  mkdirSync(out);
  const dirs = [];
  let written = 0;
  for (const entry of entries(profile, options)) {
    if (entry.meta) continue;
    const path = join(out, entry.path);
    if (entry.type === 'dir') {
      mkdirSync(path);
      dirs.push([path, entry.mtime]);
    } else if (entry.type === 'file') {
      writeFileSync(path, entry.data);
      utimesSync(path, entry.mtime, entry.mtime);
    } else if (entry.type === 'symlink') {
      symlinkSync(entry.target, path);
      lutimesSync(path, entry.mtime, entry.mtime);
    } else if (entry.type === 'fifo') {
      const made = spawnSync('/usr/bin/mkfifo', ['-m', '0644', path]);
      if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
      utimesSync(path, entry.mtime, entry.mtime);
    }
    written += lstatSync(path).blocks * 512;
    if (written > allowance) throw new LimitReached();
  }
  // Folder times last, deepest first, because writing into a folder moves its time.
  for (const [path, mtime] of dirs.reverse()) utimesSync(path, mtime, mtime);
}

function usage(message) {
  if (message) console.error(`gen-export: ${message}`);
  console.error(
    `usage: node tools/gen-export/gen-export.mjs <${Object.keys(PROFILES).join('|')}> --seed <n> --out <dir> [--nonce <id>] [--dry-run]`,
  );
  process.exit(64);
}

function parse(argv) {
  const [profile, ...rest] = argv;
  if (!profile || !Object.hasOwn(PROFILES, profile))
    usage(profile ? `unknown profile ${profile}` : '');
  const options = { profile, seed: null, out: null, nonce: null, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (['--seed', '--out', '--nonce'].includes(arg) && i + 1 < rest.length) {
      options[arg.slice(2)] = rest[++i];
    } else usage(`unexpected argument ${arg}`);
  }
  if (!/^\d{1,9}$/.test(options.seed ?? '')) usage('--seed must be a whole number');
  options.seed = Number(options.seed);
  if (!options.out) usage('--out is required');
  if (profile === 'hostile' && !/^[a-z0-9]{6,32}$/.test(options.nonce ?? '')) {
    usage('the hostile profile needs --nonce: 6 to 32 lowercase letters and digits');
  }
  if (profile !== 'hostile' && options.nonce !== null)
    usage('--nonce is only for the hostile profile');
  return options;
}

function main() {
  const options = parse(process.argv.slice(2));
  const out = resolve(options.out);
  const corpora = dirname(out);
  if (existsSync(out)) {
    console.error(`gen-export: ${out} already exists; each corpus is generated once`);
    process.exit(73);
  }
  mkdirSync(corpora, { recursive: true });
  const fs = statfsSync(corpora);
  const settings = { seed: options.seed, nonce: options.nonce };
  const projected = project(options.profile, settings, fs.bsize);
  const corporaBytes = diskBytes(corpora);
  const freeBytes = fs.bavail * fs.bsize;
  const budget = checkBudget({ projected: projected.disk, corporaBytes, freeBytes });
  console.log(
    `gen-export: ${options.profile} seed ${options.seed}: ${projected.files} entries, ` +
      `${mib(projected.bytes)} MiB of content, ${mib(projected.disk)} MiB on disk (projected)`,
  );
  console.log(
    `gen-export: corpora in ${corpora}: ${mib(corporaBytes)} MiB now; with this one and ` +
      `${mib(COPIES_RESERVE)} MiB kept for copies: ${mib(budget.total)} of ${mib(CORPORA_CAP)} MiB; ` +
      `${gib(freeBytes - projected.disk)} GiB of disk would stay free`,
  );
  if (!budget.ok) {
    console.error(`gen-export: refused: ${budget.reason}`);
    process.exit(75);
  }
  if (options.dryRun) return;

  const allowance = CORPORA_CAP - COPIES_RESERVE - corporaBytes;
  try {
    write(options.profile, settings, out, allowance);
  } catch (err) {
    rmSync(out, { recursive: true, force: true });
    if (err instanceof LimitReached) {
      console.error('gen-export: stopped: the corpora reached their limit; nothing was kept');
      process.exit(75);
    }
    throw err;
  }

  const { summary } = projected;
  const manifest = {
    format: 1,
    profile: options.profile,
    seed: options.seed,
    nonce: options.nonce,
    destination: out,
    account: summary.account,
    run_folder: RUN_FOLDER,
    metadata_bytes: PROFILES[options.profile].kind === 'mix' ? METADATA_BYTES : null,
    file_times:
      'folders and labels.json: 2025-06-30T12:00:00Z; message files: one second later for every 20 pairs, in file-name order',
    streamed_at_run_time:
      options.profile === 'perf'
        ? 'the 10 MB and 50 MB messages (stream.mjs largeMessage)'
        : options.profile === 'hostile'
          ? 'the 200 MB text and HTML parts (stream.mjs largeMessage)'
          : null,
    file_order:
      options.profile === 'stress'
        ? 'names of the late small conversation start with "-" and the linker\'s with "z", so in byte order the small group comes first and the linker last'
        : null,
    probe_pair: options.profile === 'small' ? summary.probePair : null,
    counts: summary.counts,
    entries: projected.files,
    bytes: projected.bytes,
    disk_bytes: diskBytes(out),
    digest: digest(out),
  };
  writeFileSync(`${out}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `gen-export: wrote ${basename(out)}: ${mib(manifest.disk_bytes)} MiB on disk, digest ${manifest.digest}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
