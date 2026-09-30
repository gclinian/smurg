// Byte helpers shared by Node and browsers. No cryptography here (randomness comes from the platform CSPRNG).
// Every decoder is strict and throws on anything that is not the canonical encoding: these functions parse values
// that arrive from invite links, key files and IndexedDB, so "almost valid" input must never be accepted.

/** A shared zero-length array. Never write into it. */
export const EMPTY_BYTES: Uint8Array = new Uint8Array(0);

/** Concatenates into a fresh buffer (never aliases an input). */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Equality whose running time does not depend on where the arrays differ (only on their length). Used for key and
 * fingerprint comparisons so a probing peer cannot learn a prefix through timing.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Strict UTF-8 decoding: invalid sequences throw instead of becoming U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  return strictDecoder.decode(bytes);
}

const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (!HEX_RE.test(hex)) throw new TypeError('invalid hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** RFC 4648 §5 base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const at = (j: number): number => bytes[j] as number;
  const ch = (n: number): string => B64URL_ALPHABET[n & 63] as string;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (at(i) << 16) | (at(i + 1) << 8) | at(i + 2);
    out += ch(n >> 18) + ch(n >> 12) + ch(n >> 6) + ch(n);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = at(i) << 16;
    out += ch(n >> 18) + ch(n >> 12);
  } else if (rest === 2) {
    const n = (at(i) << 16) | (at(i + 1) << 8);
    out += ch(n >> 18) + ch(n >> 12) + ch(n >> 6);
  }
  return out;
}

/**
 * Strict base64url decoder: alphabet `[A-Za-z0-9_-]` only, no padding, no whitespace, and the unused trailing bits
 * must be zero, so every byte string has exactly one accepted encoding.
 */
export function fromBase64Url(text: string): Uint8Array {
  if (!B64URL_RE.test(text) || text.length % 4 === 1) throw new TypeError('invalid base64url');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const c of text) {
    acc = ((acc << 6) | B64URL_ALPHABET.indexOf(c)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if ((acc & ((1 << bits) - 1)) !== 0) throw new TypeError('non-canonical base64url');
  return out;
}

/** Cryptographically secure random bytes from the platform (WebCrypto in browsers and Node). */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError(`invalid length ${length}`);
  const out = new Uint8Array(length);
  // getRandomValues refuses more than 65536 bytes per call.
  for (let off = 0; off < length; off += 65_536) globalThis.crypto.getRandomValues(out.subarray(off, Math.min(length, off + 65_536)));
  return out;
}
