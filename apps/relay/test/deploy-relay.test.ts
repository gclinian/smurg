// scripts/deploy-relay.sh (apps/relay/scripts/deploy.ts) without a Cloudflare account: its argument rules, the edit it
// makes to wrangler.jsonc, how it reads wrangler's output (formats taken from wrangler 4.142's source), and its checks
// from outside against a LOCAL relay configured like production (Google on with a made-up client, no dev login, the
// SPA with the _headers CSP). Nothing here deploys, logs in or touches a real secret.
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalRelay, type LocalRelay } from '../test-support/index.ts';
import {
  DeployError,
  GOOGLE_ENDPOINTS,
  OWNER_COMMANDS,
  WRANGLER_CONFIG,
  checkRelay,
  deployTargets,
  main,
  parseDeployArgs,
  parseSecretList,
  parseWhoami,
  parseWranglerJsonc,
  setProductionVars,
  workersDevOrigin,
  workersDevTarget,
} from '../scripts/deploy.ts';

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const URL_ = 'https://smurg-relay.example-sub.workers.dev';
const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';

describe('arguments', () => {
  it('deploy by default; --url must be this Worker on workers.dev; --google-client-id must look like a Google client id', () => {
    expect(parseDeployArgs([])).toEqual({ mode: 'deploy', waitSeconds: 180 });
    expect(parseDeployArgs(['--url', `${URL_}/`, '--google-client-id', CLIENT_ID])).toEqual({ mode: 'deploy', url: URL_, googleClientId: CLIENT_ID, waitSeconds: 180 });
    expect(parseDeployArgs(['--dry-run', '--wait', '5'])).toEqual({ mode: 'dry-run', waitSeconds: 5 });
    expect(parseDeployArgs(['--check', 'http://127.0.0.1:8787'])).toEqual({ mode: 'check', url: 'http://127.0.0.1:8787', waitSeconds: 20 });
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
    expect(refused(['--url', 'https://smurg.app'])).toBe(2);
    expect(refused(['--url', 'http://smurg-relay.x.workers.dev'])).toBe(2);
    expect(refused(['--url', 'https://other.x.workers.dev'])).toBe(2);
    expect(refused(['--url', `${URL_}/path`])).toBe(2);
    expect(refused(['--google-client-id', 'nope'])).toBe(2);
    expect(refused(['--dry-run', '--check', URL_])).toBe(2);
    expect(refused(['--check', 'http://relay.example.com'])).toBe(2);
    expect(refused(['--check'])).toBe(2);
    expect(refused(['--wait', 'soon'])).toBe(2);
    expect(refused(['--deploy-everything'])).toBe(2);
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
  });
});

/** A web build's shape (what check-web-dist accepts) with the real _headers of apps/web/public. */
function fakeWebBuild(dir: string): string {
  const built = join(dir, 'built');
  mkdirSync(join(built, 'assets'), { recursive: true });
  writeFileSync(join(built, 'index.html'), '<!doctype html><html><head><title>smurg</title><script type="module" crossorigin src="/assets/index-test.js"></script></head><body><div id="root"></div></body></html>\n');
  writeFileSync(join(built, 'assets', 'index-test.js'), 'export {};\n');
  copyFileSync(join(REPO_ROOT, 'apps', 'web', 'public', '_headers'), join(built, '_headers'));
  return built;
}

