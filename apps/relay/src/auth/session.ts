// Relay sessions: a browser presents the HttpOnly cookie, the CLI and the daemon a bearer token. Both carry the same
// EdDSA session JWT.
import type { RequestContext } from '../context.ts';
import { devLoginEnabled, isAllowedOrigin } from '../lib/config.ts';
import { cookieNames, readCookie } from '../lib/cookies.ts';
import { errorResponse } from '../lib/http.ts';
import { identityFromClaims, type Identity } from './identity.ts';
import { SESSION_TOKEN, TokenError, verifyToken } from './tokens.ts';

export type Authenticated = { identity: Identity; via: 'cookie' | 'bearer' };

export type AuthOutcome = { status: 'anonymous' } | { status: 'invalid' } | { status: 'ok'; auth: Authenticated };

const BEARER_RE = /^Bearer ([A-Za-z0-9._-]+)$/;

export async function authenticate(ctx: RequestContext): Promise<AuthOutcome> {
  const authorization = ctx.req.headers.get('authorization');
  let token: string;
  let via: Authenticated['via'];
  if (authorization !== null) {
    // A malformed or failing Authorization header never falls back to the cookie.
    const match = BEARER_RE.exec(authorization);
    if (!match?.[1]) return { status: 'invalid' };
    token = match[1];
    via = 'bearer';
  } else {
    const cookie = readCookie(ctx.req.headers.get('cookie'), cookieNames(ctx.config.secureCookies).session);
    if (cookie === null) return { status: 'anonymous' };
    token = cookie;
    via = 'cookie';
  }
  const keys = await ctx.keys();
  let identity: Identity | null;
  try {
    identity = identityFromClaims(await verifyToken(keys, ctx.config.issuer, token, SESSION_TOKEN));
  } catch (error) {
    if (error instanceof TokenError) return { status: 'invalid' };
    throw error;
  }
  if (identity === null) return { status: 'invalid' };
  // Defence in depth: a dev identity is only honoured where dev login itself is enabled, even if such a token was
  // somehow signed with this relay's key.
  if (identity.provider === 'dev' && !devLoginEnabled(ctx.config, ctx.url)) return { status: 'invalid' };
  return { status: 'ok', auth: { identity, via } };
}

/**
 * Authenticates or returns the error response. With `originCheck` (WebSocket upgrades and state-changing requests)
 * a cookie session additionally needs an allow-listed Origin: browsers attach the SameSite=Lax cookie to requests from
 * sibling origins of the same site, so the Origin allow-list is the real CSWSH/CSRF barrier (relay.md §1.4). Bearer
 * tokens are not ambient credentials and need no Origin.
 */
export async function requireAuth(ctx: RequestContext, { originCheck }: { originCheck: boolean }): Promise<Authenticated | Response> {
  const outcome = await authenticate(ctx);
  if (outcome.status === 'anonymous') return errorResponse(401, 'unauthorized', 'login required');
  if (outcome.status === 'invalid') return errorResponse(401, 'invalid_session', 'session is invalid or expired');
  if (originCheck && outcome.auth.via === 'cookie' && !isAllowedOrigin(ctx.config, ctx.req.headers.get('origin'))) {
    return errorResponse(403, 'origin_not_allowed');
  }
  return outcome.auth;
}
