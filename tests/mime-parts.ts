// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic messages with many MIME parts, for the reader's part limit.

/** One body of each kind, as alternatives, with `tag` in the text. */
function alternative(tag: string): string[] {
  return [
    'Content-Type: multipart/alternative; boundary="a"',
    '',
    '--a',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Text ${tag}.`,
    '--a',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<p id="p">HTML ${tag}.</p>`,
    '--a--',
  ];
}

/** `count` small attachment parts. */
function fillers(count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(
      '--m',
      'Content-Type: application/octet-stream',
      `Content-Disposition: attachment; filename="f${i}.bin"`,
      '',
      'x',
    );
  }
  return lines;
}

const HEAD = [
  'From: <sender@example.com>',
  'To: <owner@example.com>',
  'Subject: Many parts',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="m"',
  '',
];

/** A message whose bodies come after `parts` attachment parts. */
export function bodiesAfter(parts: number): string {
  return [...HEAD, ...fillers(parts), '--m', ...alternative('after the parts'), '--m--', ''].join(
    '\r\n',
  );
}

/** A message with bodies before `parts` attachment parts and bodies after them. */
export function bodiesAround(parts: number): string {
  return [
    ...HEAD,
    '--m',
    ...alternative('before the parts'),
    ...fillers(parts),
    '--m',
    ...alternative('after the parts'),
    '--m--',
    '',
  ].join('\r\n');
}
