// The identity the relay asserts about a logged-in person, and its JWT claim form.
import {
  RELAY_USER_ID_PATTERN,
  relayAvatarUrlSchema,
  relayDisplayNameSchema,
  sanitizeRelayDisplayName,
} from '@smurg/protocol/relay';
import type { JWTPayload } from 'jose';

export const PROVIDERS = ['github', 'google', 'dev'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type Identity = {
  /** "github:<id>" | "google:<sub>" | "dev:<name>" (ARCHITECTURE §3). */
  userId: string;
  displayName: string;
  provider: Provider;
  avatarUrl?: string;
};

/**
 * Builds an Identity from what a provider returned: the id must match the protocol's user-id pattern and the
 * provider prefix, the display name is sanitised (falling back to `fallbackName`), and an avatar that is not a clean
 * https URL is dropped. Returns null when no valid identity can be formed.
 */
export function makeIdentity(input: {
  provider: Provider;
  subject: string;
  displayName: string | undefined;
  fallbackName: string;
  avatarUrl?: string | undefined;
}): Identity | null {
  const userId = `${input.provider}:${input.subject}`;
  if (!RELAY_USER_ID_PATTERN.test(userId)) return null;
  const displayName = sanitizeRelayDisplayName(input.displayName ?? '', input.fallbackName);
  if (!relayDisplayNameSchema.safeParse(displayName).success) return null;
  const identity: Identity = { userId, displayName, provider: input.provider };
  if (input.avatarUrl && relayAvatarUrlSchema.safeParse(input.avatarUrl).success) identity.avatarUrl = input.avatarUrl;
  return identity;
}

export function identityClaims(identity: Identity): JWTPayload {
  return {
    sub: identity.userId,
    name: identity.displayName,
    provider: identity.provider,
    ...(identity.avatarUrl ? { picture: identity.avatarUrl } : {}),
  };
}

/** Strict inverse of identityClaims for tokens the relay minted itself: anything unexpected is rejected. */
export function identityFromClaims(payload: JWTPayload): Identity | null {
  const { sub, name, provider, picture } = payload as JWTPayload & Record<string, unknown>;
  if (typeof sub !== 'string' || !RELAY_USER_ID_PATTERN.test(sub)) return null;
  if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) return null;
  if (!sub.startsWith(`${provider}:`)) return null;
  if (typeof name !== 'string' || !relayDisplayNameSchema.safeParse(name).success) return null;
  const identity: Identity = { userId: sub, displayName: name, provider: provider as Provider };
  if (picture !== undefined) {
    if (typeof picture !== 'string' || !relayAvatarUrlSchema.safeParse(picture).success) return null;
    identity.avatarUrl = picture;
  }
  return identity;
}

/** The JSON shape of a user in relay API responses. */
export function identityJson(identity: Identity): Record<string, string> {
  return {
    userId: identity.userId,
    displayName: identity.displayName,
    provider: identity.provider,
    ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
  };
}