describe('checks from outside (a local relay configured like production)', () => {
  let dirs: string | undefined;
  let production: LocalRelay | undefined;
  let development: LocalRelay | undefined;

  beforeAll(async () => {
    dirs = mkdtempSync(join(tmpdir(), 'smurg-deploy-web-'));
    const built = fakeWebBuild(dirs);
    // The development stand-in page (scripts/ensure-web-dist.ts): no build, no _headers.
    const standIn = join(dirs, 'stand-in');
    mkdirSync(standIn);
    writeFileSync(join(standIn, 'index.html'), '<!doctype html><p>尚未建置網頁介面。</p>\n');
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
    expect(Object.keys(failed).sort()).toEqual(['GET /api/login-options', 'GET /auth/google/login', 'GET /join/…（SPA 深層連結與 CSP）', 'GET /（網頁與 CSP）'].sort());
    expect(failed['GET /api/login-options']).toContain('開發用登入');
    expect(failed['GET /（網頁與 CSP）']).toContain('替代頁面');
    // The production relay with a different expected client id, and Google expected off (the state before its secret).
    const wrongId = await checkRelay((production as LocalRelay).origin, { expectGoogle: true, googleClientId: 'other-123.apps.googleusercontent.com' });
    expect(wrongId.filter((r) => !r.ok).map((r) => r.name)).toEqual(['GET /auth/google/login']);
    const googleOff = await checkRelay((production as LocalRelay).origin, { expectGoogle: false });
    expect(googleOff.filter((r) => !r.ok).map((r) => r.name).sort()).toEqual(['GET /api/login-options', 'GET /auth/google/login'].sort());
  });

  it('scripts/deploy-relay.ts --check: exit 0 and 「全部通過」 for the production-like relay, exit 1 for the development one', async () => {
    const entry = join(REPO_ROOT, 'scripts', 'deploy-relay.ts');
    const ok = await run(process.execPath, [entry, '--check', (production as LocalRelay).origin, '--wait', '0'], { cwd: REPO_ROOT, timeout: 60_000 });
    expect(ok.stdout).toContain('全部通過');
    const bad = await run(process.execPath, [entry, '--check', (development as LocalRelay).origin, '--wait', '0'], { cwd: REPO_ROOT, timeout: 60_000 }).then(
      () => ({ code: 0, stdout: '' }),
      (error: { code?: number; stdout?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? '' }),
    );
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('✗ GET /api/login-options');
  }, 120_000);
});

