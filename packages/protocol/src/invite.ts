// Invite links, invite id / PSK derivation and the Noise prologue (ARCHITECTURE §4.1, §4.2; noise.md §1.4).
//
//   https://<web-origin>/join/<workspaceId>#k=<43 chars>&s=<43 chars>
//   k        = BLAKE2s-256("smurg/v1 daemon static key fingerprint" ‖ daemonStaticPublicKey)
//   s        = 32 random bytes (the one-time secret; the daemon never stores it)
//   inviteId = BLAKE2s(key = s, "smurg/v1 invite id", 16 bytes)   never on the wire, only in the prologue
//   psk      = BLAKE2s(key = s, "smurg/v1 invite psk", 32 bytes)  Noise psk3
//   prologue = "smurg-noise/1" ‖ 0x00 ‖ u8 len(workspaceId) ‖ workspaceId ‖ u8 mode ‖ inviteId (invite mode only)
//
// The fragment never reaches a server. Parsers here are strict and fail closed: a link that is not exactly what
// buildInviteUrl produces is rejected rather than "repaired".
import { blake2s } from '@noble/hashes/blake2.js';
import { NOISE_PROLOGUE_TAG } from './constants.ts';
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, toHex, utf8Encode } from './bytes.ts';
import { isLocalHostname, isWorkspaceId } from './relay/routes.ts';

export const INVITE_SECRET_BYTES = 32;
export const INVITE_ID_BYTES = 16;
export const INVITE_PSK_BYTES = 32;
export const DAEMON_FINGERPRINT_BYTES = 32;
/** Length of a base64url-encoded 32-byte value (`k` and `s`). */
export const INVITE_FRAGMENT_VALUE_CHARS = 43;

const FINGERPRINT_LABEL = utf8Encode('smurg/v1 daemon static key fingerprint');
const INVITE_ID_LABEL = utf8Encode('smurg/v1 invite id');
const INVITE_PSK_LABEL = utf8Encode('smurg/v1 invite psk');

/** Which handshake a connection runs; the byte goes into HELLO (cleartext) and into the prologue. */
export type HandshakeMode = 'invite' | 'device';
export const HANDSHAKE_MODE_BYTES: Readonly<Record<HandshakeMode, number>> = Object.freeze({ invite: 0x01, device: 0x02 });

export function handshakeModeFromByte(byte: number | undefined): HandshakeMode | null {
  if (byte === HANDSHAKE_MODE_BYTES.invite) return 'invite';
  if (byte === HANDSHAKE_MODE_BYTES.device) return 'device';
  return null;
}

export type InviteLinkErrorCode = 'bad-url' | 'bad-origin' | 'bad-path' | 'bad-workspace-id' | 'bad-fragment';

export class InviteLinkError extends Error {
  readonly code: InviteLinkErrorCode;

  constructor(code: InviteLinkErrorCode, message: string) {
    super(message);
    this.name = 'InviteLinkError';
    this.code = code;
  }
}

function assertLength(bytes: Uint8Array, length: number, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new RangeError(`${what} must be ${length} bytes`);
}

/** `k`: what the client compares the daemon's static key against at msg2. */
export function daemonKeyFingerprint(daemonStaticPublicKey: Uint8Array): Uint8Array {
  assertLength(daemonStaticPublicKey, 32, 'daemon static public key');
  return blake2s(concatBytes(FINGERPRINT_LABEL, daemonStaticPublicKey));
}

/**
 * Short, human-comparable form of a fingerprint for UIs ("safety number"): the first 10 bytes as five groups of four
 * hex digits. For display only; the protocol always compares all 32 bytes.
 */
export function formatFingerprintForDisplay(fingerprint: Uint8Array): string {
  assertLength(fingerprint, DAEMON_FINGERPRINT_BYTES, 'fingerprint');
  return (toHex(fingerprint.subarray(0, 10)).match(/.{4}/g) as string[]).join(' ');
}

/** A fresh one-time invite secret `s`. */
export function generateInviteSecret(): Uint8Array {
  return randomBytes(INVITE_SECRET_BYTES);
}

export interface InviteKeys {
  /** 16 bytes; identifies the invite to the daemon through the prologue. Never sent on the wire. */
  readonly inviteId: Uint8Array;
  /** 32 bytes; the Noise psk3 value. Secret. */
  readonly psk: Uint8Array;
}

/**
 * Derives the invite id and PSK from `s` with keyed BLAKE2s (a PRF). The daemon stores only these two values
 * (plus role, expiry and uses), never `s`.
 */
export function deriveInviteKeys(secret: Uint8Array): InviteKeys {
  assertLength(secret, INVITE_SECRET_BYTES, 'invite secret');
  return {
    inviteId: blake2s(INVITE_ID_LABEL, { key: secret, dkLen: INVITE_ID_BYTES }),
    psk: blake2s(INVITE_PSK_LABEL, { key: secret, dkLen: INVITE_PSK_BYTES }),
  };
}

export interface InviteFragment {
  /** `k`: fingerprint of the daemon's static key. */
  readonly fingerprint: Uint8Array;
  /** `s`: the one-time invite secret. */
  readonly secret: Uint8Array;
}

