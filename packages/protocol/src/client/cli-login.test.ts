import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cliLoginConfirmCode, createCliLoginRequest, createPkceVerifier, parseCliCallback, pkceChallenge } from './cli-login.ts';

describe('PKCE', () => {
  it('verifier matches RFC 7636 and the challenge is base64url(SHA-256(verifier)) (cross-checked with node:crypto)', () => {
    const verifier = createPkceVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(pkceChallenge(verifier)).toBe(expected);
    expect(pkceChallenge(verifier)).toHaveLength(43);
    expect(createPkceVerifier()).not.toBe(verifier);
  });

  it('RFC 7636 appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('refuses malformed verifiers', () => {
    expect(() => pkceChallenge('short')).toThrow(RangeError);
    expect(() => pkceChallenge(`${'a'.repeat(43)} `)).toThrow(RangeError);
  });
});

describe('createCliLoginRequest', () => {
  it('builds the relay start URL with port, state and challenge', () => {
    const request = createCliLoginRequest({ relayUrl: 'https://smurg.app', port: 53682, provider: 'github' });
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe('https://smurg.app/auth/cli/start');
    expect(url.searchParams.get('port')).toBe('53682');
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge(request.codeVerifier));
    expect(url.searchParams.get('provider')).toBe('github');
    expect(request.state).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(request.redirectUri).toBe('http://127.0.0.1:53682/callback');
    // The verifier never appears in the URL.
    expect(request.url).not.toContain(request.codeVerifier);
  });

  it('dev provider takes a user name; everything else is validated', () => {
    const request = createCliLoginRequest({ relayUrl: 'http://localhost:8787', port: 40000, provider: 'dev', user: 'amy' });
    expect(new URL(request.url).searchParams.get('user')).toBe('amy');
    expect(() => createCliLoginRequest({ relayUrl: 'http://example.com', port: 40000 })).toThrow(); // http only for localhost
    expect(() => createCliLoginRequest({ relayUrl: 'https://smurg.app', port: 80 })).toThrow(RangeError);
    expect(() => createCliLoginRequest({ relayUrl: 'https://smurg.app', port: 40000, user: 'amy' })).toThrow(RangeError);
    expect(() => createCliLoginRequest({ relayUrl: 'https://smurg.app', port: 40000, provider: 'dev', user: 'a b' })).toThrow(RangeError);
  });
});

describe('parseCliCallback', () => {
  const state = 'state_0123456789abcdef';

  it('accepts the matching state and a code', () => {
    expect(parseCliCallback(`/callback?code=abc.def-ghi_jkl&state=${state}`, state)).toEqual({ ok: true, code: 'abc.def-ghi_jkl' });
    expect(parseCliCallback(new URL(`http://127.0.0.1:4000/callback?state=${state}&code=x`), state)).toEqual({ ok: true, code: 'x' });
  });

  it('checks the state before believing anything else (CSRF on the loopback port)', () => {
    expect(parseCliCallback('/callback?code=abc&state=other_state_0123456', state)).toEqual({ ok: false, error: 'state_mismatch' });
    expect(parseCliCallback('/callback?code=abc', state)).toEqual({ ok: false, error: 'state_mismatch' });
    expect(parseCliCallback(`/callback?code=abc&state=${state}&state=${state}`, state)).toEqual({ ok: false, error: 'state_mismatch' });
    expect(parseCliCallback(`/callback?error=access_denied&state=nope_nope_nope_nope`, state)).toEqual({ ok: false, error: 'state_mismatch' });
  });

  it('reports the relay error, and refuses other paths, missing or duplicate codes, odd characters', () => {
    expect(parseCliCallback(`/callback?error=access_denied&state=${state}`, state)).toEqual({ ok: false, error: 'access_denied' });
    expect(parseCliCallback(`/callback?error=%3Cscript%3E&state=${state}`, state)).toEqual({ ok: false, error: 'login_failed' });
    expect(parseCliCallback(`/other?code=abc&state=${state}`, state)).toEqual({ ok: false, error: 'bad_callback' });
    expect(parseCliCallback(`/callback?state=${state}`, state)).toEqual({ ok: false, error: 'bad_callback' });
    expect(parseCliCallback(`/callback?code=a&code=b&state=${state}`, state)).toEqual({ ok: false, error: 'bad_callback' });
    expect(parseCliCallback(`/callback?code=a%20b&state=${state}`, state)).toEqual({ ok: false, error: 'bad_callback' });
  });

  it('requires a well-formed expected state', () => {
    expect(() => parseCliCallback('/callback?code=a&state=x', 'x')).toThrow(RangeError);
  });
});

describe('cliLoginConfirmCode (review SEC-E-03)', () => {
  it('computes the relay confirmation page code (the relay test vectors of apps/relay cliConfirmCode)', () => {
    expect(cliLoginConfirmCode('cli-state-0123456789')).toBe('ZX27-UPQ2');
    expect(cliLoginConfirmCode('abcdefghijklmnop')).toBe('CDG7-3U2M');
    expect(cliLoginConfirmCode('A'.repeat(32))).toBe('MDAJ-JDLN');
  });

  it('is part of every login request, derived from its state', () => {
    const request = createCliLoginRequest({ relayUrl: 'https://relay.example', port: 40000 });
    expect(request.confirmCode).toBe(cliLoginConfirmCode(request.state));
    expect(request.confirmCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });
});
