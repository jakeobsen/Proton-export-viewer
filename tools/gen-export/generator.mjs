// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds synthetic exports in the layout the export tool writes:
//
//   <out>/<account address>/mail_YYYYMMDD_HHMMSS/
//     labels.json
//     <ID>.eml              the raw message
//     <ID>.metadata.json    {Version: 1, Payload: {...}}
//
// The content comes from seeded random streams (random.mjs), so the same
// profile, seed and nonce always give the same bytes. entries() yields every
// file without writing anything; gen-export.mjs measures and writes them.

import { Random } from './random.mjs';
import {
  DOMAINS,
  base64Lines,
  encodedWord,
  exportId,
  html,
  mailbox,
  person,
  quotedPrintable,
  rfcDate,
  sentence,
  subject,
  textOfSize,
  words,
} from './text.mjs';
import { hostileMessages } from './hostile.mjs';

/** The export run all corpora claim to come from (UTC). */
export const EXPORT_TIME = Date.UTC(2025, 5, 30, 12, 0, 0) / 1000;
export const RUN_FOLDER = 'mail_20250630_120000';
/** Messages are dated between these two times. */
const FIRST_TIME = Date.UTC(2012, 0, 1) / 1000;
const LAST_TIME = Date.UTC(2025, 5, 29) / 1000;

/**
 * Size of a metadata file, in bytes. Every file stays under 8,192 bytes, so
 * it takes two 4 KiB blocks on disk.
 */
export const METADATA_BYTES = { min: 7680, max: 8150 };

export const PROFILES = {
  /** 20,000 messages with a realistic size and conversation mix. */
  perf: { kind: 'mix', messages: 20000, bigThreads: [1050, 1150, 1300] },
  /** About 200 messages with the same mix, for folder-access tests. */
  small: { kind: 'mix', messages: 200, bigThreads: [] },
  /** 10,000 messages that stress conversation grouping. */
  stress: { kind: 'stress', messages: 10000, chain: 9000, lateSmall: 5 },
  /** Hostile content and export structure. Needs a nonce. */
  hostile: { kind: 'hostile' },
};

/** System labels, by ID. Their Type values are deliberately inconsistent. */
const SYSTEM_LABELS = [
  ['0', 'Inbox', 4],
  ['1', 'All Drafts', 4],
  ['2', 'All Sent', 4],
  ['3', 'Trash', 3],
  ['4', 'Spam', 4],
  ['5', 'All Mail', 4],
  ['6', 'Archive', 3],
  ['7', 'Sent', 4],
  ['8', 'Drafts', 1],
  ['9', 'Outbox', 4],
  ['10', 'Starred', 1],
  ['12', 'All Scheduled', 4],
  ['15', 'All Mail', 4],
  ['16', 'Snoozed', 4],
];
/** Label IDs that messages carry but labels.json doesn't list. */
export const UNKNOWN_LABEL_IDS = ['22', '24'];

function msgId(rng, domain) {
  return `${rng.bytes(15).toString('base64url')}@${domain}`;
}

export function accountAddress(profile, seed) {
  return `${profile}${seed}@example.com`;
}

// --- labels.json -------------------------------------------------------------

/**
 * 95 user entries, 7 of them folders, some nested (ParentID and a "/" Path)
 * and some with a Color that isn't #RRGGBB, plus the system labels.
 */
export function buildLabels(rng) {
  const payload = SYSTEM_LABELS.map(([ID, Name, Type]) => ({
    ID,
    Name,
    Path: Name,
    ParentID: '',
    Color: '',
    Type,
  }));
  const folders = [];
  const labels = [];
  const badColors = ['#12345', 'red', '#GGGGGG', '', '#1234567', 'rgb(1,2,3)'];
  for (let i = 0; i < 95; i++) {
    const isFolder = i < 7;
    const parents = isFolder ? folders : labels;
    const parent = i % 9 === 4 && parents.length > 0 ? rng.pick(parents) : null;
    const name = words(rng, rng.int(1, 2))
      .map((w) => `${w[0].toUpperCase()}${w.slice(1)}`)
      .join(' ');
    const color =
      i % 13 === 6
        ? badColors[((i / 13) % badColors.length) | 0]
        : `#${rng.next().toString(16).padStart(8, '0').slice(0, 6)}`;
    const entry = {
      ID: exportId(rng),
      Name: name,
      Path: parent ? `${parent.Path}/${name}` : name,
      ParentID: parent ? parent.ID : '',
      Color: color,
      Type: isFolder ? 3 : 1,
    };
    (isFolder ? folders : labels).push(entry);
    payload.push(entry);
  }
  return { file: { Version: 1, Payload: payload }, folders, labels };
}

