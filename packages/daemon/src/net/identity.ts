// Verification of the relay-signed identity token (ARCHITECTURE §4, §4.2; relay.md §1.5, §6.5).
//
// admit() must be SYNCHRONOUS (check-and-consume of invites cannot race, noise.md V1), and jose's jwtVerify is
// async. So the token is parsed with jose's synchronous decoders and its Ed25519 signature is checked with
// node:crypto.verify — the same primitive jose uses in Node — against keys fetched from the relay's JWKS
// beforehand (IdentityKeySource). Claims are checked here exactly as relay.md §6.5 does with jwtVerify:
// typ, alg EdDSA, iss, aud = smurg-daemon:<workspaceId>, exp / iat / nbf with a small skew, age ≤ 5 min, plus the
// blinded `cnf` commitment the caller checks against the authenticated Noise key.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { IDENTITY_CNF_MEMBER, IDENTITY_TOKEN_AUDIENCE_PREFIX, IDENTITY_TOKEN_TTL_SECONDS, IDENTITY_TOKEN_TYP, fromBase64Url } from '@smurg/protocol';
import { relayUserIdSchema, sanitizeRelayDisplayName } from '@smurg/protocol/relay';
import type { Clock } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';

/** The relay's identity-token `typ` (single source: @smurg/protocol). */
export const IDENTITY_TOKEN_TYPE = IDENTITY_TOKEN_TYP;
export const CNF_CLAIM = IDENTITY_CNF_MEMBER;

/** Where verification keys come from. `get` is synchronous (called inside admit()). */
export interface IdentityKeySource {
  /** The cached Ed25519 public key for `kid`, or null when unknown. */
  get(kid: string): KeyObject | null;
  /** Re-fetch the keys (JWKS). Never throws; resolves when done. Rate-limited by the caller. */
  refresh(): Promise<void>;
  /**
   * The relay's clock minus the host's (ms), measured on the last key fetch, or null when unknown. Identity-token
   * times are relay times: a host clock that drifted (NTP blocked, a VM after resume) must not lock every member out
   *.
   */
  clockOffsetMs?(): number | null;
}

/** A measured offset beyond this is not believed (and not applied): time checks then fail closed on the host clock. */
export const MAX_RELAY_CLOCK_OFFSET_MS = 24 * 3600 * 1000;

export interface IdentityClaims {
  readonly sub: string;
  /** Sanitised display name (falls back to the part of `sub` after the provider prefix). */
  readonly name: string;
  readonly provider: string | null;
  /** The blinded commitment (43 base64url chars) to compare with identityCnf(nonce, device key). */
  readonly cnf: string;
  readonly iat: number;
  readonly exp: number;
}

export type IdentityFailure = 'malformed' | 'header' | 'unknown-key' | 'signature' | 'issuer' | 'audience' | 'expired' | 'not-yet-valid' | 'too-old' | 'subject' | 'cnf-missing';

export type IdentityVerification =
  | { readonly ok: true; readonly claims: IdentityClaims }
  /** `iatDeltaMs` (time failures): the token's issue time minus the time it was checked against (relay-corrected). */
  | { readonly ok: false; readonly reason: IdentityFailure; readonly iatDeltaMs?: number };

/** Failures that mean "the clocks disagree" rather than "a bad token". */
export function isTimeFailure(reason: IdentityFailure): boolean {
  return reason === 'expired' || reason === 'not-yet-valid' || reason === 'too-old';
}

export interface IdentityVerifierOptions {
  readonly keys: IdentityKeySource;
  /** `iss` (the relay origin). */
  readonly issuer: string;
  readonly workspaceId: string;
  readonly clock: Clock;
  readonly skewMs: number;
  readonly maxAgeSeconds?: number;
}

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CNF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class IdentityVerifier {
  private readonly options: IdentityVerifierOptions;
  readonly audience: string;

  constructor(options: IdentityVerifierOptions) {
    this.options = options;
    this.audience = `${IDENTITY_TOKEN_AUDIENCE_PREFIX}${options.workspaceId}`;
  }

  verify(token: string): IdentityVerification {
    if (typeof token !== 'string' || token.length > 4_096 || !COMPACT_JWS.test(token)) return { ok: false, reason: 'malformed' };
    let header: ReturnType<typeof decodeProtectedHeader>;
    let payload: ReturnType<typeof decodeJwt>;
    try {
      header = decodeProtectedHeader(token);
      payload = decodeJwt(token);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if ((header.alg !== 'EdDSA' && header.alg !== 'Ed25519') || header.typ !== IDENTITY_TOKEN_TYPE || header.crit !== undefined || header.b64 !== undefined) {
      return { ok: false, reason: 'header' };
    }
    if (typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 256) return { ok: false, reason: 'header' };
    const key = this.options.keys.get(header.kid);
    if (!key) return { ok: false, reason: 'unknown-key' };
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.') as [string, string, string];
    let signature: Uint8Array;
    try {
      signature = fromBase64Url(encodedSignature);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    let valid = false;
    try {
      valid = signature.length === 64 && cryptoVerify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), key, signature);
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: 'signature' };

    if (payload.iss !== this.options.issuer) return { ok: false, reason: 'issuer' };
    const aud = payload.aud;
    if (!(aud === this.audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === this.audience))) return { ok: false, reason: 'audience' };
    // Token times are the relay's: compare them with the relay's time as last measured.
    const offset = this.options.keys.clockOffsetMs?.() ?? null;
    const now = this.options.clock.now() + (offset !== null && Math.abs(offset) <= MAX_RELAY_CLOCK_OFFSET_MS ? offset : 0);
    const skew = this.options.skewMs;
    const maxAge = (this.options.maxAgeSeconds ?? IDENTITY_TOKEN_TTL_SECONDS) * 1000;
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return { ok: false, reason: 'malformed' };
    const iatDeltaMs = Math.round(payload.iat * 1000 - now);
    if (payload.exp * 1000 <= now - skew) return { ok: false, reason: 'expired', iatDeltaMs };
    if (payload.iat * 1000 > now + skew || (typeof payload.nbf === 'number' && payload.nbf * 1000 > now + skew)) return { ok: false, reason: 'not-yet-valid', iatDeltaMs };
    if (now - payload.iat * 1000 > maxAge + skew) return { ok: false, reason: 'too-old', iatDeltaMs };
    if (typeof payload.sub !== 'string' || !relayUserIdSchema.safeParse(payload.sub).success) return { ok: false, reason: 'subject' };
    const cnf = (payload as { cnf?: unknown }).cnf;
    const commitment = cnf !== null && typeof cnf === 'object' ? (cnf as Record<string, unknown>)[CNF_CLAIM] : undefined;
    // At first contact and on every reconnect a token without the device binding is refused (relay.md §1.5).
    if (typeof commitment !== 'string' || !CNF_PATTERN.test(commitment)) return { ok: false, reason: 'cnf-missing' };
    const rawName = typeof (payload as { name?: unknown }).name === 'string' ? ((payload as { name: string }).name) : '';
    const fallback = payload.sub.slice(payload.sub.indexOf(':') + 1) || payload.sub;
    const provider = typeof (payload as { provider?: unknown }).provider === 'string' ? (payload as { provider: string }).provider : null;
    return {
      ok: true,
      claims: { sub: payload.sub, name: sanitizeRelayDisplayName(rawName, fallback), provider, cnf: commitment, iat: payload.iat, exp: payload.exp },
    };
  }
}

