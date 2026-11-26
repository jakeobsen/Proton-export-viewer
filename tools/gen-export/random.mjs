// SPDX-License-Identifier: AGPL-3.0-or-later
// Seeded random numbers. Everything the generator writes comes from these
// streams, so the same profile, seed and nonce always give the same files.
// Each stream is keyed by a string, so a message's content depends only on
// its key and not on how many numbers other messages used.

/** 32-bit FNV-1a over the UTF-16 code units of a string. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A small, fast generator (sfc32) seeded from a string key. */
export class Random {
  /** @param {string} key */
  constructor(key) {
    this.key = key;
    this.a = fnv1a(`${key}#a`);
    this.b = fnv1a(`${key}#b`);
    this.c = fnv1a(`${key}#c`);
    this.d = fnv1a(`${key}#d`) | 1;
    for (let i = 0; i < 16; i++) this.next();
  }

  /** A new, independent stream for a sub-key. */
  fork(label) {
    return new Random(`${this.key}/${label}`);
  }

  /** The next unsigned 32-bit integer. */
  next() {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** A float in [0, 1). */
  float() {
    return this.next() / 4294967296;
  }

  /** An integer in [min, max], both included. */
  int(min, max) {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  chance(probability) {
    return this.float() < probability;
  }

  pick(items) {
    return items[Math.floor(this.float() * items.length)];
  }

  /** A standard normal value (Box-Muller). */
  normal() {
    const u = 1 - this.float();
    const v = this.float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** A log-normal value with the given median and 95th percentile. */
  logNormal(median, p95) {
    const sigma = Math.log(p95 / median) / 1.6448536269514722;
    return Math.exp(Math.log(median) + sigma * this.normal());
  }

  /** Shuffles an array in place (Fisher-Yates) and returns it. */
  shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  /** `count` pseudo-random bytes. */
  bytes(count) {
    const out = Buffer.allocUnsafe(count);
    let i = 0;
    for (; i + 4 <= count; i += 4) out.writeUInt32LE(this.next(), i);
    if (i < count) {
      const last = this.next();
      for (let k = 0; i < count; i++, k++) out[i] = (last >>> (8 * k)) & 0xff;
    }
    return out;
  }
}
