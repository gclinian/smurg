// scripts/deploy-relay.sh (apps/relay/scripts/deploy.ts) without a Cloudflare account: its argument rules, the edit it
// makes to wrangler.jsonc, how it reads wrangler's output (formats taken from wrangler 4.142's source), and its checks
// from outside against a LOCAL relay configured like production (Google on with a made-up client, no dev login, the
// SPA with the _headers CSP). Both hostname shapes are covered: the committed config (the shared relay on the custom
// domain app.smurg.ai) and the workers.dev shape a self-hosted relay starts from. Nothing here deploys, logs in or
// touches a real secret.
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STAND_IN_TEXT, webDistProblem } from '../scripts/ensure-web-dist.ts';
import { startLocalRelay, type LocalRelay } from '../test-support/index.ts';
import {
  CHECK_NAMES,
  CUSTOM_DOMAIN_TARGET_SUFFIX,
  DeployError,
  GOOGLE_ENDPOINTS,
  OWNER_COMMANDS,
  RELAY_DIR,
  WRANGLER_CONFIG,
  checkRelay,
  deployTargets,
  deployedTargetProblem,
  hostnameOccupant,
  localWebAssets,
  main,
  parseDeployArgs,
  parseSecretList,
  parseWhoami,
  parseWranglerJsonc,
  setProductionVars,
  webAssetsOf,
  workersDevOrigin,
  workersDevTarget,
  type RelayHosting,
} from '../scripts/deploy.ts';

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const URL_ = 'https://smurg-relay.example-sub.workers.dev';
const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
/** The committed config's custom domain (the shared relay). */
const CUSTOM_HOST = 'app.smurg.ai';
const CUSTOM_URL = `https://${CUSTOM_HOST}`;
const CUSTOM: RelayHosting = { kind: 'custom-domain', host: CUSTOM_HOST, origin: CUSTOM_URL };

/**
 * The committed config turned into the workers.dev shape a self-hosted relay starts from (README "Self-hosting on workers.dev"):
 * "workers_dev": true, the "routes" line deleted, origin and client id empty.
 */
function asWorkersDevBeforeFirstDeploy(text: string): string {
  const customDomain = `  "workers_dev": false,\n  "routes": [{ "pattern": "${CUSTOM_HOST}", "custom_domain": true }],\n`;
  expect(text).toContain(customDomain);
  return setProductionVars(text.replace(customDomain, '  "workers_dev": true,\n'), { RELAY_ISSUER: '', ALLOWED_ORIGINS: '', GOOGLE_CLIENT_ID: '' });
}

describe('arguments', () => {
  it('deploy by default; --url must be this Worker on workers.dev or a custom domain; --google-client-id must look like a Google client id', () => {
    expect(parseDeployArgs([])).toEqual({ mode: 'deploy', waitSeconds: 180 });
    expect(parseDeployArgs(['--url', `${URL_}/`, '--google-client-id', CLIENT_ID])).toEqual({ mode: 'deploy', url: URL_, googleClientId: CLIENT_ID, waitSeconds: 180 });
    // A custom-domain origin is a valid --url too; whether it is THE custom domain is decided against wrangler.jsonc.
    expect(parseDeployArgs(['--url', `${CUSTOM_URL}/`])).toEqual({ mode: 'deploy', url: CUSTOM_URL, waitSeconds: 180 });
    expect(parseDeployArgs(['--url', 'https://smurg.app'])).toEqual({ mode: 'deploy', url: 'https://smurg.app', waitSeconds: 180 });
    expect(parseDeployArgs(['--dry-run', '--wait', '5'])).toEqual({ mode: 'dry-run', waitSeconds: 5 });
    expect(parseDeployArgs(['--check', 'http://127.0.0.1:8787'])).toEqual({ mode: 'check', url: 'http://127.0.0.1:8787', waitSeconds: 20 });
    expect(parseDeployArgs(['--check', `${CUSTOM_URL}/`])).toEqual({ mode: 'check', url: CUSTOM_URL, waitSeconds: 20 });
    // --web-dist (the build --check compares the live web app with) belongs to --check; --take-over-hostname to a deploy.
    expect(parseDeployArgs(['--check', CUSTOM_URL, '--web-dist', '/tmp/web-build'])).toEqual({ mode: 'check', url: CUSTOM_URL, waitSeconds: 20, webDist: '/tmp/web-build' });
    expect(parseDeployArgs(['--take-over-hostname'])).toEqual({ mode: 'deploy', waitSeconds: 180, takeOverHostname: true });
    expect(parseDeployArgs(['--help'])).toBe('help');
    const refused = (argv: string[]): number => {
      try {
        parseDeployArgs(argv);
      } catch (error) {
        if (error instanceof DeployError) return error.exitCode;
        throw error;
      }
      return 0;
    };
    expect(refused(['--url', 'http://smurg-relay.x.workers.dev'])).toBe(2);
    expect(refused(['--url', 'https://other.x.workers.dev'])).toBe(2);
    expect(refused(['--url', `${URL_}/path`])).toBe(2);
    expect(refused(['--url', `${CUSTOM_URL}/path`])).toBe(2);
    expect(refused(['--url', `http://${CUSTOM_HOST}`])).toBe(2);
    expect(refused(['--url', `${CUSTOM_URL}:8443`])).toBe(2);
    expect(refused(['--url', 'https://localhost'])).toBe(2);
    expect(refused(['--url', 'http://localhost:8787'])).toBe(2);
    expect(refused(['--url', 'https://10.0.0.1'])).toBe(2);
    expect(refused(['--url', 'https://intranet'])).toBe(2);
    expect(refused(['--google-client-id', 'nope'])).toBe(2);
    expect(refused(['--dry-run', '--check', URL_])).toBe(2);
    expect(refused(['--check', 'http://relay.example.com'])).toBe(2);
    expect(refused(['--check'])).toBe(2);
    expect(refused(['--wait', 'soon'])).toBe(2);
    expect(refused(['--deploy-everything'])).toBe(2);
    expect(refused(['--web-dist', '/tmp/web-build'])).toBe(2);
    expect(refused(['--dry-run', '--web-dist', '/tmp/web-build'])).toBe(2);
    expect(refused(['--check', CUSTOM_URL, '--take-over-hostname'])).toBe(2);
    expect(refused(['--check', CUSTOM_URL, '--web-dist'])).toBe(2);
  });

  it('the owner commands keep secrets out of argv and the screen and target the production (top-level) Worker', () => {
    expect(OWNER_COMMANDS.signingKey).toBe('node apps/relay/scripts/signing-key.ts | pnpm --filter @smurg/relay exec wrangler secret put RELAY_SIGNING_KEY --env=""');
    // scripts/env.sh sets CI=true, which makes wrangler refuse its interactive (no-echo) prompt.
    expect(OWNER_COMMANDS.googleSecret).toBe('CI=false pnpm --filter @smurg/relay exec wrangler secret put GOOGLE_CLIENT_SECRET --env=""');
    expect(OWNER_COMMANDS.login).toBe('CI=false pnpm --filter @smurg/relay exec wrangler login');
  });
});