/** Keys given up front (tests, or a pinned relay key). */
export function staticKeySource(keys: ReadonlyMap<string, KeyObject>): IdentityKeySource {
  return { get: (kid) => keys.get(kid) ?? null, refresh: async () => {} };
}

export interface JwksKeySourceOptions {
  readonly url: string;
  readonly log: Logger;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** The host's clock (the one identity tokens are checked with); default Date.now. */
  readonly now?: () => number;
}

/** Offsets smaller than this are not worth a warning (the verifier's skew tolerance is larger). */
const CLOCK_OFFSET_WARN_MS = 30_000;

/**
 * Ed25519 keys of the relay's /.well-known/jwks.json, cached; a failed refresh keeps the previous keys. Each fetch also
 * reads the response's HTTP `Date` to estimate the relay's clock (second resolution, ± half the round trip).
 */
export function jwksKeySource(options: JwksKeySourceOptions): IdentityKeySource & { readonly size: number } {
  let keys = new Map<string, KeyObject>();
  let inflight: Promise<void> | null = null;
  let offsetMs: number | null = null;
  let warnedOffsetMs: number | null = null;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const measure = (response: Response, sentAt: number, receivedAt: number): void => {
    const header = response.headers.get('date');
    const relayMs = header === null ? Number.NaN : Date.parse(header);
    if (!Number.isFinite(relayMs)) return;
    // `Date` is truncated to the second: its midpoint, against the midpoint of our request.
    const measured = Math.round(relayMs + 500 - (sentAt + receivedAt) / 2);
    if (Math.abs(measured) > MAX_RELAY_CLOCK_OFFSET_MS) {
      options.log.warn('the relay reports an implausible time; identity tokens are checked against the host clock', { offsetSec: Math.round(measured / 1000) });
      offsetMs = null;
      return;
    }
    offsetMs = measured;
    if (Math.abs(measured) >= CLOCK_OFFSET_WARN_MS && (warnedOffsetMs === null || Math.abs(measured - warnedOffsetMs) >= CLOCK_OFFSET_WARN_MS)) {
      warnedOffsetMs = measured;
      options.log.warn("this computer's clock differs from the relay's; identity tokens are checked against the relay's time (please fix the system clock)", {
        offsetSec: Math.round(measured / 1000),
      });
    }
  };
  const load = async (): Promise<void> => {
    try {
      const sentAt = now();
      const response = await fetchImpl(options.url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5_000), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      measure(response, sentAt, now());
      const body = (await response.json()) as { keys?: unknown };
      const next = new Map<string, KeyObject>();
      for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
        if (jwk === null || typeof jwk !== 'object') continue;
        const { kty, crv, x, kid, use, alg } = jwk as Record<string, unknown>;
        if (kty !== 'OKP' || crv !== 'Ed25519' || typeof x !== 'string' || typeof kid !== 'string') continue;
        if ((use !== undefined && use !== 'sig') || (alg !== undefined && alg !== 'EdDSA' && alg !== 'Ed25519')) continue;
        try {
          next.set(kid, createPublicKey({ key: { kty, crv, x }, format: 'jwk' }));
        } catch {
          // skip a malformed key
        }
      }
      if (next.size === 0) throw new Error('no usable keys');
      keys = next;
    } catch (err) {
      options.log.warn('identity key refresh failed', { error: err instanceof Error ? err.message.slice(0, 120) : 'unknown' });
    }
  };
  return {
    get: (kid) => keys.get(kid) ?? null,
    refresh: () => {
      inflight ??= load().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    clockOffsetMs: () => offsetMs,
    get size() {
      return keys.size;
    },
  };
}
