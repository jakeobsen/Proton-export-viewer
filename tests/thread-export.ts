// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic exports with conversations of a chosen size, for the conversation
// reader's tests: every message after the first replies to it, so the index
// groups them into one conversation. The run folder and labels.json come from
// the small profile; the messages are written here.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeExport, type WrittenExport } from './exports';

export interface ThreadSpec {
  /** Messages in the conversation, oldest first. */
  messages: number;
  /** The label IDs of message `i`; Inbox and All Mail by default. */
  labels?: (i: number) => string[];
  /** The subject of its first message. */
  subject?: string;
  /** Messages (after the first) that take the time of the one before. */
  tied?: number[];
}

export interface WrittenThread {
  /** The message IDs, oldest first; the files are `<id>.eml` and `<id>.metadata.json`. */
  ids: string[];
  /** Seconds since the epoch of message `i`. */
  times: number[];
}

export interface WrittenThreads extends WrittenExport {
  threads: WrittenThread[];
}

/** The first message's time; each message is a minute after the one before. */
const BASE_TIME = 1_780_000_000;

/** The pair of files of one message. */
export function writeMessage(
  run: string,
  id: string,
  options: {
    time: number;
    subject: string;
    from: { name: string; address: string };
    labels: string[];
    messageId: string;
    /** Message-IDs this one replies to; the last is its parent. */
    references: string[];
    body: string;
  },
): void {
  const date = new Date(options.time * 1000).toUTCString().replace('GMT', '+0000');
  const parent = options.references.at(-1);
  const headers = [
    `Message-ID: <${options.messageId}>`,
    ...(parent
      ? [
          `In-Reply-To: <${parent}>`,
          `References: ${options.references.map((r) => `<${r}>`).join(' ')}`,
        ]
      : []),
  ];
  const eml = [
    `From: ${options.from.name} <${options.from.address}>`,
    'To: Owner <owner@example.com>',
    `Subject: ${options.subject}`,
    `Date: ${date}`,
    ...headers,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.body,
    '',
  ].join('\r\n');
  writeFileSync(join(run, `${id}.eml`), eml);
  const payload = {
    ID: id,
    AddressID: 'address-1',
    LabelIDs: options.labels,
    ExternalID: '',
    Subject: options.subject,
    Sender: { Name: options.from.name, Address: options.from.address },
    ToList: [{ Name: 'Owner', Address: 'owner@example.com' }],
    CCList: [],
    BCCList: [],
    ReplyTos: [{ Name: options.from.name, Address: options.from.address }],
    Flags: 1,
    Time: options.time,
    Size: Buffer.byteLength(eml),
    Unread: 0,
    IsReplied: 0,
    IsRepliedAll: 0,
    IsForwarded: 0,
    NumAttachments: 0,
    Attachments: [],
    MIMEType: 'text/plain',
    Headers: `${headers.join('\r\n')}\r\n`,
    WriterType: 0,
  };
  writeFileSync(join(run, `${id}.metadata.json`), JSON.stringify({ Version: 1, Payload: payload }));
}

/** Writes an export below `root` with the given conversations. */
export function writeThreads(
  root: string,
  options: { seed: number; threads: ThreadSpec[] },
): WrittenThreads {
  const base = writeExport(root, { seed: options.seed, messages: 0 });
  const threads: WrittenThread[] = [];
  let pairs = 0;
  let minute = 0;
  for (const [t, spec] of options.threads.entries()) {
    const ids: string[] = [];
    const times: number[] = [];
    const root = `c${t}-0@example.com`;
    for (let i = 0; i < spec.messages; i += 1) {
      const id = `conv${t}-msg${String(i).padStart(5, '0')}`;
      if (i > 0 && spec.tied?.includes(i)) minute -= 1;
      const time = BASE_TIME + minute * 60;
      minute += 1;
      writeMessage(base.run, id, {
        time,
        subject: i === 0 ? (spec.subject ?? `Conversation ${t}`) : `Re: Conversation ${t}`,
        from: { name: `Sender ${i % 7}`, address: `sender${i % 7}@example.com` },
        labels: spec.labels?.(i) ?? ['0', '5'],
        messageId: i === 0 ? root : `c${t}-${i}@example.com`,
        references: i === 0 ? [] : [root],
        body: `Message ${i} of conversation ${t}: https://example.com/c${t}/m${i}`,
      });
      ids.push(id);
      times.push(time);
      pairs += 1;
    }
    threads.push({ ids, times });
  }
  return { ...base, pairs, threads };
}
