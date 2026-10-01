// The wrangler config is part of the contract: production values at the top level, localhost values only in
// env.dev (relay.md gotcha 25), and the Worker-first routes equal to the protocol's route table. Production is the
// shared relay on the Workers Free plan with Google login only, deployed with exactly this file's top level to the
// Cloudflare Custom Domain app.smurg.ai with workers.dev off (README.md「部署到 Cloudflare」; it was the workers.dev URL
// until 2026-10-01). scripts/deploy-relay.sh also deploys the other supported shape, workers.dev (a self-hosted
// relay's default: origin empty until the first deploy names it), and refuses anything else.
import { fileURLToPath } from 'node:url';
import { RELAY_CLIENT_SWEEP_MS, RELAY_HOST_TIMEOUT_MS, RELAY_WORKER_FIRST_PATTERNS } from '@smurg/protocol/relay';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { DEFAULT_RELAY_URL } from '../../../packages/cli/src/relay/default-relay.ts';
import { GOOGLE_ENDPOINTS, customDomainHost, productionConfigProblems, relayHostingOf, type ProductionConfigView } from '../scripts/deploy.ts';
import { RelayConfigError, loginOptionsFor, parseRelayConfig, type RelayVars } from '../src/lib/config.ts';

/** The shared relay's public origin (README.md「部署到 Cloudflare」). */
const SHARED_RELAY = 'https://app.smurg.ai';

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

  it('keeps production values at the top level: the custom domain app.smurg.ai only, no preview URLs, no dev login, no tap, Google only', () => {
    // Exactly one public hostname: the custom domain; workers.dev off (it answers 404 since 2026-10-01).
    expect(prod.workers_dev).toBe(false);
    expect(prod.routes).toEqual([{ pattern: 'app.smurg.ai', custom_domain: true }]);
    expect(prod.route).toBeUndefined();
    expect(prod.preview_urls).toBe(false);
    expect(prod.vars['DEV_LOGIN']).toBe('0');
    expect(prod.vars['RELAY_TAP_URL']).toBe('');
    expect(prod.vars['RELAY_ISSUER']).toBe(SHARED_RELAY);
    expect(prod.vars['ALLOWED_ORIGINS']).toBe(SHARED_RELAY);
    expect(Object.keys(prod.vars).filter((name) => name.startsWith('GITHUB_'))).toEqual([]);
    for (const [name, url] of Object.entries(GOOGLE_ENDPOINTS)) expect(prod.vars[name]).toBe(url);
    // The same rules scripts/deploy-relay.sh enforces before it deploys: the custom-domain shape.
    const view = prod as unknown as ProductionConfigView;
    expect(productionConfigProblems(view)).toEqual([]);
    expect(relayHostingOf(view)).toEqual({ hosting: { kind: 'custom-domain', host: 'app.smurg.ai', origin: SHARED_RELAY }, problems: [] });
    // The CLI's built-in relay is the relay this file deploys (a binary keeps its built-in relay forever).
    expect(DEFAULT_RELAY_URL).toBe(SHARED_RELAY);
  });

  it('the deploy preflight refuses a production config that is not the shared custom-domain / Google-only relay', () => {
    const base = prod as unknown as ProductionConfigView;
    const problems = (change: Partial<ProductionConfigView>, vars: Record<string, unknown> = {}): string[] =>
      productionConfigProblems({ ...base, ...change, vars: { ...base.vars, ...vars } });
    expect(problems({ preview_urls: true })).toHaveLength(1);
    expect(problems({}, { DEV_LOGIN: '1' })).toHaveLength(1);
    expect(problems({}, { RELAY_TAP_URL: 'http://127.0.0.1:9/tap' })).toHaveLength(1);
    expect(problems({}, { GITHUB_CLIENT_ID: 'abc' })).toHaveLength(1);
    expect(problems({}, { RELAY_ISSUER: 'http://app.smurg.ai', ALLOWED_ORIGINS: 'http://app.smurg.ai' })).toHaveLength(1);
    expect(problems({}, { ALLOWED_ORIGINS: '' })).toHaveLength(1);
    expect(problems({}, { GOOGLE_CLIENT_ID: 'not a client id' })).toHaveLength(1);
    expect(problems({}, { GOOGLE_TOKEN_URL: 'https://evil.example/token' })).toHaveLength(1);
    expect(problems({ migrations: [{ tag: 'v1' }] })).toHaveLength(1);
    // The custom-domain shape: the origin must be https://<that host>, known before any deploy (never empty).
    expect(problems({}, { RELAY_ISSUER: 'https://other.smurg.ai', ALLOWED_ORIGINS: 'https://other.smurg.ai' })).toHaveLength(1);
    expect(problems({}, { RELAY_ISSUER: '', ALLOWED_ORIGINS: '' })).toHaveLength(1);
    expect(problems({}, { RELAY_ISSUER: 'https://smurg-relay.x.workers.dev', ALLOWED_ORIGINS: 'https://smurg-relay.x.workers.dev' })).toHaveLength(1);
    // Exactly one hostname: no workers.dev next to the custom domain, no second route, no plain or zone-bound route.
    expect(problems({ workers_dev: true })).toHaveLength(1);
    const custom = { pattern: 'app.smurg.ai', custom_domain: true };
    expect(problems({ routes: [custom, { pattern: 'www.smurg.ai', custom_domain: true }] })).toHaveLength(1);
    expect(problems({ routes: [custom, 'app.smurg.ai/*'] })).toHaveLength(1);
    expect(problems({ routes: [] })).toHaveLength(1);
    expect(problems({ routes: undefined })).toHaveLength(1);
    expect(problems({ routes: [{ pattern: 'app.smurg.ai' }] })).toHaveLength(1);
    expect(problems({ routes: [{ pattern: 'app.smurg.ai/*', zone_name: 'smurg.ai' }] })).toHaveLength(1);
    expect(problems({ routes: [{ ...custom, zone_name: 'smurg.ai' }] })).toHaveLength(1);
    expect(problems({ routes: ['app.smurg.ai'] })).toHaveLength(1);
    expect(problems({ route: 'app.smurg.ai/*' })).toHaveLength(1);
    expect(problems({ workers_dev: undefined })).toHaveLength(1);
    for (const pattern of ['*.smurg.ai', 'APP.smurg.ai', 'app.smurg.ai/', 'app.smurg.ai:8443', 'smurg', 'app.smurg.ai.', 'relay.example.workers.dev', '10.0.0.1', 'relay.localhost']) {
      expect(problems({ routes: [{ pattern, custom_domain: true }] }).length, pattern).toBeGreaterThanOrEqual(1);
    }
  });

  it('the deploy preflight also accepts the workers.dev shape (a self-hosted relay) and nothing in between', () => {
    const base = prod as unknown as ProductionConfigView;
    const workersDev = (vars: Record<string, unknown>, change: Partial<ProductionConfigView> = {}): string[] =>
      productionConfigProblems({ ...base, workers_dev: true, routes: undefined, ...change, vars: { ...base.vars, ...vars } });
    const sub = 'https://smurg-relay.example-sub.workers.dev';
    // Before the first deploy (origin and client id empty), and afterwards (this Worker's workers.dev URL).
    expect(workersDev({ RELAY_ISSUER: '', ALLOWED_ORIGINS: '', GOOGLE_CLIENT_ID: '' })).toEqual([]);
    expect(workersDev({ RELAY_ISSUER: sub, ALLOWED_ORIGINS: sub })).toEqual([]);
    expect(relayHostingOf({ workers_dev: true })).toEqual({ hosting: { kind: 'workers-dev' }, problems: [] });
    expect(relayHostingOf({ workers_dev: true, routes: [] })).toEqual({ hosting: { kind: 'workers-dev' }, problems: [] });
    // workers.dev WITH a route or custom domain: two hostnames in front of the same Durable Objects.
    expect(workersDev({ RELAY_ISSUER: '', ALLOWED_ORIGINS: '' }, { routes: [{ pattern: 'app.smurg.ai', custom_domain: true }] })).toHaveLength(1);
    expect(workersDev({ RELAY_ISSUER: '', ALLOWED_ORIGINS: '' }, { route: 'relay.example.org/*' })).toHaveLength(1);
    // On workers.dev the origin must be this Worker's workers.dev URL (or still empty).
    expect(workersDev({ RELAY_ISSUER: SHARED_RELAY, ALLOWED_ORIGINS: SHARED_RELAY })).toHaveLength(1);
    expect(workersDev({ RELAY_ISSUER: 'https://other.example-sub.workers.dev', ALLOWED_ORIGINS: 'https://other.example-sub.workers.dev' })).toHaveLength(1);
    expect(workersDev({ RELAY_ISSUER: 'http://smurg-relay.x.workers.dev', ALLOWED_ORIGINS: 'http://smurg-relay.x.workers.dev' })).toHaveLength(1);
    expect(workersDev({ RELAY_ISSUER: sub, ALLOWED_ORIGINS: '' })).toHaveLength(1);
  });

  it('a custom domain is a plain lower-case hostname of two or more labels', () => {
    expect(customDomainHost('app.smurg.ai')).toBe('app.smurg.ai');
    expect(customDomainHost('relay.example.co.uk')).toBe('relay.example.co.uk');
    for (const text of ['', 'smurg', '*.smurg.ai', 'App.smurg.ai', 'app.smurg.ai.', 'app..smurg.ai', '-app.smurg.ai', 'app.smurg.ai/x', 'smurg-relay.sub.workers.dev', 'workers.dev', '127.0.0.1', 'app.localhost']) {
      expect(customDomainHost(text), text).toBeNull();
    }
  });

  it('enables the dev-only login and localhost origins only in env.dev', () => {
    expect(dev.vars['DEV_LOGIN']).toBe('1');
    expect(dev.vars['RELAY_TAP_URL']).toBe('');
    expect(String(dev.vars['RELAY_ISSUER'])).toMatch(/^http:\/\/localhost:8787$/);
    expect(String(dev.vars['ALLOWED_ORIGINS']).split(',')).toContain('http://localhost:5173');
  });

  it('env.dev does not inherit the production custom domain (wrangler dev would rewrite requests to app.smurg.ai)', () => {
    // Inherited, `wrangler dev --env dev` takes its request host from the first route (the dev login, gated to local
    // hostnames, would be off) and `wrangler deploy --env dev` would move app.smurg.ai to smurg-relay-dev.
    expect(dev.routes).toEqual([]);
    expect(dev.route).toBeUndefined();
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
