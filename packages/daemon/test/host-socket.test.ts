// The production host socket (the `ws` package) against a real WebSocket server on 127.0.0.1: the bearer header
// arrives, text stays text, binary arrives as fresh bytes, and the relay link runs over it end to end.
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { DEFAULT_TIMING } from '../src/core/config.ts';
import { systemClock } from '../src/core/lifecycle.ts';
import { silentLogger } from '../src/core/logger.ts';
import { wsHostSocketFactory, type HostSocket } from '../src/net/host-socket.ts';
import { RelayLink } from '../src/net/relay-connection.ts';
import { waitFor } from '../src/testing/index.ts';

let server: WebSocketServer | null = null;
const sockets: HostSocket[] = [];
const links: RelayLink[] = [];

afterEach(async () => {
  for (const link of links.splice(0)) link.stop();
  for (const socket of sockets.splice(0)) socket.terminate();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function startServer(onConnection: (socket: ServerSocket, auth: string | undefined, path: string | undefined) => void): Promise<string> {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, request) => onConnection(socket, request.headers.authorization, request.url));
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('wsHostSocketFactory', () => {
  it('sends the bearer header and keeps text and binary frames apart', async () => {
    const seen: { auth?: string; text: string[]; binary: number[][] } = { text: [], binary: [] };
    const base = await startServer((socket, auth) => {
      seen.auth = auth;
      socket.on('message', (data, isBinary) => {
        if (isBinary) seen.binary.push([...(data as Buffer)]);
        else seen.text.push(data.toString());
      });
      socket.send('pong');
      socket.send(Buffer.from([0, 0, 0, 7, 42]));
    });
    const received: (string | number[])[] = [];
    let opened = false;
    const socket = wsHostSocketFactory()(`${base}/ws/x/host`, { authorization: 'Bearer dummy-token' }, {
      open: () => {
        opened = true;
      },
      message: (data) => received.push(typeof data === 'string' ? data : [...data]),
      close: () => {},
      error: () => {},
    });
    sockets.push(socket);
    await waitFor(() => opened && received.length === 2);
    socket.send('ping');
    socket.send(new Uint8Array([0, 0, 0, 7, 1, 2]));
    await waitFor(() => seen.text.length === 1 && seen.binary.length === 1);
    expect(seen.auth).toBe('Bearer dummy-token');
    expect(received).toEqual(['pong', [0, 0, 0, 7, 42]]);
    expect(seen.text).toEqual(['ping']);
    expect(seen.binary).toEqual([[0, 0, 0, 7, 1, 2]]);
  });

  it('carries a RelayLink: ping/pong keeps it online, peer.open and frames are demultiplexed', async () => {
    const frames: { conn: number; payload: number[] }[] = [];
    const opened: number[] = [];
    let path: string | undefined;
    const base = await startServer((socket, _auth, url) => {
      path = url;
      socket.on('message', (data, isBinary) => {
        if (!isBinary && data.toString() === 'ping') socket.send('pong');
      });
      socket.send(JSON.stringify({ t: 'peer.open', conn: 3, userId: 'dev:amy', displayName: 'Amy' }));
      socket.send(Buffer.from([0, 0, 0, 3, 9, 9]));
    });
    const link = new RelayLink({
      url: `${base}/ws/ws_test_host_socket_1/host`,
      token: 'dummy-token',
      label: 'ws',
      socketFactory: wsHostSocketFactory(),
      timing: { ...DEFAULT_TIMING, relayPingIntervalMs: 20, pongWatchdogMs: 200 },
      clock: systemClock,
      log: silentLogger,
      handlers: {
        online: () => {},
        offline: () => {},
        peerOpen: (frame) => opened.push(frame.conn),
        peerClose: () => {},
        frame: (conn, payload) => frames.push({ conn, payload: [...payload] }),
      },
    });
    links.push(link);
    link.start();
    await waitFor(() => frames.length === 1 && opened.length === 1);
    expect(path).toBe('/ws/ws_test_host_socket_1/host');
    expect(opened).toEqual([3]);
    expect(frames).toEqual([{ conn: 3, payload: [9, 9] }]);
    await new Promise((resolve) => setTimeout(resolve, 400)); // two watchdog periods of healthy pinging
    expect(link.state).toBe('online');
  });
});
