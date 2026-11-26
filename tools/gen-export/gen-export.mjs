// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes one synthetic export corpus.
//
//   node tools/gen-export/gen-export.mjs <perf|small|stress|hostile> --seed <n> --out <dir>
//       [--nonce <id>] [--dry-run]
//
// Neither --out nor <out>.manifest.json may exist yet (exit 73); the parent
// folder holds all corpora. The hostile profile needs --nonce (6 to 32
// lowercase letters and digits): every external reference in it names
// leak-<nonce>.test.
//
// Before writing, it prints the projected size and refuses (exit 75) when all
// corpora in that parent folder would pass 600 MB (600,000,000 bytes),
// counting 40 MB kept for scratch and container copies, or when less than
// 20 GiB of disk would stay free. The projection rounds each file up to whole
// blocks and allows each folder a block plus twice the bytes of its entries,
// so it is never below what ext4 or APFS allocates. While writing, it counts
// each entry's allocated blocks and its share of its folder the same way and
// stops at the same limit (exit 75).
//
// It removes only what it created: the output folder once its own mkdir made
// it. On any failure it removes that folder, so no corpus stays without its
// manifest, which it creates exclusively.
//
// The 10 MB and 50 MB messages and the 200 MB parts are never written: tests
// stream them with largeMessage() from stream.mjs.
//
// File times: the output folder, the folders in it and labels.json carry the
// export start (2025-06-30 12:00:00 UTC); message files carry one second
// later for every 20 pairs, in file-name order.
//
// It writes <out>.manifest.json with the seed, nonce, destination, counts per
// category, the measured range of metadata sizes, total bytes and the digest
// from tree.mjs.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  openSync,
  rmSync,
  statfsSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXPORT_TIME, METADATA_BYTES, PROFILES, RUN_FOLDER, entries } from './generator.mjs';
import { diskBytes, digest } from './tree.mjs';

const MB = 1000 * 1000;
const GIB = 1024 * 1024 * 1024;
/** All corpora together, scratch and container copies included. */
export const CORPORA_CAP = 600 * MB;
/** Kept for the scratch copies of the small exports and a container corpus. */
export const COPIES_RESERVE = 40 * MB;
/** Disk space that must stay free. */
export const MIN_FREE = 20 * GIB;

/** Bytes an entry named `name` takes in its folder on ext4: 8 plus the name, in 4-byte units. */
function entryBytes(name) {
  return 8 + Math.ceil(Buffer.byteLength(name) / 4) * 4;
}

/**
 * A folder's size on disk, at most: a block, plus twice its entries' bytes in
 * whole blocks, since a large folder's index blocks are often half empty.
 * (APFS folders take no blocks at all.)
 */
function folderBytes(entriesBytes, blockSize) {
  return blockSize * (1 + Math.ceil((2 * entriesBytes) / blockSize));
}

/**
 * The corpus's size before writing: {files, bytes, disk, folders, summary}.
 * `disk` rounds each file up to whole blocks and adds `folders`, the folders'
 * share, the output folder included.
 */
export function project(profile, options, blockSize = 4096) {
  let files = 0;
  let bytes = 0;
  let disk = 0;
  let summary = null;
  // Bytes of the entries in each folder; '' is the output folder.
  const inFolder = new Map([['', 0]]);
  for (const entry of entries(profile, options)) {
    if (entry.meta) {
      summary = entry;
      continue;
    }
    files += 1;
    const slash = entry.path.lastIndexOf('/');
    const parent = slash === -1 ? '' : entry.path.slice(0, slash);
    inFolder.set(parent, (inFolder.get(parent) ?? 0) + entryBytes(entry.path.slice(slash + 1)));
    if (entry.type === 'dir') {
      if (!inFolder.has(entry.path)) inFolder.set(entry.path, 0);
    } else if (entry.type === 'file') {
      bytes += entry.data.length;
      disk += Math.ceil(entry.data.length / blockSize) * blockSize;
    } else {
      disk += blockSize;
    }
  }
  let folders = 0;
  for (const used of inFolder.values()) folders += folderBytes(used, blockSize);
  return { files, bytes, disk: disk + folders, folders, summary };
}