describe('wrangler.jsonc edit', () => {
  const original = readFileSync(WRANGLER_CONFIG, 'utf8');

  it('sets RELAY_ISSUER, ALLOWED_ORIGINS and GOOGLE_CLIENT_ID in the top-level vars only; comments and env.dev stay', () => {
    const edited = setProductionVars(original, { RELAY_ISSUER: URL_, ALLOWED_ORIGINS: URL_, GOOGLE_CLIENT_ID: CLIENT_ID });
    const before = parseWranglerJsonc(original);
    const after = parseWranglerJsonc(edited);
    expect(after.vars).toEqual({ ...before.vars, RELAY_ISSUER: URL_, ALLOWED_ORIGINS: URL_, GOOGLE_CLIENT_ID: CLIENT_ID });
    expect(after['env']).toEqual(before['env']);
    const changed = edited.split('\n').filter((line, i) => line !== original.split('\n')[i]);
    expect(changed.map((line) => line.trim()).sort()).toEqual(
      [`"ALLOWED_ORIGINS": "${URL_}",`, `"GOOGLE_CLIENT_ID": "${CLIENT_ID}",`, `"RELAY_ISSUER": "${URL_}",`].sort(),
    );
    expect(edited.split('\n').filter((line) => line.trim().startsWith('//'))).toEqual(original.split('\n').filter((line) => line.trim().startsWith('//')));
    // Idempotent: the same values again change nothing.
    expect(setProductionVars(edited, { RELAY_ISSUER: URL_, ALLOWED_ORIGINS: URL_, GOOGLE_CLIENT_ID: CLIENT_ID })).toBe(edited);
  });

  it('wrangler itself reads the edited file with the new production values and the old development ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smurg-deploy-config-'));
    try {
      const path = join(dir, 'wrangler.jsonc');
      writeFileSync(path, setProductionVars(original, { RELAY_ISSUER: URL_, ALLOWED_ORIGINS: URL_ }));
      const { unstable_readConfig } = await import('wrangler');
      const prod = unstable_readConfig({ config: path, env: '' }, { hideWarnings: true });
      const dev = unstable_readConfig({ config: path, env: 'dev' }, { hideWarnings: true });
      expect(prod.vars).toMatchObject({ RELAY_ISSUER: URL_, ALLOWED_ORIGINS: URL_, DEV_LOGIN: '0' });
      expect(dev.vars).toMatchObject({ RELAY_ISSUER: 'http://localhost:8787', DEV_LOGIN: '1' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file whose top-level vars do not have the line exactly once', () => {
    const withoutClientId = original.replace(/^ {4}"GOOGLE_CLIENT_ID": "[^"]*",\n/m, '');
    expect(withoutClientId).not.toBe(original);
    expect(() => setProductionVars(withoutClientId, { GOOGLE_CLIENT_ID: CLIENT_ID })).toThrow(DeployError);
    expect(() => setProductionVars('{ "name": "x" }', { RELAY_ISSUER: URL_ })).toThrow(DeployError);
  });
});

