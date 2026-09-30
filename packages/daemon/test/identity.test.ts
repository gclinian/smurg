// Identity tokens (ARCHITECTURE §4, §4.2; relay.md §1.5): signature, typ, alg, iss, aud, age, and the blinded cnf
// commitment that binds the relay's login to the authenticated Noise key. The daemon verifies synchronously
// (admit() cannot await), so every rule jwtVerify would apply is tested here.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { identityCnf, randomBytes } from '@smurg/protocol';
import { waitForState, type ConnectionRelay, type ConnectionState } from '@smurg/protocol/client';
import { ManualClock } from '../src/core/lifecycle.ts';
import { IdentityVerifier, jwksKeySource, staticKeySource } from '../src/net/identity.ts';
import { createLineLogger } from '../src/core/logger.ts';
import { MEMORY_RELAY_ORIGIN, TestIdentityIssuer } from '../src/testing/memory-relay.ts';
import { createTestDaemon, type TestDaemon } from '../src/testing/index.ts';

const WS = 'ws_test_identity_001';
const clock = new ManualClock(1_760_000_000_000);
const keys = generateKeyPairSync('ed25519');
const issuer = new TestIdentityIssuer(MEMORY_RELAY_ORIGIN, keys, clock, 'kid-1');
const verifier = new IdentityVerifier({ keys: staticKeySource(new Map([['kid-1', keys.publicKey]])), issuer: MEMORY_RELAY_ORIGIN, workspaceId: WS, clock, skewMs: 60_000 });
const cnf = identityCnf(randomBytes(32), randomBytes(32));
const base = { sub: 'dev:amy', name: 'Amy', workspaceId: WS, cnf };

describe('IdentityVerifier', () => {
  it('accepts a well-formed token and returns its claims', async () => {
    const result = verifier.verify(await issuer.issue(base));
    expect(result).toEqual({ ok: true, claims: expect.objectContaining({ sub: 'dev:amy', name: 'Amy', cnf, provider: 'dev' }) });
  });

  it.each([
    ['another issuer', { issuer: 'https://evil.example' }, 'issuer'],
    ['another workspace', { audience: 'smurg-daemon:ws_other_workspace_1' }, 'audience'],
    ['a session token type', { typ: 'smurg-session+jwt' }, 'header'],
    ['an unknown key id', { kid: 'kid-unknown' }, 'unknown-key'],
    ['no cnf (not bound to a device)', { cnf: undefined }, 'cnf-missing'],
    ['an expired token', { iatMs: clock.now() - 10 * 60_000 }, 'expired'],
    ['a token issued in the future', { iatMs: clock.now() + 10 * 60_000 }, 'not-yet-valid'],
    ['a long-lived token older than 5 min', { iatMs: clock.now() - 10 * 60_000, ttlSeconds: 3600 }, 'too-old'],
    ['a forged signature under the right kid', { signWith: generateKeyPairSync('ed25519').privateKey }, 'signature'],
    ['a relay user id that is not one', { sub: 'root' }, 'subject'],
  ] as const)('refuses %s', async (_label, overrides, reason) => {
    const token = await issuer.issue({ ...base, ...overrides } as Parameters<TestIdentityIssuer['issue']>[0]);
    // Time failures also say how far the token's issue time is from the time it was checked against (REL-05).
    const time = reason === 'expired' || reason === 'not-yet-valid' || reason === 'too-old';
    expect(verifier.verify(token)).toEqual({ ok: false, reason, ...(time ? { iatDeltaMs: expect.any(Number) } : {}) });
  });

  describe("the host's clock is off; token times are checked against the relay's time (REL-05)", () => {
    const withOffset = (offsetMs: number | null): IdentityVerifier =>
      new IdentityVerifier({
        keys: { ...staticKeySource(new Map([['kid-1', keys.publicKey]])), clockOffsetMs: () => offsetMs },
        issuer: MEMORY_RELAY_ORIGIN,
        workspaceId: WS,
        clock,
        skewMs: 60_000,
      });

    it('host 2 min behind the relay: a fresh token is accepted, not "not yet valid"', async () => {
      const token = await issuer.issue({ ...base, iatMs: clock.now() + 120_000 });
      expect(withOffset(null).verify(token)).toMatchObject({ ok: false, reason: 'not-yet-valid', iatDeltaMs: 120_000 });
      expect(withOffset(120_000).verify(token).ok).toBe(true);
    });

    it('host 7 min ahead of the relay: a fresh token is accepted, not "expired"', async () => {
      const token = await issuer.issue({ ...base, iatMs: clock.now() - 420_000 });
      expect(withOffset(null).verify(token)).toMatchObject({ ok: false, reason: 'expired' });
      expect(withOffset(-420_000).verify(token).ok).toBe(true);
    });

    it('the relay offset does not make a stale token fresh, and an implausible offset is ignored (fail closed)', async () => {
      const stale = await issuer.issue({ ...base, iatMs: clock.now() - 20 * 60_000 });
      expect(withOffset(0).verify(stale)).toMatchObject({ ok: false, reason: 'expired' });
      const future = await issuer.issue({ ...base, iatMs: clock.now() + 400 * 24 * 3600_000 });
      expect(withOffset(400 * 24 * 3600_000).verify(future)).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    });

    it("jwksKeySource reads the relay's time from the HTTP Date of the key fetch", async () => {
      const jwk = keys.publicKey.export({ format: 'jwk' });
      let relayAhead = 120_000;
      const fetchStub = (async () =>
        Response.json({ keys: [{ ...jwk, kid: 'kid-1', alg: 'EdDSA', use: 'sig' }] }, { headers: { date: new Date(clock.now() + relayAhead).toUTCString() } })) as typeof fetch;
      const lines: string[] = [];
      const source = jwksKeySource({
        url: `${MEMORY_RELAY_ORIGIN}/.well-known/jwks.json`,
        log: createLineLogger({ write: (line) => lines.push(line) }),
        fetch: fetchStub,
        now: () => clock.now(),
      });
      await source.refresh();
      expect(Math.abs((source.clockOffsetMs?.() ?? 0) - 120_000)).toBeLessThanOrEqual(1_000);
      expect(lines.some((l) => l.includes(' warn ') && /offsetSec=12[01]\b/.test(l))).toBe(true);
      const verify = new IdentityVerifier({ keys: source, issuer: MEMORY_RELAY_ORIGIN, workspaceId: WS, clock, skewMs: 60_000 });
      expect(verify.verify(await issuer.issue({ ...base, iatMs: clock.now() + 120_000 })).ok).toBe(true);
      relayAhead = 400 * 24 * 3600_000; // nonsense: not believed
      await source.refresh();
      expect(source.clockOffsetMs?.()).toBeNull();
    });
  });

  it('refuses a tampered payload, alg none and garbage', async () => {
    const token = await issuer.issue(base);
    const [h, p, s] = token.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.sub = 'dev:mallory';
    expect(verifier.verify(`${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`)).toEqual({ ok: false, reason: 'signature' });
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'smurg-identity+jwt', kid: 'kid-1' })).toString('base64url');
    expect(verifier.verify(`${none}.${p}.${s}`)).toEqual({ ok: false, reason: 'header' });
    expect(verifier.verify('not-a-jwt')).toEqual({ ok: false, reason: 'malformed' });
    expect(verifier.verify(`${h}.${p}.${randomUUID()}`)).toEqual({ ok: false, reason: 'signature' });
  });
});

