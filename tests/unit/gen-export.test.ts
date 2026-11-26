// SPDX-License-Identifier: AGPL-3.0-or-later
// The synthetic export generator (tools/gen-export): the export layout and
// field shapes, determinism, the conversation and size mix, the stress
// corpus's file order, the hostile corpus, the disk guard and the streams
// for very large messages.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  COPIES_RESERVE,
  CORPORA_CAP,
  MIN_FREE,
  checkBudget,
  project,
} from '../../tools/gen-export/gen-export.mjs';
import {
  METADATA_BYTES,
  RUN_FOLDER,
  UNKNOWN_LABEL_IDS,
  entries,
  guessedAttachmentEntry,
} from '../../tools/gen-export/generator.mjs';
import type { Entry, Summary } from '../../tools/gen-export/generator.mjs';
import {
  CANARY_IPS,
  IP_LITERAL_FORMS,
  dimensionBombPng,
  gif,
} from '../../tools/gen-export/hostile.mjs';
import { largeMessage } from '../../tools/gen-export/stream.mjs';
import { diskBytes, digest, walk } from '../../tools/gen-export/tree.mjs';
import { REPO_ROOT, testDir } from '../paths';

const CLI = join(REPO_ROOT, 'tools', 'gen-export', 'gen-export.mjs');
const MIB = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{86}==$/;
const METADATA_KEYS = [
  'ID',
  'AddressID',
  'LabelIDs',
  'ExternalID',
  'Subject',
  'Sender',
  'ToList',
  'CCList',
  'BCCList',
  'ReplyTos',
  'Flags',
  'Time',
  'Size',
  'Unread',
  'IsReplied',
  'IsRepliedAll',
  'IsForwarded',
  'NumAttachments',
  'Attachments',
  'MIMEType',
  'Headers',
  'WriterType',
];
const SYSTEM_IDS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '15', '16'];

