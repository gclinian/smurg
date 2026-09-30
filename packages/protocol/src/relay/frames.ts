import { z } from 'zod';
import { CLOSE_REASON_MAX_BYTES, RELAY_CONTROL_MAX_CHARS } from '../constants.ts';
import { MAX_CONN_ID, MIN_CONN_ID } from './binary.ts';
import { RELAY_CLOSE_CODES, utf8ByteLength } from './close-codes.ts';

// Relay control frames (ARCHITECTURE §6). Control is JSON in WebSocket TEXT frames; tunnelled traffic is binary.
// Schemas are strict (unknown keys are rejected): relay, daemon, CLI and web ship from one repository, so a new field
// is a protocol change, and a parser that silently accepts unknown input is harder to reason about.

// ---------------------------------------------------------------------------------------------------------------
// Heartbeat: the exact text frames "ping" -> "pong", answered by the Durable Object's auto-response without waking
// it. Only a text "ping" moves getWebSocketAutoResponseTimestamp; protocol-level pings do not (relay.md V29).
// ---------------------------------------------------------------------------------------------------------------

export const RELAY_PING = 'ping';
export const RELAY_PONG = 'pong';

// ---------------------------------------------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------------------------------------------

export const relayConnIdSchema = z.number().int().min(MIN_CONN_ID).max(MAX_CONN_ID);

/** Relay-issued user ids: "github:<numeric id>" | "google:<sub>" | "dev:<name>" (ARCHITECTURE §3). */
export const RELAY_USER_ID_PATTERN = /^(?:github:[1-9][0-9]{0,19}|google:[A-Za-z0-9_-]{1,255}|dev:[A-Za-z0-9._-]{1,64})$/;
export const relayUserIdSchema = z.string().regex(RELAY_USER_ID_PATTERN, 'not a relay user id');

export const RELAY_DISPLAY_NAME_MAX_CHARS = 256;
// Control characters and bidi overrides would let a name spoof other text in the host's member list.
const UNSAFE_NAME_CHARS = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;
const UNSAFE_NAME_CHARS_GLOBAL = new RegExp(UNSAFE_NAME_CHARS.source, 'gu');

export const relayDisplayNameSchema = z
  .string()
  .min(1)
  .max(RELAY_DISPLAY_NAME_MAX_CHARS)
  .refine((name) => /\S/u.test(name), 'display name is blank')
  .refine((name) => !UNSAFE_NAME_CHARS.test(name), 'display name contains control or bidi characters');

/**
 * Turns an identity provider's display name into one that relayDisplayNameSchema accepts: strips control and bidi
 * characters, trims, and cuts to the maximum length without splitting a code point. Returns `fallback` when nothing
 * is left (callers pass e.g. the provider login).
 */
export function sanitizeRelayDisplayName(name: string, fallback: string): string {
  const cleaned = cutCodePoints(name.replace(UNSAFE_NAME_CHARS_GLOBAL, '').trim(), RELAY_DISPLAY_NAME_MAX_CHARS);
  if (cleaned.length > 0) return cleaned;
  return cutCodePoints(fallback.replace(UNSAFE_NAME_CHARS_GLOBAL, '').trim(), RELAY_DISPLAY_NAME_MAX_CHARS);
}

function cutCodePoints(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let out = '';
  for (const codePoint of text) {
    if (out.length + codePoint.length > maxUnits) break;
    out += codePoint;
  }
  return out;
}

export const RELAY_AVATAR_URL_MAX_CHARS = 2048;
/** Avatars are shown in the UI: https only, no credentials in the URL. */
export const relayAvatarUrlSchema = z
  .string()
  .max(RELAY_AVATAR_URL_MAX_CHARS)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'avatar URL must be an https URL without credentials');

/** Close reasons travel in `bye` and then in the WebSocket close frame, which allows 123 bytes of UTF-8. */
export const relayCloseReasonSchema = z
  .string()
  .refine((reason) => utf8ByteLength(reason) <= CLOSE_REASON_MAX_BYTES, 'close reason exceeds 123 bytes of UTF-8');

export const RELAY_HOST_OFFLINE_REASONS = ['closed', 'timeout'] as const;

// ---------------------------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------------------------

/** relay -> client, first frame on every client socket. `host`: the host is online right now. */
export const relayHelloFrameSchema = z.strictObject({
  t: z.literal('hello'),
  conn: relayConnIdSchema,
  host: z.boolean(),
});

/** relay -> client */
export const relayHostOnlineFrameSchema = z.strictObject({
  t: z.literal('host.online'),
});

/** relay -> client: the host socket closed, or the alarm saw no host ping for RELAY_HOST_TIMEOUT_MS. */
export const relayHostOfflineFrameSchema = z.strictObject({
  t: z.literal('host.offline'),
  reason: z.enum(RELAY_HOST_OFFLINE_REASONS),
});

/** relay -> host: a logged-in client opened a socket. Identity is the relay's claim, not proof (ARCHITECTURE §2). */
export const relayPeerOpenFrameSchema = z.strictObject({
  t: z.literal('peer.open'),
  conn: relayConnIdSchema,
  userId: relayUserIdSchema,
  displayName: relayDisplayNameSchema,
  avatarUrl: relayAvatarUrlSchema.optional(),
});

