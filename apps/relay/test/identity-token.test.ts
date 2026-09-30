// Identity tokens as the daemon will verify them (ARCHITECTURE §4.2): jose in Node against the relay's JWKS, with
// issuer, audience (per workspace), typ, EdDSA, max age, and the blinded `cnf` commitment to the device key.
import { randomBytes } from 'node:crypto';
import { IDENTITY_TOKEN_TTL_SECONDS as PROTOCOL_IDENTITY_TTL } from '@smurg/protocol';
import {
  SignJWT,
  calculateJwkThumbprint,
  createRemoteJWKSet,
  decodeProtectedHeader,
  generateKeyPair,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IDENTITY_CNF_MEMBER,
  IDENTITY_TOKEN_AUDIENCE_PREFIX,
  IDENTITY_TOKEN_TTL_SECONDS,
  IDENTITY_TOKEN_TYP,
} from '../src/auth/tokens.ts';
import { cnfCommitment, startLocalRelay, type DevSession, type LocalRelay } from '../test-support/index.ts';

let relay: LocalRelay;
let alice: DevSession;
let workspaceId: string;

beforeAll(async () => {
  relay = await startLocalRelay();
  alice = await relay.devLogin('alice', { displayName: 'Alice' });
  workspaceId = await relay.createWorkspace(alice.token);
});

afterAll(async () => {
  await relay?.stop();
});

describe('the JWKS response carries the relay clock (review REL-05)', () => {
  it('has a Date header close to now: the daemon checks token times against the relay clock estimated from it', async () => {
    const res = await fetch(relay.jwksUrl);
    expect(res.status).toBe(200);
    const date = res.headers.get('date');
    expect(date).not.toBeNull();
    expect(Math.abs(Date.parse(date as string) - Date.now())).toBeLessThan(60_000);
  });
});

/** What the daemon does after the Noise handshake authenticated `remoteStatic` and msg3 carried `nonce`. */
async function daemonVerify(
  token: string,
  opts: { workspaceId: string; nonce: Uint8Array; remoteStatic: Uint8Array; currentDate?: Date },
): Promise<JWTPayload> {
  const jwks = createRemoteJWKSet(new URL(relay.jwksUrl));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: relay.issuer,
    audience: `smurg-daemon:${opts.workspaceId}`,
    typ: 'smurg-identity+jwt',
    algorithms: ['EdDSA'],
    maxTokenAge: '5m',
    ...(opts.currentDate ? { currentDate: opts.currentDate } : {}),
  });
  const cnf = (payload['cnf'] as Record<string, unknown> | undefined)?.['smurg-noise-static'];
  if (typeof cnf !== 'string' || cnf !== cnfCommitment(opts.nonce, opts.remoteStatic)) throw new Error('cnf mismatch');
  return payload;
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'ACCEPTED',
    (error: unknown) => (error as { code?: string }).code ?? (error as Error).message,
  );
}

describe('identity token', () => {
  it('keeps the wire constants in step with @smurg/protocol', () => {
    expect(IDENTITY_TOKEN_TTL_SECONDS).toBe(PROTOCOL_IDENTITY_TTL);
    expect(IDENTITY_TOKEN_TYP).toBe('smurg-identity+jwt');
    expect(IDENTITY_TOKEN_AUDIENCE_PREFIX).toBe('smurg-daemon:');
    expect(IDENTITY_CNF_MEMBER).toBe('smurg-noise-static');
  });

  it('verifies from Node with the relay JWKS and binds the device key through the blinded commitment', async () => {
    const nonce = randomBytes(32);
    const deviceKey = randomBytes(32);
    const cnf = cnfCommitment(nonce, deviceKey);
    const token = await relay.identityToken(alice.token, workspaceId, cnf);

    const payload = await daemonVerify(token, { workspaceId, nonce, remoteStatic: deviceKey });
    expect(payload).toMatchObject({ iss: relay.issuer, sub: alice.userId, name: 'Alice', provider: 'dev', aud: `smurg-daemon:${workspaceId}` });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
    expect(typeof payload.jti).toBe('string');
    // The relay only ever sees the commitment, never the device key or the nonce.
    expect(token).not.toContain(Buffer.from(deviceKey).toString('base64url'));

    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: 'EdDSA', typ: 'smurg-identity+jwt' });
    const jwks = (await (await fetch(relay.jwksUrl)).json()) as { keys: Record<string, string>[] };
    expect(jwks.keys).toHaveLength(1);
    const [published] = jwks.keys;
    expect(published).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: header.kid });
    expect(published).not.toHaveProperty('d');
    expect(header.kid).toBe(await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: published?.['x'] ?? '' }));
  });

  it('is rejected for another workspace, when expired, with a wrong cnf, tampered or forged', async () => {
    const nonce = randomBytes(32);
    const deviceKey = randomBytes(32);
    const token = await relay.identityToken(alice.token, workspaceId, cnfCommitment(nonce, deviceKey));
    const other = await relay.createWorkspace(alice.token);
    const good = { workspaceId, nonce, remoteStatic: deviceKey };

    expect(await errorCode(daemonVerify(token, good))).toBe('ACCEPTED'); // positive control
    expect(await errorCode(daemonVerify(token, { ...good, workspaceId: other }))).toBe('ERR_JWT_CLAIM_VALIDATION_FAILED');
    expect(await errorCode(daemonVerify(token, { ...good, currentDate: new Date(Date.now() + 6 * 60_000) }))).toBe('ERR_JWT_EXPIRED');
    // cnf: a different device key (e.g. the relay substituted a key) or a different nonce does not match.
    expect(await errorCode(daemonVerify(token, { ...good, remoteStatic: randomBytes(32) }))).toBe('cnf mismatch');
    expect(await errorCode(daemonVerify(token, { ...good, nonce: randomBytes(32) }))).toBe('cnf mismatch');

    const [header, payload, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JWTPayload;
    const tampered = [header, Buffer.from(JSON.stringify({ ...claims, sub: 'dev:mallory' })).toString('base64url'), signature].join('.');
    expect(await errorCode(daemonVerify(tampered, good))).toBe('ERR_JWS_SIGNATURE_VERIFICATION_FAILED');

    const { privateKey: foreignKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const forged = await new SignJWT({ ...claims, sub: 'dev:mallory' })
      .setProtectedHeader({ alg: 'EdDSA', kid: decodeProtectedHeader(token).kid ?? '', typ: 'smurg-identity+jwt' })
      .sign(foreignKey);
    expect(await errorCode(daemonVerify(forged, good))).toBe('ERR_JWS_SIGNATURE_VERIFICATION_FAILED');

    // A relay session token is not an identity token (typ and audience differ).
    expect(await errorCode(daemonVerify(alice.token, good))).toBe('ERR_JWT_CLAIM_VALIDATION_FAILED');
  });

  it('requires a session and a well-formed workspace id and cnf', async () => {
    const post = (headers: Record<string, string>, body: unknown) =>
      fetch(`${relay.origin}/api/identity-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const cnf = cnfCommitment(randomBytes(32), randomBytes(32));
    const auth = { authorization: `Bearer ${alice.token}` };
    expect((await post({}, { workspaceId, cnf })).status).toBe(401);
    expect((await post(auth, { workspaceId })).status).toBe(400);
    expect((await post(auth, { workspaceId, cnf: 'too-short' })).status).toBe(400);
    expect((await post(auth, { workspaceId, cnf: `${cnf}=` })).status).toBe(400);
    expect((await post(auth, { workspaceId: 'bad id!', cnf })).status).toBe(400);
    expect((await post(auth, { workspaceId, cnf })).status).toBe(200);
  });
});