// --- The plan: who wrote what, when, in which conversation -----------------

function headerTokens(ids) {
  return ids.map((id) => `<${id}>`).join(' ');
}

/** Conversation sizes: the big ones, then 2-50 until ~60% of messages. */
function conversationSizes(rng, total, bigThreads) {
  const sizes = [...bigThreads];
  let used = sizes.reduce((a, b) => a + b, 0);
  const threadedTarget = Math.round(total * 0.6);
  let threaded = 0;
  while (threaded < threadedTarget) {
    let size = Math.min(50, 2 + Math.floor(rng.logNormal(2.5, 18)));
    size = Math.min(size, threadedTarget - threaded);
    if (size < 2) break;
    sizes.push(size);
    threaded += size;
    used += size;
  }
  while (used < total) {
    sizes.push(1);
    used += 1;
  }
  return rng.shuffle(sizes);
}

/**
 * The realistic mix: conversations, directions, labels, sizes, and a few of
 * each special case that conversation grouping must handle.
 */
function planMix(profile, seed, labelInfo) {
  const rng = new Random(`plan/${profile.name}/${seed}`);
  const owner = { Name: 'Archive Owner', Address: accountAddress(profile.name, seed) };
  const counts = {
    messages: 0,
    html: 0,
    plain: 0,
    with_attachments: 0,
    gaps: 0,
    duplicate_message_ids: 0,
    crafted_references: 0,
    phrase_form: 0,
    empty_ids: 0,
    no_message_id: 0,
    no_ids: 0,
    unknown_label_ids: 0,
    internalid_references: 0,
  };
  const plans = [];
  // A few of each special case. The gaps' messages are planned and then left
  // out, so the plan has that many extra.
  const special = Math.max(2, Math.round(profile.messages * 0.004));
  const sizes = conversationSizes(rng, profile.messages + special, profile.bigThreads);
  for (const [c, size] of sizes.entries()) {
    const crng = rng.fork(`conversation/${c}`);
    const others = [];
    for (let i = crng.int(1, 4); i > 0; i--) others.push(person(crng));
    const topic = subject(crng);
    let time = FIRST_TIME + crng.float() * (LAST_TIME - FIRST_TIME - 86400 * 30);
    const members = [];
    for (let i = 0; i < size; i++) {
      const parent = i === 0 ? null : crng.chance(0.7) ? members[i - 1] : crng.pick(members);
      if (parent) time = Math.max(time, parent.time) + Math.round(crng.logNormal(3600, 86400 * 3));
      const direction = crng.chance(0.35) ? 'sent' : crng.chance(0.02) ? 'draft' : 'received';
      const from = direction === 'received' ? crng.pick(others) : owner;
      const to = direction === 'received' ? [owner] : [crng.pick(others)];
      const ancestors = parent ? [...parent.ancestors, parent.messageId] : [];
      const plan = {
        key: `${profile.name}/${seed}/${c}/${i}`,
        conversation: c,
        messageId: msgId(crng, from.Address.split('@')[1]),
        ancestors,
        inReplyTo: parent ? `<${parent.messageId}>` : null,
        references:
          ancestors.length > 0
            ? headerTokens(
                ancestors.length > 20 ? [ancestors[0], ...ancestors.slice(-19)] : ancestors,
              )
            : null,
        time: Math.min(Math.round(time), LAST_TIME),
        direction,
        from,
        to,
        cc: crng.chance(0.25) ? [crng.pick(others)] : [],
        bcc: direction === 'sent' && crng.chance(0.05) ? [person(crng)] : [],
        replyTo: crng.chance(0.1) ? [person(crng)] : [],
        subject: i === 0 ? topic : `Re: ${topic}`,
        omit: false,
        externalId: true,
      };
      members.push(plan);
      plans.push(plan);
    }
  }

  // The special cases, picked from the whole mailbox.
  const threaded = plans.filter((p) => p.ancestors.length > 0);
  const singletons = plans.filter((p) => p.ancestors.length === 0 && !p.inReplyTo);
  const take = (list, n) => rng.shuffle([...list]).slice(0, n);

  // Gaps: a message other messages refer to is missing from the export.
  const parentsInUse = new Set(threaded.map((p) => p.ancestors[p.ancestors.length - 1]));
  for (const p of take(
    threaded.filter((p) => parentsInUse.has(p.messageId)),
    special,
  )) {
    p.omit = true;
    counts.gaps += 1;
  }
  const kept = () => plans.filter((p) => !p.omit && !p.tagged);
  // Duplicate Message-IDs: a sent message also arrives in the inbox.
  const sent = kept().filter((p) => p.direction === 'sent');
  const spare = take(
    singletons.filter((p) => !p.omit),
    special,
  );
  for (const [i, copy] of take(sent, spare.length).entries()) {
    const slot = spare[i];
    Object.assign(slot, {
      ...copy,
      key: slot.key,
      direction: 'received',
      tagged: true,
    });
    copy.tagged = true;
    counts.duplicate_message_ids += 1;
  }
  // Crafted References: a message claims a reply to an unrelated conversation.
  for (const p of take(kept(), special)) {
    const other = rng.pick(plans.filter((q) => q.conversation !== p.conversation && !q.omit));
    p.references = p.references ? `${p.references} <${other.messageId}>` : `<${other.messageId}>`;
    p.tagged = true;
    counts.crafted_references += 1;
  }
  // Phrase-form In-Reply-To and References.
  for (const p of take(
    kept().filter((q) => q.inReplyTo),
    special,
  )) {
    p.inReplyTo = `Your message of ${rfcDate(p.time - 3600)} ${p.inReplyTo}`;
    p.references = p.references?.replace(' ', ' (earlier reply) ') ?? null;
    p.tagged = true;
    counts.phrase_form += 1;
  }
  // Empty <> IDs, which link nothing.
  for (const p of take(kept(), special)) {
    p.inReplyTo = p.inReplyTo ? `<> ${p.inReplyTo}` : '<>';
    p.references = p.references ? `<> ${p.references}` : '<>';
    p.tagged = true;
    counts.empty_ids += 1;
  }
  // No Message-ID header: ExternalID stands in. Then neither.
  for (const p of take(kept(), special)) {
    p.noMessageIdHeader = true;
    p.tagged = true;
    counts.no_message_id += 1;
  }
  for (const p of take(kept(), special)) {
    p.noMessageIdHeader = true;
    p.externalId = false;
    p.tagged = true;
    counts.no_ids += 1;
  }

  // Labels, flags and sizes, per message.
  for (const p of plans) {
    if (p.omit) continue;
    const mrng = new Random(`message/${p.key}`);
    p.labels = pickLabels(mrng, p.direction, labelInfo);
    if (mrng.chance(0.01)) {
      if (p.labels.length >= 6) p.labels.pop();
      p.labels.push(mrng.pick(UNKNOWN_LABEL_IDS));
      counts.unknown_label_ids += 1;
    }
    p.unread = p.direction === 'received' && mrng.chance(0.15) ? 1 : 0;
    p.replied = mrng.chance(0.1) ? 1 : 0;
    p.repliedAll = p.replied && mrng.chance(0.2) ? 1 : 0;
    p.forwarded = mrng.chance(0.03) ? 1 : 0;
    p.body = mrng.chance(0.55) ? 'html' : 'plain';
    p.emlBytes = Math.max(900, Math.round(mrng.logNormal(4096, 16384)));
    p.attachments = [];
    if (mrng.chance(0.12)) {
      let total = Math.min(2 * 1024 * 1024, Math.round(mrng.logNormal(10240, 102400)));
      for (let n = mrng.int(1, 3); n > 0 && total > 0; n--) {
        const bytes = n === 1 ? total : Math.max(1, Math.round(total * mrng.float()));
        p.attachments.push(attachmentFile(mrng, bytes));
        total -= bytes;
      }
      counts.with_attachments += 1;
    }
    counts[p.body] += 1;
    counts.messages += 1;
    counts.internalid_references += 1;
  }
  // Conversation sizes as planned (before crafted References join any).
  const sizesNow = new Map();
  for (const p of plans)
    if (!p.omit) sizesNow.set(p.conversation, (sizesNow.get(p.conversation) ?? 0) + 1);
  counts.conversations = sizesNow.size;
  counts.singletons = [...sizesNow.values()].filter((n) => n === 1).length;
  counts.in_threads_2_to_50 = [...sizesNow.values()]
    .filter((n) => n >= 2 && n <= 50)
    .reduce((a, b) => a + b, 0);
  counts.in_threads_1000_plus = [...sizesNow.values()]
    .filter((n) => n >= 1000)
    .reduce((a, b) => a + b, 0);
  counts.largest_conversation = Math.max(...sizesNow.values());
  return { owner, plans: plans.filter((p) => !p.omit), counts };
}

