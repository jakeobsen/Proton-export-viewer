// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  avatarColor,
  blockedImages,
  firstMailbox,
  fullDate,
  initialsOf,
  senderOf,
  shortDate,
} from '../../src/renderer/reader-format';

describe('senderOf', () => {
  it('splits a name and an address', () => {
    expect(senderOf('"Sender" <sender@example.org>')).toEqual({
      name: 'Sender',
      address: 'sender@example.org',
    });
    expect(senderOf('Ana Lee <ana@example.org>')).toEqual({
      name: 'Ana Lee',
      address: 'ana@example.org',
    });
  });

  it('uses the address as the name when there is none', () => {
    expect(senderOf('<x@example.org>')).toEqual({
      name: 'x@example.org',
      address: 'x@example.org',
    });
    expect(senderOf('x@example.org')).toEqual({ name: 'x@example.org', address: 'x@example.org' });
  });

  it('keeps a field without an address as the name', () => {
    expect(senderOf('Undisclosed')).toEqual({ name: 'Undisclosed', address: '' });
    expect(senderOf('')).toEqual({ name: '', address: '' });
  });
});

describe('firstMailbox', () => {
  it('takes the first of several mailboxes', () => {
    expect(senderOf('Ana Lee <ana@example.org>, Bo Kim <bo@example.org>')).toEqual({
      name: 'Ana Lee',
      address: 'ana@example.org',
    });
    expect(senderOf('ana@example.org, bo@example.org')).toEqual({
      name: 'ana@example.org',
      address: 'ana@example.org',
    });
  });

  it('keeps a comma in a quoted name or in angle brackets', () => {
    expect(senderOf('"Lee, Ana" <ana@example.org>, Bo <bo@example.org>')).toEqual({
      name: 'Lee, Ana',
      address: 'ana@example.org',
    });
    expect(firstMailbox('"A \\" , B" <a@example.org>, c@example.org')).toBe(
      '"A \\" , B" <a@example.org>',
    );
    expect(firstMailbox('Ana <ana,x@example.org>, Bo <bo@example.org>')).toBe(
      'Ana <ana,x@example.org>',
    );
  });
});

describe('initialsOf', () => {
  it('takes up to two letters', () => {
    expect(initialsOf('Northwind Outfitters')).toBe('NO');
    expect(initialsOf('ana.lee@example.org')).toBe('AL');
    expect(initialsOf('Émile')).toBe('É');
    expect(initialsOf('"  "')).toBe('?');
    expect(initialsOf('')).toBe('?');
  });
});

describe('dates', () => {
  it('formats the short and the full date', () => {
    expect(shortDate('2026-11-25T07:02:11.000Z', 'UTC')).toBe('Wed 25 Nov, 07:02');
    expect(fullDate('2026-11-25T07:02:11.000Z', 'UTC')).toBe('Wed, 25 Nov 2026 07:02:11 +0000');
    expect(fullDate('2026-11-25T07:02:11.000Z', 'Europe/Copenhagen')).toBe(
      'Wed, 25 Nov 2026 08:02:11 +0100',
    );
    expect(fullDate('2026-07-01T12:00:00.000Z', 'America/New_York')).toBe(
      'Wed, 1 Jul 2026 08:00:00 -0400',
    );
    expect(fullDate('2026-11-25T07:02:11.000Z', 'Asia/Kathmandu')).toBe(
      'Wed, 25 Nov 2026 12:47:11 +0545',
    );
  });

  it('shows nothing for a missing or invalid date', () => {
    expect(shortDate(null)).toBe('');
    expect(fullDate(null)).toBe('');
    expect(shortDate('not a date')).toBe('');
  });
});

describe('labels', () => {
  it('counts blocked images', () => {
    expect(blockedImages(1)).toBe('1 external image blocked');
    expect(blockedImages(7)).toBe('7 external images blocked');
  });

  it('gives each address one color', () => {
    expect(avatarColor('a@example.org')).toBe(avatarColor('A@example.org'));
    expect(avatarColor('a@example.org')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
