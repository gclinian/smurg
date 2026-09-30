// Login routes (ARCHITECTURE §6): GitHub / Google for browsers, the CLI loopback flow, the dev-only provider,
// logout, /api/me and /api/login-options.
//
// The OAuth transaction (state, PKCE verifier, nonce, CLI parameters, return URL) lives in a signed 10-minute cookie,
// so the relay keeps no server-side login state.
import { authCallbackPath, type RelayAuthProvider } from '@smurg/protocol/relay';
import type { JWTPayload } from 'jose';
import type { RequestContext } from '../context.ts';
import { randomToken, sha256Base64url, timingSafeEqualString } from '../lib/base64url.ts';
import { devLoginEnabled, isAllowedOrigin, loginOptionsFor } from '../lib/config.ts';
import { clearCookie, cookieNames, readCookie, serializeCookie } from '../lib/cookies.ts';
import { cliConfirmPage, continuePage, errorPage } from '../lib/html.ts';
import {
  emptyResponse,
  errorResponse,
  htmlResponse,
  isRecord,
  jsonResponse,
  readFormBody,
  readJsonBody,
  redirectResponse,
} from '../lib/http.ts';
import {
  CLI_STATE_PATTERN,
  DEV_USER_PATTERN,
  PKCE_CHALLENGE_PATTERN,
  PKCE_VERIFIER_PATTERN,
  cliConfirmCode,
  cliLoopbackUrl,
  parseCliParams,
  resolveReturnTo,
  type CliParams,
} from '../lib/validate.ts';
import { identityClaims, identityFromClaims, identityJson, makeIdentity, type Identity } from './identity.ts';
import { githubAuthorizeUrl, githubIdentity, googleAuthorizeUrl, googleIdentity, ProviderError } from './providers.ts';
import { authenticate } from './session.ts';
import { CLI_CODE_TOKEN, OAUTH_TX_TOKEN, SESSION_TOKEN, TokenError, signToken, verifyToken } from './tokens.ts';

type Tx = {
  provider: RelayAuthProvider;
  state: string;
  verifier: string;
  nonce?: string;
  cli?: CliParams;
  returnTo?: string;
};

type LoginTarget = { cli?: CliParams | undefined; returnTo?: string | undefined };

const PROVIDER_LABEL: Record<RelayAuthProvider, string> = { github: 'GitHub', google: 'Google' };

function methodNotAllowed(): Response {
  return errorResponse(405, 'method_not_allowed');
}

function notFound(): Response {
  return errorResponse(404, 'not_found');
}

function badLink(message = '登入連結無效或已過期，請回到原本的頁面重新登入。'): Response {
  return htmlResponse(errorPage('無法登入', message), 400);
}

// ---------------------------------------------------------------------------------------------------------------
// Browser login
// ---------------------------------------------------------------------------------------------------------------