/** `k=<base64url>&s=<base64url>` (without the leading "#"). */
export function buildInviteFragment(daemonStaticPublicKey: Uint8Array, secret: Uint8Array): string {
  assertLength(secret, INVITE_SECRET_BYTES, 'invite secret');
  return `k=${toBase64Url(daemonKeyFingerprint(daemonStaticPublicKey))}&s=${toBase64Url(secret)}`;
}

const FRAGMENT_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Strict fragment parser: exactly `k` and `s`, each once, in any order, each exactly 43 characters of canonical
 * base64url for 32 bytes. No percent-encoding, no padding, no empty or extra parameters. Accepts an optional
 * leading "#".
 */
export function parseInviteFragment(hash: string): InviteFragment {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  const values = new Map<string, string>();
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? '' : part.slice(eq + 1);
    if ((key !== 'k' && key !== 's') || values.has(key)) {
      throw new InviteLinkError('bad-fragment', 'invite fragment must contain exactly k and s');
    }
    if (!FRAGMENT_VALUE_RE.test(value)) throw new InviteLinkError('bad-fragment', `invite fragment value ${key} is malformed`);
    values.set(key, value);
  }
  const k = values.get('k');
  const s = values.get('s');
  if (k === undefined || s === undefined) throw new InviteLinkError('bad-fragment', 'invite fragment must contain exactly k and s');
  try {
    const fingerprint = fromBase64Url(k);
    const secret = fromBase64Url(s);
    assertLength(fingerprint, DAEMON_FINGERPRINT_BYTES, 'k');
    assertLength(secret, INVITE_SECRET_BYTES, 's');
    return { fingerprint, secret };
  } catch {
    throw new InviteLinkError('bad-fragment', 'invite fragment is not canonical base64url of 32 bytes');
  }
}

/**
 * Validates a web origin for invite links: `https:` (or `http:` for a local hostname), no credentials, no path,
 * query or fragment. Returns the normalised origin string (no trailing slash).
 */
export function inviteWebOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new InviteLinkError('bad-origin', 'web origin is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHostname(url.hostname))) {
    throw new InviteLinkError('bad-origin', 'web origin must use https (http only for localhost)');
  }
  if (url.username !== '' || url.password !== '') throw new InviteLinkError('bad-origin', 'web origin must not contain credentials');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new InviteLinkError('bad-origin', 'web origin must not have a path, query or fragment');
  }
  return url.origin;
}

/** `https://<origin>/join/<workspaceId>#k=…&s=…` */
export function buildInviteUrl(
  webOrigin: string,
  workspaceId: string,
  daemonStaticPublicKey: Uint8Array,
  secret: Uint8Array,
): string {
  const origin = inviteWebOrigin(webOrigin);
  if (!isWorkspaceId(workspaceId)) throw new InviteLinkError('bad-workspace-id', 'invalid workspace id');
  return `${origin}/join/${workspaceId}#${buildInviteFragment(daemonStaticPublicKey, secret)}`;
}

export interface ParsedInviteUrl extends InviteFragment {
  /** The web origin the link points at, e.g. "https://smurg.app". */
  readonly origin: string;
  readonly workspaceId: string;
}

const JOIN_PATH_RE = /^\/join\/([^/]+)$/;

/** Strict inverse of buildInviteUrl (used by `smurg attach --invite URL` and tests). */
export function parseInviteUrl(link: string): ParsedInviteUrl {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new InviteLinkError('bad-url', 'invite link is not a valid URL');
  }
  const hash = url.hash;
  url.hash = '';
  const pathname = url.pathname;
  const search = url.search;
  url.pathname = '/';
  url.search = '';
  const origin = inviteWebOrigin(url.toString());
  if (search !== '') throw new InviteLinkError('bad-path', 'invite link must not have a query');
  const m = JOIN_PATH_RE.exec(pathname);
  if (!m) throw new InviteLinkError('bad-path', 'invite link path must be /join/<workspaceId>');
  const workspaceId = m[1] as string;
  if (!isWorkspaceId(workspaceId)) throw new InviteLinkError('bad-workspace-id', 'invalid workspace id in invite link');
  if (!hash.startsWith('#')) throw new InviteLinkError('bad-fragment', 'invite link has no fragment');
  return { origin, workspaceId, ...parseInviteFragment(hash) };
}

/**
 * The Noise prologue. It binds what both sides rely on that is not otherwise inside the handshake: the protocol
 * tag, the workspace, the mode (which travels in cleartext in HELLO) and, in invite mode, the invite id (never sent).
 * Any mismatch makes the handshake fail.
 */
export function buildNoisePrologue(workspaceId: string, mode: HandshakeMode, inviteId?: Uint8Array): Uint8Array {
  if (!isWorkspaceId(workspaceId)) throw new RangeError('invalid workspace id');
  const modeByte = HANDSHAKE_MODE_BYTES[mode];
  if (modeByte === undefined || !Object.hasOwn(HANDSHAKE_MODE_BYTES, mode)) throw new RangeError('invalid handshake mode');
  if (mode === 'invite') assertLength(inviteId as Uint8Array, INVITE_ID_BYTES, 'invite id');
  else if (inviteId !== undefined) throw new RangeError('invite id is only allowed in invite mode');
  const wid = utf8Encode(workspaceId);
  return concatBytes(utf8Encode(NOISE_PROLOGUE_TAG), new Uint8Array([0x00, wid.length]), wid, new Uint8Array([modeByte]), inviteId ?? new Uint8Array(0));
}