/** Whether a corpus of `projected` bytes fits; with the reason when not. */
export function checkBudget({ projected, corporaBytes, freeBytes }) {
  const total = corporaBytes + projected + COPIES_RESERVE;
  if (total > CORPORA_CAP) {
    return {
      ok: false,
      total,
      reason: `all corpora would take ${mb(total)} MB (limit ${mb(CORPORA_CAP)} MB)`,
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

function mb(bytes) {
  return (bytes / MB).toFixed(1);
}

function gib(bytes) {
  return (bytes / GIB).toFixed(1);
}

class LimitReached extends Error {}

/** Creates `path` with `text`; fails if it exists, and removes it again if writing fails. */
function createFile(path, text) {
  const fd = openSync(path, 'wx');
  try {
    writeFileSync(fd, text);
  } catch (err) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw err;
  }
  closeSync(fd);
}

/**
 * Writes the corpus into `out`, which this run has just created. Returns the
 * measured range of metadata file sizes, or null if it wrote none.
 */
function write(profile, options, out, allowance) {
  const dirs = [];
  let written = 0;
  let metadata = null;
  for (const entry of entries(profile, options)) {
    if (entry.meta) continue;
    const path = join(out, entry.path);
    if (entry.type === 'dir') {
      mkdirSync(path);
      dirs.push([path, entry.mtime]);
    } else if (entry.type === 'file') {
      writeFileSync(path, entry.data);
      utimesSync(path, entry.mtime, entry.mtime);
      if (path.endsWith('.metadata.json')) {
        const size = entry.data.length;
        metadata = {
          min: Math.min(metadata?.min ?? size, size),
          max: Math.max(metadata?.max ?? size, size),
        };
      }
    } else if (entry.type === 'symlink') {
      symlinkSync(entry.target, path);
      lutimesSync(path, entry.mtime, entry.mtime);
    } else if (entry.type === 'fifo') {
      const made = spawnSync('/usr/bin/mkfifo', ['-m', '0644', path]);
      if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
      utimesSync(path, entry.mtime, entry.mtime);
    }
    // Its blocks, and its share of its folder's growth.
    written += lstatSync(path).blocks * 512 + 2 * entryBytes(basename(path));
    if (written > allowance) throw new LimitReached();
  }
  // Folder times last, deepest first, because writing into a folder moves its
  // time; the output folder last of all.
  for (const [path, mtime] of dirs.reverse()) utimesSync(path, mtime, mtime);
  utimesSync(out, EXPORT_TIME, EXPORT_TIME);
  return metadata;
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
  const manifestPath = `${out}.manifest.json`;
  const corpora = dirname(out);
  for (const path of [out, manifestPath]) {
    if (existsSync(path)) {
      console.error(`gen-export: ${path} already exists; each corpus is generated once`);
      process.exit(73);
    }
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
      `${mb(projected.bytes)} MB of content, ${mb(projected.disk)} MB on disk (projected)`,
  );
  console.log(
    `gen-export: corpora in ${corpora}: ${mb(corporaBytes)} MB now; with this one and ` +
      `${mb(COPIES_RESERVE)} MB kept for copies: ${mb(budget.total)} of ${mb(CORPORA_CAP)} MB; ` +
      `${gib(freeBytes - projected.disk)} GiB of disk would stay free`,
  );
  if (!budget.ok) {
    console.error(`gen-export: refused: ${budget.reason}`);
    process.exit(75);
  }
  if (options.dryRun) return;

  // The output folder is this run's only once this mkdir made it, and only
  // then may a failure remove it.
  try {
    mkdirSync(out);
  } catch (err) {
    console.error(`gen-export: cannot create ${out}: ${err.message}`);
    process.exit(73);
  }
  const allowance = CORPORA_CAP - COPIES_RESERVE - corporaBytes;
  let manifest;
  try {
    const metadata = write(options.profile, settings, out, allowance);
    manifest = manifestFor(options, out, projected, metadata);
    createFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    // No corpus stays without its manifest. A manifest this run couldn't
    // create isn't touched.
    rmSync(out, { recursive: true, force: true });
    if (err instanceof LimitReached) {
      console.error('gen-export: stopped: the corpora reached their limit; nothing was kept');
      process.exit(75);
    }
    if (err?.code === 'EEXIST' && err.path === manifestPath) {
      console.error(`gen-export: ${manifestPath} appeared while writing; nothing was kept`);
      process.exit(73);
    }
    throw err;
  }
  console.log(
    `gen-export: wrote ${basename(out)}: ${mb(manifest.disk_bytes)} MB on disk, digest ${manifest.digest}`,
  );
}

function manifestFor(options, out, projected, metadata) {
  const { summary } = projected;
  return {
    format: 1,
    profile: options.profile,
    seed: options.seed,
    nonce: options.nonce,
    destination: out,
    account: summary.account,
    run_folder: RUN_FOLDER,
    metadata_bytes: metadata,
    metadata_target_bytes: PROFILES[options.profile].kind === 'mix' ? METADATA_BYTES : null,
    file_times:
      'the output folder, the folders in it and labels.json: 2025-06-30T12:00:00Z; message files: one second later for every 20 pairs, in file-name order',
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
