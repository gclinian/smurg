// The control-socket protocol (ARCHITECTURE §7.1 `run/<short>.ctl`, §8): how `smurg stop`, `smurg status` and a
// host-local `smurg attach` talk to the running daemon. Shared by the daemon's control server and the CLI.
//
// Frames on the Unix stream socket:  [u32be length][u8 kind][body]   (length = 1 + body length)
//   kind 0x01 CONTROL   UTF-8 JSON, at most CTL_CONTROL_MAX_BYTES: one request from the client, one response
//   kind 0x02 ENVELOPE  one msgpack Envelope (at most MAX_APP_MESSAGE), both ways, only after a successful attach
// The client's first frame is a CONTROL request; the daemon answers with exactly one CONTROL response.
//   status → { ok, op: 'status', status } and the daemon closes the socket;
//   stop   → { ok, op: 'stop' }, the daemon closes the socket and stops (channels get channel.closed{stopped}); the
//            request names no reason: the daemon's stop reason is always CTL_STOP_REASON (verification F-2);
//   attach → { ok, op: 'attach', welcome }, then ENVELOPE frames until either side closes. The connection is a
//            logical channel of the host (DaemonLifecycle.attachLocal): same seq/outbox/resume and router, but only
//            the messages `smurg attach` sends are accepted (./local-channel.ts LOCAL_CHANNEL_TYPES; anything else is
//            refused `forbidden` {reason: 'control-socket'}), and its audit entries carry `via: 'control-socket'`.
// Anything else (unknown kind, oversized frame, invalid JSON, a second request) ends the connection.
// There is no Noise: the socket is 0600 inside the 0700 run dir, so only the host's OS account can connect.
import { z } from 'zod';
import { MAX_APP_MESSAGE, errorPayloadSchema, opaqueIdSchema, seqSchema, shortTextSchema, welcomeSchema } from '@smurg/protocol';
import type { DaemonStatus } from '../core/interfaces.ts';

export const CTL_PROTOCOL_VERSION = 1;
export const CTL_FRAME_KIND = Object.freeze({ control: 0x01, envelope: 0x02 } as const);
export type CtlFrameKind = (typeof CTL_FRAME_KIND)[keyof typeof CTL_FRAME_KIND];
export const CTL_CONTROL_MAX_BYTES = 64 * 1024;
/** Largest `length` field: a kind byte plus the largest Envelope. */
export const CTL_FRAME_MAX_BYTES = 1 + MAX_APP_MESSAGE;

export class CtlProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CtlProtocolError';
  }
}

const version = z.literal(CTL_PROTOCOL_VERSION);

/**
 * The daemon's stop reason for every `stop` of the control socket. The request carries no reason of its own (it used
 * to: verification F-2, 2026-10-02): whoever reaches the socket (every session of a 「可使用 agent」 member runs as the
 * host's OS account) must not choose the text that `smurg host` and the daemon's listeners read, e.g. one of `smurg
 * host`'s own stop reasons, which made the host's terminal miss the stop.
 */
export const CTL_STOP_REASON = 'smurg stop';

export const ctlRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ v: version, op: z.literal('status') }),
  z.strictObject({ v: version, op: z.literal('stop') }),
  z.strictObject({
    v: version,
    op: z.literal('attach'),
    deviceName: shortTextSchema.pipe(z.string().min(1)),
    resume: z.strictObject({ channelId: opaqueIdSchema, lastSeq: seqSchema }).optional(),
  }),
]);
export type CtlRequest = z.infer<typeof ctlRequestSchema>;

const count = z.int().min(0);
export const daemonStatusSchema = z.strictObject({
  workspaceId: z.string().min(1).max(64),
  started: z.boolean(),
  stopped: z.boolean(),
  relay: z.strictObject({ interactive: z.string().max(32), transfer: z.string().max(32) }),
  connections: count,
  onlineMembers: count,
  power: z.strictObject({
    active: z.boolean(),
    mechanism: z.enum(['caffeinate', 'systemd-inhibit', 'none']),
    pid: z.int().positive().nullable(),
    reason: z.string().max(1_000).nullable(),
  }),
  handshakes: z.strictObject({
    handshakes: count,
    accepted: count,
    failed: count,
    refusedByRateLimit: count,
    kickedForFailures: count,
    kickedIdle: count,
  }),
  // Added after 0.1.0 (`smurg status` shows what `smurg host` no longer prints at the start): optional, so a status
  // command still reads a daemon of an older build that was started before an upgrade.
  fingerprint: z.string().max(200).optional(),
  relayUrl: z.string().max(2_048).nullable().optional(),
  switches: z.strictObject({ attributeBashEdits: z.boolean() }).optional(),
  isGitRepo: z.boolean().optional(),
});

