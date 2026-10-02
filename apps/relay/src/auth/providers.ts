// OAuth providers. GitHub: OAuth App web flow with state + PKCE (S256), no scope (public profile only).
// Google: OpenID Connect code flow with state + nonce + PKCE, id_token verified against Google's JWKS.
// Provider access tokens are used once to read the profile and then dropped: the relay stores nothing.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { GithubConfig, GoogleConfig } from '../lib/config.ts';
import { isRecord } from '../lib/http.ts';
import { makeIdentity, type Identity } from './identity.ts';

export class ProviderError extends Error {
  override readonly name = 'ProviderError';
}

const PROVIDER_TIMEOUT_MS = 10_000;
const USER_AGENT = 'smurg-relay';

export function githubAuthorizeUrl(
  github: GithubConfig,
  p: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(github.authorizeUrl);
  url.searchParams.set('client_id', github.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'true');
  return url.href;
}

export function googleAuthorizeUrl(
  google: GoogleConfig,
  p: { redirectUri: string; state: string; codeChallenge: string; nonce: string },
): string {
  const url = new URL(google.authorizeUrl);
  url.searchParams.set('client_id', google.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', p.state);
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.href;
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError(`${what}: response is not JSON (HTTP ${res.status})`);
  }
  if (!isRecord(body)) throw new ProviderError(`${what}: unexpected response`);
  return body;
}

export async function githubIdentity(
  github: GithubConfig,
  p: { code: string; verifier: string; redirectUri: string },
): Promise<Identity> {
  const tokenRes = await fetch(github.tokenUrl, {
    method: 'POST',
    // Without Accept: application/json GitHub answers form-encoded (relay.md gotcha 18).
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: new URLSearchParams({
      client_id: github.clientId,
      client_secret: github.clientSecret,
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const token = await readJson(tokenRes, 'github token');
  const accessToken = token['access_token'];
  if (!tokenRes.ok || typeof accessToken !== 'string' || accessToken === '') {
    throw new ProviderError(`github token: ${typeof token['error'] === 'string' ? token['error'] : `HTTP ${tokenRes.status}`}`);
  }
  const userRes = await fetch(`${github.apiUrl}/user`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT, // GitHub rejects API requests without a User-Agent
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!userRes.ok) throw new ProviderError(`github user: HTTP ${userRes.status}`);
  const user = await readJson(userRes, 'github user');
  const id = user['id'];
  const login = typeof user['login'] === 'string' ? user['login'] : '';
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new ProviderError('github user: no numeric id');
  const identity = makeIdentity({
    provider: 'github',
    subject: String(id),
    displayName: typeof user['name'] === 'string' && user['name'] !== '' ? user['name'] : login,
    fallbackName: login || `GitHub ${id}`,
    avatarUrl: typeof user['avatar_url'] === 'string' ? user['avatar_url'] : undefined,
  });
  if (!identity) throw new ProviderError('github user: unusable identity');
  return identity;
}

const googleKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function googleKeySet(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  let keySet = googleKeySets.get(jwksUrl);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: PROVIDER_TIMEOUT_MS });
    googleKeySets.set(jwksUrl, keySet);
  }
  return keySet;
}

export async function googleIdentity(
  google: GoogleConfig,
  p: { code: string; verifier: string; redirectUri: string; nonce: string },
): Promise<Identity> {
  const tokenRes = await fetch(google.tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: google.clientId,
      client_secret: google.clientSecret,
      code: p.code,
      code_verifier: p.verifier,
      grant_type: 'authorization_code',
      redirect_uri: p.redirectUri,
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const token = await readJson(tokenRes, 'google token');
  const idToken = token['id_token'];
  if (!tokenRes.ok || typeof idToken !== 'string' || idToken === '') {
    throw new ProviderError(`google token: ${typeof token['error'] === 'string' ? token['error'] : `HTTP ${tokenRes.status}`}`);
  }
  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(idToken, googleKeySet(google.jwksUrl), {
      issuer: google.issuers,
      audience: google.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    claims = payload;
  } catch (error) {
    throw new ProviderError(`google id_token: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  if (claims['nonce'] !== p.nonce) throw new ProviderError('google id_token: nonce mismatch');
  // `azp`, when present, names the client the token was issued to; it must be us.
  if (claims['azp'] !== undefined && claims['azp'] !== google.clientId) throw new ProviderError('google id_token: azp');
  const sub = claims['sub'];
  if (typeof sub !== 'string') throw new ProviderError('google id_token: sub');
  // The e-mail address is only used as a display name, and only when Google says it is verified (gotcha 19).
  const email = claims['email_verified'] === true && typeof claims['email'] === 'string' ? claims['email'] : undefined;
  const identity = makeIdentity({
    provider: 'google',
    subject: sub,
    displayName: typeof claims['name'] === 'string' && claims['name'] !== '' ? claims['name'] : email,
    fallbackName: email ?? 'Google user',
    avatarUrl: typeof claims['picture'] === 'string' ? claims['picture'] : undefined,
  });
  if (!identity) throw new ProviderError('google id_token: unusable identity');
  return identity;
}
