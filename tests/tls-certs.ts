// SPDX-License-Identifier: AGPL-3.0-or-later
// Throwaway TLS certificates for loopback test servers, made with openssl at
// test time: a test CA, a server certificate it signs for 127.0.0.1 and
// localhost, one it signs for another name only, and a self-signed one.
// Nothing here is committed; the keys live in the test's own folder.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testDir } from './paths';

export interface TestCerts {
  ca: string;
  /** Signed by the CA, for IP 127.0.0.1 and DNS localhost. */
  server: { cert: string; key: string };
  /** Signed by the CA, for DNS other.test only. */
  wrongName: { cert: string; key: string };
  /** Signed by nobody the client trusts. */
  selfSigned: { cert: string; key: string };
}

function openssl(dir: string, args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

const KEY = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

function leaf(dir: string, name: string, san: string): { cert: string; key: string } {
  openssl(dir, [
    'req',
    ...KEY,
    '-subj',
    `/CN=${name}`,
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
  ]);
  writeFileSync(
    join(dir, `${name}.ext`),
    `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,
  );
  openssl(dir, [
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    `${name}.ext`,
    '-out',
    `${name}.pem`,
  ]);
  return {
    cert: readFileSync(join(dir, `${name}.pem`), 'utf8'),
    key: readFileSync(join(dir, `${name}.key`), 'utf8'),
  };
}

export function makeCerts(): TestCerts {
  const dir = testDir('tls-certs');
  writeFileSync(
    join(dir, 'ca.cnf'),
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      'x509_extensions = v3_ca',
      '[dn]',
      'CN = pev-test-ca',
      '[v3_ca]',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
  );
  openssl(dir, [
    'req',
    '-x509',
    ...KEY,
    '-days',
    '2',
    '-config',
    'ca.cnf',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
  ]);
  const server = leaf(dir, 'server', 'IP:127.0.0.1,DNS:localhost');
  const wrongName = leaf(dir, 'wrong', 'DNS:other.test');
  openssl(dir, [
    'req',
    '-x509',
    ...KEY,
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout',
    'self.key',
    '-out',
    'self.pem',
  ]);
  return {
    ca: readFileSync(join(dir, 'ca.pem'), 'utf8'),
    server,
    wrongName,
    selfSigned: {
      cert: readFileSync(join(dir, 'self.pem'), 'utf8'),
      key: readFileSync(join(dir, 'self.key'), 'utf8'),
    },
  };
}
