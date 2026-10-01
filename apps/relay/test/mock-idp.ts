// Mock GitHub OAuth App + Google OIDC provider on 127.0.0.1, mirroring the documented endpoints and parameters
// (relay.md V19/V25/V26). It enforces client credentials, redirect_uri match, PKCE S256, state passthrough and the
// User-Agent requirement, and can be told to misbehave for negative tests.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

const b64url = (bytes: Buffer) => bytes.toString('base64url');
const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export const GITHUB_USER = { id: 12345, login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.example/u/12345' };
export const GOOGLE_USER = {
  sub: '110248495921238986420',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  picture: 'https://lh3.example/ada.png',
};

export type MockIdpBehaviour = {
  /** id_token `nonce` replaced by this value. */
  googleNonce?: string;
  /** id_token `aud` replaced by this value. */
  googleAudience?: string;
};

type PendingCode = { provider: 'github' | 'google'; challenge: string; redirectUri: string; nonce?: string };

export type MockIdp = {
  base: string;
  vars: Record<string, string>;
  secrets: { GITHUB_CLIENT_SECRET: string; GOOGLE_CLIENT_SECRET: string };
  /** Mutable: set before a flow to make the IdP misbehave. */
  behaviour: MockIdpBehaviour;
  /** Every authorize request's query parameters and every /user request's User-Agent. */
  seen: { authorize: URLSearchParams[]; userAgents: (string | undefined)[] };
  close(): Promise<void>;
};

export async function startMockIdp(): Promise<MockIdp> {
  const github = { clientId: 'gh-test-client', clientSecret: b64url(randomBytes(24)) };
  const google = { clientId: 'google-test-client.apps.googleusercontent.com', clientSecret: b64url(randomBytes(24)) };
  const codes = new Map<string, PendingCode>();
  const tokens = new Map<string, typeof GITHUB_USER>();
  const seen: MockIdp['seen'] = { authorize: [], userAgents: [] };
  const behaviour: MockIdpBehaviour = {};
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: 'mock-rsa-1', alg: 'RS256', use: 'sig' };
  let base = '';

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => resolve(body));
    });
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const redirectBack = (res: ServerResponse, q: URLSearchParams, code: string) => {
    const to = new URL(q.get('redirect_uri') ?? '');
    to.searchParams.set('code', code);
    to.searchParams.set('state', q.get('state') ?? '');
    res.writeHead(302, { location: to.href });
    res.end();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://idp.invalid');
    const q = url.searchParams;
    const form = new URLSearchParams(await readBody(req));

    // ---------------------------------------------------------------- GitHub
    if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
      seen.authorize.push(q);
      if (q.get('client_id') !== github.clientId) return json(res, 400, { error: 'bad client' });
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, 400, { error: 'pkce required' });
      const code = b64url(randomBytes(16));
      codes.set(code, { provider: 'github', challenge: q.get('code_challenge') ?? '', redirectUri: q.get('redirect_uri') ?? '' });
      return redirectBack(res, q, code);
    }
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const pending = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!pending || pending.provider !== 'github') return json(res, 200, { error: 'bad_verification_code' });
      if (form.get('client_id') !== github.clientId || form.get('client_secret') !== github.clientSecret) {
        return json(res, 200, { error: 'incorrect_client_credentials' });
      }
      if (form.get('redirect_uri') !== pending.redirectUri) return json(res, 200, { error: 'redirect_uri_mismatch' });
      if (s256(form.get('code_verifier') ?? '') !== pending.challenge) return json(res, 200, { error: 'bad_verification_code' });
      if (!(req.headers.accept ?? '').includes('application/json')) return json(res, 400, { error: 'expected Accept json' });
      const accessToken = `gho_${b64url(randomBytes(12))}`;
      tokens.set(accessToken, GITHUB_USER);
      return json(res, 200, { access_token: accessToken, token_type: 'bearer', scope: '' });
    }
    if (req.method === 'GET' && url.pathname === '/user') {
      seen.userAgents.push(req.headers['user-agent']);
      if (!req.headers['user-agent']) return json(res, 403, { message: 'User-Agent required' });
      const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      return user ? json(res, 200, user) : json(res, 401, { message: 'Bad credentials' });
    }

    // ---------------------------------------------------------------- Google
    if (req.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') {
      seen.authorize.push(q);
      if (q.get('client_id') !== google.clientId || q.get('response_type') !== 'code') return json(res, 400, { error: 'invalid_request' });
      if (!q.get('scope')?.split(' ').includes('openid')) return json(res, 400, { error: 'invalid_scope' });
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, 400, { error: 'pkce required' });
      const code = `4/${b64url(randomBytes(16))}`;
      codes.set(code, {
        provider: 'google',
        challenge: q.get('code_challenge') ?? '',
        redirectUri: q.get('redirect_uri') ?? '',
        nonce: q.get('nonce') ?? '',
      });
      return redirectBack(res, q, code);
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const pending = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!pending || pending.provider !== 'google' || form.get('grant_type') !== 'authorization_code') {
        return json(res, 400, { error: 'invalid_grant' });
      }
      if (form.get('client_id') !== google.clientId || form.get('client_secret') !== google.clientSecret) {
        return json(res, 401, { error: 'invalid_client' });
      }
      if (form.get('redirect_uri') !== pending.redirectUri) return json(res, 400, { error: 'redirect_uri_mismatch' });
      if (s256(form.get('code_verifier') ?? '') !== pending.challenge) return json(res, 400, { error: 'invalid_grant' });
      const idToken = await new SignJWT({
        email: GOOGLE_USER.email,
        email_verified: true,
        name: GOOGLE_USER.name,
        picture: GOOGLE_USER.picture,
        nonce: behaviour.googleNonce ?? pending.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'mock-rsa-1', typ: 'JWT' })
        .setIssuer(base)
        .setAudience(behaviour.googleAudience ?? google.clientId)
        .setSubject(GOOGLE_USER.sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
      return json(res, 200, { access_token: `ya29.${b64url(randomBytes(12))}`, expires_in: 3599, token_type: 'Bearer', id_token: idToken });
    }
    if (req.method === 'GET' && url.pathname === '/oauth2/v3/certs') return json(res, 200, { keys: [publicJwk] });
    json(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    behaviour,
    seen,
    vars: {
      GITHUB_CLIENT_ID: github.clientId,
      GITHUB_AUTHORIZE_URL: `${base}/login/oauth/authorize`,
      GITHUB_TOKEN_URL: `${base}/login/oauth/access_token`,
      GITHUB_API_URL: base,
      GOOGLE_CLIENT_ID: google.clientId,
      GOOGLE_AUTHORIZE_URL: `${base}/o/oauth2/v2/auth`,
      GOOGLE_TOKEN_URL: `${base}/token`,
      GOOGLE_JWKS_URL: `${base}/oauth2/v3/certs`,
      GOOGLE_ISSUER: base,
    },
    secrets: { GITHUB_CLIENT_SECRET: github.clientSecret, GOOGLE_CLIENT_SECRET: google.clientSecret },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
