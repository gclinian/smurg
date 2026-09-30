// Wire frames of one client <-> daemon connection. Every WebSocket binary message is exactly one frame
// (ARCHITECTURE §4, §4.2; noise.md §1.3 and V-C):
//
//   0x01 HELLO   c->d  [0x01][ver = 1][mode: 1 = invite, 2 = device][noise msg1]   (the invite id is NOT sent)
//   0x02 REPLY   d->c  [0x02][noise msg2]
//   0x03 FINISH  c->d  [0x03][noise msg3]   (payload = opaque hello, e.g. msgpack ClientHello)
//   0x10 DATA    both  [0x10]{ [u16be len][noise transport message] }+   record plaintext = [flags][body]
//   0x7f ABORT   both  [0x7f][0x00]   cleartext, unauthenticated, ONE generic code, only before authentication
//
// The first DATA message from the daemon is the verdict: [0x00][opaque accept payload] | [0x01][opaque reject payload].
import { FRAME_TYPE_BYTES, NOISE_MAX_MESSAGE_BYTES } from '../constants.ts';

export const CHANNEL_FRAME = Object.freeze({ HELLO: 0x01, REPLY: 0x02, FINISH: 0x03, DATA: 0x10, ABORT: 0x7f } as const);
export type ChannelFrameType = (typeof CHANNEL_FRAME)[keyof typeof CHANNEL_FRAME];

/** Version byte in HELLO. It versions the handshake wire format, not the application protocol. */
export const HANDSHAKE_WIRE_VERSION = 1;

/** Bytes before msg1 in HELLO: type, version, mode. */
export const HELLO_HEADER_BYTES = 3;
/** Largest HELLO / REPLY / FINISH frame. */
export const MAX_HANDSHAKE_FRAME_BYTES = HELLO_HEADER_BYTES + NOISE_MAX_MESSAGE_BYTES;

/** First byte of the verdict message. */
export const VERDICT = Object.freeze({ ACCEPT: 0x00, REJECT: 0x01 } as const);

const GENERIC_ABORT_BYTES = [CHANNEL_FRAME.ABORT, 0x00] as const;

/** A fresh copy of the one and only cleartext ABORT frame. */
export function genericAbortFrame(): Uint8Array {
  return new Uint8Array(GENERIC_ABORT_BYTES);
}

export function isGenericAbortFrame(frame: Uint8Array): boolean {
  return frame.length === 2 && frame[0] === CHANNEL_FRAME.ABORT && frame[1] === 0x00;
}

/** `[type][body]` in a fresh buffer. */
export function handshakeFrame(type: ChannelFrameType, header: readonly number[], body: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_TYPE_BYTES + header.length + body.length);
  out[0] = type;
  out.set(header, FRAME_TYPE_BYTES);
  out.set(body, FRAME_TYPE_BYTES + header.length);
  return out;
}
