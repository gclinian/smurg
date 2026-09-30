import { describe, expect, it } from 'vitest';
import { relayLoginOptionsSchema } from './http.ts';
import { RELAY_AUTH_PROVIDERS } from './routes.ts';

describe('relayLoginOptionsSchema (GET /api/login-options)', () => {
  it('accepts every combination of providers and dev', () => {
    for (const github of [false, true]) {
      for (const google of [false, true]) {
        for (const dev of [false, true]) {
          const body = { providers: { github, google }, dev };
          expect(relayLoginOptionsSchema.parse(body)).toEqual(body);
        }
      }
    }
  });

  it('has exactly one boolean per supported OAuth provider', () => {
    expect(Object.keys(relayLoginOptionsSchema.shape).sort()).toEqual(['dev', 'providers']);
    expect(Object.keys(relayLoginOptionsSchema.shape.providers.shape).sort()).toEqual([...RELAY_AUTH_PROVIDERS].sort());
  });

  it('rejects unknown fields at either level (e.g. a leaked client id)', () => {
    const ok = { providers: { github: true, google: false }, dev: false };
    for (const bad of [
      { ...ok, clientId: 'gh-test-client' },
      { ...ok, providers: { ...ok.providers, githubClientId: 'gh-test-client' } },
      { ...ok, providers: { ...ok.providers, gitlab: true } },
      { ...ok, providers: { ...ok.providers, dev: true } },
    ]) {
      expect(relayLoginOptionsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects missing fields and non-boolean values', () => {
    for (const bad of [
      {},
      { providers: { github: true, google: true } },
      { providers: { github: true }, dev: false },
      { dev: true },
      { providers: { github: 'true', google: false }, dev: false },
      { providers: { github: true, google: 1 }, dev: false },
      { providers: { github: true, google: false }, dev: null },
      { providers: [true, false], dev: false },
      null,
      'dev',
    ]) {
      expect(relayLoginOptionsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
