// Every token the relay mints is an EdDSA JWT with its own `typ` and audience, so one kind can never be replayed as
// another (a session token is not an identity token, an OAuth transaction is not a CLI code).
import { IDENTITY_CNF_MEMBER, IDENTITY_TOKEN_AUDIENCE_PREFIX, IDENTITY_TOKEN_TTL_SECONDS, IDENTITY_TOKEN_TYP } from '@smurg/protocol/relay';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { SigningKeys } from './keys.ts';

export type TokenKind = { typ: string; aud: string; ttlSeconds: number };

/** Relay session: browser cookie or CLI/daemon bearer token. Stateless, so it cannot be revoked before it expires. */
export const SESSION_TOKEN: TokenKind = { typ: 'smurg-session+jwt', aud: 'smurg-relay', ttlSeconds: 7 * 24 * 3600 };
/** OAuth transaction (state, PKCE verifier, nonce, CLI parameters) kept in a short-lived cookie. */
export const OAUTH_TX_TOKEN: TokenKind = { typ: 'smurg-oauth-tx+jwt', aud: 'smurg-oauth-tx', ttlSeconds: 600 };
/** CLI loopback code: bound to the CLI's PKCE challenge, exchanged at POST /auth/cli/token. */
export const CLI_CODE_TOKEN: TokenKind = { typ: 'smurg-cli-code+jwt', aud: 'smurg-cli-code', ttlSeconds: 60 };

// Identity token (ARCHITECTURE §4.2): forwarded by the client inside the encrypted channel to the daemon, which
// verifies it with the relay's JWKS. These strings are the wire contract with the daemon: one definition, in
// @smurg/protocol/relay (the daemon reads the same constants).
export { IDENTITY_CNF_MEMBER, IDENTITY_TOKEN_AUDIENCE_PREFIX, IDENTITY_TOKEN_TTL_SECONDS, IDENTITY_TOKEN_TYP };

export function identityTokenKind(workspaceId: string): TokenKind {
  return { typ: IDENTITY_TOKEN_TYP, aud: `${IDENTITY_TOKEN_AUDIENCE_PREFIX}${workspaceId}`, ttlSeconds: IDENTITY_TOKEN_TTL_SECONDS };
}

const MAX_TOKEN_CHARS = 8192;

export async function signToken(keys: SigningKeys, issuer: string, kind: TokenKind, claims: JWTPayload): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: keys.kid, typ: kind.typ })
    .setIssuer(issuer)
    .setAudience(kind.aud)
    .setIssuedAt()
    .setExpirationTime(`${kind.ttlSeconds}s`)
    .setJti(crypto.randomUUID())
    .sign(keys.privateKey);
}

export class TokenError extends Error {
  override readonly name = 'TokenError';
}

/** Verifies signature, issuer, audience, `typ`, algorithm, expiry and age. Throws TokenError on any failure. */
export async function verifyToken(keys: SigningKeys, issuer: string, token: string, kind: TokenKind): Promise<JWTPayload> {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) throw new TokenError('token length');
  try {
    const { payload } = await jwtVerify(token, keys.keySet, {
      issuer,
      audience: kind.aud,
      typ: kind.typ,
      algorithms: ['EdDSA'],
      maxTokenAge: `${kind.ttlSeconds}s`,
      requiredClaims: ['iat', 'exp', 'jti'],
    });
    return payload;
  } catch (error) {
    throw new TokenError(error instanceof Error ? error.message : 'invalid token');
  }
}
