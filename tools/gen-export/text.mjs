// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic names, words and the MIME encodings the generated messages use.
// Every address is under a domain reserved for examples (RFC 2606), and every
// link in an ordinary message points at a .test name.

const WORDS = `about above across after again against agenda align almost along already also
although always among answer anyone anything april around arrive ask attach august autumn
available away back balance based basic because become before begin behind below better
between beyond board book both bring budget build business call calendar came carry case
change check choose city clear close coffee come common complete consider contact continue
copy corner cost could country course cover create current customer date day decide deliver
design detail develop different dinner direct draft during each early easy either else email
end enough evening event every example expect explain fact family february field figure file
final find finish first follow form forward friday full future garden give goal going good
great group guess half hand happy have hear help here hold home hope hotel hour house idea
include inside instead issue item january join july june just keep kind know large last late
later launch lead learn least leave less letter level light like line list little live local
long look lunch made main make manage march matter maybe meet meeting member message might
minute monday month morning most move much name near need never next night note nothing
notice november number october offer office often once only open order other over page paper
part party pass past people perhaps person phone picture place plan please point possible
post prepare present price print problem process project provide question quick quite rather
read ready real reason receive recent record reply report request result review right room
round run same saturday schedule second section send september service share short should
show side simple since site small some soon sound space speak spring staff start state still
stop story street study summer sunday support sure system table take talk team tell than
thank that their then there these thing think this those though thursday time today together
tomorrow topic total toward travel tuesday under until update upon used usual value very
visit wait want weather wednesday week welcome well were what when where which while whole
will window winter wish with within without word work world would write year yesterday`
  .split(/\s+/)
  .filter(Boolean);

const FIRST = `Ada Alan Alice Amara Ana Ben Bianca Carl Chen Clara Dan Dana Elif Emil Erin Eva Felix
Gil Grace Hana Hugo Ines Ivan Jana Jon Kai Kim Lara Leo Lina Luca Maja Mark Mia Nadia Nils
Noor Olga Omar Pia Ravi Rosa Sam Sara Tom Uma Vera Wen Yara Zoe`
  .split(/\s+/)
  .filter(Boolean);

const LAST = `Abbott Baker Berg Brandt Carter Cruz Dahl Ellis Falk Fischer Gray Hale Holm Ito Jensen
Kaur Klein Lang Lund Meyer Moreno Nash Novak Olsen Park Quinn Reed Rossi Sato Schmidt Silva
Stone Tan Vance Voss Walsh Weber West Young Zhou`
  .split(/\s+/)
  .filter(Boolean);

/** An ID in the export's style: 64 random bytes in URL-safe base64. */
export function exportId(rng) {
  return `${rng.bytes(64).toString('base64url')}==`;
}

/** Domains reserved for examples (RFC 2606). */
export const DOMAINS = ['example.com', 'example.org', 'example.net'];

/** A person under one of the example domains. */
export function person(rng) {
  const first = rng.pick(FIRST);
  const last = rng.pick(LAST);
  const domain = rng.pick(DOMAINS);
  const local = rng.chance(0.5) ? `${first}.${last}` : `${first[0]}${last}`;
  return { Name: `${first} ${last}`, Address: `${local.toLowerCase()}@${domain}` };
}

export function words(rng, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(rng.pick(WORDS));
  return out;
}

export function sentence(rng) {
  const text = words(rng, rng.int(5, 14)).join(' ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

export function subject(rng) {
  const text = words(rng, rng.int(2, 7)).join(' ');
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

/** Plain text of about `bytes` bytes, in paragraphs wrapped at 72 columns. */
export function textOfSize(rng, bytes) {
  const lines = [];
  let size = 0;
  while (size < bytes) {
    const paragraph = [];
    const count = rng.int(1, 5);
    for (let i = 0; i < count; i++) paragraph.push(sentence(rng));
    for (const line of wrap(paragraph.join(' '), 72)) {
      lines.push(line);
      size += line.length + 2;
    }
    lines.push('');
    size += 2;
  }
  return lines.join('\r\n');
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Escapes text for HTML. */
export function html(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An RFC 5322 date in UTC. */
export function rfcDate(seconds) {
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

/** "Name <address>", with the name quoted when it needs to be. */
export function mailbox({ Name, Address }) {
  if (!Name) return `<${Address}>`;
  const name = /^[A-Za-z0-9 ]+$/.test(Name) ? Name : `"${Name.replace(/["\\]/g, '\\$&')}"`;
  return `${name} <${Address}>`;
}

/** A header value as an RFC 2047 encoded word when it isn't plain ASCII. */
export function encodedWord(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** Base64 in lines of 76 characters. */
export function base64Lines(buffer) {
  const encoded = buffer.toString('base64');
  const lines = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join('\r\n');
}

/** Quoted-printable (RFC 2045) for text with CRLF line breaks. */
export function quotedPrintable(text) {
  const out = [];
  for (const line of text.split('\r\n')) {
    let encoded = '';
    for (const byte of Buffer.from(line, 'utf8')) {
      const plain = (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32;
      encoded += plain
        ? String.fromCharCode(byte)
        : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    if (encoded.endsWith(' ')) encoded = `${encoded.slice(0, -1)}=20`;
    while (encoded.length > 76) {
      let cut = 75;
      if (encoded[cut - 1] === '=') cut -= 1;
      else if (encoded[cut - 2] === '=') cut -= 2;
      out.push(`${encoded.slice(0, cut)}=`);
      encoded = encoded.slice(cut);
    }
    out.push(encoded);
  }
  return out.join('\r\n');
}