/** relay -> host */
export const relayPeerCloseFrameSchema = z.strictObject({
  t: z.literal('peer.close'),
  conn: relayConnIdSchema,
});

/** host -> relay: close that client with 4003 (kicked). */
export const relayPeerKickFrameSchema = z.strictObject({
  t: z.literal('peer.kick'),
  conn: relayConnIdSchema,
  reason: relayCloseReasonSchema,
});

/** relay -> anyone, always sent right before a relay-initiated close. */
export const relayByeFrameSchema = z.strictObject({
  t: z.literal('bye'),
  code: z.literal([
    RELAY_CLOSE_CODES.heartbeatTimeout,
    RELAY_CLOSE_CODES.hostReplaced,
    RELAY_CLOSE_CODES.kicked,
    RELAY_CLOSE_CODES.tooBig,
  ]),
  reason: relayCloseReasonSchema,
});

export const relayToClientFrameSchema = z.discriminatedUnion('t', [
  relayHelloFrameSchema,
  relayHostOnlineFrameSchema,
  relayHostOfflineFrameSchema,
  relayByeFrameSchema,
]);

export const relayToHostFrameSchema = z.discriminatedUnion('t', [
  relayPeerOpenFrameSchema,
  relayPeerCloseFrameSchema,
  relayByeFrameSchema,
]);

export const hostToRelayFrameSchema = z.discriminatedUnion('t', [relayPeerKickFrameSchema]);

/** Every control frame, in any direction. */
export const relayControlFrameSchema = z.discriminatedUnion('t', [
  relayHelloFrameSchema,
  relayHostOnlineFrameSchema,
  relayHostOfflineFrameSchema,
  relayPeerOpenFrameSchema,
  relayPeerCloseFrameSchema,
  relayPeerKickFrameSchema,
  relayByeFrameSchema,
]);

export type RelayHelloFrame = z.infer<typeof relayHelloFrameSchema>;
export type RelayHostOnlineFrame = z.infer<typeof relayHostOnlineFrameSchema>;
export type RelayHostOfflineFrame = z.infer<typeof relayHostOfflineFrameSchema>;
export type RelayPeerOpenFrame = z.infer<typeof relayPeerOpenFrameSchema>;
export type RelayPeerCloseFrame = z.infer<typeof relayPeerCloseFrameSchema>;
export type RelayPeerKickFrame = z.infer<typeof relayPeerKickFrameSchema>;
export type RelayByeFrame = z.infer<typeof relayByeFrameSchema>;
export type RelayToClientFrame = z.infer<typeof relayToClientFrameSchema>;
export type RelayToHostFrame = z.infer<typeof relayToHostFrameSchema>;
export type HostToRelayFrame = z.infer<typeof hostToRelayFrameSchema>;
export type RelayControlFrame = z.infer<typeof relayControlFrameSchema>;
export type RelayHostOfflineReason = (typeof RELAY_HOST_OFFLINE_REASONS)[number];

// ---------------------------------------------------------------------------------------------------------------
// Parsing and encoding text frames
// ---------------------------------------------------------------------------------------------------------------

export type RelayTextInvalidReason = 'too-large' | 'not-json' | 'schema';

export type RelayTextMessage<F> =
  | { kind: 'ping' }
  | { kind: 'pong' }
  | { kind: 'control'; frame: F }
  | { kind: 'invalid'; reason: RelayTextInvalidReason; detail: string };

function parseText<F>(schema: z.ZodType<F>, text: string): RelayTextMessage<F> {
  if (text === RELAY_PING) return { kind: 'ping' };
  if (text === RELAY_PONG) return { kind: 'pong' };
  if (text.length > RELAY_CONTROL_MAX_CHARS) {
    return { kind: 'invalid', reason: 'too-large', detail: `${text.length} chars > ${RELAY_CONTROL_MAX_CHARS}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'not-json', detail: 'text frame is not JSON' };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { kind: 'invalid', reason: 'schema', detail: z.prettifyError(result.error) };
  }
  return { kind: 'control', frame: result.data };
}

/** Client side: classify a text frame received from the relay. Invalid input must be ignored or end the socket. */
export function parseRelayToClientText(text: string): RelayTextMessage<RelayToClientFrame> {
  return parseText(relayToClientFrameSchema, text);
}

/** Daemon side: classify a text frame received from the relay on the host socket. */
export function parseRelayToHostText(text: string): RelayTextMessage<RelayToHostFrame> {
  return parseText(relayToHostFrameSchema, text);
}

/** Relay side: classify a text frame received on the host socket. */
export function parseHostToRelayText(text: string): RelayTextMessage<HostToRelayFrame> {
  return parseText(hostToRelayFrameSchema, text);
}

/**
 * Validates and serialises a control frame. Throws on an invalid frame (fail closed): a peer must never put a frame
 * on the wire that the other side would reject. Sanitize names with sanitizeRelayDisplayName and reasons with
 * truncateCloseReason first.
 */
export function encodeRelayControl(frame: RelayControlFrame): string {
  const text = JSON.stringify(relayControlFrameSchema.parse(frame));
  if (text.length > RELAY_CONTROL_MAX_CHARS) throw new RangeError('relay control frame exceeds RELAY_CONTROL_MAX_CHARS');
  return text;
}
