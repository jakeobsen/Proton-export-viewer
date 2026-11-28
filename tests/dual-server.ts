// SPDX-License-Identifier: AGPL-3.0-or-later
// One loopback port that speaks both http and https, for the fetcher's tests:
// the first byte of each connection (0x16 starts a TLS handshake) picks an
// internal http or https server, and the bytes are piped through unchanged.
// Clients see one address and port, the one the fetcher's test entry allows.

import { once } from 'node:events';
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as HttpServer,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';

export interface DualServer {
  port: number;
  /** Connections the public port accepted. */
  connections(): number;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

const closed = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

export async function dualServer(
  handler: RequestListener,
  tls: { cert: string; key: string },
): Promise<DualServer> {
  const http: HttpServer = createHttpServer(handler);
  const https = createHttpsServer(tls, handler);
  const httpPort = await listen(http);
  const httpsPort = await listen(https);
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => undefined);
  };
  let connections = 0;
  const front = createNetServer((socket) => {
    connections += 1;
    track(socket);
    socket.once('data', (first) => {
      const back = connect(first[0] === 0x16 ? httpsPort : httpPort, '127.0.0.1');
      track(back);
      back.on('close', () => socket.destroy());
      socket.on('close', () => back.destroy());
      back.write(first);
      socket.pipe(back);
      back.pipe(socket);
    });
  });
  const port = await listen(front);
  return {
    port,
    connections: () => connections,
    close: async () => {
      for (const s of sockets) s.destroy();
      http.closeAllConnections();
      https.closeAllConnections();
      await Promise.all([closed(front), closed(http), closed(https)]);
    },
  };
}
