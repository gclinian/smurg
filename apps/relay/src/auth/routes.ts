// Login routes (ARCHITECTURE §6): GitHub / Google for browsers, the dev-only provider, logout, /api/me and
// /api/login-options. The CLI logs in by device code: ./device.ts.
//
// The OAuth transaction (state, PKCE verifier, nonce, return URL) lives in a signed 10-minute cookie, so these routes
// keep no server-side login state (the device-code login does: ./device-store.ts).
import { authCallbackPath, type RelayAuthProvider } from '@smurg/protocol/relay';
import type { JWTPayload } from 'jose';
import type { RequestContext } from '../context.ts';
import { randomToken, sha256Base64url, timingSafeEqualString } from '../lib/base64url.ts';
import { devLoginEnabled, isAllowedOrigin, loginOptionsFor } from '../lib/config.ts';
import { clearCookie, cookieNames, readCookie, serializeCookie } from '../lib/cookies.ts';
import { errorPage, type PageView } from '../lib/html.ts';
import { emptyResponse, errorResponse, htmlResponse, isRecord, jsonResponse, readJsonBody, redirectResponse } from '../lib/http.ts';
import { getPageView, languageSwitchRedirect, plainPageView } from '../lib/locale.ts';
import { STRINGS } from '../lib/strings.ts';
import { DEV_USER_PATTERN, PKCE_VERIFIER_PATTERN, resolveReturnTo } from '../lib/validate.ts';
import { identityClaims, identityJson, makeIdentity, type Identity } from './identity.ts';
import { githubAuthorizeUrl, githubIdentity, googleAuthorizeUrl, googleIdentity, ProviderError } from './providers.ts';
import { authenticate } from './session.ts';
import { OAUTH_TX_TOKEN, SESSION_TOKEN, TokenError, signToken, verifyToken } from './tokens.ts';

type Tx = {
  provider: RelayAuthProvider;
  state: string;
  verifier: string;
  nonce?: string;
  returnTo?: string;
};

const PROVIDER_LABEL: Record<RelayAuthProvider, string> = { github: 'GitHub', google: 'Google' };

export function methodNotAllowed(): Response {
  return errorResponse(405, 'method_not_allowed');
}

function notFound(): Response {
  return errorResponse(404, 'not_found');
}

/** The "Cannot log in" page in the viewer's language. */
function cannotLogIn(view: PageView, message: string, status: number, cookies: readonly string[] = []): Response {
  return htmlResponse(errorPage(view, STRINGS[view.locale].cannotLogInTitle, message), status, cookies);
}

