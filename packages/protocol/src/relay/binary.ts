import { MAX_RELAY_FRAME, RELAY_CONN_PREFIX_BYTES } from '../constants.ts';

// Binary tunnel frames on host sockets (ARCHITECTURE §6):
//   client -> relay  <ciphertext>                 relay -> host  <u32be conn><ciphertext>
//   host   -> relay  <u32be conn><ciphertext>     relay -> client <ciphertext>
// The connection id is relay-assigned and unauthenticated: a relay that mixes ids up only causes AEAD failures on the
// wrong Noise session, never cross-talk (relay.md gotcha 10).

/** Connection ids are u32; 0 is reserved and never assigned. */
export const MIN_CONN_ID = 1;
export const MAX_CONN_ID = 0xffff_ffff;

export function isConnId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CONN_ID && value <= MAX_CONN_ID;
}

function assertConnId(conn: number): void {
  if (!isConnId(conn)) throw new RangeError(`connection id must be an integer in 1..${MAX_CONN_ID}, got ${conn}`);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Writes `conn` big-endian into the first 4 bytes of `frame` (in place). */
export function writeConnPrefix(frame: Uint8Array, conn: number): void {
  assertConnId(conn);
  if (frame.byteLength < RELAY_CONN_PREFIX_BYTES) throw new RangeError('frame is shorter than the connection-id prefix');
  view(frame).setUint32(0, conn, false);
}

/**
 * Returns `<u32be conn><payload>` in a new buffer (one copy of `payload`). Senders that can produce the payload in
 * place should use allocPrefixedFrame instead and avoid the copy.
 */
export function prefixFrame(conn: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const { frame, payload: body } = allocPrefixedFrame(conn, payload.byteLength);
  body.set(payload);
  return frame;
}

/**
 * Allocates a frame with the connection-id prefix already written and returns it together with a view of its
 * payload area, so a sealer can encrypt straight into the frame (zero-copy).
 */
export function allocPrefixedFrame(
  conn: number,
  payloadBytes: number,
): { frame: Uint8Array<ArrayBuffer>; payload: Uint8Array<ArrayBuffer> } {
  assertConnId(conn);
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new RangeError(`payload size must be a non-negative safe integer, got ${payloadBytes}`);
  }
  const frame = new Uint8Array(RELAY_CONN_PREFIX_BYTES + payloadBytes);
  view(frame).setUint32(0, conn, false);
  return { frame, payload: frame.subarray(RELAY_CONN_PREFIX_BYTES) };
}

export type SplitFrame = {
  conn: number;
  /** View into the input (no copy). Copy it before the input buffer is reused. */
  payload: Uint8Array;
};

/**
 * Splits `<u32be conn><payload>` without copying. Returns null (the caller drops the frame) when the frame is too
 * short to carry a prefix and a non-empty payload, or names the reserved connection id 0.
 */
export function splitFrame(frame: Uint8Array | ArrayBuffer): SplitFrame | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength <= RELAY_CONN_PREFIX_BYTES) return null;
  const conn = view(bytes).getUint32(0, false);
  if (conn === 0) return null;
  return { conn, payload: bytes.subarray(RELAY_CONN_PREFIX_BYTES) };
}

/** True when a binary frame of `byteLength` must be refused (`bye 1009`). */
export function exceedsRelayFrameLimit(byteLength: number, limit: number = MAX_RELAY_FRAME): boolean {
  return !(byteLength >= 0 && byteLength <= limit);
}