/** A status as the control socket carries it (the fields added after 0.1.0 may be missing: an older daemon). */
export type CtlStatus = z.infer<typeof daemonStatusSchema>;

export const ctlResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), op: z.literal('status'), status: daemonStatusSchema }),
  z.strictObject({ ok: z.literal(true), op: z.literal('stop') }),
  z.strictObject({ ok: z.literal(true), op: z.literal('attach'), welcome: welcomeSchema }),
  z.strictObject({ ok: z.literal(false), error: errorPayloadSchema }),
]);
export type CtlResponse = z.infer<typeof ctlResponseSchema>;

// Compile-time: the wire schema describes the daemon's DaemonStatus.
const statusMatches: (s: DaemonStatus) => z.input<typeof daemonStatusSchema> = (s) => ({ ...s, relay: { interactive: s.relay.interactive, transfer: s.relay.transfer } });
void statusMatches;

export interface CtlFrame {
  readonly kind: CtlFrameKind;
  /** A fresh buffer (Envelope byte fields alias it after decoding). */
  readonly body: Uint8Array;
}

export function encodeCtlFrame(kind: CtlFrameKind, body: Uint8Array): Uint8Array {
  const limit = kind === CTL_FRAME_KIND.control ? CTL_CONTROL_MAX_BYTES : MAX_APP_MESSAGE;
  if (body.length > limit) throw new CtlProtocolError(`frame body of ${body.length} bytes exceeds ${limit}`);
  const frame = new Uint8Array(5 + body.length);
  new DataView(frame.buffer).setUint32(0, 1 + body.length);
  frame[4] = kind;
  frame.set(body, 5);
  return frame;
}

/** A CONTROL frame carrying a validated request or response. */
export function encodeCtlControl(message: CtlRequest | CtlResponse): Uint8Array {
  const valid = ctlRequestSchema.safeParse(message).success || ctlResponseSchema.safeParse(message).success;
  if (!valid) throw new CtlProtocolError('not a valid control message');
  return encodeCtlFrame(CTL_FRAME_KIND.control, new TextEncoder().encode(JSON.stringify(message)));
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new CtlProtocolError('control frame is not UTF-8 JSON');
  }
}

export function parseCtlRequest(body: Uint8Array): CtlRequest {
  const parsed = ctlRequestSchema.safeParse(parseJson(body));
  if (!parsed.success) throw new CtlProtocolError('invalid control request');
  return parsed.data;
}

export function parseCtlResponse(body: Uint8Array): CtlResponse {
  const parsed = ctlResponseSchema.safeParse(parseJson(body));
  if (!parsed.success) throw new CtlProtocolError('invalid control response');
  return parsed.data;
}

/** Reassembles frames from stream chunks. Throws CtlProtocolError (end the connection) on anything malformed. */
export class CtlFrameDecoder {
  /** Received, not yet framed; joined only when a whole frame is there (an 8 MiB frame arrives in many chunks). */
  private chunks: Uint8Array[] = [];
  private size = 0;

  push(chunk: Uint8Array): CtlFrame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
    const frames: CtlFrame[] = [];
    for (;;) {
      if (this.size < 5) break;
      const head = this.peek(5);
      const length = new DataView(head.buffer, head.byteOffset, 4).getUint32(0);
      const kind = head[4];
      if (length < 1 || length > CTL_FRAME_MAX_BYTES) throw new CtlProtocolError(`bad frame length ${length}`);
      if (kind !== CTL_FRAME_KIND.control && kind !== CTL_FRAME_KIND.envelope) throw new CtlProtocolError('unknown frame kind');
      if (kind === CTL_FRAME_KIND.control && length - 1 > CTL_CONTROL_MAX_BYTES) throw new CtlProtocolError('control frame too large');
      if (this.size < 4 + length) break;
      const frame = this.take(4 + length);
      frames.push({ kind, body: frame.slice(5) });
    }
    return frames;
  }

  /** Bytes of an incomplete frame still waiting (a client that closes mid-frame). */
  get pending(): number {
    return this.size;
  }

  /** The first `n` buffered bytes (joins chunks only as far as needed). */
  private peek(n: number): Uint8Array {
    const first = this.chunks[0] as Uint8Array;
    if (first.length >= n) return first;
    this.chunks = [this.join(this.size)];
    return this.chunks[0] as Uint8Array;
  }

  private take(n: number): Uint8Array {
    const all = this.join(this.size);
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    this.size -= n;
    return all.subarray(0, n);
  }

  private join(n: number): Uint8Array {
    if (this.chunks.length === 1 && (this.chunks[0] as Uint8Array).length === n) return this.chunks[0] as Uint8Array;
    const out = new Uint8Array(n);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