/** The view of a login route's own error page: a GET whose query (`return_to`, `user`) the language links keep. */
function loginRouteView(ctx: RequestContext): PageView {
  return getPageView(ctx, { keepQuery: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Browser login
// ---------------------------------------------------------------------------------------------------------------

/** GET /auth/:provider/login[?return_to=<path or allow-listed URL>] */
export async function handleLogin(ctx: RequestContext, provider: RelayAuthProvider): Promise<Response> {
  if (ctx.req.method !== 'GET') return methodNotAllowed();
  const switched = languageSwitchRedirect(ctx);
  if (switched !== null) return switched;
  const view = loginRouteView(ctx);
  const s = STRINGS[view.locale];
  if (!providerConfigured(ctx, provider)) return cannotLogIn(view, s.providerNotConfigured(PROVIDER_LABEL[provider]), 503);
  const returnTo = resolveReturnTo(ctx.url.searchParams.get('return_to'), ctx.config.issuer, ctx.config.allowedOrigins);
  if (returnTo === null) return cannotLogIn(view, s.badLoginLink, 400);
  return startOAuth(ctx, provider, returnTo, view);
}

function providerConfigured(ctx: RequestContext, provider: RelayAuthProvider): boolean {
  return provider === 'github' ? ctx.config.github !== null : ctx.config.google !== null;
}

/**
 * GET /api/login-options → `{ providers: { github, google }, dev }` (relayLoginOptionsSchema): which login buttons the
 * web app shows, so it no longer probes the login routes (each probe was a 400 / 404 / 503 in the browser console).
 * No session needed and none is read; like the other public GET routes it sends no CORS headers (a page on another
 * origin cannot read it) and is not cached (`dev` depends on the hostname of this very request).
 */
export function handleLoginOptions(ctx: RequestContext): Response {
  if (ctx.req.method !== 'GET') return methodNotAllowed();
  return jsonResponse(loginOptionsFor(ctx.config, ctx.url));
}

async function startOAuth(ctx: RequestContext, provider: RelayAuthProvider, returnTo: string, view: PageView): Promise<Response> {
  const tx: Tx = { provider, state: randomToken(), verifier: randomToken(48), returnTo };
  const redirectUri = `${ctx.config.issuer}${authCallbackPath(provider)}`;
  const codeChallenge = await sha256Base64url(tx.verifier);
  let location: string;
  if (provider === 'github' && ctx.config.github) {
    location = githubAuthorizeUrl(ctx.config.github, { redirectUri, state: tx.state, codeChallenge });
  } else if (provider === 'google' && ctx.config.google) {
    tx.nonce = randomToken();
    location = googleAuthorizeUrl(ctx.config.google, { redirectUri, state: tx.state, codeChallenge, nonce: tx.nonce });
  } else {
    return cannotLogIn(view, STRINGS[view.locale].providerNotConfigured(PROVIDER_LABEL[provider]), 503);
  }
  const keys = await ctx.keys();
  const txToken = await signToken(keys, ctx.config.issuer, OAUTH_TX_TOKEN, { ...tx } as JWTPayload);
  const names = cookieNames(ctx.config.secureCookies);
  const txCookie = serializeCookie(names.tx, txToken, OAUTH_TX_TOKEN.ttlSeconds, ctx.config.secureCookies);
  return redirectResponse(location, [txCookie]);
}

/** GET /auth/:provider/callback?code=…&state=… */
export async function handleCallback(ctx: RequestContext, provider: RelayAuthProvider): Promise<Response> {
  if (ctx.req.method !== 'GET') return methodNotAllowed();
  const names = cookieNames(ctx.config.secureCookies);
  const clearTx = clearCookie(names.tx, ctx.config.secureCookies);
  // No language switch on these pages: the callback URL carries a one-time code and its transaction cookie is cleared
  // with the answer, so requesting the same URL again would only show a different error.
  const view = plainPageView(ctx);
  const s = STRINGS[view.locale];
  const failed = (message: string, status: number): Response => cannotLogIn(view, message, status, [clearTx]);
  const txToken = readCookie(ctx.req.headers.get('cookie'), names.tx);
  if (txToken === null) return failed(s.loginTimedOutOrDone, 400);

  let tx: Tx | null;
  try {
    tx = parseTx(await verifyToken(await ctx.keys(), ctx.config.issuer, txToken, OAUTH_TX_TOKEN));
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    tx = null;
  }
  if (tx === null || tx.provider !== provider) return failed(s.loginTimedOut, 400);

  // The state check comes first: until it passes, nothing proves this request belongs to our transaction.
  if (!timingSafeEqualString(ctx.url.searchParams.get('state') ?? '', tx.state)) return failed(s.stateMismatch, 400);
  if (ctx.url.searchParams.get('error') !== null) return failed(s.loginCancelled, 400);
  const code = ctx.url.searchParams.get('code');
  if (!code || code.length > 2048) return failed(s.noAuthorizationCode, 400);

  const redirectUri = `${ctx.config.issuer}${authCallbackPath(provider)}`;
  let identity: Identity;
  try {
    if (provider === 'github' && ctx.config.github) {
      identity = await githubIdentity(ctx.config.github, { code, verifier: tx.verifier, redirectUri });
    } else if (provider === 'google' && ctx.config.google && tx.nonce) {
      identity = await googleIdentity(ctx.config.google, { code, verifier: tx.verifier, redirectUri, nonce: tx.nonce });
    } else {
      return failed(s.providerNotConfigured(PROVIDER_LABEL[provider]), 503);
    }
  } catch (error) {
    // Log the reason (never a token or code) for the operator; the person only sees a generic message.
    console.warn(`login via ${provider} failed: ${error instanceof ProviderError ? error.message : 'unexpected error'}`);
    return failed(s.cannotConfirmIdentity(PROVIDER_LABEL[provider]), 502);
  }
  return finishLogin(ctx, identity, tx.returnTo, [clearTx]);
}

function parseTx(payload: JWTPayload): Tx | null {
  const { provider, state, verifier, nonce, returnTo } = payload as Record<string, unknown>;
  if (provider !== 'github' && provider !== 'google') return null;
  if (typeof state !== 'string' || typeof verifier !== 'string' || !PKCE_VERIFIER_PATTERN.test(verifier)) return null;
  const tx: Tx = { provider, state, verifier };
  if (nonce !== undefined) {
    if (typeof nonce !== 'string') return null;
    tx.nonce = nonce;
  }
  if (returnTo !== undefined) {
    if (typeof returnTo !== 'string') return null;
    tx.returnTo = returnTo;
  }
  return tx;
}

/** Browser login done: the session cookie, and a redirect to `returnTo` (already checked by resolveReturnTo). */
async function finishLogin(ctx: RequestContext, identity: Identity, returnTo: string | undefined, cookies: string[] = []): Promise<Response> {
  const session = await signToken(await ctx.keys(), ctx.config.issuer, SESSION_TOKEN, identityClaims(identity));
  const names = cookieNames(ctx.config.secureCookies);
  return redirectResponse(returnTo ?? `${ctx.config.issuer}/`, [
    ...cookies,
    serializeCookie(names.session, session, SESSION_TOKEN.ttlSeconds, ctx.config.secureCookies),
  ]);
}

/** The bearer session the CLI saves: `{ token, tokenType, expiresIn, user }` (the dev token and the device login). */
export async function sessionJson(ctx: RequestContext, identity: Identity): Promise<Response> {
  const token = await signToken(await ctx.keys(), ctx.config.issuer, SESSION_TOKEN, identityClaims(identity));
  return jsonResponse({ token, tokenType: 'Bearer', expiresIn: SESSION_TOKEN.ttlSeconds, user: identityJson(identity) });
}

// ---------------------------------------------------------------------------------------------------------------
// Dev-only provider: DEV_LOGIN=1 AND a local hostname, otherwise 404 (indistinguishable from a missing route).
// ---------------------------------------------------------------------------------------------------------------

function devIdentity(user: string | null, displayName: unknown): Identity | null {
  if (user === null || !DEV_USER_PATTERN.test(user)) return null;
  return makeIdentity({
    provider: 'dev',
    subject: user,
    displayName: typeof displayName === 'string' ? displayName : user,
    fallbackName: user,
  });
}

/** GET /auth/dev/start?user=<name>[&name=<display name>][&return_to=…]: browser login without a provider. */
export async function handleDevStart(ctx: RequestContext): Promise<Response> {
  if (!devLoginEnabled(ctx.config, ctx.url)) return notFound();
  if (ctx.req.method !== 'GET') return methodNotAllowed();
  const switched = languageSwitchRedirect(ctx);
  if (switched !== null) return switched;
  const view = loginRouteView(ctx);
  const s = STRINGS[view.locale];
  const identity = devIdentity(ctx.url.searchParams.get('user'), ctx.url.searchParams.get('name') ?? undefined);
  if (!identity) return cannotLogIn(view, s.devNameRule, 400);
  const returnTo = resolveReturnTo(ctx.url.searchParams.get('return_to'), ctx.config.issuer, ctx.config.allowedOrigins);
  if (returnTo === null) return cannotLogIn(view, s.badLoginLink, 400);
  return finishLogin(ctx, identity, returnTo);
}

/** POST /auth/dev/token { user, displayName? } → bearer session token (automated tests). */
export async function handleDevToken(ctx: RequestContext): Promise<Response> {
  if (!devLoginEnabled(ctx.config, ctx.url)) return notFound();
  if (ctx.req.method !== 'POST') return methodNotAllowed();
  const body = await readJsonBody(ctx.req);
  if (!body.ok) return body.response;
  if (!isRecord(body.value)) return errorResponse(400, 'bad_request');
  const user = typeof body.value['user'] === 'string' ? body.value['user'] : null;
  const identity = devIdentity(user, body.value['displayName']);
  if (!identity) return errorResponse(400, 'bad_request', 'user must match [A-Za-z0-9._-]{1,64}');
  return sessionJson(ctx, identity);
}

// ---------------------------------------------------------------------------------------------------------------
// The relay's own forms (/device, ./device.ts)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Only the relay's own pages (/device) may change a login: a same-origin form POST. A page on another origin can
 * submit the same fields, but the browser labels that request with the other page's Origin and a Sec-Fetch-Site other
 * than `same-origin`. A request without an Origin is refused (fail closed; browsers send one with every POST).
 */
export function isSameOriginFormPost(ctx: RequestContext): boolean {
  const site = ctx.req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  const origin = ctx.req.headers.get('origin');
  return origin !== null && (origin === ctx.config.issuer || isAllowedOrigin(ctx.config, origin));
}

// ---------------------------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------------------------

/** POST /auth/logout: clears the browser cookie (the JWT itself stays valid until it expires; it is stateless). */
export async function handleLogout(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== 'POST') return methodNotAllowed();
  const names = cookieNames(ctx.config.secureCookies);
  const hasCookie = readCookie(ctx.req.headers.get('cookie'), names.session) !== null;
  if (hasCookie && !isAllowedOrigin(ctx.config, ctx.req.headers.get('origin'))) return errorResponse(403, 'origin_not_allowed');
  return emptyResponse(204, [clearCookie(names.session, ctx.config.secureCookies)]);
}

/** GET /api/me → { user } or 401. */
export async function handleMe(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== 'GET') return methodNotAllowed();
  const outcome = await authenticate(ctx);
  if (outcome.status === 'anonymous') return errorResponse(401, 'unauthorized', 'login required');
  if (outcome.status === 'invalid') return errorResponse(401, 'invalid_session', 'session is invalid or expired');
  return jsonResponse({ user: identityJson(outcome.auth.identity) });
}