function pickLabels(rng, direction, { folders, labels }) {
  const ids = [];
  if (direction === 'sent') ids.push('7', '2');
  else if (direction === 'draft') ids.push('8', '1');
  else {
    const r = rng.float();
    if (r < 0.5) ids.push('0');
    else if (r < 0.8) ids.push('6');
    else if (r < 0.92) ids.push(rng.pick(folders).ID);
    else if (r < 0.97) ids.push('3');
    else ids.push('4');
  }
  ids.push('5');
  if (rng.chance(0.06)) ids.push('10');
  for (let n = rng.int(0, 3); n > 0 && ids.length < 6; n--) {
    const id = rng.pick(labels).ID;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

const ATTACHMENT_TYPES = [
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['zip', 'application/zip'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['csv', 'text/csv'],
  ['txt', 'text/plain'],
];

function attachmentFile(rng, bytes) {
  const [ext, type] = rng.pick(ATTACHMENT_TYPES);
  return { name: `${words(rng, rng.int(1, 3)).join('-')}.${ext}`, type, bytes };
}

/**
 * The stress mix: one ~9,000-message conversation linked only by
 * In-Reply-To, in shuffled file order, and a late merge: a small
 * conversation whose files sort first, a large one whose files sort after
 * it, and one message, sorting last, that replies to both.
 */
function planStress(profile, seed) {
  const rng = new Random(`plan/stress/${seed}`);
  const owner = { Name: 'Archive Owner', Address: accountAddress('stress', seed) };
  const plans = [];
  let time = FIRST_TIME;
  const add = (plan) => {
    time += 60;
    plans.push({ ...plan, time, minimal: true, externalId: true, from: owner, to: [owner] });
  };
  let previous = null;
  for (let i = 0; i < profile.chain; i++) {
    const id = msgId(rng, 'example.org');
    add({
      key: `stress/${seed}/chain/${i}`,
      messageId: id,
      inReplyTo: previous ? `<${previous}>` : null,
      references: null,
      subject: `Chain ${i}`,
    });
    previous = id;
  }
  const lateLarge = profile.messages - profile.chain - profile.lateSmall - 1;
  const groups = { small: [], large: [] };
  for (const [group, size] of [
    ['small', profile.lateSmall],
    ['large', lateLarge],
  ]) {
    let prev = null;
    for (let i = 0; i < size; i++) {
      const id = msgId(rng, 'example.net');
      add({
        key: `stress/${seed}/${group}/${i}`,
        messageId: id,
        inReplyTo: prev ? `<${prev}>` : null,
        references: null,
        subject: `${group === 'small' ? 'Small' : 'Large'} ${i}`,
        group,
      });
      groups[group].push(id);
      prev = id;
    }
  }
  add({
    key: `stress/${seed}/linker`,
    messageId: msgId(rng, 'example.net'),
    inReplyTo: `<${groups.small.at(-1)}>`,
    references: `<${groups.large.at(-1)}>`,
    subject: 'Joins small and large',
    group: 'linker',
  });
  // File names decide the order an indexer meets the files in, if it sorts
  // them by name. The chain's names are random, so its order is shuffled. In
  // byte order '-' is the lowest URL-safe base64 character and 'z' the
  // highest: the small group's names start with '-', the linker's with 'z',
  // and no other name starts with either.
  for (const plan of plans) {
    const id = exportId(rng);
    if (plan.group === 'small') plan.id = `-${id.slice(1)}`;
    else if (plan.group === 'linker') plan.id = `z${id.slice(1)}`;
    else if (id[0] === '-') plan.id = `A${id.slice(1)}`;
    else if (id[0] === 'z') plan.id = `y${id.slice(1)}`;
    else plan.id = id;
  }
  for (const plan of plans) {
    plan.labels = ['0', '5'];
    plan.unread = 0;
    plan.replied = 0;
    plan.repliedAll = 0;
    plan.forwarded = 0;
    plan.body = 'plain';
    plan.attachments = [];
  }
  const counts = {
    messages: plans.length,
    chain: profile.chain,
    late_small: profile.lateSmall,
    late_large: lateLarge,
    late_linker: 1,
    internalid_references: plans.length,
  };
  return { owner, plans, counts };
}

// --- Files -------------------------------------------------------------------

function fold(name, value) {
  const line = `${name}: ${value}`;
  if (line.length <= 78) return line;
  const out = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current && current.length + 1 + word.length > 78) {
      out.push(current);
      current = ` ${word}`;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out.join('\r\n');
}

function receivedHop(rng, time) {
  const host = `mx${rng.int(1, 40)}.${rng.pick(DOMAINS)}`;
  const ip = `198.51.100.${rng.int(1, 254)}`;
  return fold(
    'Received',
    `from ${host} (${host} [${ip}]) by mail.example.com (Postfix) with ESMTPS id ` +
      `${rng.bytes(9).toString('hex').toUpperCase()} for <owner@example.com>; ${rfcDate(time)}`,
  );
}

/** The header lines both files share: addresses, IDs and subject. */
function coreHeaders(plan, { internalId }) {
  const lines = [
    `Date: ${rfcDate(plan.time)}`,
    fold('From', mailbox(plan.from)),
    fold('To', plan.to.map(mailbox).join(', ')),
  ];
  if (plan.cc?.length) lines.push(fold('Cc', plan.cc.map(mailbox).join(', ')));
  if (plan.replyTo?.length) lines.push(fold('Reply-To', plan.replyTo.map(mailbox).join(', ')));
  lines.push(fold('Subject', encodedWord(plan.subject)));
  if (!plan.noMessageIdHeader) lines.push(`Message-ID: <${plan.messageId}>`);
  if (plan.inReplyTo) lines.push(fold('In-Reply-To', plan.inReplyTo));
  const refs = [plan.references, internalId ? `<${plan.id}@protonmail.internalid>` : null]
    .filter(Boolean)
    .join(' ');
  if (refs) lines.push(fold('References', refs));
  return lines;
}

function authResults(rng, plan) {
  const domain = plan.from.Address.split('@')[1];
  return fold(
    'Authentication-Results',
    `mail.example.com; dkim=pass (2048-bit key) header.d=${domain} header.i=@${domain} ` +
      `header.b="${rng.bytes(6).toString('base64')}"; dmarc=pass (p=quarantine dis=none) ` +
      `header.from=${domain}; spf=pass smtp.mailfrom=${domain}`,
  );
}

/**
 * The raw header block kept in the metadata. Extra Received hops and
 * signatures make the metadata file reach its drawn size.
 */
function metadataHeaders(rng, plan, room) {
  const core = [...coreHeaders(plan, { internalId: false })];
  if (plan.minimal) return `${core.join('\r\n')}\r\n`;
  const lines = [authResults(rng, plan), ...core, 'MIME-Version: 1.0'];
  const escaped = (text) => JSON.stringify(text).length - 2;
  let size = escaped(`${lines.join('\r\n')}\r\n`);
  const extras = [
    () => receivedHop(rng, plan.time),
    () =>
      fold(
        'DKIM-Signature',
        `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${plan.from.Address.split('@')[1]}; s=mail; ` +
          `h=from:to:subject:date:message-id; bh=${rng.bytes(32).toString('base64')}; ` +
          `b=${rng.bytes(256).toString('base64')}`,
      ),
    () =>
      fold(
        'ARC-Seal',
        `i=1; a=rsa-sha256; t=${plan.time}; cv=none; d=example.com; s=arc; b=${rng
          .bytes(256)
          .toString('base64')}`,
      ),
  ];
  // Add headers until the next one wouldn't fit, then short ones, so the file
  // lands within a few bytes of its drawn size.
  const short = [
    () => `X-Spam-Score: ${rng.int(-50, 30) / 10}`,
    () => `X-Spam-Level: ${'*'.repeat(rng.int(0, 9))}`,
    () => `X-Priority: ${rng.int(1, 5)}`,
  ];
  for (const pool of [extras, short]) {
    for (let misses = 0; misses < 6;) {
      const line = pool[rng.int(0, pool.length - 1)]();
      const grow = escaped(`${line}\r\n`);
      if (size + grow > room) {
        misses += 1;
        continue;
      }
      lines.unshift(line);
      size += grow;
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

// The field names of an Attachments[] entry are a guess that hasn't been
// confirmed yet. This is the only place that builds one.
export function guessedAttachmentEntry({ id, name, size, type }) {
  return { ID: id, Name: name, Size: size, MIMEType: type, Disposition: 'attachment' };
}

function metadataFile(rng, plan, addressId, emlSize, mimeType) {
  const flags = plan.direction === 'sent' ? 2 : plan.direction === 'draft' ? 0 : 1;
  const attachments = (plan.attachments ?? []).map((a, i) =>
    guessedAttachmentEntry({
      id: `${plan.id.slice(0, 40)}${i}`,
      name: a.name,
      size: a.bytes,
      type: a.type,
    }),
  );
  const payload = {
    ID: plan.id,
    AddressID: addressId,
    LabelIDs: plan.labels,
    ExternalID: plan.externalId ? plan.messageId : '',
    Subject: plan.subject,
    Sender: plan.from,
    ToList: plan.to,
    CCList: plan.cc ?? [],
    BCCList: plan.bcc ?? [],
    ReplyTos: plan.replyTo?.length ? plan.replyTo : [plan.from],
    Flags: flags,
    Time: plan.time,
    Size: emlSize,
    Unread: plan.unread,
    IsReplied: plan.replied,
    IsRepliedAll: plan.repliedAll,
    IsForwarded: plan.forwarded,
    NumAttachments: attachments.length,
    Attachments: attachments,
    MIMEType: mimeType,
    Headers: '',
    WriterType: 0,
  };
  if (plan.minimal) {
    payload.Headers = metadataHeaders(rng, plan, 0);
    return JSON.stringify({ Version: 1, Payload: payload });
  }
  const target = rng.int(METADATA_BYTES.min, METADATA_BYTES.max);
  const empty = Buffer.byteLength(JSON.stringify({ Version: 1, Payload: payload }));
  payload.Headers = metadataHeaders(rng, plan, target - empty);
  return JSON.stringify({ Version: 1, Payload: payload });
}

function htmlBody(rng, bytes) {
  const parts = [
    '<html><head><meta charset="utf-8"><style>p{margin:0 0 1em} td{padding:4px}</style></head>',
    '<body><div style="font-family:Arial,sans-serif;font-size:14px;color:#222">',
  ];
  let size = parts.join('').length;
  while (size < bytes) {
    let p = html(sentence(rng));
    if (rng.chance(0.3)) {
      p += ` <a href="https://www.example.test/${words(rng, 2).join('/')}">${html(words(rng, 2).join(' '))}</a>`;
    }
    if (rng.chance(0.2)) p = `<b>${html(words(rng, 2).join(' '))}</b> ${p}`;
    const block = rng.chance(0.08)
      ? `<table border="0"><tr><td>${html(words(rng, 3).join(' '))}</td><td>${rng.int(1, 999)}</td></tr></table>`
      : `<p>${p} ${html(sentence(rng))}</p>`;
    parts.push(block);
    size += block.length + 2;
  }
  parts.push('</div></body></html>');
  return parts.join('\r\n');
}

function boundary(rng) {
  return `=_${rng.bytes(12).toString('hex')}`;
}

/** Returns [mime type, header lines, body] for the message's body part(s). */
function bodyPart(rng, plan, bytes) {
  // textOfSize ends on a whole paragraph, so aim a little short.
  const text = textOfSize(rng, plan.minimal ? 4 : Math.max(40, bytes - 150));
  if (plan.body === 'plain') {
    return [
      'text/plain',
      ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable'],
      quotedPrintable(text),
    ];
  }
  const b = boundary(rng);
  // Quoted-printable adds about 5% to HTML; the two parts share the size.
  const htmlText = htmlBody(rng, Math.round(bytes * 0.55));
  const shortText = textOfSize(rng, Math.max(40, Math.round(bytes * 0.3)));
  return [
    'text/html',
    [`Content-Type: multipart/alternative; boundary="${b}"`],
    [
      `--${b}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(shortText),
      `--${b}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(htmlText),
      `--${b}--`,
    ].join('\r\n'),
  ];
}

function attachmentContent(rng, a) {
  if (a.type.startsWith('text/')) return Buffer.from(textOfSize(rng, a.bytes).slice(0, a.bytes));
  return rng.bytes(a.bytes);
}

function emlFile(rng, plan) {
  const header = [];
  if (!plan.minimal) {
    header.push(`Return-Path: <${plan.from.Address}>`, receivedHop(rng, plan.time));
    if (plan.direction === 'received') header.push(authResults(rng, plan));
  }
  header.push(...coreHeaders(plan, { internalId: true }), 'MIME-Version: 1.0');
  const headerBytes = header.join('\r\n').length + 4;
  const [mimeType, bodyHeaders, body] = bodyPart(
    rng,
    plan,
    plan.minimal ? 0 : (plan.emlBytes ?? 0) - headerBytes,
  );
  let text;
  if (plan.attachments?.length) {
    const b = boundary(rng);
    const parts = [`--${b}`, ...bodyHeaders, '', body];
    for (const a of plan.attachments) {
      parts.push(
        `--${b}`,
        `Content-Type: ${a.type}; name="${a.name}"`,
        `Content-Disposition: attachment; filename="${a.name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(attachmentContent(rng, a)),
      );
    }
    parts.push(`--${b}--`, '');
    text = [...header, `Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts].join('\r\n');
  } else {
    text = [...header, ...bodyHeaders, '', body, ''].join('\r\n');
  }
  return [mimeType, Buffer.from(text, 'utf8')];
}

/**
 * Every entry of a profile's corpus, in writing order, without touching the
 * disk. Each entry: {path, type: 'dir'|'file'|'symlink'|'fifo', data?, target?,
 * mtime}. Paths are relative to the output folder.
 */
export function* entries(profileName, { seed, nonce }) {
  if (!Object.hasOwn(PROFILES, profileName)) throw new Error(`unknown profile ${profileName}`);
  const profile = { ...PROFILES[profileName], name: profileName };
  const account = accountAddress(profileName, seed);
  const run = `${account}/${RUN_FOLDER}`;
  const labelRng = new Random(`labels/${profileName}/${seed}`);
  const labelInfo = buildLabels(labelRng);
  const addressId = exportId(new Random(`address/${profileName}/${seed}`));

  let planned;
  if (profile.kind === 'mix') planned = planMix(profile, seed, labelInfo);
  else if (profile.kind === 'stress') planned = planStress(profile, seed);
  else
    planned = hostileMessages({
      seed,
      nonce,
      labelInfo,
      owner: { Name: 'Archive Owner', Address: account },
    });

  if (profile.kind === 'mix') {
    const idRng = new Random(`ids/${profileName}/${seed}`);
    for (const plan of planned.plans) plan.id = exportId(idRng);
  }
  yield { path: account, type: 'dir', mtime: EXPORT_TIME };
  yield { path: run, type: 'dir', mtime: EXPORT_TIME };
  yield {
    path: `${run}/labels.json`,
    type: 'file',
    data: Buffer.from(JSON.stringify(labelInfo.file)),
    mtime: EXPORT_TIME,
  };

  // Files are written in file-name order, 20 pairs a second after the start.
  const ordered = [...planned.plans].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const [k, plan] of ordered.entries()) {
    const rng = new Random(`files/${plan.key}`);
    const mtime = EXPORT_TIME + 1 + Math.floor(k / 20);
    const [mimeType, eml] = plan.emlData
      ? [plan.mimeType ?? 'text/html', plan.emlData]
      : emlFile(rng, plan);
    if (!plan.skipEml) yield { path: `${run}/${plan.id}.eml`, type: 'file', data: eml, mtime };
    if (!plan.skipMetadata) {
      const meta = metadataFile(rng, plan, addressId, eml.length, mimeType);
      yield {
        path: `${run}/${plan.id}.metadata.json`,
        type: 'file',
        data: Buffer.from(meta),
        mtime,
      };
    }
  }
  for (const extra of planned.extras ?? [])
    yield {
      ...extra,
      path: `${extra.base === 'root' ? '' : `${run}/`}${extra.path}`,
      mtime: EXPORT_TIME + 1 + Math.floor(ordered.length / 20),
    };
  yield {
    meta: true,
    counts: planned.counts,
    account,
    run,
    probePair: planned.probePair ?? ordered[0]?.id ?? null,
  };
}
