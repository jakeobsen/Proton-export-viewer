// SPDX-License-Identifier: AGPL-3.0-or-later
// Fetches one remote image: the request, its redirects and its budgets.
//
// Every socket connects to an address the policy checked. For a name, the
// request's `lookup` resolves it, checks every answer, and hands Node only
// checked addresses, so the address connected to is the address checked and
// a second resolution can't change it. Node never calls `lookup` for an IP
// literal, so a literal is checked before the request is made. When the
// socket connects, its remote address is compared with the checked ones
// once more.
//
// Requests use Node's own HTTP/1.1 client with a fresh agent per request, so
// no connection, proxy or cookie is shared or reused; TLS uses Node's default
// trust store and refuses any certificate error. Exactly five headers are
// sent. Nothing is decompressed: a response with any Content-Encoding but
// identity is refused. The body must pass the raster check.

import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkRaster, type RasterFormat } from '../core/reader/raster';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_MS,
  MAX_REDIRECTS,
  type Destination,
  type FetchRefusal,
} from '../shared/fetcher-protocol';
import {
  checkAddress,
  checkAnswers,
  formatIp,
  isTestAllowed,
  parseIp,
  parseTarget,
  sameIp,
  type Ip,
  type Target,
  type TestAllow,
} from './address';

/** One generic User-Agent, the same for every request. */
export const USER_AGENT = 'Mozilla/5.0';
export const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** `dns.lookup` with `{ all: true }`, or a stand-in for it. */
export type Resolve = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface FetchEnv {
  resolve: Resolve;
  /** Builds with test hooks only: the one loopback address and port allowed. */
  allow: TestAllow | null;
  /** Builds with test hooks only: told about every connect. */
  record: ((destination: Destination) => void) | null;
  now: () => number;
  /** Tests only: a shorter wall-clock budget. */
  imageMaxMs?: number;
}

/** The bytes a whole view may still receive, shared by its images. */
export interface ViewBytes {
  /** Counts bytes received; false once the view has received more than it may. */
  take(bytes: number): boolean;
  /** How many more bytes the view may receive. */
  left(): number;
}

export type ImageOutcome =
  | {
      ok: true;
      bytes: Uint8Array;
      format: RasterFormat;
      insecure: boolean;
      status: number;
      ms: number;
    }
  | { ok: false; reason: FetchRefusal; insecure: boolean; status: number | null; ms: number };

type Hop =
  | { kind: 'redirect'; location: string; status: number }
  | { kind: 'body'; bytes: Uint8Array; status: number }
  | { kind: 'refused'; reason: FetchRefusal; status: number | null };