describe("reading wrangler's output", () => {
  it('whoami --json: logged in with accounts, or not logged in', () => {
    const json = JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'owner@example.com', accounts: [{ id: 'a1b2', name: "Owner's Account" }], tokenPermissions: [] }, null, 2);
    expect(parseWhoami(json, 0)).toEqual({ loggedIn: true, accounts: [{ id: 'a1b2', name: "Owner's Account" }] });
    expect(parseWhoami('{\n  "loggedIn": false\n}', 1)).toEqual({ loggedIn: false });
    expect(parseWhoami('', 1)).toEqual({ loggedIn: false });
    expect(parseWhoami('Not logged in.', 0)).toEqual({ loggedIn: false });
  });

  it('secret list --format json: names, or the Worker does not exist yet', () => {
    expect(parseSecretList('[\n  {\n    "name": "RELAY_SIGNING_KEY",\n    "type": "secret_text"\n  }\n]\n', '', 0)).toEqual({ kind: 'names', names: ['RELAY_SIGNING_KEY'] });
    expect(parseSecretList('[]', '', 0)).toEqual({ kind: 'names', names: [] });
    const notFound = '✘ [ERROR] Worker "smurg-relay" not found.\n\nIf this is a new Worker, run `wrangler deploy` first to create it.';
    expect(parseSecretList('', notFound, 1)).toEqual({ kind: 'no-worker' });
    expect(parseSecretList('', 'Authentication error', 1)).toMatchObject({ kind: 'error' });
  });

  it('deploy output file: the workers.dev target of the last deploy entry', () => {
    const ndjson = [
      JSON.stringify({ type: 'wrangler-session', version: 1, wrangler_version: '4.142.0' }),
      JSON.stringify({ type: 'deploy', version: 1, worker_name: 'smurg-relay', version_id: 'v1', targets: [URL_] }),
      '',
    ].join('\n');
    expect(deployTargets(ndjson)).toEqual([URL_]);
    expect(workersDevTarget(deployTargets(ndjson), 'smurg-relay')).toBe(URL_);
    expect(workersDevTarget(['relay.example.com/*', URL_], 'smurg-relay')).toBe(URL_);
    expect(workersDevTarget(['https://other.example-sub.workers.dev'], 'smurg-relay')).toBeNull();
    expect(deployTargets('not json\n')).toEqual([]);
    expect(workersDevOrigin('https://SMURG-RELAY.Example-Sub.workers.dev')).toBe(URL_);
    // The workers.dev shape: the target must be this Worker's workers.dev URL, and that URL.
    expect(deployedTargetProblem([URL_], { kind: 'workers-dev' }, 'smurg-relay', URL_)).toBeNull();
    expect(deployedTargetProblem(['https://smurg-relay.renamed-sub.workers.dev'], { kind: 'workers-dev' }, 'smurg-relay', URL_)).toContain('https://smurg-relay.renamed-sub.workers.dev');
    expect(deployedTargetProblem([`${CUSTOM_HOST}${CUSTOM_DOMAIN_TARGET_SUFFIX}`], { kind: 'workers-dev' }, 'smurg-relay', URL_)).not.toBeNull();
  });

  it('deploy output file: a custom domain is "<host> (custom domain)", without a scheme, and nothing else may be public', () => {
    const target = `${CUSTOM_HOST} (custom domain)`;
    expect(`${CUSTOM_HOST}${CUSTOM_DOMAIN_TARGET_SUFFIX}`).toBe(target);
    const ndjson = [
      JSON.stringify({ type: 'wrangler-session', version: 1, wrangler_version: '4.142.0' }),
      JSON.stringify({ type: 'deploy', version: 1, worker_name: 'smurg-relay', version_id: 'v2', targets: [target] }),
      '',
    ].join('\n');
    expect(deployTargets(ndjson)).toEqual([target]);
    expect(deployedTargetProblem(deployTargets(ndjson), CUSTOM, 'smurg-relay', CUSTOM_URL)).toBeNull();
    // Missing (no target: wrangler skipped the custom domain), another host, a zone-bound or plain route instead.
    expect(deployedTargetProblem([], CUSTOM, 'smurg-relay', CUSTOM_URL)).toContain(target);
    expect(deployedTargetProblem(['other.smurg.ai (custom domain)'], CUSTOM, 'smurg-relay', CUSTOM_URL)).toContain(target);
    expect(deployedTargetProblem([`${CUSTOM_HOST} (custom domain - zone name: smurg.ai)`], CUSTOM, 'smurg-relay', CUSTOM_URL)).not.toBeNull();
    expect(deployedTargetProblem([CUSTOM_HOST], CUSTOM, 'smurg-relay', CUSTOM_URL)).not.toBeNull();
    expect(deployedTargetProblem([CUSTOM_URL], CUSTOM, 'smurg-relay', CUSTOM_URL)).not.toBeNull();
    // workers.dev still on next to the custom domain: a second public hostname.
    expect(deployedTargetProblem([URL_, target], CUSTOM, 'smurg-relay', CUSTOM_URL)).toContain('workers.dev');
  });

  it("the formats above are wrangler 4.142's own: renderRoute's suffix, and https:// only for workers.dev targets", () => {
    const pkg = JSON.parse(readFileSync(join(RELAY_DIR, 'node_modules', 'wrangler', 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe('4.142.0');
    const source = readFileSync(join(RELAY_DIR, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js'), 'utf8');
    expect(source).toContain(`result += \`${CUSTOM_DOMAIN_TARGET_SUFFIX}\`;`);
    expect(source).toContain('(target.endsWith("workers.dev") ? "https://" : "") + target');
    expect(source).toMatch(/writeOutput\(\{\s*type: "deploy",\s*version: 1,[^}]*targets: result\.targets,/);
  });

  it("why the script looks before it deploys a custom domain: wrangler 4.142 run without a terminal or under CI takes the hostname over without asking", () => {
    const source = readFileSync(join(RELAY_DIR, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js'), 'utf8');
    // publishCustomDomains: stdout not a terminal → override another Worker's custom domain and an existing DNS record.
    expect(source).toMatch(/if \(!process\.stdout\.isTTY\) \{\s*options\.override_existing_origin = true;\s*options\.override_existing_dns_record = true;/);
    // On a terminal it asks through confirm(), whose answer under CI=true (scripts/env.sh) is the fallback: yes.
    expect(source).toMatch(/async function confirm2\(text, \{ defaultValue = true, fallbackValue = true \} = \{\}\) \{\s*if \(isNonInteractiveOrCI\(\)\) \{/);
    expect(source).toMatch(/function isNonInteractiveOrCI\(\) \{\s*return !isInteractive\(\) \|\| import_ci_info\.default\.isCI;/);
  });
});

/**
 * A web build's shape (what check-web-dist accepts) with the real _headers of apps/web/public. `entry` stands for the
 * content-hashed name Vite gives the entry script: another build, another name.
 */
function fakeWebBuild(dir: string, name = 'built', entry = 'index-test.js'): string {
  const built = join(dir, name);
  mkdirSync(join(built, 'assets'), { recursive: true });
  writeFileSync(join(built, 'index.html'), `<!doctype html><html><head><title>smurg</title><script type="module" crossorigin src="/assets/${entry}"></script></head><body><div id="root"></div></body></html>\n`);
  writeFileSync(join(built, 'assets', entry), 'export {};\n');
  copyFileSync(join(REPO_ROOT, 'apps', 'web', 'public', '_headers'), join(built, '_headers'));
  return built;
}

describe('which web build a relay serves: the content-hashed /assets/ files of its index.html', () => {
  it('reads every /assets/ file an index.html loads (as vite writes it), sorted, each once', () => {
    // The shape of a real apps/web/dist/index.html (the live one on 2026-10-01).
    const index = [
      '<!doctype html>',
      '<html lang="zh-Hant-TW">',
      '  <head>',
      '    <link rel="icon" href="data:," />',
      '    <script type="module" crossorigin src="/assets/index-B6XB8O73.js"></script>',
      '    <link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-BpQH8Ho1.js">',
      '    <link rel="stylesheet" crossorigin href="/assets/index-N4h0_T9z.css">',
      '  </head>',
      '  <body><div id="root"></div></body>',
      '</html>',
    ].join('\n');
    expect(webAssetsOf(index)).toEqual(['/assets/index-B6XB8O73.js', '/assets/index-N4h0_T9z.css', '/assets/rolldown-runtime-BpQH8Ho1.js']);
    expect(webAssetsOf(`${index}\n<script type="module" src="/assets/index-B6XB8O73.js"></script>`)).toHaveLength(3);
    expect(webAssetsOf(`<p>${STAND_IN_TEXT}</p>`)).toEqual([]);
  });

  it('a local web build: only a real one counts (not the development stand-in, not a missing directory)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smurg-deploy-assets-'));
    try {
      expect(await localWebAssets(fakeWebBuild(dir))).toEqual(['/assets/index-test.js']);
      const standIn = join(dir, 'stand-in');
      mkdirSync(standIn);
      writeFileSync(join(standIn, '.smurg-stand-in'), 'stand-in\n');
      writeFileSync(join(standIn, 'index.html'), `<!doctype html><p>${STAND_IN_TEXT}</p>\n`);
      expect(await localWebAssets(standIn)).toBeNull();
      expect(await localWebAssets(join(dir, 'missing'))).toBeNull();
      // A build check-web-dist refuses for its headers (the repo's apps/web/dist of 2026-10-01 16:45, from before the
      // HSTS line) still says which files it loads: --check compares it instead of silently skipping the comparison.
      const older = fakeWebBuild(dir, 'older', 'index-older.js');
      writeFileSync(join(older, '_headers'), readFileSync(join(older, '_headers'), 'utf8').replace(/^.*Strict-Transport-Security.*\n/m, ''));
      expect(webDistProblem(older)).toBe('no-hsts');
      expect(await localWebAssets(older)).toEqual(['/assets/index-older.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checks from outside (a local relay configured like production)', () => {
  let dirs: string | undefined;
  let built: string;
  let production: LocalRelay | undefined;
  let development: LocalRelay | undefined;

  beforeAll(async () => {
    dirs = mkdtempSync(join(tmpdir(), 'smurg-deploy-web-'));
    built = fakeWebBuild(dirs);
    // The development stand-in page (scripts/ensure-web-dist.ts): no build, no _headers.
    const standIn = join(dirs, 'stand-in');
    mkdirSync(standIn);
    writeFileSync(join(standIn, 'index.html'), `<!doctype html><p>${STAND_IN_TEXT}</p>\n`);
    production = await startLocalRelay({
      webDist: built,
      vars: { DEV_LOGIN: '0', GOOGLE_CLIENT_ID: CLIENT_ID, ...GOOGLE_ENDPOINTS },
      secrets: { GOOGLE_CLIENT_SECRET: 'not-a-real-secret' },
    });
    // The development relay: dev login on, no Google, and the stand-in page instead of a web build.
    development = await startLocalRelay({ webDist: standIn });
  }, 120_000);

  afterAll(async () => {
    await production?.stop();
    await development?.stop();
    if (dirs) rmSync(dirs, { recursive: true, force: true });
  });

  it('a production-like relay passes every check: healthz, login options, JWKS, SPA + CSP, the Google redirect', async () => {
    const results = await checkRelay((production as LocalRelay).origin, { expectGoogle: true, googleClientId: CLIENT_ID });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toHaveLength(6);
  });

  it('a relay that is not production fails the checks that matter, each with a reason', async () => {
    const results = await checkRelay((development as LocalRelay).origin, { expectGoogle: true });
    const failed = Object.fromEntries(results.filter((r) => !r.ok).map((r) => [r.name, r.detail]));
    expect(Object.keys(failed).sort()).toEqual(['GET /api/login-options', 'GET /auth/google/login', 'GET /join/... (SPA deep link and CSP)', 'GET / (web app and CSP)'].sort());
    expect(failed['GET /api/login-options']).toContain('the development login must be off in production');
    expect(failed['GET / (web app and CSP)']).toContain('this is the development stand-in page, not a web build');
    // The production relay with a different expected client id, and Google expected off (the state before its secret).
    const wrongId = await checkRelay((production as LocalRelay).origin, { expectGoogle: true, googleClientId: 'other-123.apps.googleusercontent.com' });
    expect(wrongId.filter((r) => !r.ok).map((r) => r.name)).toEqual(['GET /auth/google/login']);
    const googleOff = await checkRelay((production as LocalRelay).origin, { expectGoogle: false });
    expect(googleOff.filter((r) => !r.ok).map((r) => r.name).sort()).toEqual(['GET /api/login-options', 'GET /auth/google/login'].sort());
  });

  it('the live web app must be the expected build: the same /assets/ files, else both lists and what to do', async () => {
    const origin = (production as LocalRelay).origin;
    const same = await checkRelay(origin, { expectGoogle: true, googleClientId: CLIENT_ID, webAssets: ['/assets/index-test.js'] });
    expect(same.filter((r) => !r.ok)).toEqual([]);
    expect(same.map((r) => r.name)).toContain(CHECK_NAMES.webBuild);
    // The relay still serves an older build than the one expected (as app.smurg.ai served 7a690c9's after cb99aa0).
    const other = await checkRelay(origin, { expectGoogle: true, googleClientId: CLIENT_ID, webAssets: ['/assets/index-newer.js'] });
    const failed = other.filter((r) => !r.ok);
    expect(failed.map((r) => r.name)).toEqual([CHECK_NAMES.webBuild]);
    expect(failed[0]?.detail).toContain('/assets/index-test.js');
    expect(failed[0]?.detail).toContain('/assets/index-newer.js');
    expect(failed[0]?.detail).toContain('scripts/deploy-relay.sh');
    // The stand-in page loads nothing from /assets/.
    const standIn = await checkRelay((development as LocalRelay).origin, { expectGoogle: true, webAssets: ['/assets/index-test.js'] });
    expect(standIn.find((r) => r.name === CHECK_NAMES.webBuild)?.detail).toContain('(no /assets/ files)');
  });

  it('a custom domain must answer http:// with a permanent redirect to the same https:// URL; workers.dev and local relays are not asked', async () => {
    const host = 'relay.example.org';
    const local = (production as LocalRelay).origin;
    // https://relay.example.org is the production-like relay; http://relay.example.org answers as `plain` says.
    const via = (plain: (url: string) => Response): typeof fetch =>
      ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(`http://${host}/`)) return Promise.resolve(plain(url));
        return fetch(url.replace(`https://${host}`, local), init);
      }) as typeof fetch;
    const redirectCheck = async (plain: (url: string) => Response) =>
      (await checkRelay(`https://${host}`, { expectGoogle: true, fetch: via(plain) })).find((r) => r.name === CHECK_NAMES.httpsRedirect);
    const moved = (status: number, to: (url: string) => string) => (url: string) => new Response(null, { status, headers: { location: to(url) } });
    const toHttps = (url: string): string => url.replace('http://', 'https://');
    expect(await redirectCheck(moved(301, toHttps))).toMatchObject({ ok: true });
    expect(await redirectCheck(moved(308, toHttps))).toMatchObject({ ok: true });
    // Served over plain http (the zone's "Always Use HTTPS" off: app.smurg.ai on 2026-10-01), a temporary redirect, or
    // a redirect somewhere else.
    const plainOk = await redirectCheck(() => new Response('ok', { status: 200 }));
    expect(plainOk).toMatchObject({ ok: false });
    expect(plainOk?.detail).toContain('Always Use HTTPS');
    expect(await redirectCheck(moved(302, toHttps))).toMatchObject({ ok: false });
    expect(await redirectCheck(moved(301, () => 'https://elsewhere.example.org/healthz'))).toMatchObject({ ok: false });
    // Not asked: a local relay over http, and workers.dev (.dev is HSTS-preloaded in browsers).
    expect((await checkRelay(local, { expectGoogle: true })).map((r) => r.name)).not.toContain(CHECK_NAMES.httpsRedirect);
    const workersDev = await checkRelay(URL_, { expectGoogle: true, fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(URL_, local), init)) as typeof fetch });
    expect(workersDev.map((r) => r.name)).not.toContain(CHECK_NAMES.httpsRedirect);
  });

  it('an https relay must send the Strict-Transport-Security of apps/web/public/_headers with its SPA; a local http relay is not asked', async () => {
    const host = 'relay.example.org';
    const local = (production as LocalRelay).origin;
    // https://relay.example.org is the production-like relay (its _headers are the real ones of apps/web/public).
    const via = (strip: boolean): typeof fetch =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await fetch(String(input).replace(`https://${host}`, local).replace(`http://${host}`, local), init);
        if (!strip) return res;
        const headers = new Headers(res.headers);
        headers.delete('strict-transport-security');
        return new Response(await res.arrayBuffer(), { status: res.status, headers });
      }) as typeof fetch;
    const spaChecks: string[] = [CHECK_NAMES.spaRoot, CHECK_NAMES.spaDeepLink];
    const withHsts = await checkRelay(`https://${host}`, { expectGoogle: true, fetch: via(false) });
    expect(withHsts.filter((r) => spaChecks.includes(r.name))).toEqual(spaChecks.map((name) => ({ name, ok: true, detail: 'OK' })));
    // The live app.smurg.ai on 2026-10-01: a web build from before the HSTS line.
    const without = await checkRelay(`https://${host}`, { expectGoogle: true, fetch: via(true) });
    for (const name of spaChecks) {
      const result = without.find((r) => r.name === name);
      expect(result, name).toMatchObject({ ok: false });
      expect(result?.detail, name).toContain('Strict-Transport-Security');
      expect(result?.detail, name).toContain('scripts/deploy-relay.sh');
    }
    // A local relay over http: browsers ignore HSTS there, so its absence is not a failure.
    const plain = await checkRelay(local, { expectGoogle: true, googleClientId: CLIENT_ID, fetch: via(true) });
    expect(plain.filter((r) => !r.ok)).toEqual([]);
    // Two headers (_headers' and, say, the zone's HSTS setting) reach fetch() as one value joined with ', '; browsers
    // process only the first header (RFC 6797 §8.1), and so does the check.
    const twice = (value: string): typeof fetch =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await fetch(String(input).replace(`https://${host}`, local), init);
        const headers = new Headers(res.headers);
        headers.set('strict-transport-security', value);
        return new Response(await res.arrayBuffer(), { status: res.status, headers });
      }) as typeof fetch;
    const spaResults = async (value: string) =>
      (await checkRelay(`https://${host}`, { expectGoogle: true, fetch: twice(value) })).filter((r) => spaChecks.includes(r.name)).map((r) => r.ok);
    expect(await spaResults('max-age=31536000, max-age=31536000')).toEqual([true, true]);
    expect(await spaResults('max-age=31536000, max-age=0')).toEqual([true, true]);
    expect(await spaResults('max-age=0, max-age=31536000')).toEqual([false, false]);
  });

  it('a response Cloudflare challenged instead of the relay fails every check with that reason', async () => {
    const challenged = (() => Promise.resolve(new Response('<html>Just a moment…</html>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))) as typeof fetch;
    const results = await checkRelay(CUSTOM_URL, { expectGoogle: true, fetch: challenged });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.ok, result.name).toBe(false);
      expect(result.detail, result.name).toContain('cf-mitigated: challenge');
    }
  });

  it('scripts/deploy-relay.ts --check: exit 0 and "All checks passed." for the production-like relay, exit 1 for the development one', async () => {
    const entry = join(REPO_ROOT, 'scripts', 'deploy-relay.ts');
    // --web-dist: compare with the build the local relay serves (the default, apps/web/dist, is whatever this checkout last built).
    const ok = await run(process.execPath, [entry, '--check', (production as LocalRelay).origin, '--web-dist', built, '--wait', '0'], { cwd: REPO_ROOT, timeout: 60_000 });
    expect(ok.stdout).toContain(`Comparing the live web app with ${built} (/assets/index-test.js)`);
    expect(ok.stdout).toContain(`✓ ${CHECK_NAMES.webBuild}`);
    expect(ok.stdout).toContain('All checks passed.');
    expect(ok.stdout).not.toContain('Note:');
    // A local build from before the HSTS line is still compared, with a note (not skipped as "no web build").
    const older = join(dirs as string, 'older-than-hsts');
    rmSync(older, { recursive: true, force: true });
    cpSync(built, older, { recursive: true });
    writeFileSync(join(older, '_headers'), readFileSync(join(built, '_headers'), 'utf8').replace(/^.*Strict-Transport-Security.*\n/m, ''));
    const noted = await run(process.execPath, [entry, '--check', (production as LocalRelay).origin, '--web-dist', older, '--wait', '0'], { cwd: REPO_ROOT, timeout: 60_000 });
    expect(noted.stdout).toContain(`Comparing the live web app with ${older} (/assets/index-test.js)`);
    expect(noted.stdout).toContain('Note:');
    expect(noted.stdout).toContain('built before apps/web/public/_headers had HSTS');
    expect(noted.stdout).toContain(`✓ ${CHECK_NAMES.webBuild}`);
    expect(noted.stdout).not.toContain('holds no web build');
    const bad =await run(process.execPath, [entry, '--check', (development as LocalRelay).origin, '--wait', '0'], { cwd: REPO_ROOT, timeout: 60_000 }).then(
      () => ({ code: 0, stdout: '' }),
      (error: { code?: number; stdout?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? '' }),
    );
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('✗ GET /api/login-options');
  }, 120_000);
});

// The whole guided deploy, run in-process against a FAKE wrangler (an executable that answers whoami / secret list /
// deploy like wrangler 4.142 does, from a state file) and copies of wrangler.jsonc: the workers.dev shape a self-hosted
// relay starts from, and the committed custom-domain config. The checks from outside reach a local relay configured as
// the deployed one (its RELAY_ISSUER is the workers.dev URL or https://app.smurg.ai; fetch is routed to it).
describe('the guided deploy against a fake wrangler', () => {
  const SUB_URL = 'https://smurg-relay.test-sub.workers.dev';
  let dir: string;
  let statePath: string;
  let configPath: string;
  let customConfigPath: string;
  let wranglerBin: string;
  let googleOff: LocalRelay | undefined;
  let googleOn: LocalRelay | undefined;
  let sharedRelay: LocalRelay | undefined;
  let current: LocalRelay | undefined;
  /** The web build every local relay here serves, and so what step 4 "built". */
  let built: string;
  /** The smurg.ai zone's "Always Use HTTPS": http://app.smurg.ai/… is a 301 to https:// while on. */
  let alwaysUseHttps = true;
  const saved = { account: process.env['CLOUDFLARE_ACCOUNT_ID'], xdg: process.env['XDG_CONFIG_HOME'] };
  const committed = readFileSync(WRANGLER_CONFIG, 'utf8');
  const committedClientId = String(parseWranglerJsonc(committed).vars['GOOGLE_CLIENT_ID']);

  interface FakeState {
    loggedIn: boolean;
    accounts: { id: string; name: string }[];
    worker: boolean;
    secrets: string[];
    subdomain: string;
    /**
     * wrangler reports no "<host> (custom domain)" target. As run by the script it does not skip a conflict (it takes
     * the hostname over: deploy.ts step 5), so this is the script's defence against an unexpected deploy result.
     */
    dropCustomDomain: boolean;
    calls: { args: string[]; issuer?: string; clientId?: string }[];
    /** Every wrangler command run, as its first two words. */
    seen: string[];
  }
  const state = (): FakeState => JSON.parse(readFileSync(statePath, 'utf8')) as FakeState;
  const setState = (change: Partial<FakeState>): void => writeFileSync(statePath, JSON.stringify({ ...state(), ...change }));

  const FAKE = `// TEST ONLY: answers like wrangler 4.142 (formats from its source), from a JSON state file.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const statePath = process.argv[2];
const args = process.argv.slice(3);
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
state.seen.push(args.slice(0, 2).join(' '));
save();
const configArg = args.indexOf('--config');
const topConfig = () => JSON.parse(readFileSync(args[configArg + 1], 'utf8').replace(/^\\s*\\/\\/.*$/gm, ''));
if (args[0] === 'whoami') {
  if (!state.loggedIn) { process.stdout.write('{\\n  "loggedIn": false\\n}\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'owner@example.com', accounts: state.accounts, tokenPermissions: [] }, null, 2) + '\\n');
} else if (args[0] === 'secret' && args[1] === 'list') {
  if (!state.worker) { process.stderr.write('✘ [ERROR] Worker "smurg-relay" not found.\\n\\nIf this is a new Worker, run \`wrangler deploy\` first to create it.\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(state.secrets.map((name) => ({ name, type: 'secret_text' })), null, '  ') + '\\n');
} else if (args[0] === 'deploy' && args.includes('--dry-run')) {
  state.calls.push({ args }); save();
} else if (args[0] === 'deploy') {
  const config = topConfig();
  const vars = config.vars;
  state.calls.push({ args, issuer: vars.RELAY_ISSUER, clientId: vars.GOOGLE_CLIENT_ID });
  if (!state.worker && !state.secrets.includes('RELAY_SIGNING_KEY')) { save(); process.stderr.write('The following required secrets have not been set: RELAY_SIGNING_KEY\\n'); process.exit(1); }
  state.worker = true; save();
  // triggersDeploy: the workers.dev hostname when workers_dev is on (with https://), each custom domain as renderRoute
  // writes it ("<pattern> (custom domain)").
  const targets = [];
  if (config.workers_dev ?? (config.routes ?? []).length === 0) targets.push('https://smurg-relay.' + state.subdomain + '.workers.dev');
  for (const route of config.routes ?? []) {
    if (route.custom_domain && !state.dropCustomDomain) targets.push(route.pattern + ' (custom domain)');
  }
  appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type: 'deploy', version: 1, worker_name: 'smurg-relay', targets }) + '\\n');
} else {
  process.stderr.write('fake wrangler: unexpected ' + args.join(' ') + '\\n'); process.exit(2);
}
`;

  beforeAll(async () => {
    delete process.env['CLOUDFLARE_ACCOUNT_ID'];
    process.env['XDG_CONFIG_HOME'] = join(REPO_ROOT, '.xdg');
    dir = mkdtempSync(join(tmpdir(), 'smurg-deploy-flow-'));
    statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({ loggedIn: false, accounts: [], worker: false, secrets: [], subdomain: 'test-sub', dropCustomDomain: false, calls: [], seen: [] } satisfies FakeState));
    writeFileSync(join(dir, 'fake-wrangler.mjs'), FAKE);
    wranglerBin = join(dir, 'wrangler');
    writeFileSync(wranglerBin, `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'fake-wrangler.mjs')}' '${statePath}' "$@"\n`);
    chmodSync(wranglerBin, 0o755);
    // A self-hosted relay on workers.dev before its first deploy: the committed config in the workers.dev shape,
    // empty origin and client id.
    configPath = join(dir, 'wrangler.jsonc');
    writeFileSync(configPath, asWorkersDevBeforeFirstDeploy(committed));
    // The shared relay: the committed config exactly (custom domain app.smurg.ai, its origin and client id set).
    mkdirSync(join(dir, 'shared'));
    customConfigPath = join(dir, 'shared', 'wrangler.jsonc');
    writeFileSync(customConfigPath, committed);
    built = fakeWebBuild(dir);
    const deployed = { RELAY_ISSUER: SUB_URL, ALLOWED_ORIGINS: SUB_URL, DEV_LOGIN: '0', ...GOOGLE_ENDPOINTS };
    googleOff = await startLocalRelay({ webDist: built, vars: deployed });
    googleOn = await startLocalRelay({ webDist: built, vars: { ...deployed, GOOGLE_CLIENT_ID: CLIENT_ID }, secrets: { GOOGLE_CLIENT_SECRET: 'not-a-real-secret' } });
    // Stands in for https://app.smurg.ai: the committed (public) client id, a made-up client secret.
    sharedRelay = await startLocalRelay({
      webDist: built,
      vars: { RELAY_ISSUER: CUSTOM_URL, ALLOWED_ORIGINS: CUSTOM_URL, DEV_LOGIN: '0', GOOGLE_CLIENT_ID: committedClientId, ...GOOGLE_ENDPOINTS },
      secrets: { GOOGLE_CLIENT_SECRET: 'not-a-real-secret' },
    });
  }, 120_000);

  afterAll(async () => {
    if (saved.account === undefined) delete process.env['CLOUDFLARE_ACCOUNT_ID'];
    else process.env['CLOUDFLARE_ACCOUNT_ID'] = saved.account;
    if (saved.xdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = saved.xdg;
    await googleOff?.stop();
    await googleOn?.stop();
    await sharedRelay?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** The workers.dev URL / the custom domain is served by the local relay standing in for the deployed Worker. */
  const toCurrent = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`http://${CUSTOM_HOST}/`)) {
      return Promise.resolve(alwaysUseHttps ? new Response(null, { status: 301, headers: { location: url.replace('http://', 'https://') } }) : new Response('ok', { status: 200 }));
    }
    return fetch(url.replace(SUB_URL, (current as LocalRelay).origin).replace(CUSTOM_URL, (current as LocalRelay).origin), init);
  }) as typeof fetch;

  const deployOnce = async (
    argv: string[],
    config = configPath,
    extra: { readonly fetch?: typeof fetch; readonly lookupHost?: (host: string) => Promise<boolean>; readonly webDist?: string } = {},
  ): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await main([...argv, '--wait', '0'], {
      wranglerBin,
      configPath: config,
      buildWeb: async () => {},
      webDist: extra.webDist ?? built,
      // The custom domain resolves (it is the live app.smurg.ai); what answers there is the local relay (`toCurrent`).
      lookupHost: extra.lookupHost ?? (async () => true),
      fetch: extra.fetch ?? toCurrent,
      out: (line) => {
        out += `${line}\n`;
      },
      err: (text) => {
        err += text;
      },
      retryIntervalMs: 10,
    });
    return { code, out, err };
  };
  const prodVars = (): Record<string, unknown> => parseWranglerJsonc(readFileSync(configPath, 'utf8')).vars;

  it('stops for the owner: not logged in, several accounts, no Worker / signing key yet (exit 3, the command to run)', async () => {
    const notLoggedIn = await deployOnce([]);
    expect(notLoggedIn.code).toBe(3);
    expect(notLoggedIn.err).toContain(OWNER_COMMANDS.login);
    setState({ loggedIn: true, accounts: [{ id: 'acc1', name: 'One' }, { id: 'acc2', name: 'Two' }] });
    const several = await deployOnce([]);
    expect(several.code).toBe(3);
    expect(several.err).toContain('CLOUDFLARE_ACCOUNT_ID=<account ID>');
    expect(several.err).toContain('acc2  Two');
    setState({ accounts: [{ id: 'acc1', name: 'One' }] });
    const noWorker = await deployOnce([]);
    expect(noWorker.code).toBe(3);
    expect(noWorker.err).toContain(OWNER_COMMANDS.signingKey);
    expect(state().calls).toEqual([]); // nothing was deployed
  });

  it('first deploy: learns the URL from a closed deploy, writes it into the config, deploys again; Google still pending', async () => {
    // What `wrangler secret put RELAY_SIGNING_KEY` does to a missing Worker: an empty Worker holding the key.
    setState({ worker: true, secrets: ['RELAY_SIGNING_KEY'] });
    current = googleOff;
    const first = await deployOnce([]);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(state().calls.map((c) => c.issuer)).toEqual(['', SUB_URL]);
    expect(prodVars()).toMatchObject({ RELAY_ISSUER: SUB_URL, ALLOWED_ORIGINS: SUB_URL, GOOGLE_CLIENT_ID: '' });
    expect(first.out).toContain(`Authorized redirect URIs:      ${SUB_URL}/auth/google/callback`);
    expect(first.out).toContain(`Authorized JavaScript origins: ${SUB_URL}`);
    expect(first.out).toContain(OWNER_COMMANDS.googleSecret);
    expect(first.out).toContain(`export const DEFAULT_RELAY_URL: string | null = '${SUB_URL}';`);
    expect(first.out).toContain('Deployed, but Google login is not on yet.');
    expect(first.out).not.toContain('✗');
  });

  it('with the client secret put and --google-client-id: one deploy with both in the config, every check passes', async () => {
    setState({ secrets: ['RELAY_SIGNING_KEY', 'GOOGLE_CLIENT_SECRET'], calls: [] });
    current = googleOn;
    const second = await deployOnce(['--google-client-id', CLIENT_ID]);
    expect(second.err).toBe('');
    expect(second.code).toBe(0);
    expect(state().calls.map((c) => [c.issuer, c.clientId])).toEqual([[SUB_URL, CLIENT_ID]]);
    expect(prodVars()).toMatchObject({ RELAY_ISSUER: SUB_URL, GOOGLE_CLIENT_ID: CLIENT_ID });
    expect(second.out).toContain(`Done: ${SUB_URL} is deployed and passes every check`);
    // Idempotent: again, nothing to write, same result.
    const before = readFileSync(configPath, 'utf8');
    const again = await deployOnce([]);
    expect(again.code).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(again.out).toContain('Already correct: nothing to change');
  });

  it('refuses when the deployed workers.dev URL is not the configured one (the account subdomain changed); --dry-run deploys nothing', async () => {
    setState({ subdomain: 'renamed-sub', calls: [] });
    const renamed = await deployOnce([]);
    expect(renamed.code).toBe(1);
    expect(renamed.err).toContain('https://smurg-relay.renamed-sub.workers.dev');
    expect(renamed.err).toContain('--url https://smurg-relay.renamed-sub.workers.dev');
    setState({ subdomain: 'test-sub', calls: [], seen: [] });
    const before = readFileSync(configPath, 'utf8');
    const dry = await deployOnce(['--dry-run', '--google-client-id', 'other-1.apps.googleusercontent.com']);
    expect(dry.code).toBe(0);
    expect(state().calls.map((c) => c.args.includes('--dry-run'))).toEqual([true]);
    // No account contact at all: not even whoami or secret list.
    expect(state().seen).toEqual(['deploy --dry-run']);
    expect(state().calls[0]?.args).toContain('GOOGLE_CLIENT_ID:other-1.apps.googleusercontent.com');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('workers.dev: --url must be this Worker on workers.dev, never a custom domain (refused before anything is deployed)', async () => {
    setState({ calls: [], seen: [] });
    const before = readFileSync(configPath, 'utf8');
    for (const url of [CUSTOM_URL, 'https://smurg.app']) {
      const refused = await deployOnce(['--url', url]);
      expect(refused.code, url).toBe(2);
      expect(refused.err).toContain('set "workers_dev" to false');
    }
    expect(state().calls).toEqual([]);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('custom domain (the committed config): one deploy, nothing to learn or write, the "(custom domain)" target, every check passes', async () => {
    setState({ secrets: ['RELAY_SIGNING_KEY', 'GOOGLE_CLIENT_SECRET'], dropCustomDomain: false, calls: [], seen: [] });
    current = sharedRelay;
    for (const argv of [[], ['--url', CUSTOM_URL]]) {
      setState({ calls: [] });
      const shared = await deployOnce(argv, customConfigPath);
      expect(shared.err).toBe('');
      expect(shared.code).toBe(0);
      // Exactly one real deploy, of the committed values: no first deploy to learn a URL, no edit of the file.
      expect(state().calls.map((c) => [c.args.includes('--dry-run'), c.issuer, c.clientId])).toEqual([[false, CUSTOM_URL, committedClientId]]);
      expect(readFileSync(customConfigPath, 'utf8')).toBe(committed);
      expect(shared.out).toContain(`the Cloudflare Custom Domain ${CUSTOM_HOST}`);
      expect(shared.out).toContain(`${CUSTOM_HOST} is already a smurg relay: deploying again`);
      expect(shared.out).toContain('Web app: /assets/index-test.js');
      expect(shared.out).toContain('Already correct: nothing to change');
      expect(shared.out).toContain(`Authorized JavaScript origins: ${CUSTOM_URL}`);
      expect(shared.out).toContain(`Authorized redirect URIs:      ${CUSTOM_URL}/auth/google/callback`);
      expect(shared.out).toContain('Authorized domains');
      // The CLI's built-in relay already is this one: no DEFAULT_RELAY_URL line to change.
      expect(shared.out).not.toContain('export const DEFAULT_RELAY_URL');
      expect(shared.out).not.toContain('✗');
      // The checks a custom domain adds: the live web app is this build, and http:// moves to https://.
      expect(shared.out).toContain(`✓ ${CHECK_NAMES.webBuild}`);
      expect(shared.out).toContain(`✓ ${CHECK_NAMES.httpsRedirect}`);
      expect(shared.out).toContain(`Done: ${CUSTOM_URL} is deployed and passes every check`);
    }
  });

  it('custom domain: the live web app must be the one just built, and http:// must move to https://; else exit 1, no "Done"', async () => {
    setState({ secrets: ['RELAY_SIGNING_KEY', 'GOOGLE_CLIENT_SECRET'], dropCustomDomain: false, calls: [] });
    current = sharedRelay;
    // Step 4 built another web app than the one the relay serves (a deploy that did not take).
    const newer = fakeWebBuild(dir, 'newer', 'index-newer.js');
    const stale = await deployOnce([], customConfigPath, { webDist: newer });
    expect(stale.code).toBe(1);
    expect(stale.out).toContain(`✗ ${CHECK_NAMES.webBuild}`);
    expect(stale.out).not.toContain('Done:');
    // The zone's "Always Use HTTPS" off: http://app.smurg.ai answers with the page itself.
    alwaysUseHttps = false;
    try {
      const plain = await deployOnce([], customConfigPath);
      expect(plain.code).toBe(1);
      expect(plain.out).toContain(`✗ ${CHECK_NAMES.httpsRedirect}`);
      expect(plain.out).toContain('Always Use HTTPS');
      expect(plain.out).not.toContain('Done:');
    } finally {
      alwaysUseHttps = true;
    }
  });

  it('custom domain: a hostname that answers as something else is not taken over without --take-over-hostname (exit 3, nothing deployed)', async () => {
    setState({ secrets: ['RELAY_SIGNING_KEY', 'GOOGLE_CLIENT_SECRET'], dropCustomDomain: false, calls: [] });
    current = sharedRelay;
    // Another site already answers at app.smurg.ai (a DNS record or another Worker that wrangler would replace).
    const otherSite = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith(`${CUSTOM_URL}/`) ? Promise.resolve(new Response('<!doctype html><title>shop</title>', { status: 200, headers: { 'content-type': 'text/html' } })) : toCurrent(input, init)) as typeof fetch;
    const refused = await deployOnce([], customConfigPath, { fetch: otherSite });
    expect(refused.code).toBe(3);
    expect(refused.err).toContain(`Something already answers at ${CUSTOM_HOST}, and it is not a smurg relay`);
    expect(refused.err).toContain('--take-over-hostname');
    expect(state().calls).toEqual([]);
    // Told to take it over: no question asked, one deploy (the checks then reach the relay).
    const takenOver = await deployOnce(['--take-over-hostname'], customConfigPath);
    expect(takenOver.err).toBe('');
    expect(takenOver.code).toBe(0);
    expect(takenOver.out).toContain('--take-over-hostname:');
    expect(state().calls).toHaveLength(1);
    // A name that does not resolve yet (the first deploy of a new custom domain): nothing to take over, nothing asked.
    setState({ calls: [] });
    const fresh = await deployOnce([], customConfigPath, { lookupHost: async () => false });
    expect(fresh.code).toBe(0);
    expect(fresh.out).toContain(`${CUSTOM_HOST} has no DNS record yet`);
    expect(state().calls).toHaveLength(1);
  });

  it('who answers at a custom domain: nothing, a smurg relay (also one without its issuer yet), or something else', async () => {
    const relay = ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(CUSTOM_URL, (sharedRelay as LocalRelay).origin), init)) as typeof fetch;
    const answering = (status: number, body: string): typeof fetch => (() => Promise.resolve(new Response(body, { status }))) as typeof fetch;
    const resolves = async (): Promise<boolean> => true;
    expect(await hostnameOccupant(CUSTOM_HOST, { lookupHost: async () => false, fetch: answering(500, 'never asked') })).toEqual({ kind: 'none' });
    expect(await hostnameOccupant(CUSTOM_HOST, { lookupHost: resolves, fetch: relay })).toEqual({ kind: 'relay' });
    expect(await hostnameOccupant(CUSTOM_HOST, { lookupHost: resolves, fetch: answering(404, 'not found') })).toMatchObject({ kind: 'other' });
    // "ok" at /healthz alone is common; /api/login-options must answer as the relay's too.
    const healthzOnly = ((input: string | URL | Request) => Promise.resolve(String(input).endsWith('/healthz') ? new Response('ok') : new Response('nope', { status: 404 }))) as typeof fetch;
    expect(await hostnameOccupant(CUSTOM_HOST, { lookupHost: resolves, fetch: healthzOnly })).toMatchObject({ kind: 'other', detail: expect.stringContaining('/api/login-options') });
    const unreachable = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    expect(await hostnameOccupant(CUSTOM_HOST, { lookupHost: resolves, fetch: unreachable })).toMatchObject({ kind: 'other', detail: expect.stringContaining('fetch failed') });
  });

  it('custom domain: --url must be exactly https://<that host>; a workers.dev --url says how to switch shapes; nothing is deployed', async () => {
    setState({ calls: [], seen: [] });
    const other = await deployOnce(['--url', 'https://smurg.app'], customConfigPath);
    expect(other.code).toBe(2);
    expect(other.err).toContain(`is not the custom domain of wrangler.jsonc, ${CUSTOM_URL}`);
    const workersDev = await deployOnce(['--url', SUB_URL], customConfigPath);
    expect(workersDev.code).toBe(2);
    expect(workersDev.err).toContain('set "workers_dev" to true');
    expect(state().calls).toEqual([]);
    expect(readFileSync(customConfigPath, 'utf8')).toBe(committed);
  });

  it('custom domain: refuses when wrangler did not attach the custom domain, and a config with a second hostname', async () => {
    setState({ dropCustomDomain: true, calls: [] });
    const dropped = await deployOnce([], customConfigPath);
    expect(dropped.code).toBe(1);
    expect(dropped.err).toContain(`the deploy result does not list the custom domain ${CUSTOM_HOST} (custom domain)`);
    expect(dropped.out).not.toContain('Done:');
    setState({ dropCustomDomain: false, calls: [] });
    // workers.dev on next to the custom domain, an extra route, a host that is not RELAY_ISSUER: refused at step 3.
    const variants = {
      'workers_dev true with routes': committed.replace('"workers_dev": false,', '"workers_dev": true,'),
      'an extra route': committed.replace(
        `"routes": [{ "pattern": "${CUSTOM_HOST}", "custom_domain": true }],`,
        `"routes": [{ "pattern": "${CUSTOM_HOST}", "custom_domain": true }, { "pattern": "www.smurg.ai", "custom_domain": true }],`,
      ),
      'a mismatched host': committed.replace(`"routes": [{ "pattern": "${CUSTOM_HOST}"`, '"routes": [{ "pattern": "relay.smurg.ai"'),
    };
    const variantPath = join(dir, 'shared', 'variant.jsonc');
    for (const [what, text] of Object.entries(variants)) {
      expect(text, what).not.toBe(committed);
      writeFileSync(variantPath, text);
      const refused = await deployOnce([], variantPath);
      expect(refused.code, what).toBe(1);
      expect(refused.err, what).toContain('wrangler.jsonc is not fit for production');
    }
    expect(state().calls).toEqual([]);
  });

  it('custom domain --dry-run: no account contact, the committed values, nothing written', async () => {
    setState({ calls: [], seen: [] });
    const dry = await deployOnce(['--dry-run'], customConfigPath);
    expect(dry.code).toBe(0);
    expect(state().seen).toEqual(['deploy --dry-run']);
    // Nothing to change, so nothing is passed with --var: the dry run bundles exactly the committed file.
    expect(state().calls[0]?.args.filter((a) => a === '--var')).toEqual([]);
    expect(dry.out).toContain(`${CUSTOM_URL} (routes in wrangler.jsonc)`);
    expect(readFileSync(customConfigPath, 'utf8')).toBe(committed);
  });
});