let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

function rejectedState(state: ConnectionState): boolean {
  return state.kind === 'rejected' || state.kind === 'closed' || state.kind === 'online';
}

describe('admission binds the token to the connection and the device', () => {
  it('refuses a token whose cnf was made for another device key', async () => {
    t = await createTestDaemon();
    // A relay API that asks for tokens committing to a random key instead of the device's real one.
    const honest = t.relay.apiFor({ userId: 'dev:amy', displayName: 'Amy' }, t.issuer);
    const lying: ConnectionRelay = {
      origin: honest.origin,
      me: () => honest.me(),
      createWebSocket: (url) => honest.createWebSocket(url),
      identityToken: (workspaceId) => honest.identityToken(workspaceId, identityCnf(randomBytes(32), randomBytes(32))),
    };
    const again = await t.connect({ userId: 'dev:amy', waitOnline: false, connection: { relay: lying } as never });
    const state = await waitForState(again.conn, rejectedState, { timeoutMs: 10_000 });
    expect(state).toMatchObject({ kind: 'rejected', reason: 'identity-invalid' });
    const audit = await t.ctx.audit.query({ limit: 50 });
    expect(audit.find((e) => e.action === 'auth.rejected')?.detail).toMatchObject({ why: 'cnf-mismatch' });
    expect(t.ctx.members.get('dev:amy')).toBeNull();
  });

  it("refuses a token for another user than the one the relay says opened the socket", async () => {
    t = await createTestDaemon();
    const amyApi = t.relay.apiFor({ userId: 'dev:amy', displayName: 'Amy' }, t.issuer);
    const bobApi = t.relay.apiFor({ userId: 'dev:bob', displayName: 'Bob' }, t.issuer);
    const mixed: ConnectionRelay = {
      origin: amyApi.origin,
      me: () => amyApi.me(),
      createWebSocket: (url) => amyApi.createWebSocket(url),
      identityToken: (workspaceId, commitment) => bobApi.identityToken(workspaceId, commitment),
    };
    const client = await t.connect({ userId: 'dev:amy', waitOnline: false, connection: { relay: mixed } as never });
    expect(await waitForState(client.conn, rejectedState, { timeoutMs: 10_000 })).toMatchObject({ kind: 'rejected', reason: 'identity-invalid' });
    expect((await t.ctx.audit.query({ limit: 50 })).find((e) => e.action === 'auth.rejected')?.detail).toMatchObject({ why: 'relay-user-mismatch' });
  });
});
