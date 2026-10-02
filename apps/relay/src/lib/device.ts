// Pure pieces of the CLI's device-code login (auth/device.ts, auth/device-store.ts): limits, user-code generation,
// what the relay records about the machine that started a login, and how the /device page words it. Web APIs only, so
// the Node tests use it unchanged; the record types are shared with the Durable Object and the tests.
import { DEVICE_USER_CODE_ALPHABET, DEVICE_USER_CODE_LENGTH } from '@smurg/protocol/relay';
import { intlTag, type Locale } from '@smurg/protocol/locale';
import type { Identity } from '../auth/identity.ts';
import { STRINGS } from './strings.ts';

export const DEVICE_LIMITS = {
  /** One fixed window for every counter below. */
  windowMs: 10 * 60_000,
  /** Wrong user codes one browser account may enter per window (then the "too many wrong codes" page until the window ends). */
  wrongCodesPerAccount: 10,
  /**
   * Wrong user codes per IP address per window. Higher than per account: a whole class behind one school NAT shares an
   * address, and each wrong guess is already tied to a logged-in account.
   */
  wrongCodesPerIp: 30,
  /** Logins started per IP address per window (each one is a stored record until it expires). */
  startsPerIp: 30,
} as const;

/**
 * A poll this much earlier than the interval still counts as on time: the CLI waits the interval after each answer, so
 * the gaps the relay sees vary by the network's jitter.
 */
export const DEVICE_POLL_SLACK_MS = 1_000;

/** Dev-only route (DEV_LOGIN=1 and a local hostname): a pending login's DeviceLoginInspection, or `?expire=1`. Tests. */
export const DEVICE_DEBUG_PATH = '/api/debug/device-login';

/** What the relay keeps about one login, in the Durable Object named after its user code, until it ends. */
export type DeviceLoginRecord = {
  /** Normalised, `WDJBMJHT`. */
  userCode: string;
  /** base64url(SHA-256(secret part of the device code)): the code itself is never stored. */
  secretHash: string;
  createdAt: number;
  expiresAt: number;
  /** Seconds the CLI was told to wait between polls. */
  interval: number;
  /** Where the CLI's request came from, as Cloudflare saw it: shown on the confirmation screen. */
  ip: string | null;
  country: string | null;
  city: string | null;
  status: 'pending' | 'approved' | 'denied';
  /** The browser session that pressed "Allow" (status approved only). */
  identity?: Identity;
};

/** The pending login as the confirmation screen shows it (no secret hash). */
export type DeviceLoginView = Pick<DeviceLoginRecord, 'userCode' | 'createdAt' | 'expiresAt' | 'ip' | 'country' | 'city'>;

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'approved'; identity: Identity }
  | { status: 'denied' }
  /** Unknown, already collected, expired, or a secret that does not match: the CLI cannot tell these apart. */
  | { status: 'expired' };

/** The dev-only debug route's view of one Durable Object instance (tests). */
export type DeviceLoginInspection = {
  login: (DeviceLoginView & { status: DeviceLoginRecord['status']; userId: string | null }) | null;
  window: { end: number; count: number } | null;
  alarm: number | null;
};

/** A fresh user code: DEVICE_USER_CODE_LENGTH characters of the RFC 8628 alphabet, uniformly (rejection sampling). */
export function randomUserCode(): string {
  const size = DEVICE_USER_CODE_ALPHABET.length;
  const limit = 256 - (256 % size);
  let code = '';
  while (code.length < DEVICE_USER_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && code.length < DEVICE_USER_CODE_LENGTH) code += DEVICE_USER_CODE_ALPHABET[byte % size];
    }
  }
  return code;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const IP_RE = /^[0-9A-Fa-f.:]{2,45}$/;

export type RequestPlace = { ip: string | null; country: string | null; city: string | null };

/**
 * The client's address (`CF-Connecting-IP`, which Cloudflare sets and a client cannot) and Cloudflare's guess of
 * its country and city (`request.cf`). Each is null when missing or not plausible.
 */
export function requestPlace(req: Request): RequestPlace {
  const ip = req.headers.get('cf-connecting-ip');
  const cf = (req as Request & { cf?: Record<string, unknown> }).cf;
  const country = typeof cf?.['country'] === 'string' && /^[A-Z0-9]{2}$/.test(cf['country']) ? cf['country'] : null;
  const city = typeof cf?.['city'] === 'string' ? cf['city'].replace(CONTROL, '').trim().slice(0, 80) : '';
  return { ip: ip !== null && IP_RE.test(ip) ? ip : null, country, city: city === '' ? null : city };
}

/** `Taipei, Taiwan`, `Taiwan`, or "unknown": the country's name in the page's language where the runtime knows it, else the code. */
export function placeText(locale: Locale, country: string | null, city: string | null): string {
  const s = STRINGS[locale];
  const name = country === null || country === 'XX' ? null : regionName(locale, country);
  if (city !== null && name !== null) return s.placeCityCountry(city, name);
  return city ?? name ?? s.placeUnknown;
}

function regionName(locale: Locale, code: string): string {
  if (code === 'T1') return STRINGS[locale].torNetwork;
  try {
    return new Intl.DisplayNames([intlTag(locale)], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** `3 minutes ago (2026-10-01 08:15 UTC)`: the page runs no script, so it cannot know the browser's time zone. */
export function ageText(locale: Locale, createdAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  const utc = `${new Date(createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return STRINGS[locale].age(minutes, utc);
}

/** Whole minutes until `until`, rounded up (at least 1). */
export function minutesUntil(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 60_000));
}