/** GET /auth/:provider/login[?return_to=<path or allow-listed URL>] */
export async function handleLogin(ctx: RequestContext, provider: RelayAuthProvider): Promise<Response> {
  if (ctx.req.method !== 'GET') return methodNotAllowed();
  if (!providerConfigured(ctx, provider)) {
    return htmlResponse(errorPage('無法登入', `這個 relay 尚未設定 ${PROVIDER_LABEL[provider]} 登入。`), 503);
  }
  const returnTo = resolveReturnTo(ctx.url.searchParams.get('return_to'), ctx.config.issuer, ctx.config.allowedOrigins);
  if (returnTo === null) return badLink();
  return startOAuth(ctx, provider, { returnTo });
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

async function startOAuth(ctx: RequestContext, provider: RelayAuthProvider, target: LoginTarget): Promise<Response> {
  const tx: Tx = { provider, state: randomToken(), verifier: randomToken(48) };
  if (target.cli) tx.cli = target.cli;
  if (target.returnTo) tx.returnTo = target.returnTo;
  const redirectUri = `${ctx.config.issuer}${authCallbackPath(provider)}`;
  const codeChallenge = await sha256Base64url(tx.verifier);
  let location: string;
  if (provider === 'github' && ctx.config.github) {
    location = githubAuthorizeUrl(ctx.config.github, { redirectUri, state: tx.state, codeChallenge });
  } else if (provider === 'google' && ctx.config.google) {
    tx.nonce = randomToken();
    location = googleAuthorizeUrl(ctx.config.google, { redirectUri, state: tx.state, codeChallenge, nonce: tx.nonce });
  } else {
    return htmlResponse(errorPage('無法登入', `這個 relay 尚未設定 ${PROVIDER_LABEL[provider]} 登入。`), 503);
  }
  const keys = await ctx.keys();
  const txToken = await signToken(keys, ctx.config.issuer, OAUTH_TX_TOKEN, { ...tx } as JWTPayload);
  const names = cookieNames(ctx.config.secureCookies);
  const txCookie = serializeCookie(names.tx, txToken, OAUTH_TX_TOKEN.ttlSeconds, ctx.config.secureCookies);
  // The CLI flow gets here from the confirmation page's form POST: a 302 to the IdP would be blocked by that page's
  // CSP form-action (OWNER-01), so the browser continues from a page of our own.
  if (target.cli) {
    return htmlResponse(
      continuePage('正在前往登入頁面', `正在前往 ${PROVIDER_LABEL[provider]} 登入。`, location, `前往 ${PROVIDER_LABEL[provider]}`),
      200,
      [txCookie],
    );
  }
  return redirectResponse(location, [txCookie]);
}

/** GET /auth/:provider/callback?code=…&state=… */
export async function handleCallback(ctx: RequestContext, provider: RelayAuthProvider): Promise<Response> {
  if (ctx.req.method !== 'GET') return methodNotAllowed();
  const names = cookieNames(ctx.config.secureCookies);
  const clearTx = clearCookie(names.tx, ctx.config.secureCookies);
  const txToken = readCookie(ctx.req.headers.get('cookie'), names.tx);
  if (txToken === null) return htmlResponse(errorPage('無法登入', '登入逾時或已在其他分頁完成，請重新登入。'), 400, [clearTx]);

  let tx: Tx | null;
  try {
    tx = parseTx(await verifyToken(await ctx.keys(), ctx.config.issuer, txToken, OAUTH_TX_TOKEN));
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    tx = null;
  }
  if (tx === null || tx.provider !== provider) return htmlResponse(errorPage('無法登入', '登入逾時，請重新登入。'), 400, [clearTx]);

  // The state check comes first: until it passes, nothing proves this request belongs to our transaction, so not
  // even an error is forwarded to the CLI's loopback listener.
  if (!timingSafeEqualString(ctx.url.searchParams.get('state') ?? '', tx.state)) {
    return htmlResponse(errorPage('無法登入', '登入請求不相符（state 錯誤），請重新登入。'), 400, [clearTx]);
  }
  if (ctx.url.searchParams.get('error') !== null) return loginFailed(tx, 'access_denied', '你取消了登入，或登入服務拒絕了這次請求。', 400, clearTx);
  const code = ctx.url.searchParams.get('code');
  if (!code || code.length > 2048) return loginFailed(tx, 'login_failed', '登入服務沒有回傳授權碼。', 400, clearTx);

  const redirectUri = `${ctx.config.issuer}${authCallbackPath(provider)}`;
  let identity: Identity;
  try {
    if (provider === 'github' && ctx.config.github) {
      identity = await githubIdentity(ctx.config.github, { code, verifier: tx.verifier, redirectUri });
    } else if (provider === 'google' && ctx.config.google && tx.nonce) {
      identity = await googleIdentity(ctx.config.google, { code, verifier: tx.verifier, redirectUri, nonce: tx.nonce });
    } else {
      return loginFailed(tx, 'login_failed', `這個 relay 尚未設定 ${PROVIDER_LABEL[provider]} 登入。`, 503, clearTx);
    }
  } catch (error) {
    // Log the reason (never a token or code) for the operator; the person only sees a generic message.
    console.warn(`login via ${provider} failed: ${error instanceof ProviderError ? error.message : 'unexpected error'}`);
    return loginFailed(tx, 'login_failed', `無法向 ${PROVIDER_LABEL[provider]} 確認你的身分，請稍後再試。`, 502, clearTx);
  }
  return finishLogin(ctx, identity, { cli: tx.cli, returnTo: tx.returnTo }, [clearTx]);
}

function loginFailed(tx: Tx, error: string, message: string, status: number, clearTx: string): Response {
  // The CLI is waiting on its loopback listener: tell it, so it can stop and print the reason.
  if (tx.cli) return cliReturn(tx.cli, { error }, '登入沒有完成', `${message}正在通知 smurg CLI。`, [clearTx]);
  return htmlResponse(errorPage('無法登入', message), status, [clearTx]);
}

/**
 * Hands the result to the CLI's loopback listener. Never a 302: the navigation that ends here usually began with a
 * form submission (our confirmation page, or the IdP's own consent / login form), and Chromium applies that page's
 * CSP form-action to every redirect of it, so a redirect to http://127.0.0.1 would be blocked and the CLI would wait
 * forever (OWNER-01). This page ends that chain on our origin and continues with a meta refresh; it runs no script,
 * sends no referrer and is not cached.
 */
function cliReturn(
  cli: CliParams,
  result: { code: string } | { error: string },
  title: string,
  message: string,
  cookies: readonly string[] = [],
): Response {
  const target = cliLoopbackUrl(cli, result);
  return htmlResponse(continuePage(title, message, target, '回到 smurg CLI'), 200, cookies);
}

function parseTx(payload: JWTPayload): Tx | null {
  const { provider, state, verifier, nonce, cli, returnTo } = payload as Record<string, unknown>;
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
  if (cli !== undefined) {
    if (!isRecord(cli)) return null;
    const { port, state: cliState, codeChallenge } = cli;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
    if (typeof cliState !== 'string' || !CLI_STATE_PATTERN.test(cliState)) return null;
    if (typeof codeChallenge !== 'string' || !PKCE_CHALLENGE_PATTERN.test(codeChallenge)) return null;
    tx.cli = { port, state: cliState, codeChallenge };
  }
  return tx;
}

/** Browser: session cookie + redirect. CLI: a 60-second code bound to the CLI's PKCE challenge, sent to its loopback. */
async function finishLogin(
  ctx: RequestContext,
  identity: Identity,
  target: LoginTarget,
  cookies: string[] = [],
): Promise<Response> {
  const keys = await ctx.keys();
  if (target.cli) {
    const code = await signToken(keys, ctx.config.issuer, CLI_CODE_TOKEN, {
      ...identityClaims(identity),
      cc: target.cli.codeChallenge,
    });
    return cliReturn(target.cli, { code }, '登入完成', '正在把登入交回 smurg CLI，完成後可以關閉這個分頁。', cookies);
  }
  const session = await signToken(keys, ctx.config.issuer, SESSION_TOKEN, identityClaims(identity));
  const names = cookieNames(ctx.config.secureCookies);
  return redirectResponse(target.returnTo ?? `${ctx.config.issuer}/`, [
    ...cookies,
    serializeCookie(names.session, session, SESSION_TOKEN.ttlSeconds, ctx.config.secureCookies),
  ]);
}

async function sessionJson(ctx: RequestContext, identity: Identity): Promise<Response> {
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
  const identity = devIdentity(ctx.url.searchParams.get('user'), ctx.url.searchParams.get('name') ?? undefined);
  if (!identity) return badLink(DEV_NAME_RULE);
  const returnTo = resolveReturnTo(ctx.url.searchParams.get('return_to'), ctx.config.issuer, ctx.config.allowedOrigins);
  if (returnTo === null) return badLink();
  return finishLogin(ctx, identity, { returnTo });
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
// CLI loopback login
// ---------------------------------------------------------------------------------------------------------------

const CLI_BAD_LINK = 'CLI 登入連結的參數缺少或格式錯誤，請重新執行 smurg login。';
const DEV_NAME_RULE = '開發用帳號名稱只能包含英數字、「.」、「_」、「-」，最多 64 個字元。';

/**
 * CLI loopback login.
 *
 * `GET /auth/cli/start?port=P&state=S&code_challenge=C[&provider=github|google|dev][&user=<dev name>]` only ever shows
 * the confirmation page (SEC-E-03). Any web page can link here with a port, state and PKCE challenge of its own
 * choosing; when a GET went straight on to the IdP, which approves a returning user without a consent screen, one
 * click handed the person's relay session to whoever listens on port P of their machine. `provider` only narrows the
 * choices on the page (`smurg login --provider github`).
 *
 * `POST /auth/cli/start` (the same fields as a form, from that page only): the provider flow, or the dev login. The
 * result reaches http://127.0.0.1:P/callback?code=…&state=S (or ?error=…) through cliReturn.
 */
export async function handleCliStart(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method === 'POST') return handleCliConfirm(ctx);
  if (ctx.req.method !== 'GET') return methodNotAllowed();
  const cli = parseCliParams(ctx.url.searchParams);
  if (!cli) return badLink(CLI_BAD_LINK);
  const devEnabled = devLoginEnabled(ctx.config, ctx.url);
  const provider = ctx.url.searchParams.get('provider');
  let only: 'github' | 'google' | 'dev' | undefined;
  let devUser: string | undefined;
  if (provider === 'github' || provider === 'google') {
    if (!providerConfigured(ctx, provider)) {
      return htmlResponse(errorPage('無法登入', `這個 relay 尚未設定 ${PROVIDER_LABEL[provider]} 登入。`), 503);
    }
    only = provider;
  } else if (provider === 'dev') {
    if (!devEnabled) return notFound();
    const user = ctx.url.searchParams.get('user');
    if (user !== null && !DEV_USER_PATTERN.test(user)) return badLink(DEV_NAME_RULE);
    only = 'dev';
    devUser = user ?? undefined;
  } else if (provider !== null) {
    return badLink();
  }
  const page = cliConfirmPage(
    cli,
    { github: ctx.config.github !== null, google: ctx.config.google !== null, dev: devEnabled },
    { relayOrigin: ctx.url.origin, confirmCode: await cliConfirmCode(cli.state), only, devUser },
  );
  // same-origin: the page's forms must carry the real Origin (see HtmlOptions.referrerPolicy).
  return htmlResponse(page, 200, [], { referrerPolicy: 'same-origin' });
}

/**
 * Only the confirmation page may continue the login: a same-origin form POST. A page on another origin can submit
 * the same fields, but the browser labels that request with the other page's Origin and a Sec-Fetch-Site other than
 * `same-origin`. A request without an Origin is refused (fail closed; browsers send one with every POST).
 */
function isSameOriginFormPost(ctx: RequestContext): boolean {
  const site = ctx.req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  const origin = ctx.req.headers.get('origin');
  return origin !== null && (origin === ctx.config.issuer || isAllowedOrigin(ctx.config, origin));
}

async function handleCliConfirm(ctx: RequestContext): Promise<Response> {
  if (!isSameOriginFormPost(ctx)) {
    return htmlResponse(
      errorPage('無法登入', '這個登入請求不是從 relay 的確認頁面送出的，已經拒絕。如果你正在登入 smurg CLI，請回到終端機重新執行 smurg login。'),
      403,
    );
  }
  const form = await readFormBody(ctx.req);
  if (!form.ok) return form.response;
  const cli = parseCliParams(form.value);
  if (!cli) return badLink(CLI_BAD_LINK);
  const provider = form.value.get('provider');
  if (provider === 'github' || provider === 'google') {
    if (!providerConfigured(ctx, provider)) {
      return htmlResponse(errorPage('無法登入', `這個 relay 尚未設定 ${PROVIDER_LABEL[provider]} 登入。`), 503);
    }
    return startOAuth(ctx, provider, { cli });
  }
  if (provider === 'dev') {
    if (!devLoginEnabled(ctx.config, ctx.url)) return notFound();
    const identity = devIdentity(form.value.get('user'), undefined);
    if (!identity) return badLink(DEV_NAME_RULE);
    return finishLogin(ctx, identity, { cli });
  }
  return badLink();
}

/** POST /auth/cli/token { code, codeVerifier } → bearer session token. */
export async function handleCliToken(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== 'POST') return methodNotAllowed();
  const body = await readJsonBody(ctx.req);
  if (!body.ok) return body.response;
  if (!isRecord(body.value)) return errorResponse(400, 'bad_request');
  const { code, codeVerifier } = body.value;
  if (typeof code !== 'string' || typeof codeVerifier !== 'string' || !PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
    return errorResponse(400, 'bad_request', 'expected { code, codeVerifier }');
  }
  let payload: JWTPayload;
  try {
    payload = await verifyToken(await ctx.keys(), ctx.config.issuer, code, CLI_CODE_TOKEN);
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    return errorResponse(400, 'invalid_code');
  }
  const identity = identityFromClaims(payload);
  const challenge = payload['cc'];
  if (identity === null || typeof challenge !== 'string') return errorResponse(400, 'invalid_code');
  if (identity.provider === 'dev' && !devLoginEnabled(ctx.config, ctx.url)) return errorResponse(400, 'invalid_code');
  // The code is a stateless JWT and may be presented more than once within its 60 s; only the holder of the PKCE
  // verifier can redeem it (relay.md verification: accepted).
  if (!timingSafeEqualString(await sha256Base64url(codeVerifier), challenge)) return errorResponse(400, 'pkce_mismatch');
  return sessionJson(ctx, identity);
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
