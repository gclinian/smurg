import { z } from 'zod';

// The CLI's device-code login (RFC 8628 style; ARCHITECTURE §6, decided 2026-10-01): `smurg login` asks the relay to
// start a login (POST /auth/device/start), prints the relay's /device page and a short user code, and polls
// POST /auth/device/token until the person, logged in to the relay in any browser (a phone will do), entered the code
// and approved the request. Nothing reaches the CLI's machine from the browser, so it works the same over SSH.
//
// What relay and CLI both have to agree on lives here: the user-code alphabet and its normalisation, the device-code
// shape, the timings and the error codes of the token endpoint.

/**
 * RFC 8628 §6.1's base-20 alphabet: consonants only (no vowels, so no words; no I/O/U/Y look-alikes either). Eight
 * characters give 20^8 ≈ 2^34.6 codes.
 */
export const DEVICE_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const DEVICE_USER_CODE_LENGTH = 8;
/** A pending login lives this long (the code is printed as valid for 10 minutes). */
export const DEVICE_LOGIN_TTL_SECONDS = 600;
/** Seconds between two polls of the token endpoint, until the relay answers `slow_down`. */
export const DEVICE_LOGIN_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: after `slow_down` the client polls this much more slowly, from then on. */
export const DEVICE_LOGIN_SLOW_DOWN_SECONDS = 5;

/** The token endpoint's `error` codes (HTTP 400). Anything else is a relay problem. */
export const DEVICE_TOKEN_ERRORS = ['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_request'] as const;
export type DeviceTokenError = (typeof DEVICE_TOKEN_ERRORS)[number];

const USER_CODE_RE = new RegExp(`^[${DEVICE_USER_CODE_ALPHABET}]{${DEVICE_USER_CODE_LENGTH}}$`);

/**
 * `<user code>.<secret>`: the normalised user code (so the relay finds the pending login) and 32 random bytes as
 * base64url, of which the relay stores only a hash. The CLI keeps it in memory and never prints it.
 */
export const DEVICE_CODE_PATTERN = new RegExp(`^([${DEVICE_USER_CODE_ALPHABET}]{${DEVICE_USER_CODE_LENGTH}})\\.([A-Za-z0-9_-]{43})$`);

/**
 * What a person typed, as the relay compares it: NFKC (full-width letters and dashes from an input method become
 * ASCII), upper case, every space and dash removed. Returns the 8-character code, or null when the result is not one.
 */
export function normalizeDeviceUserCode(input: string): string | null {
  if (input.length > 64) return null;
  const code = input.normalize('NFKC').toUpperCase().replace(/[\s\p{Pd}]/gu, '');
  return USER_CODE_RE.test(code) ? code : null;
}

/** `WDJBMJHT` → `WDJB-MJHT`, the way the CLI prints it and the /device page shows it. */
export function formatDeviceUserCode(code: string): string {
  if (!USER_CODE_RE.test(code)) throw new RangeError('not a device user code');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** `POST /auth/device/start` → 200. Strict, like the other relay bodies (./http.ts). */
export const relayDeviceStartSchema = z.strictObject({
  deviceCode: z.string().regex(DEVICE_CODE_PATTERN),
  /** Formatted, `XXXX-XXXX`. */
  userCode: z.string().refine((text) => normalizeDeviceUserCode(text) !== null && /^[A-Z]{4}-[A-Z]{4}$/.test(text)),
  /** `<relay origin>/device`: where the person enters the code. Never carries the code (a prefilled link invites phishing). */
  verificationUri: z.url({ protocol: /^https?$/ }).refine((text) => {
    const url = new URL(text);
    return url.search === '' && url.hash === '';
  }),
  expiresIn: z.number().int().positive().max(3600),
  interval: z.number().int().min(1).max(60),
});
export type RelayDeviceStart = z.infer<typeof relayDeviceStartSchema>;
