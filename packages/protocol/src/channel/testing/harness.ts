// TEST ONLY. A fake daemon policy (invites + device registry behind one synchronous admit) and helpers to run
// handshakes over an in-memory "relay" that logs every byte and can tamper. Not reachable from any entry point.
import { toHex, utf8Decode, utf8Encode } from '../../bytes.ts';
import { buildInviteUrl, deriveInviteKeys, generateInviteSecret, parseInviteUrl } from '../../invite.ts';
import { x25519KeyPair, type RawNoiseKeyPair } from '../../noise/suite.ts';
import {
  clientConnect,
  daemonAccept,
  type AdmitContext,
  type AdmitDecision,
  type ClientConnectOptions,
  type ClientConnectResult,
  type ClientTrust,
  type DaemonAcceptOptions,
  type DaemonAcceptResult,
  type DaemonInviteKey,
} from '../handshake.ts';
import { createMemoryTransportPair, type MemoryDirection, type Transport } from '../transport.ts';
import type { ChannelError } from '../errors.ts';

export const WS = 'ws_test_0123456789';

type InviteRecord = { inviteId: Uint8Array; psk: Uint8Array; usesLeft: number; expiresAt: number };

export const accept = (text: string): AdmitDecision => ({ accept: true, payload: utf8Encode(text) });
export const reject = (reason: string): AdmitDecision => ({ accept: false, payload: utf8Encode(reason) });

/** The daemon's side of R2/R3 as the real daemon must implement it: check and consume in ONE synchronous step. */
export class FakeDaemon {
  readonly staticKey: RawNoiseKeyPair = x25519KeyPair();
  readonly invites = new Map<string, InviteRecord>();
  readonly devices = new Map<string, { revoked: boolean }>();
  readonly admitted: AdmitContext[] = [];
  admitCalls = 0;
  now: () => number = Date.now;

  addInvite(secret: Uint8Array = generateInviteSecret(), uses = 1, ttlMs = 60_000): { secret: Uint8Array; trust: ClientTrust; url: string } {
    const { inviteId, psk } = deriveInviteKeys(secret);
    this.invites.set(toHex(inviteId), { inviteId, psk, usesLeft: uses, expiresAt: this.now() + ttlMs });
    const url = buildInviteUrl('https://smurg.app', WS, this.staticKey.publicKey, secret);
    const parsed = parseInviteUrl(url);
    return { secret, url, trust: { kind: 'invite', fingerprint: parsed.fingerprint, secret: parsed.secret } };
  }

  usesLeft(secret: Uint8Array): number | undefined {
    return this.invites.get(toHex(deriveInviteKeys(secret).inviteId))?.usesLeft;
  }

  revoke(publicKey: Uint8Array): void {
    const device = this.devices.get(toHex(publicKey));
    if (device) device.revoked = true;
  }

  inviteKeys = (): DaemonInviteKey[] => [...this.invites.values()].map(({ inviteId, psk }) => ({ inviteId, psk }));

  admit = (ctx: AdmitContext): AdmitDecision => {
    this.admitCalls++;
    const key = toHex(ctx.clientStaticKey);
    const device = this.devices.get(key);
    if (device?.revoked) return reject('device-revoked');
    if (ctx.mode === 'device') {
      if (!device) return reject('device-unknown');
      this.admitted.push(ctx);
      return accept(`welcome device ${utf8Decode(ctx.helloPayload)}`);
    }
    const invite = ctx.inviteId ? this.invites.get(toHex(ctx.inviteId)) : undefined;
    if (!invite) return reject('invite-invalid');
    if (this.now() > invite.expiresAt) return reject('invite-expired');
    if (invite.usesLeft <= 0) return reject('invite-exhausted');
    invite.usesLeft--; // same synchronous step as the checks above
    this.devices.set(key, { revoked: false });
    this.admitted.push(ctx);
    return accept(`welcome invite ${utf8Decode(ctx.helloPayload)}`);
  };

  accept(transport: Transport, extra: Partial<DaemonAcceptOptions> = {}): Promise<DaemonAcceptResult> {
    return daemonAccept(transport, {
      workspaceId: WS,
      staticKey: this.staticKey,
      invites: this.inviteKeys,
      admit: this.admit,
      ...extra,
    });
  }
}

export type Tap = (frame: Uint8Array, direction: MemoryDirection) => readonly Uint8Array[];

export interface RunResult {
  client: PromiseSettledResult<ClientConnectResult>;
  daemon: PromiseSettledResult<DaemonAcceptResult>;
  log: readonly { direction: MemoryDirection; frame: Uint8Array }[];
}

/** One client and one daemon over a logging (and optionally tampering) in-memory relay. */
export async function runHandshake(
  daemon: FakeDaemon,
  client: Omit<ClientConnectOptions, 'workspaceId' | 'hello'> & Partial<Pick<ClientConnectOptions, 'workspaceId' | 'hello'>>,
  options: { tap?: Tap; wrapClient?: (t: Transport) => Transport; daemonOptions?: Partial<DaemonAcceptOptions> } = {},
): Promise<RunResult> {
  const pair = createMemoryTransportPair(options.tap ? { tap: options.tap } : {});
  const clientTransport = options.wrapClient ? options.wrapClient(pair.client) : pair.client;
  const [c, d] = await Promise.allSettled([
    clientConnect(clientTransport, { workspaceId: WS, hello: utf8Encode('client-hello'), ...client }),
    daemon.accept(pair.daemon, options.daemonOptions),
  ]);
  return { client: c, daemon: d, log: pair.log };
}

export function errorOf(result: PromiseSettledResult<unknown>): ChannelError | undefined {
  return result.status === 'rejected' ? (result.reason as ChannelError) : undefined;
}

export function valueOf<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

export function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Delays frames that match `predicate` on their way out of `transport`. */
export function delaySends(transport: Transport, predicate: (frame: Uint8Array) => boolean, ms: number): Transport {
  return {
    send(frame) {
      if (predicate(frame)) setTimeout(() => transport.send(frame), ms);
      else transport.send(frame);
    },
    onMessage: (h) => transport.onMessage(h),
    onClose: (h) => transport.onClose(h),
    close: (code, reason) => transport.close(code, reason),
  };
}

export function nextMessage(channel: { onMessage(h: (m: Uint8Array) => void): () => void }): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const off = channel.onMessage((m) => {
      off();
      resolve(m);
    });
  });
}
