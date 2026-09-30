import { CLOSE_REASON_MAX_BYTES } from '../constants.ts';

/**
 * WebSocket close codes the relay uses. It always sends `{ t: 'bye', code, reason }` right before closing, because
 * Node clients only see the close event when workerd's TCP FIN arrives, 10-16 s later (relay.md V11).
 */
export const RELAY_CLOSE_CODES = {
  /** WorkspaceDO alarm: the host stopped pinging. */
  heartbeatTimeout: 4000,
  /** A newer host connection replaced this one (laptop woke up and reconnected). */
  hostReplaced: 4001,
  /** The daemon asked the relay to drop this client (`peer.kick`). */
  kicked: 4003,
  /** A binary frame exceeded MAX_RELAY_FRAME. */
  tooBig: 1009,
} as const;

export type RelayCloseCode = (typeof RELAY_CLOSE_CODES)[keyof typeof RELAY_CLOSE_CODES];

/**
 * `peer.kick` reason (and so the `bye 4003` reason) the daemon uses for a relay connection that never completed a
 * handshake in time (or kept its socket after its channel ended). Not a removal of the member: a client that sees it
 * without an authenticated channel.closed before it reconnects instead of giving up.
 */
export const PEER_KICK_REASON_IDLE = 'idle';

export const RELAY_CLOSE_CODE_VALUES: readonly RelayCloseCode[] = Object.values(RELAY_CLOSE_CODES);

const utf8 = new TextEncoder();

/** UTF-8 byte length of a string (close reasons are limited in bytes, not characters). */
export function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

/**
 * Shortens `reason` to at most CLOSE_REASON_MAX_BYTES of UTF-8 without splitting a code point, so it is always safe
 * to pass to `WebSocket.close()` (which throws for longer reasons) and valid in a `bye` frame.
 */
export function truncateCloseReason(reason: string, maxBytes: number = CLOSE_REASON_MAX_BYTES): string {
  if (utf8ByteLength(reason) <= maxBytes) return reason;
  let out = '';
  let used = 0;
  for (const codePoint of reason) {
    const size = utf8ByteLength(codePoint);
    if (used + size > maxBytes) break;
    out += codePoint;
    used += size;
  }
  return out;
}
