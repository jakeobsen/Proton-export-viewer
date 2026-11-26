// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  conversationKeys,
  headerValues,
  msgIds,
  parseMetadata,
  threadHeaders,
} from '../../src/testhooks/bench/metadata';

const block = (lines: string[]) => lines.join('\r\n');

describe('conversation keys from the metadata header block', () => {
  it('unfolds header lines and matches names without case', () => {
    const h = block(['message-id: <a@x>', 'References: <r1@x>', ' <r2@x>', 'X-Other: <no@x>']);
    expect(headerValues(h, 'Message-ID')).toEqual([' <a@x>']);
    expect(headerValues(h, 'References')).toEqual([' <r1@x> <r2@x>']);
  });

  it('takes only <…> tokens, trimmed, and skips empty and over-long ids', () => {
    expect(msgIds('Your message of Monday <id1@x>')).toEqual(['id1@x']);
    expect(msgIds('<> < spaced@x >')).toEqual(['spaced@x']);
    expect(msgIds(`<${'a'.repeat(998)}> <${'b'.repeat(999)}>`)).toEqual(['a'.repeat(998)]);
    expect(msgIds('no brackets at all')).toEqual([]);
  });

  it('uses the own id, In-Reply-To and only the last 100 References', () => {
    const refs = Array.from({ length: 150 }, (_, i) => `<r${i}@x>`).join(' ');
    const h = threadHeaders(
      block(['Message-ID: <own@x>', 'In-Reply-To: <p@x>', `References: ${refs}`]),
      'ext@x',
    );
    const keys = conversationKeys(h);
    expect(keys[0]).toBe('own@x');
    expect(keys).toContain('p@x');
    expect(keys).not.toContain('r49@x');
    expect(keys).toContain('r50@x');
    expect(keys).toContain('r149@x');
    expect(keys).toHaveLength(102);
  });

  it('falls back to ExternalID, and a message with neither has no own key', () => {
    expect(threadHeaders(block(['Subject: s']), ' ext@x ').messageId).toBe('ext@x');
    expect(threadHeaders(block(['Message-ID: <>']), 'ext@x').messageId).toBe('ext@x');
    expect(threadHeaders(block(['Subject: s']), '').messageId).toBeNull();
  });

  it('reads the DMARC result from Authentication-Results', () => {
    const h = block(['Authentication-Results: mx; spf=pass; dmarc=FAIL (p=none)']);
    expect(threadHeaders(h, '').dmarc).toBe('fail');
  });
});

describe('parseMetadata', () => {
  const doc = (payload: Record<string, unknown>) =>
    JSON.stringify({ Version: 1, Payload: payload });

  it('maps the payload and refuses a mismatched ID or a broken file', () => {
    const row = parseMetadata(
      'ID1',
      doc({
        ID: 'ID1',
        Subject: 'Hello',
        Sender: { Name: 'A', Address: 'a@example.com' },
        ToList: [{ Name: 'B', Address: 'b@example.com' }],
        LabelIDs: ['0', '5', '5', 7],
        Time: 1700000000,
        Unread: 1,
        NumAttachments: 1,
        Attachments: [{ Name: 'f.pdf', MIMEType: 'application/pdf', Size: 10 }],
        Headers: 'Message-ID: <m@x>\r\nIn-Reply-To: <p@x>\r\n',
      }),
    );
    expect(row.labelIds).toEqual(['0', '5']);
    expect(row.keys).toEqual(['m@x', 'p@x']);
    expect(row.unread).toBe(1);
    expect(row.attachments).toEqual([{ name: 'f.pdf', mime: 'application/pdf', size: 10 }]);
    expect(() => parseMetadata('ID2', doc({ ID: 'ID1' }))).toThrow('META_ID');
    expect(() => parseMetadata('ID1', '{')).toThrow('META_JSON');
    expect(() => parseMetadata('ID1', '[]')).toThrow('META_SHAPE');
  });
});