function gen(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function json(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

interface Label {
  ID: string;
  Name: string;
  Path: string;
  ParentID: string;
  Color: string;
  Type: number;
}

function files(stream: Iterable<unknown>): Entry[] {
  return [...stream].filter((e): e is Entry => !(e as { meta?: boolean }).meta);
}

describe('a small corpus', () => {
  const root = testDir('gen-small');
  const out = join(root, 'small1');
  let run = '';

  beforeAll(() => {
    const made = gen(['small', '--seed', '1', '--out', out]);
    expect(made.stderr).toBe('');
    expect(made.status).toBe(0);
    expect(made.stdout).toMatch(/MiB on disk \(projected\)/);
    run = join(out, 'small1@example.com', RUN_FOLDER);
  });

  it('has the export layout: account folder, run folder, labels.json and pairs', () => {
    expect(readdirSync(out)).toEqual(['small1@example.com']);
    expect(readdirSync(join(out, 'small1@example.com'))).toEqual([RUN_FOLDER]);
    const names = readdirSync(run);
    expect(names).toContain('labels.json');
    const emls = names.filter((n) => n.endsWith('.eml')).map((n) => n.slice(0, -4));
    const metas = names.filter((n) => n.endsWith('.metadata.json')).map((n) => n.slice(0, -14));
    expect(emls.length).toBeGreaterThan(180);
    expect(metas.sort()).toEqual(emls.sort());
    expect(names).toHaveLength(1 + emls.length * 2);
    for (const id of emls) expect(id).toMatch(ID_RE);
  });

  it('writes labels.json with system labels, 95 user entries, nesting and odd colors', () => {
    const labels = json(join(run, 'labels.json'));
    expect(labels.Version).toBe(1);
    const payload: Label[] = labels.Payload;
    for (const label of payload) {
      expect(Object.keys(label)).toEqual(['ID', 'Name', 'Path', 'ParentID', 'Color', 'Type']);
    }
    const ids = payload.map((l) => l.ID);
    for (const id of SYSTEM_IDS) expect(ids).toContain(id);
    for (const id of UNKNOWN_LABEL_IDS) expect(ids).not.toContain(id);
    const user = payload.filter((l) => !SYSTEM_IDS.includes(l.ID));
    expect(user).toHaveLength(95);
    expect(user.filter((l) => l.Type === 3)).toHaveLength(7);
    expect(user.filter((l) => l.Type === 1)).toHaveLength(88);
    const nested = user.filter((l) => l.ParentID);
    expect(nested.length).toBeGreaterThan(0);
    for (const child of nested) {
      const parent = payload.find((l) => l.ID === child.ParentID);
      expect(parent).toBeDefined();
      expect(child.Path).toBe(`${parent?.Path}/${child.Name}`);
      expect(child.Type).toBe(parent?.Type);
    }
    expect(user.some((l) => !/^#[0-9A-Fa-f]{6}$/.test(l.Color))).toBe(true);
    expect(user.some((l) => /^#[0-9A-Fa-f]{6}$/.test(l.Color))).toBe(true);
  });

  it('writes metadata with every field, in order, and a matching .eml', () => {
    const labels: Label[] = json(join(run, 'labels.json')).Payload;
    const known = new Set([...labels.map((l) => l.ID), ...UNKNOWN_LABEL_IDS]);
    for (const name of readdirSync(run).filter((n) => n.endsWith('.metadata.json'))) {
      const id = name.slice(0, -14);
      const raw = readFileSync(join(run, name));
      expect(raw.length).toBeGreaterThanOrEqual(METADATA_BYTES.min - 100);
      expect(raw.length).toBeLessThanOrEqual(METADATA_BYTES.max);
      const meta = JSON.parse(raw.toString('utf8'));
      expect(meta.Version).toBe(1);
      const p = meta.Payload;
      expect(Object.keys(p)).toEqual(METADATA_KEYS);
      expect(p.ID).toBe(id);
      expect(p.LabelIDs.length).toBeGreaterThanOrEqual(1);
      expect(p.LabelIDs.length).toBeLessThanOrEqual(6);
      for (const label of p.LabelIDs) expect(known.has(label)).toBe(true);
      expect(Object.keys(p.Sender)).toEqual(['Name', 'Address']);
      expect(Number.isInteger(p.Time)).toBe(true);
      expect(p.NumAttachments).toBe(p.Attachments.length);
      const eml = readFileSync(join(run, `${id}.eml`));
      expect(p.Size).toBe(eml.length);
      const text = eml.toString('latin1');
      const head = text.slice(0, text.indexOf('\r\n\r\n'));
      expect(head.replace(/\r\n\s+/g, ' ')).toContain(`<${id}@protonmail.internalid>`);
      expect(p.Headers).not.toContain('protonmail.internalid');
      if (p.Headers.includes('Message-ID:')) expect(head).toContain('Message-ID:');
    }
  });

  it('projects the allocated size it then writes', () => {
    // The guard counts allocated blocks. The projection rounds each file up
    // to whole blocks and allows each folder a block plus twice its entries'
    // bytes: never less than ext4, whose folders grow with their entries,
    // allocates, and more than APFS, whose folders take no blocks, by at most
    // the folders' share.
    const written = diskBytes(out);
    expect(json(`${out}.manifest.json`).disk_bytes).toBe(written);
    const projected = project('small', { seed: 1 });
    expect(projected.disk).toBeGreaterThanOrEqual(written);
    expect(projected.disk).toBeLessThanOrEqual(written + projected.folders + 16 * 1024);
  });

  it('writes a manifest with the digest of what it wrote', () => {
    const manifest = json(`${out}.manifest.json`);
    expect(manifest).toMatchObject({
      profile: 'small',
      seed: 1,
      nonce: null,
      destination: out,
      account: 'small1@example.com',
      run_folder: RUN_FOLDER,
    });
    expect(manifest.digest).toBe(digest(out));
    expect(manifest.counts.messages).toBe(
      readdirSync(run).filter((n) => n.endsWith('.eml')).length,
    );
    expect(existsSync(join(run, `${manifest.probe_pair}.eml`))).toBe(true);
    expect(manifest.disk_bytes).toBeGreaterThan(0);
  });

  it('gives the same files and digest for the same seed, and others for another', () => {
    const again = join(testDir('gen-small-again'), 'small1');
    expect(gen(['small', '--seed', '1', '--out', again]).status).toBe(0);
    expect(json(`${again}.manifest.json`).digest).toBe(json(`${out}.manifest.json`).digest);
    expect(walk(again).map((e) => [e.path, e.mtime])).toEqual(
      walk(out).map((e) => [e.path, e.mtime]),
    );
    const other = join(testDir('gen-small-other'), 'small2');
    expect(gen(['small', '--seed', '2', '--out', other]).status).toBe(0);
    expect(json(`${other}.manifest.json`).digest).not.toBe(json(`${out}.manifest.json`).digest);
    expect(readdirSync(other)).toEqual(['small2@example.com']);
  });

  it('sets file times from the export start, 20 pairs a second in name order', () => {
    const start = Date.UTC(2025, 5, 30, 12, 0, 0) / 1000;
    const list = walk(out);
    for (const e of list.filter((x) => x.type === 'dir' || x.path.endsWith('labels.json'))) {
      expect(e.mtime).toBe(start);
    }
    const emls = list.filter((e) => e.path.endsWith('.eml'));
    for (const [k, e] of emls.entries()) expect(e.mtime).toBe(start + 1 + Math.floor(k / 20));
  });
});

describe('the perf profile', () => {
  it('has the size and conversation mix, and every special case', () => {
    const noAttachments: number[] = [];
    const metadata: number[] = [];
    let summary: Summary | null = null;
    let disk = 0;
    for (const e of entries('perf', { seed: 1 })) {
      if ('meta' in e) {
        summary = e;
        continue;
      }
      disk += Math.ceil((e.data?.length ?? 0) / 4096) * 4096 || 4096;
      if (e.type !== 'file' || !e.data) continue;
      if (e.path.endsWith('.metadata.json')) metadata.push(e.data.length);
      else if (
        e.path.endsWith('.eml') &&
        !e.data.subarray(0, 4000).toString('latin1').includes('multipart/mixed')
      ) {
        noAttachments.push(e.data.length);
      }
    }
    const count = (name: string) => summary?.counts[name] ?? Number.NaN;
    const messages = count('messages');
    expect(messages).toBe(20000);
    expect(count('in_threads_2_to_50') / messages).toBeGreaterThan(0.57);
    expect(count('in_threads_2_to_50') / messages).toBeLessThan(0.63);
    expect(count('in_threads_1000_plus')).toBeGreaterThanOrEqual(3000);
    expect(count('largest_conversation')).toBeGreaterThanOrEqual(1000);
    expect(count('singletons')).toBeGreaterThan(0);
    expect(count('html') / messages).toBeGreaterThan(0.52);
    expect(count('html') / messages).toBeLessThan(0.58);
    expect(count('with_attachments') / messages).toBeGreaterThan(0.1);
    expect(count('with_attachments') / messages).toBeLessThan(0.14);
    for (const special of [
      'gaps',
      'duplicate_message_ids',
      'crafted_references',
      'phrase_form',
      'empty_ids',
      'no_message_id',
      'no_ids',
      'unknown_label_ids',
    ]) {
      expect(count(special), special).toBeGreaterThan(0);
    }
    expect(count('internalid_references')).toBe(messages);
    const sorted = noAttachments.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    expect(median).toBeGreaterThan(3600);
    expect(median).toBeLessThan(4600);
    expect(p95).toBeGreaterThan(14000);
    expect(p95).toBeLessThan(18500);
    expect(Math.max(...metadata)).toBeLessThanOrEqual(8192);
    expect(disk).toBeLessThan(440 * MIB);
  });
});

describe('the stress profile', () => {
  it('orders the late merge by file name and links the chain by In-Reply-To only', () => {
    const metas = files(entries('stress', { seed: 1 })).filter((e) =>
      e.path.endsWith('.metadata.json'),
    );
    expect(metas).toHaveLength(10000);
    const payloads = metas.map((e) => JSON.parse(e.data?.toString('utf8') ?? '{}').Payload);
    const ids = payloads.map((p) => p.ID as string);
    expect([...ids].sort()).toEqual(ids);
    const small = payloads.filter((p) => p.Subject.startsWith('Small '));
    const large = payloads.filter((p) => p.Subject.startsWith('Large '));
    const chain = payloads.filter((p) => p.Subject.startsWith('Chain '));
    expect([small.length, large.length, chain.length]).toEqual([5, 994, 9000]);
    expect(ids.slice(0, 5).every((id) => id.startsWith('-'))).toBe(true);
    expect(ids.slice(5).every((id) => !id.startsWith('-'))).toBe(true);
    const linker = payloads.at(-1);
    expect(linker.ID.startsWith('z')).toBe(true);
    expect(ids.slice(0, -1).every((id) => !id.startsWith('z'))).toBe(true);
    for (const p of chain) expect(p.Headers).not.toMatch(/^References:/m);
    expect(chain.filter((p) => /^In-Reply-To:/m.test(p.Headers))).toHaveLength(8999);
    expect(chain.map((p) => p.Subject)).not.toEqual(chain.map((_, i) => `Chain ${i}`));
    const lastSmall = small.find((p) => p.Subject === 'Small 4');
    const lastLarge = large.find((p) => p.Subject === 'Large 993');
    expect(linker.Headers).toContain(`In-Reply-To: <${lastSmall.ExternalID}>`);
    expect(linker.Headers).toContain(`References: <${lastLarge.ExternalID}>`);
    for (const e of metas) expect(e.data?.length).toBeLessThan(4096);
  });
});

describe('the hostile corpus', () => {
  const nonce = 'n0nce1234';
  const root = testDir('gen-hostile');
  const out = join(root, 'hostile1');
  let run = '';

  beforeAll(() => {
    const made = gen(['hostile', '--seed', '1', '--nonce', nonce, '--out', out]);
    expect(made.stderr).toBe('');
    expect(made.status).toBe(0);
    run = join(out, 'hostile1@example.com', RUN_FOLDER);
  });

  it('needs a nonce of the right form', () => {
    const dir = testDir('gen-hostile-nonce');
    expect(gen(['hostile', '--seed', '1', '--out', join(dir, 'a')]).status).toBe(64);
    expect(
      gen(['hostile', '--seed', '1', '--nonce', 'UPPER1', '--out', join(dir, 'b')]).status,
    ).toBe(64);
    expect(gen(['small', '--seed', '1', '--nonce', nonce, '--out', join(dir, 'c')]).status).toBe(
      64,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it('has every category', () => {
    const { counts } = json(`${out}.manifest.json`);
    for (const category of [
      'script_markup',
      'ip_literals',
      'malformed_mime',
      'odd_charsets',
      'pathological',
      'attachments_images',
      'export_structure',
    ]) {
      expect(counts[category], category).toBeGreaterThan(0);
    }
    expect(counts.ip_literals).toBe(IP_LITERAL_FORMS.length);
    expect(counts.export_structure_nested_labels).toBeGreaterThan(0);
  });

  it('refers only to canary names, documentation IPs and loopback', () => {
    const allowed = new Set([...IP_LITERAL_FORMS.map(([, host]) => host), ...CANARY_IPS]);
    const canary = new RegExp(`(^|\\.)leak-${nonce}\\.test$`);
    const hosts = new Set<string>();
    for (const e of walk(out)) {
      if (e.type !== 'file') continue;
      const text = readFileSync(e.full, 'latin1');
      // URLs, and protocol-relative ones after a quote, "(" or "=" (base64
      // data never has those right before "//").
      for (const m of text.matchAll(/(?:\bhttps?:\/\/|["'(=]\/\/)([^/"'\s)<>]+)/g)) {
        hosts.add(m[1] ?? '');
      }
      // Every .test name carries the nonce.
      for (const m of text.matchAll(/\.test\b/g)) {
        const before = text.slice(Math.max(0, (m.index ?? 0) - 64), m.index);
        const name = `${/[a-z0-9.-]*$/.exec(before)?.[0] ?? ''}.test`;
        expect(name, e.path).toMatch(canary);
      }
    }
    expect(hosts.size).toBeGreaterThan(3);
    for (const host of hosts) expect(allowed.has(host) || canary.test(host), host).toBe(true);
  });

  it('has links that stay inside the corpus, FIFOs and broken pairs', () => {
    const list = walk(out);
    const links = list.filter((e) => e.type === 'symlink');
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      expect(realpathSync(link.full).startsWith(`${realpathSync(out)}/`)).toBe(true);
    }
    const fifos = list.filter((e) => e.type === 'fifo');
    expect(fifos).toHaveLength(2);
    for (const f of fifos) expect(lstatSync(f.full).isFIFO()).toBe(true);
    const names = readdirSync(run);
    const emls = new Set(names.filter((n) => n.endsWith('.eml')).map((n) => n.slice(0, -4)));
    const metas = new Set(
      names.filter((n) => n.endsWith('.metadata.json')).map((n) => n.slice(0, -14)),
    );
    expect([...emls].filter((id) => !metas.has(id)).length).toBeGreaterThanOrEqual(2);
    expect([...metas].filter((id) => !emls.has(id)).length).toBeGreaterThanOrEqual(2);
    expect(json(`${out}.manifest.json`).digest).toBe(digest(out));
  });

  it('builds image bombs that are well-formed up to their claims', () => {
    const png = dimensionBombPng(30000, 30000);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(30000);
    expect(png.readUInt32BE(20)).toBe(30000);
    const anim = gif(1, 1, 3000);
    expect(anim.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(anim.at(-1)).toBe(0x3b);
    expect(gif(65535, 65535, 1).readUInt16LE(6)).toBe(65535);
  });
});

describe('the command line and the disk guard', () => {
  it('refuses a corpus that would pass the limit or leave too little disk', () => {
    const roomy = 100 * 1024 * MIB;
    expect(checkBudget({ projected: 10 * MIB, corporaBytes: 0, freeBytes: roomy }).ok).toBe(true);
    const full = checkBudget({
      projected: 100 * MIB,
      corporaBytes: CORPORA_CAP - COPIES_RESERVE - 99 * MIB,
      freeBytes: roomy,
    });
    expect(full.ok).toBe(false);
    expect(full.reason).toMatch(/limit/);
    const disk = checkBudget({
      projected: 10 * MIB,
      corporaBytes: 0,
      freeBytes: MIN_FREE + 5 * MIB,
    });
    expect(disk.ok).toBe(false);
    expect(disk.reason).toMatch(/free/);
  });

  it('checks its arguments and never writes over a corpus', () => {
    const dir = testDir('gen-cli');
    expect(gen([]).status).toBe(64);
    expect(gen(['nope', '--seed', '1', '--out', join(dir, 'x')]).status).toBe(64);
    expect(gen(['small', '--seed', '-1', '--out', join(dir, 'x')]).status).toBe(64);
    expect(gen(['small', '--seed', '1']).status).toBe(64);
    expect(gen(['small', '--seed', '1', '--out', join(dir, 'x'), '--extra']).status).toBe(64);
    const dry = gen(['small', '--seed', '1', '--out', join(dir, 'x'), '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/of 600\.0 MiB/);
    expect(existsSync(join(dir, 'x'))).toBe(false);
    expect(gen(['small', '--seed', '1', '--out', dir]).status).toBe(73);
  });

  it('builds attachment entries in one place', () => {
    expect(
      guessedAttachmentEntry({ id: 'a', name: 'n.pdf', size: 3, type: 'application/pdf' }),
    ).toEqual({
      ID: 'a',
      Name: 'n.pdf',
      Size: 3,
      MIMEType: 'application/pdf',
      Disposition: 'attachment',
    });
  });
});

describe('very large messages, streamed at run time', () => {
  async function collect(kind: 'text' | 'html' | 'attachment', bytes: number) {
    const hash = createHash('sha256');
    let size = 0;
    let tail = '';
    for await (const chunk of largeMessage({ kind, bytes })) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
      tail = (chunk as Buffer).toString('latin1');
    }
    return { digest: hash.digest('hex'), size, tail };
  }

  it.each(['text', 'html', 'attachment'] as const)(
    'streams a %s part of the asked size',
    async (kind) => {
      const bytes = 3 * MIB + 7;
      const first = await collect(kind, bytes);
      const second = await collect(kind, bytes);
      expect(second.digest).toBe(first.digest);
      expect(first.size).toBeGreaterThan(bytes);
      expect(first.size).toBeLessThan(bytes + 2048);
      if (kind === 'html') expect(first.tail.endsWith('</body></html>\r\n')).toBe(true);
      if (kind === 'attachment') expect(first.tail.endsWith('--\r\n')).toBe(true);
    },
  );
});