// The whole guided deploy, run in-process against a FAKE wrangler (an executable that answers whoami / secret list /
// deploy like wrangler 4.142 does, from a state file) and a copy of wrangler.jsonc; the checks from outside reach a
// local relay configured as the deployed one (its RELAY_ISSUER is the workers.dev URL; fetch is routed to it).
describe('the guided deploy against a fake wrangler', () => {
  const SUB_URL = 'https://smurg-relay.test-sub.workers.dev';
  let dir: string;
  let statePath: string;
  let configPath: string;
  let wranglerBin: string;
  let googleOff: LocalRelay | undefined;
  let googleOn: LocalRelay | undefined;
  let current: LocalRelay | undefined;
  const saved = { account: process.env['CLOUDFLARE_ACCOUNT_ID'], xdg: process.env['XDG_CONFIG_HOME'] };

  interface FakeState {
    loggedIn: boolean;
    accounts: { id: string; name: string }[];
    worker: boolean;
    secrets: string[];
    subdomain: string;
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
const topVars = () => {
  const text = readFileSync(args[configArg + 1], 'utf8').replace(/^\\s*\\/\\/.*$/gm, '');
  return JSON.parse(text).vars;
};
if (args[0] === 'whoami') {
  if (!state.loggedIn) { process.stdout.write('{\\n  "loggedIn": false\\n}\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'owner@example.com', accounts: state.accounts, tokenPermissions: [] }, null, 2) + '\\n');
} else if (args[0] === 'secret' && args[1] === 'list') {
  if (!state.worker) { process.stderr.write('✘ [ERROR] Worker "smurg-relay" not found.\\n\\nIf this is a new Worker, run \`wrangler deploy\` first to create it.\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(state.secrets.map((name) => ({ name, type: 'secret_text' })), null, '  ') + '\\n');
} else if (args[0] === 'deploy' && args.includes('--dry-run')) {
  state.calls.push({ args }); save();
} else if (args[0] === 'deploy') {
  const vars = topVars();
  state.calls.push({ args, issuer: vars.RELAY_ISSUER, clientId: vars.GOOGLE_CLIENT_ID });
  if (!state.worker && !state.secrets.includes('RELAY_SIGNING_KEY')) { save(); process.stderr.write('The following required secrets have not been set: RELAY_SIGNING_KEY\\n'); process.exit(1); }
  state.worker = true; save();
  const target = 'https://smurg-relay.' + state.subdomain + '.workers.dev';
  appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type: 'deploy', version: 1, worker_name: 'smurg-relay', targets: [target] }) + '\\n');
} else {
  process.stderr.write('fake wrangler: unexpected ' + args.join(' ') + '\\n'); process.exit(2);
}
`;

  beforeAll(async () => {
    delete process.env['CLOUDFLARE_ACCOUNT_ID'];
    process.env['XDG_CONFIG_HOME'] = join(REPO_ROOT, '.xdg');
    dir = mkdtempSync(join(tmpdir(), 'smurg-deploy-flow-'));
    statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({ loggedIn: false, accounts: [], worker: false, secrets: [], subdomain: 'test-sub', calls: [], seen: [] } satisfies FakeState));
    writeFileSync(join(dir, 'fake-wrangler.mjs'), FAKE);
    wranglerBin = join(dir, 'wrangler');
    writeFileSync(wranglerBin, `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'fake-wrangler.mjs')}' '${statePath}' "$@"\n`);
    chmodSync(wranglerBin, 0o755);
    // The committed config as it is before the first deploy: empty origin and client id.
    configPath = join(dir, 'wrangler.jsonc');
    writeFileSync(configPath, setProductionVars(readFileSync(WRANGLER_CONFIG, 'utf8'), { RELAY_ISSUER: '', ALLOWED_ORIGINS: '', GOOGLE_CLIENT_ID: '' }));
    const built = fakeWebBuild(dir);
    const deployed = { RELAY_ISSUER: SUB_URL, ALLOWED_ORIGINS: SUB_URL, DEV_LOGIN: '0', ...GOOGLE_ENDPOINTS };
    googleOff = await startLocalRelay({ webDist: built, vars: deployed });
    googleOn = await startLocalRelay({ webDist: built, vars: { ...deployed, GOOGLE_CLIENT_ID: CLIENT_ID }, secrets: { GOOGLE_CLIENT_SECRET: 'not-a-real-secret' } });
  }, 120_000);

  afterAll(async () => {
    if (saved.account === undefined) delete process.env['CLOUDFLARE_ACCOUNT_ID'];
    else process.env['CLOUDFLARE_ACCOUNT_ID'] = saved.account;
    if (saved.xdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = saved.xdg;
    await googleOff?.stop();
    await googleOn?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const deployOnce = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await main([...argv, '--wait', '0'], {
      wranglerBin,
      configPath,
      buildWeb: async () => {},
      // The workers.dev URL is served by the local relay standing in for the deployed Worker.
      fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(SUB_URL, (current as LocalRelay).origin), init)) as typeof fetch,
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
    expect(several.err).toContain('CLOUDFLARE_ACCOUNT_ID=<帳號 ID>');
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
    expect(first.out).toContain(`Authorized redirect URIs：     ${SUB_URL}/auth/google/callback`);
    expect(first.out).toContain(`Authorized JavaScript origins：${SUB_URL}`);
    expect(first.out).toContain(OWNER_COMMANDS.googleSecret);
    expect(first.out).toContain(`export const DEFAULT_RELAY_URL: string | null = '${SUB_URL}';`);
    expect(first.out).toContain('已部署，但 Google 登入還沒有開啟');
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
    expect(second.out).toContain('完成');
    // Idempotent: again, nothing to write, same result.
    const before = readFileSync(configPath, 'utf8');
    const again = await deployOnce([]);
    expect(again.code).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(again.out).toContain('已經是正確的值');
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
});
