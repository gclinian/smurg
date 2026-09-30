// A forged client: the real Noise handshake and a real relay socket, but no client SDK in between, so a test can put
// bytes on the encrypted channel that the SDK would refuse to produce (a `..` path, an unexpected message). The
// daemon must treat whatever arrives as hostile (SPEC §0: permission checks run on the daemon, clients are untrusted).
import {
  PROTOCOL_VERSION,
  clientConnect,
  decodeEnvelope,
  decodeWelcome,
  encodeClientHello,
  encodeEnvelope,
  generateCnfNonce,
  identityCnf,
  parseInviteUrl,
  type AnyEnvelope,
  type ClientTrust,
  type SecureChannel,
  type Transport,
  type TransportCloseEvent,
  type Welcome,
} from '@smurg/protocol';
import { nodeCryptoSuite } from '@smurg/protocol/node';
import { wsClientUrl } from '@smurg/protocol/relay';
import { connectRelaySocket, type RelaySocket } from '@smurg/relay/testing';
import type { Stack, StackDevice } from './harness.ts';

/** A Transport over a test RelaySocket: binary frames only (control text stays with the RelaySocket). */
export function relaySocketTransport(socket: RelaySocket): Transport {
  const handlers = new Set<(frame: Uint8Array) => void>();
  const closeHandlers = new Set<(event: TransportCloseEvent) => void>();
  const pending: Uint8Array[] = [];
  let closed: TransportCloseEvent | null = null;
  socket.ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary || closed) return;
    const frame = new Uint8Array(data.byteLength);
    frame.set(data);
    if (handlers.size === 0) pending.push(frame);
    else for (const handler of [...handlers]) handler(frame);
  });
  void socket.closed.then((event) => {
    if (closed) return;
    closed = { code: event.code, reason: event.reason };
    for (const handler of [...closeHandlers]) handler(closed);
  });
  return {
    send(frame) {
      if (!closed && socket.ws.readyState === socket.ws.OPEN) socket.ws.send(frame);
    },
    onMessage(handler) {
      handlers.add(handler);
      for (const frame of pending.splice(0)) handler(frame);
      return () => {
        handlers.delete(handler);
      };
    },
    onClose(handler) {
      if (closed) {
        const event = closed;
        queueMicrotask(() => handler(event));
        return () => {};
      }
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    close() {
      if (closed) return;
      closed = { code: 1000, reason: 'closed' };
      socket.terminate();
      for (const handler of [...closeHandlers]) handler(closed);
    },
  };
}

export interface RawClient {
  readonly socket: RelaySocket;
  readonly channel: SecureChannel;
  readonly welcome: Welcome;
  /** Daemon envelopes received so far (decoded strictly, as the SDK would). */
  readonly received: AnyEnvelope[];
  /** The next client→daemon seq (the daemon de-duplicates by seq on the interactive channel). */
  nextSeq(): number;
  /** Puts raw envelope bytes on the encrypted channel. */
  sendBytes(bytes: Uint8Array): void;
  /** Resolves with the first received envelope (already received ones included) that matches. */
  next(predicate: (envelope: AnyEnvelope) => boolean, timeoutMs?: number): Promise<AnyEnvelope>;
  close(): void;
}

/**
 * Joins (invite given) or reconnects (the device's pin) with the real handshake over a raw relay socket. The device's
 * key and pin store are shared with SDK clients of the same StackDevice.
 */
export async function connectRawClient(stack: Stack, device: StackDevice, options: { readonly invite?: string } = {}): Promise<RawClient> {
  const { workspaceId, relay } = stack;
  const socket = connectRelaySocket(wsClientUrl(relay.origin, workspaceId), { token: device.session.token });
  try {
    await socket.opened;
    const hello = await socket.nextControl('hello', 10_000);
    if (hello['host'] !== true) await socket.nextControl('host.online', 10_000);
    const deviceKey = await device.deviceKeys.getKeyPair(workspaceId);
    let trust: ClientTrust;
    if (options.invite) {
      const parsed = parseInviteUrl(options.invite);
      trust = { kind: 'invite', fingerprint: parsed.fingerprint, secret: parsed.secret };
    } else {
      const pin = await device.pins.get(workspaceId);
      if (!pin) throw new Error(`${device.name} has no pinned daemon key and no invite`);
      trust = { kind: 'pinned', daemonStaticKey: pin };
    }
    const nonce = generateCnfNonce();
    const identityToken = await relay.identityToken(device.session.token, workspaceId, identityCnf(nonce, deviceKey.publicKey));
    const result = await clientConnect(relaySocketTransport(socket), {
      workspaceId,
      deviceKey,
      trust,
      hello: encodeClientHello({ protocolVersion: PROTOCOL_VERSION, purpose: 'interactive', identityToken, cnfNonce: nonce, clientKind: 'cli', deviceName: 'forged client' }),
      suite: nodeCryptoSuite,
      onDaemonVerified: (key, mode) => device.pins.pin(workspaceId, key, { replace: mode === 'invite' }),
    });
    const verdict = decodeWelcome(result.verdict);
    if (!verdict.ok || !verdict.verdict.ok) throw new Error('the daemon did not admit the raw client');
    const received: AnyEnvelope[] = [];
    const waiters: { predicate: (e: AnyEnvelope) => boolean; resolve: (e: AnyEnvelope) => void }[] = [];
    result.channel.onMessage((bytes) => {
      const decoded = decodeEnvelope(bytes, { from: 'daemon', channel: 'interactive' });
      if (!decoded.ok) return;
      received.push(decoded.envelope);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(decoded.envelope)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(decoded.envelope);
        }
      }
    });
    let seq = 0;
    return {
      socket,
      channel: result.channel,
      welcome: verdict.verdict.welcome,
      received,
      nextSeq: () => ++seq,
      sendBytes: (bytes) => result.channel.send(bytes),
      next: (predicate, timeoutMs = 10_000) => {
        const found = received.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const waiter = {
            predicate,
            resolve: (e: AnyEnvelope) => {
              clearTimeout(timer);
              resolve(e);
            },
          };
          const timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`raw client: no matching envelope within ${timeoutMs} ms`));
          }, timeoutMs);
          waiters.push(waiter);
        });
      },
      close: () => {
        result.channel.close();
        socket.terminate();
      },
    };
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

/**
 * A valid envelope whose bytes are then altered: every occurrence of `from` is replaced by `to` (same UTF-8 length,
 * exactly one occurrence), producing what a hostile client can send and the SDK's encoder never would.
 */
export function forgeEnvelope(envelope: Parameters<typeof encodeEnvelope>[0], from: string, to: string): Uint8Array {
  const bytes = Buffer.from(encodeEnvelope(envelope, { from: 'client', channel: 'interactive' }));
  const needle = Buffer.from(from, 'utf8');
  const replacement = Buffer.from(to, 'utf8');
  if (needle.length !== replacement.length) throw new RangeError('forgeEnvelope: from and to must have the same UTF-8 length');
  const at = bytes.indexOf(needle);
  if (at < 0 || bytes.indexOf(needle, at + 1) >= 0) throw new Error(`forgeEnvelope: "${from}" must occur exactly once`);
  replacement.copy(bytes, at);
  return new Uint8Array(bytes);
}