/** The policy refused what a lookup or a connect found. */
class PolicyError extends Error {
  constructor(readonly reason: FetchRefusal) {
    super(reason);
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * The `lookup` a request uses for a name. It resolves every address, refuses
 * the name if any answer is refused, and passes on only checked addresses.
 * Node calls it in two forms: `{ all: true }` wants every address, the other
 * form one address (of the family asked for, if one is). Each checked
 * address is added to `checked`. An answer that comes after `cancelled()` is
 * ignored: nothing connects to it.
 */
export function policyLookup(
  resolve: Resolve,
  target: Pick<Target, 'port' | 'testPort'>,
  allow: TestAllow | null,
  checked: Ip[],
  cancelled: () => boolean,
) {
  const testEntry = (ip: Ip) => isTestAllowed(allow, formatIp(ip), target.port);
  return (
    hostname: string,
    options: LookupOneOptions | LookupAllOptions,
    callback: LookupCallback,
  ) => {
    resolve(hostname, { all: true, verbatim: true }, (err, answers) => {
      if (cancelled()) {
        callback(new PolicyError('aborted'), []);
        return;
      }
      if (err || !Array.isArray(answers)) {
        callback(new PolicyError('dns'), []);
        return;
      }
      const result = checkAnswers(answers, testEntry);
      if (!result.ok) {
        callback(new PolicyError(result.reason), []);
        return;
      }
      // On the test entry's port, only the test entry's address.
      if (target.testPort && !result.ips.every(testEntry)) {
        callback(new PolicyError('port'), []);
        return;
      }
      const family = familyOf(options?.family);
      const ips = family === null ? result.ips : result.ips.filter((ip) => ip.family === family);
      if (ips.length === 0) {
        callback(new PolicyError('dns'), []);
        return;
      }
      checked.push(...ips);
      if (options?.all) {
        callback(
          null,
          ips.map((ip) => ({ address: formatIp(ip), family: ip.family })),
        );
      } else {
        callback(null, formatIp(ips[0]!), ips[0]!.family);
      }
    });
  };
}

function familyOf(family: unknown): 4 | 6 | null {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return null;
}

/** A certificate or handshake error. */
function isTlsError(err: NodeJS.ErrnoException): boolean {
  const code = err.code ?? '';
  return (
    code.includes('CERT') ||
    code.includes('SELF_SIGNED') ||
    code.startsWith('UNABLE_TO_') ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code === 'EPROTO'
  );
}

interface HopLimits {
  /** Bytes this image may still receive. */
  imageLeft: number;
  view: ViewBytes;
}

/** One request: no redirect is followed here. */
function requestOnce(
  target: Target,
  signal: AbortSignal,
  env: FetchEnv,
  limits: HopLimits,
): Promise<Hop> {
  return new Promise<Hop>((resolve) => {
    let settled = false;
    let failure: FetchRefusal | null = null;
    let status: number | null = null;
    let req: ClientRequest | null = null;
    const finish = (hop: Hop) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      req?.destroy();
      resolve(hop);
    };
    const refuse = (reason: FetchRefusal) => finish({ kind: 'refused', reason, status });
    const onAbort = () => refuse('aborted');
    if (signal.aborted) {
      refuse('aborted');
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    const checked: Ip[] = [];
    if (target.literal !== null) {
      const literal = target.literal;
      const testEntry = isTestAllowed(env.allow, formatIp(literal), target.port);
      if (!testEntry && !checkAddress(literal).ok) {
        refuse('address');
        return;
      }
      checked.push(literal);
    }

    const servername = target.literal === null ? target.host : '';
    const options = {
      method: 'GET',
      host: target.host,
      port: target.port,
      path: `${target.url.pathname}${target.url.search}`,
      headers: {
        Host: target.url.host,
        'User-Agent': USER_AGENT,
        Accept: ACCEPT,
        'Accept-Encoding': 'identity',
        Connection: 'close',
      },
      setHost: false,
      agent: false as const,
      autoSelectFamily: false,
      insecureHTTPParser: false,
      lookup: policyLookup(env.resolve, target, env.allow, checked, () => settled),
    };
    try {
      req = target.secure
        ? httpsRequest({ ...options, servername, rejectUnauthorized: true })
        : httpRequest(options);
    } catch {
      refuse('invalid');
      return;
    }

    req.once('socket', (socket) => {
      socket.once('connect', () => {
        const remote = socket.remoteAddress === undefined ? null : parseIp(socket.remoteAddress);
        if (remote === null || !checked.some((ip) => sameIp(ip, remote))) {
          failure = 'address';
          req?.destroy(new PolicyError('address'));
          return;
        }
        env.record?.({
          address: formatIp(remote),
          port: socket.remotePort ?? 0,
          servername: target.secure && servername !== '' ? servername : null,
        });
      });
    });

    req.once('error', (err: NodeJS.ErrnoException) => {
      if (err instanceof PolicyError) refuse(err.reason);
      else if (failure !== null) refuse(failure);
      else if (target.secure && isTlsError(err)) refuse('tls');
      else refuse('network');
    });

    req.once('response', (res: IncomingMessage) => {
      status = res.statusCode ?? null;
      if (status !== null && REDIRECT_STATUSES.has(status)) {
        const location = res.headers.location;
        res.destroy();
        if (typeof location !== 'string' || location === '') refuse('status');
        else finish({ kind: 'redirect', location, status });
        return;
      }
      if (status === null || status < 200 || status > 299) {
        res.destroy();
        refuse('status');
        return;
      }
      const encoding = res.headers['content-encoding'];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
        res.destroy();
        refuse('encoding');
        return;
      }
      // A declared length past what's left is refused before any of the body is read.
      const declared = Number(res.headers['content-length']);
      if (Number.isSafeInteger(declared)) {
        if (declared > limits.imageLeft) {
          refuse('too_large');
          return;
        }
        if (declared > limits.view.left()) {
          refuse('total');
          return;
        }
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > limits.imageLeft) {
          refuse('too_large');
          return;
        }
        if (!limits.view.take(chunk.length)) {
          refuse('total');
          return;
        }
        chunks.push(chunk);
      });
      res.once('end', () => {
        const bytes = new Uint8Array(Buffer.concat(chunks, received));
        finish({ kind: 'body', bytes, status: status ?? 0 });
      });
      res.once('aborted', () => refuse('network'));
      res.once('error', () => refuse('network'));
    });

    req.end();
  });
}

/**
 * Fetches one image: at most MAX_REDIRECTS redirects, each checked like the
 * first URL; IMAGE_MAX_MS and IMAGE_MAX_BYTES across all of them. Any hop over
 * http marks the image insecure. `signal` aborts it at once.
 */
export async function fetchImage(
  raw: string,
  view: ViewBytes,
  signal: AbortSignal,
  env: FetchEnv,
): Promise<ImageOutcome> {
  const started = env.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, env.imageMaxMs ?? IMAGE_MAX_MS);
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) controller.abort();

  let insecure = false;
  let status: number | null = null;
  const end = (outcome: { ok: false; reason: FetchRefusal }): ImageOutcome => ({
    ...outcome,
    // A request cut by the image's own clock timed out; one cut by the view was aborted.
    reason: outcome.reason === 'aborted' && timedOut ? 'timeout' : outcome.reason,
    insecure,
    status,
    ms: env.now() - started,
  });
  try {
    let url = raw;
    let base: URL | undefined;
    let received = 0;
    for (let redirects = 0; ; redirects += 1) {
      const parsed = parseTarget(url, base, env.allow);
      if (!parsed.ok) return end({ ok: false, reason: parsed.reason });
      const target = parsed.target;
      if (!target.secure) insecure = true;
      const hop = await requestOnce(target, controller.signal, env, {
        imageLeft: IMAGE_MAX_BYTES - received,
        view,
      });
      status = hop.status;
      if (hop.kind === 'refused') return end({ ok: false, reason: hop.reason });
      if (hop.kind === 'redirect') {
        if (redirects + 1 > MAX_REDIRECTS) return end({ ok: false, reason: 'redirects' });
        base = target.url;
        url = hop.location;
        continue;
      }
      received += hop.bytes.length;
      const check = checkRaster(hop.bytes);
      if (!check.ok) return end({ ok: false, reason: check.reason });
      return {
        ok: true,
        bytes: hop.bytes,
        format: check.image.format,
        insecure,
        status: hop.status,
        ms: env.now() - started,
      };
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
