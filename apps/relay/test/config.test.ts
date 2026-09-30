// The wrangler config is part of the contract: production values at the top level, localhost values only in
// env.dev (relay.md gotcha 25), and the Worker-first routes equal to the protocol's route table. Production is the
// workers.dev deployment on the Workers Free plan with Google login only (README.md「部署到 Cloudflare」): its origin
// is empty until scripts/deploy-relay.sh writes the URL of the first deploy into RELAY_ISSUER / ALLOWED_ORIGINS.
import { fileURLToPath } from 'node:url';
import { RELAY_CLIENT_SWEEP_MS, RELAY_HOST_TIMEOUT_MS, RELAY_WORKER_FIRST_PATTERNS } from '@smurg/protocol/relay';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { GOOGLE_ENDPOINTS, productionConfigProblems, type ProductionConfigView } from '../scripts/deploy.ts';
import { RelayConfigError, loginOptionsFor, parseRelayConfig, type RelayVars } from '../src/lib/config.ts';

const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const prod = unstable_readConfig({ config: CONFIG, env: '' }, { hideWarnings: true });
const dev = unstable_readConfig({ config: CONFIG, env: 'dev' }, { hideWarnings: true });

describe('wrangler.jsonc', () => {
  it('pins the compatibility date verified in the research', () => {
    expect(prod.compatibility_date).toBe('2026-09-26');
    expect(dev.compatibility_date).toBe('2026-09-26');
  });

  it('declares WorkspaceDO and TransferDO as SQLite-backed Durable Objects in both environments', () => {
    for (const config of [prod, dev]) {
      const bindings: { name: string; class_name: string }[] = config.durable_objects.bindings;
      expect(bindings.map((b) => [b.name, b.class_name])).toEqual([
        ['WORKSPACE', 'WorkspaceDO'],
        ['TRANSFER', 'TransferDO'],
      ]);
    }
    expect(prod.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['WorkspaceDO', 'TransferDO'] }]);
  });

  it('serves the web SPA from ../web/dist and routes relay paths to the Worker first', () => {
    for (const config of [prod, dev]) {
      expect(config.assets?.directory).toMatch(/[/\\]web[/\\]dist$/);
      expect(config.assets?.not_found_handling).toBe('single-page-application');
      expect(config.assets?.run_worker_first).toEqual([...RELAY_WORKER_FIRST_PATTERNS]);
    }
  });

  it('keeps production values at the top level: workers.dev without preview URLs, no dev login, no tap, Google only', () => {
    expect(prod.workers_dev).toBe(true);
    expect(prod.preview_urls).toBe(false);
    expect(prod.vars['DEV_LOGIN']).toBe('0');
    expect(prod.vars['RELAY_TAP_URL']).toBe('');
    // Before the first deploy the origin is empty (fails closed); afterwards it is the workers.dev URL of this Worker.
    const issuer = String(prod.vars['RELAY_ISSUER']);
    expect(issuer === '' || /^https:\/\/smurg-relay\.[a-z0-9-]+(?:\.[a-z0-9-]+)?\.workers\.dev$/.test(issuer)).toBe(true);
    expect(prod.vars['ALLOWED_ORIGINS']).toBe(issuer);
    expect(Object.keys(prod.vars).filter((name) => name.startsWith('GITHUB_'))).toEqual([]);
    for (const [name, url] of Object.entries(GOOGLE_ENDPOINTS)) expect(prod.vars[name]).toBe(url);
    // The same rules scripts/deploy-relay.sh enforces before it deploys.
    expect(productionConfigProblems(prod as unknown as ProductionConfigView)).toEqual([]);
  });

  it('the deploy preflight refuses a production config that is not the workers.dev / Google-only relay', () => {
    const base = prod as unknown as ProductionConfigView;
    const problems = (change: Partial<ProductionConfigView>, vars: Record<string, unknown> = {}): string[] =>
      productionConfigProblems({ ...base, ...change, vars: { ...base.vars, ...vars } });
    expect(problems({ workers_dev: false })).toHaveLength(1);
    expect(problems({ preview_urls: true })).toHaveLength(1);
    expect(problems({}, { DEV_LOGIN: '1' })).toHaveLength(1);
    expect(problems({}, { RELAY_TAP_URL: 'http://127.0.0.1:9/tap' })).toHaveLength(1);
    expect(problems({}, { GITHUB_CLIENT_ID: 'abc' })).toHaveLength(1);
    expect(problems({}, { RELAY_ISSUER: 'http://smurg-relay.x.workers.dev', ALLOWED_ORIGINS: 'http://smurg-relay.x.workers.dev' })).toHaveLength(1);
    expect(problems({}, { RELAY_ISSUER: 'https://smurg-relay.x.workers.dev', ALLOWED_ORIGINS: '' })).toHaveLength(1);
    expect(problems({}, { GOOGLE_CLIENT_ID: 'not a client id' })).toHaveLength(1);
    expect(problems({}, { GOOGLE_TOKEN_URL: 'https://evil.example/token' })).toHaveLength(1);
    expect(problems({ migrations: [{ tag: 'v1' }] })).toHaveLength(1);
  });

  it('enables the dev-only login and localhost origins only in env.dev', () => {
    expect(dev.vars['DEV_LOGIN']).toBe('1');
    expect(dev.vars['RELAY_TAP_URL']).toBe('');
    expect(String(dev.vars['RELAY_ISSUER'])).toMatch(/^http:\/\/localhost:8787$/);
    expect(String(dev.vars['ALLOWED_ORIGINS']).split(',')).toContain('http://localhost:5173');
  });

  it('repeats every production var in env.dev (vars are not inherited); development may add a GitHub OAuth app', () => {
    const devOnly = Object.keys(dev.vars).filter((name) => !(name in prod.vars));
    expect(Object.keys(prod.vars).filter((name) => !(name in dev.vars))).toEqual([]);
    expect(devOnly.every((name) => name.startsWith('GITHUB_'))).toBe(true);
  });

  it('uses the protocol liveness constants in both environments', () => {
    for (const config of [prod, dev]) {
      expect(Number(config.vars['HOST_TIMEOUT_MS'])).toBe(RELAY_HOST_TIMEOUT_MS);
      expect(Number(config.vars['CLIENT_SWEEP_MS'])).toBe(RELAY_CLIENT_SWEEP_MS);
    }
  });

  it('declares only the signing key as a required secret; OAuth client secrets are optional', () => {
    for (const config of [prod, dev]) expect(config.secrets?.required).toEqual(['RELAY_SIGNING_KEY']);
  });

  it('production fails closed until its origin is set, then parses: Google on once its id and secret are set, GitHub and dev login off', () => {
    const vars = prod.vars as RelayVars;
    if (vars.RELAY_ISSUER === '') expect(() => parseRelayConfig(vars)).toThrow(RelayConfigError);
    // What scripts/deploy-relay.sh writes (URL, client id) plus the GOOGLE_CLIENT_SECRET the owner puts: made-up values.
    const url = vars.RELAY_ISSUER || 'https://smurg-relay.example-subdomain.workers.dev';
    const deployed: RelayVars = {
      ...vars,
      RELAY_ISSUER: url,
      ALLOWED_ORIGINS: url,
      GOOGLE_CLIENT_ID: vars.GOOGLE_CLIENT_ID || '123-test.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'not-a-real-secret',
    };
    const production = parseRelayConfig(deployed);
    expect(production).toMatchObject({ issuer: url, secureCookies: true, devLoginFlag: false, tapUrl: null });
    expect([...production.allowedOrigins]).toEqual([url]);
    expect(production.github).toBeNull();
    expect(production.google).toMatchObject({ authorizeUrl: GOOGLE_ENDPOINTS.GOOGLE_AUTHORIZE_URL, issuers: ['https://accounts.google.com', 'accounts.google.com'] });
    expect(loginOptionsFor(production, new URL(`${url}/api/login-options`))).toEqual({ providers: { github: false, google: true }, dev: false });
    // Without the secret (or the id) Google stays off: the login route answers 503 instead of calling Google.
    expect(parseRelayConfig({ ...deployed, GOOGLE_CLIENT_SECRET: '' }).google).toBeNull();
    const development = parseRelayConfig(dev.vars as RelayVars);
    expect(development).toMatchObject({ issuer: 'http://localhost:8787', secureCookies: false, devLoginFlag: true, tapUrl: null });
  });
});
