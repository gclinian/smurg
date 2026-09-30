// Shared helpers for the relay's own tests.
import { randomBytes } from 'node:crypto';
import { RELAY_PING, prefixFrame, splitFrame, wsClientUrl, wsHostUrl, xferClientUrl, xferHostUrl } from '@smurg/protocol/relay';
import { connectRelaySocket, type LocalRelay, type RelaySocket, type RelaySocketOptions } from '../test-support/index.ts';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function randomWorkspaceId(): string {
  return randomBytes(16).toString('base64url');
}

export type Kind = 'ws' | 'xfer';

export function tunnelUrl(relay: LocalRelay, kind: Kind, role: 'host' | 'client', workspaceId: string): string {
  if (kind === 'ws') return role === 'host' ? wsHostUrl(relay.origin, workspaceId) : wsClientUrl(relay.origin, workspaceId);
  return role === 'host' ? xferHostUrl(relay.origin, workspaceId) : xferClientUrl(relay.origin, workspaceId);
}

/** Opens a socket and waits for 101 (throws RelayUpgradeError otherwise). */
export async function open(url: string, options: RelaySocketOptions): Promise<RelaySocket> {
  const socket = connectRelaySocket(url, options);
  await socket.opened;
  return socket;
}

/** Opens a client socket and returns it with the conn id from its `hello`. */
export async function openClient(
  relay: LocalRelay,
  kind: Kind,
  workspaceId: string,
  options: RelaySocketOptions,
): Promise<{ socket: RelaySocket; conn: number; hostOnline: boolean }> {
  const socket = await open(tunnelUrl(relay, kind, 'client', workspaceId), options);
  const hello = await socket.nextControl('hello');
  return { socket, conn: Number(hello['conn']), hostOnline: hello['host'] === true };
}

export function frameFor(conn: number, payload: Uint8Array): Uint8Array {
  return prefixFrame(conn, payload);
}

/** Splits a host-side frame into [conn, payload copy]. */
export function unframe(frame: Buffer): { conn: number; payload: Buffer } {
  const split = splitFrame(frame);
  if (!split) throw new Error('not a prefixed frame');
  return { conn: split.conn, payload: Buffer.from(split.payload) };
}

/** Closes sockets and ignores errors (cleanup in afterEach/finally). */
export function closeAll(...sockets: (RelaySocket | undefined)[]): void {
  for (const socket of sockets) {
    try {
      socket?.terminate();
    } catch {
      // already closed
    }
  }
}

/**
 * Sends one "ping", waits for its "pong" and returns the time the ping was sent: the relay's last-seen timestamp for
 * this socket is at or after that moment.
 */
export async function pingOnce(socket: RelaySocket): Promise<number> {
  const previous = socket.lastPongAt;
  const sentAt = Date.now();
  socket.send(RELAY_PING);
  const deadline = sentAt + 2_000;
  while (socket.lastPongAt === previous) {
    if (Date.now() > deadline) throw new Error('no pong within 2 s');
    await sleep(5);
  }
  return sentAt;
}
