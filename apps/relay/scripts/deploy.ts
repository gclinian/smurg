// Guided, idempotent PRODUCTION deploy of the relay to a Cloudflare account on the Workers Free plan, Google login
// only (README.md "Deploying to Cloudflare"). Entry point, from the repository root:
//
//   scripts/deploy-relay.sh [--url https://<relay host>] [--google-client-id <id>] [--take-over-hostname] [--wait S]
//   scripts/deploy-relay.sh --dry-run [--url …] [--google-client-id …]      no Cloudflare account contact at all
//   scripts/deploy-relay.sh --check <url> [--web-dist DIR] [--wait S]       only the checks from outside
//
// The relay has exactly ONE public hostname, and the top level of wrangler.jsonc says which (anything else is refused):
//   · workers.dev (the default for a self-hosted relay): "workers_dev": true, no "routes"; the URL is
//     https://<worker name>.<account subdomain>.workers.dev, learned from the first deploy (or given with --url).
//   · a Cloudflare Custom Domain (the shared relay: https://app.smurg.ai since 2026-10-01): "workers_dev": false and
//     exactly one route { "pattern": "<host>", "custom_domain": true } in a zone of the same account; RELAY_ISSUER =
//     ALLOWED_ORIGINS = https://<host> are known up front, and --url, when given, must be exactly that.
//
// The wrapper sources scripts/env.sh, so wrangler keeps its login in <repo>/.xdg (XDG_CONFIG_HOME) and runs
// non-interactively (CI=true). Steps of a deploy:
//   1. Cloudflare login: `wrangler whoami --json`. Not logged in: print the login command and stop (never logs in).
//   2. Secrets: `wrangler secret list`. RELAY_SIGNING_KEY must exist before the first deploy: wrangler 4.142 refuses to
//      create a Worker whose required secret is missing, and `wrangler secret put` on a Worker that does not exist yet
//      creates an empty placeholder Worker first. So the script prints the command and stops.
//   3. Production config preflight (wrangler.jsonc top level: one of the two hostname shapes above with its
//      RELAY_ISSUER, no preview URLs, DEV_LOGIN "0", no tap, no GitHub vars, the three SQLite Durable Object classes
//      with exactly the migrations v1 and v2, SPA assets with run_worker_first).
//   4. Web build: `pnpm --filter @smurg/web build`, then scripts/check-web-dist.ts (the _headers CSP and HSTS must be
//      there);
//      the `/assets/…` files its index.html loads are what step 10 expects the live relay to serve.
//   5. The URL. Custom domain: https://<host> from the config. workers.dev: --url, else RELAY_ISSUER in wrangler.jsonc,
//      else ONE first deploy with the empty issuer (fails closed: every relay route but /healthz answers 500) whose
//      result names the URL. wrangler has no command that prints the account's workers.dev subdomain (`wrangler
//      whoami` does not), but `wrangler deploy` writes its targets to WRANGLER_OUTPUT_FILE_PATH (ND-JSON
//      `{"type":"deploy","targets":[…]}`; a workers.dev target is "https://<name>.<sub>.workers.dev", a custom domain
//      "<host> (custom domain)": renderRoute and triggersDeploy in wrangler 4.142's deploy-helpers).
//      Custom domain, before anything is deployed: who answers at <host> now. wrangler as run here never asks before
//      it takes a hostname over: with stdout not a terminal publishCustomDomains sets override_existing_origin and
//      override_existing_dns_record itself, and on a terminal its confirm() returns the fallback "yes" because CI=true
//      (wrangler 4.142, deploy-helpers publish-routes.ts and dialogs.ts). So when <host> resolves and is not already a
//      smurg relay (another site, another Worker), the script stops (exit 3) unless --take-over-hostname is given.
//   6. wrangler.jsonc: RELAY_ISSUER = ALLOWED_ORIGINS = the URL (workers.dev only; a custom domain's are already set),
//      and GOOGLE_CLIENT_ID from --google-client-id, written into the top-level `vars` (only those lines change; the
//      result is re-parsed and compared). Nothing is passed with --var: the committed file is exactly what runs in
//      production.
//   7. `wrangler deploy --env ""`; the deployed target must be the URL: the workers.dev target equal to it, or
//      "<host> (custom domain)" and no workers.dev target.
//   8. Prints the URL, the Google OAuth redirect URI and JavaScript origin (and, for a custom domain, the authorized
//      domain), and the CLI's DEFAULT_RELAY_URL line when it differs.
//   9. Secrets again: the exact command for each missing one (GOOGLE_CLIENT_SECRET is pasted by the operator; this script
//      never reads, prints, writes or passes any secret value).
//  10. From outside, with retries while a new hostname comes up (workers.dev, or the custom domain's DNS record and
//      certificate): /healthz, /api/login-options (google true, github false, dev false), /.well-known/jwks.json, the
//      SPA at / and at a deep link with the Content-Security-Policy of _headers (and, on https, its
//      Strict-Transport-Security), /auth/google/login redirecting to
//      Google with this relay's callback, the live web app being this build (its index.html loads the same
//      content-hashed `/assets/…` files as step 4's apps/web/dist: an older web app refuses a newer daemon's
//      `channel.welcome`, ARCHITECTURE §5 strict objects), and, on a custom domain, http:// answered with a permanent
//      redirect to https:// (Cloudflare's "Always Use HTTPS" on the zone; *.workers.dev needs none, .dev is
//      HSTS-preloaded). A response Cloudflare itself challenged (`cf-mitigated`) fails with that reason: the CLI and
//      the daemon are not browsers and cannot pass a challenge. `--check` runs the same checks; it compares the web app
//      with apps/web/dist (or --web-dist) when that holds a web build, and says so when it does not.
//
// Exit codes: 0 done (Google may still be pending: then the next steps are printed), 1 failed, 2 usage,
// 3 the operator must act first (log in, choose an account, put the signing key).
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELAY_PATHS,
  RELAY_WORKER_FIRST_PATTERNS,
  RelayUrlError,
  authCallbackPath,
  authLoginPath,
  isLocalHostname,
  relayHttpUrl,
  relayLoginOptionsSchema,
  relayOrigin,
} from '@smurg/protocol/relay';
import { DEFAULT_RELAY_URL } from '../../../packages/cli/src/relay/default-relay.ts';
import { HSTS_MIN_MAX_AGE, STAND_IN_TEXT, WEB_DIST, hstsMaxAge, webDistProblem } from './ensure-web-dist.ts';

export const RELAY_DIR = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const WRANGLER_CONFIG = join(RELAY_DIR, 'wrangler.jsonc');
const WRANGLER_BIN = join(RELAY_DIR, 'node_modules', '.bin', 'wrangler');

export const SIGNING_KEY_SECRET = 'RELAY_SIGNING_KEY';
export const GOOGLE_SECRET = 'GOOGLE_CLIENT_SECRET';

/** Google's endpoints as the relay's production vars must name them (relay.md V26). */
export const GOOGLE_ENDPOINTS = Object.freeze({
  GOOGLE_AUTHORIZE_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GOOGLE_JWKS_URL: 'https://www.googleapis.com/oauth2/v3/certs',
  GOOGLE_ISSUER: 'https://accounts.google.com',
});

/** The commands the OPERATOR runs (the person deploying) (from the repository root, after `source scripts/env.sh`); printed, never run here. */
export const OWNER_COMMANDS = Object.freeze({
  // CI=false: scripts/env.sh sets CI=true, and wrangler would then refuse its interactive prompts.
  login: 'CI=false pnpm --filter @smurg/relay exec wrangler login',
  // Piped (stdin is not a terminal): wrangler reads the key from stdin; it never appears on screen.
  signingKey: `node apps/relay/scripts/signing-key.ts | pnpm --filter @smurg/relay exec wrangler secret put ${SIGNING_KEY_SECRET} --env=""`,
  // Interactive: wrangler asks "Enter a secret value:" without echo; paste the client secret, press Enter.
  googleSecret: `CI=false pnpm --filter @smurg/relay exec wrangler secret put ${GOOGLE_SECRET} --env=""`,
});

export class DeployError extends Error {
  override readonly name = 'DeployError';
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────────────────────

export type DeployMode = 'deploy' | 'dry-run' | 'check';

export interface DeployOptions {
  readonly mode: DeployMode;
  /** deploy / dry-run: the expected relay origin (workers.dev, or the custom domain); check: the relay to check. */
  readonly url?: string;
  readonly googleClientId?: string;
  /** How long the outside checks keep retrying (a new workers.dev hostname or custom domain can take a while). */
  readonly waitSeconds: number;
  /** check: the web build the live web app is compared with (default apps/web/dist). */
  readonly webDist?: string;
  /** deploy: a custom domain that answers as something other than a smurg relay may be taken over (step 5). */
  readonly takeOverHostname?: boolean;
}

export const DEPLOY_USAGE = `Usage (from the repository root):
  scripts/deploy-relay.sh [--url https://<relay host>] [--google-client-id <client ID>] [--take-over-hostname] [--wait S]
  scripts/deploy-relay.sh --dry-run [--url ...] [--google-client-id ...]
  scripts/deploy-relay.sh --check <relay URL> [--web-dist DIR] [--wait S]

  Deploys the relay to your Cloudflare account (Workers Free plan, Google login only). Safe to run again. The relay
  has exactly one public hostname, and apps/relay/wrangler.jsonc says which: workers.dev ("workers_dev": true, no
  "routes"; the default when you self-host), or one Cloudflare Custom Domain ("workers_dev": false and exactly one
  route { "pattern": "<domain>", "custom_domain": true }).
  --url                 The relay's URL. workers.dev: https://smurg-relay.<subdomain>.workers.dev (may be left out on
                        the first deploy: the deploy result names it and it is written to wrangler.jsonc); custom
                        domain: must equal https://<the domain in routes>
  --google-client-id    The Google OAuth client ID (Web application); written to GOOGLE_CLIENT_ID in wrangler.jsonc
  --take-over-hostname  Deploy although another site, DNS record or Worker answers at the custom domain: wrangler
                        replaces it with this relay without asking (without this option the script stops and explains)
  --dry-run             Build and check only (wrangler deploy --dry-run): no contact with the Cloudflare account (no
                        login check, no secret check), no deploy, no change to wrangler.jsonc
  --check <URL>         Only check a deployed relay from outside (healthz, login methods, JWKS, web app and CSP, the
                        Google login redirect, whether the web app is the build of this checkout, http:// redirecting
                        to https:// on a custom domain)
  --web-dist DIR        With --check: the web build to compare with (default apps/web/dist; no comparison when it
                        holds no build)
  --wait S              How long to retry failing outside checks, in seconds (default: 180 for a deploy, 20 for --check)
  Guide: apps/relay/README.md, "Deploying to Cloudflare".
`;

export function parseDeployArgs(argv: readonly string[]): DeployOptions | 'help' {
  let mode: DeployMode = 'deploy';
  let url: string | undefined;
  let googleClientId: string | undefined;
  let wait: number | undefined;
  let webDist: string | undefined;
  let takeOverHostname = false;
  const value = (i: number, name: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new DeployError(`${name} needs a value`, 2);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--dry-run':
        if (mode === 'check') throw new DeployError('--dry-run and --check cannot be used together', 2);
        mode = 'dry-run';
        break;
      case '--check':
        if (mode === 'dry-run') throw new DeployError('--dry-run and --check cannot be used together', 2);
        mode = 'check';
        url = value(i, '--check');
        i++;
        break;
      case '--url':
        if (url !== undefined) throw new DeployError('--url may be given only once', 2);
        url = value(i, '--url');
        i++;
        break;
      case '--google-client-id':
        googleClientId = value(i, '--google-client-id');
        i++;
        break;
      case '--wait': {
        const text = value(i, '--wait');
        if (!/^\d{1,4}$/.test(text)) throw new DeployError('--wait must be a number of seconds (0-9999)', 2);
        wait = Number(text);
        i++;
        break;
      }
      case '--web-dist':
        webDist = resolve(value(i, '--web-dist'));
        i++;
        break;
      case '--take-over-hostname':
        takeOverHostname = true;
        break;
      default:
        throw new DeployError(`unknown argument ${arg} (see --help)`, 2);
    }
  }
  if (mode === 'check') {
    if (googleClientId !== undefined) throw new DeployError('--check does not take --google-client-id', 2);
    if (takeOverHostname) throw new DeployError('--check does not take --take-over-hostname (it only matters for a deploy)', 2);
    return { mode, url: checkTarget(url as string), waitSeconds: wait ?? 20, ...(webDist !== undefined ? { webDist } : {}) };
  }
  if (webDist !== undefined) throw new DeployError('--web-dist only goes with --check: a deploy compares with the apps/web/dist it has just built', 2);
  return {
    mode,
    ...(url !== undefined ? { url: deployUrlOf(url) } : {}),
    ...(googleClientId !== undefined ? { googleClientId: googleClientIdOf(googleClientId) } : {}),
    waitSeconds: wait ?? 180,
    ...(takeOverHostname ? { takeOverHostname } : {}),
  };
}

/**
 * --url of a deploy: an https origin that is either this Worker on workers.dev (`workersDevOrigin`) or a custom-domain
 * hostname (`customDomainHost`). Whether it is the right one is decided against wrangler.jsonc (step 3).
 */
export function deployUrlOf(text: string): string {
  let origin: URL;
  try {
    origin = relayOrigin(text.trim());
  } catch (error) {
    if (error instanceof RelayUrlError) throw new DeployError(`--url is not a valid URL: ${text}`, 2);
    throw error;
  }
  if (origin.protocol !== 'https:') throw new DeployError(`--url must be https (got ${text})`, 2);
  if (isWorkersDevHost(origin.hostname)) return workersDevOrigin(text);
  if (origin.port !== '' || customDomainHost(origin.hostname) === null) {
    throw new DeployError(`--url must be https://smurg-relay.<your subdomain>.workers.dev or https://<custom domain> (got ${text})`, 2);
  }
  return origin.origin;
}

function isWorkersDevHost(hostname: string): boolean {
  return hostname === 'workers.dev' || hostname.endsWith('.workers.dev');
}

/** The production URL on workers.dev: `https://<worker>.<subdomain>.workers.dev` exactly (no path, lower case). */
export function workersDevOrigin(text: string, workerName = 'smurg-relay'): string {
  let origin: string;
  try {
    origin = relayOrigin(text.trim()).origin;
  } catch (error) {
    if (error instanceof RelayUrlError) throw new DeployError(`--url is not a valid URL: ${text}`, 2);
    throw error;
  }
  const pattern = new RegExp(`^https://${workerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9-]+)?\\.workers\\.dev$`);
  if (!pattern.test(origin)) throw new DeployError(`--url must be https://${workerName}.<your subdomain>.workers.dev (got ${text})`, 2);
  return origin;
}

/** --check: any https relay origin, or http on this machine (a local relay). */
function checkTarget(text: string): string {
  try {
    return relayOrigin(text.trim()).origin;
  } catch (error) {
    if (error instanceof RelayUrlError) throw new DeployError(`the URL given to --check is not valid: ${text} (https; on this machine http://127.0.0.1:<port> also works)`, 2);
    throw error;
  }
}

const GOOGLE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.apps\.googleusercontent\.com$/;

export function googleClientIdOf(text: string): string {
  const id = text.trim();
  if (!GOOGLE_CLIENT_ID.test(id)) throw new DeployError(`--google-client-id does not look like a Google OAuth client ID (expected ...apps.googleusercontent.com): ${text}`, 2);
  return id;
}

// ── wrangler.jsonc ───────────────────────────────────────────────────────────────────────────────────────────────

/** JSONC → JSON text: comments outside strings removed (wrangler.jsonc has `//` inside URL strings). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

export interface ProductionConfigView {
  readonly name?: string;
  readonly workers_dev?: boolean;
  readonly preview_urls?: boolean;
  /** wrangler's single-route form; never used here (refused). */
  readonly route?: unknown;
  readonly routes?: readonly unknown[];
  readonly vars: Readonly<Record<string, unknown>>;
  readonly migrations?: readonly { readonly tag?: string; readonly new_sqlite_classes?: readonly string[] }[];
  readonly durable_objects?: { readonly bindings?: readonly { readonly name: string; readonly class_name: string }[] };
  readonly assets?: { readonly directory?: string; readonly not_found_handling?: string; readonly run_worker_first?: boolean | readonly string[] };
  readonly secrets?: { readonly required?: readonly string[] };
}

export function parseWranglerJsonc(text: string): ProductionConfigView & Record<string, unknown> {
  try {
    return JSON.parse(stripJsonComments(text)) as ProductionConfigView & Record<string, unknown>;
  } catch {
    throw new DeployError('cannot parse apps/relay/wrangler.jsonc (JSONC)');
  }
}

/** '' (not deployed yet) or an https origin. */
function issuerProblem(issuer: unknown): string | null {
  if (issuer === '') return null;
  if (typeof issuer !== 'string') return 'RELAY_ISSUER must be a string';
  try {
    const origin = relayOrigin(issuer);
    if (origin.protocol !== 'https:' || origin.origin !== issuer) return `RELAY_ISSUER must be an https origin without a path (it is ${issuer})`;
  } catch {
    return `RELAY_ISSUER is not a valid URL (${issuer})`;
  }
  return null;
}

// ── Where the relay answers: workers.dev or one custom domain ────────────────────────────────────────────────────

/**
 * How wrangler 4.142 names a deployed Cloudflare Custom Domain in the deploy targets: `renderRoute` (deploy-helpers
 * src/triggers/publish-routes.ts) appends " (custom domain)" to the route's pattern when the route has neither zone_id
 * nor zone_name nor enabled / previews_enabled flags, and `triggersDeploy` adds "https://" only to workers.dev targets.
 */
export const CUSTOM_DOMAIN_TARGET_SUFFIX = ' (custom domain)';

export type RelayHosting =
  /** "workers_dev": true and no routes: https://<worker name>.<account subdomain>.workers.dev. */
  | { readonly kind: 'workers-dev' }
  /** "workers_dev": false and exactly one route { "pattern": host, "custom_domain": true }: https://<host>. */
  | { readonly kind: 'custom-domain'; readonly host: string; readonly origin: string };

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const CUSTOM_DOMAIN_HOST = new RegExp(`^(?=.{1,253}$)(?:${DNS_LABEL}\\.)+${DNS_LABEL}$`);

/**
 * A Cloudflare Custom Domain hostname as wrangler.jsonc must name it: lower case, at least two labels, no wildcard,
 * port, path or trailing dot, not an IP address, not a local name and not workers.dev. Null when it is not one.
 */
export function customDomainHost(text: string): string | null {
  if (!CUSTOM_DOMAIN_HOST.test(text)) return null;
  if (/^\d+$/.test(text.slice(text.lastIndexOf('.') + 1))) return null;
  if (isWorkersDevHost(text) || isLocalHostname(text)) return null;
  return text;
}

/**
 * Which of the two supported shapes the TOP LEVEL of wrangler.jsonc has (`hosting`), or why it has neither
 * (`problems`, and `hosting` null). The relay must have exactly one public hostname: workers.dev with no routes, or
 * workers.dev off and exactly one custom domain (no zone-bound route, no second hostname in front of the same Durable
 * Objects).
 */
export function relayHostingOf(config: Pick<ProductionConfigView, 'workers_dev' | 'route' | 'routes'>): { readonly hosting: RelayHosting | null; readonly problems: readonly string[] } {
  const problems: string[] = [];
  if (config.route !== undefined) problems.push('"route" (singular) is not allowed: a custom domain goes in "routes" (exactly one custom_domain entry)');
  const routes: readonly unknown[] = Array.isArray(config.routes) ? config.routes : [];
  if (config.routes !== undefined && !Array.isArray(config.routes)) problems.push('"routes" must be an array');
  if (config.workers_dev === true) {
    if (routes.length > 0) problems.push(`with workers_dev true there must be no routes (found ${routes.length}): the relay has exactly one public hostname, workers.dev or one custom domain`);
    return problems.length === 0 ? { hosting: { kind: 'workers-dev' }, problems } : { hosting: null, problems };
  }
  if (config.workers_dev !== false) {
    problems.push('workers_dev must be written explicitly: true (workers.dev) or false (a custom domain)');
    return { hosting: null, problems };
  }
  const shape = '{ "pattern": "<domain>", "custom_domain": true }';
  if (routes.length !== 1) {
    problems.push(`with workers_dev false, routes must be exactly one custom domain ${shape} (found ${routes.length})`);
    return { hosting: null, problems };
  }
  const route = routes[0] as Record<string, unknown> | null;
  if (typeof route !== 'object' || route === null || route['custom_domain'] !== true || Object.keys(route).sort().join(',') !== 'custom_domain,pattern') {
    problems.push(`routes[0] must be exactly ${shape} (not an ordinary route, and without zone_id, zone_name or any other field): ${JSON.stringify(route)}`);
    return { hosting: null, problems };
  }
  const host = typeof route['pattern'] === 'string' ? customDomainHost(route['pattern']) : null;
  if (host === null) {
    problems.push(`routes[0].pattern must be a hostname (lower case; no *, path or port; not workers.dev): ${JSON.stringify(route['pattern'])}`);
    return { hosting: null, problems };
  }
  return problems.length === 0 ? { hosting: { kind: 'custom-domain', host, origin: `https://${host}` }, problems } : { hosting: null, problems };
}

/**
 * What would make the TOP LEVEL of wrangler.jsonc (production) unfit for the Free plan / Google-only relay on
 * workers.dev or on one custom domain (`relayHostingOf`). Empty = fine. On workers.dev `RELAY_ISSUER` may still be ''
 * (before the first deploy: the deploy fills it in); on a custom domain it must be https://<host> already.
 */
export function productionConfigProblems(config: ProductionConfigView): string[] {
  const problems: string[] = [];
  const vars = config.vars ?? {};
  const { hosting, problems: hostingIssues } = relayHostingOf(config);
  problems.push(...hostingIssues);
  if (config.preview_urls !== false) problems.push('preview_urls must be false (every version would get one more public URL)');
  if (vars['DEV_LOGIN'] !== '0') problems.push('vars.DEV_LOGIN must be "0" in production');
  if (vars['RELAY_TAP_URL'] !== '') problems.push('vars.RELAY_TAP_URL must be the empty string in production');
  const github = Object.keys(vars).filter((name) => name.startsWith('GITHUB_'));
  if (github.length > 0) problems.push(`production uses Google login only: the top-level vars must not have ${github.join(', ')}`);
  const issuer = vars['RELAY_ISSUER'];
  const issuerIssue = issuerProblem(issuer);
  if (issuerIssue) problems.push(issuerIssue);
  else if (hosting?.kind === 'custom-domain' && issuer !== hosting.origin) {
    problems.push(`vars.RELAY_ISSUER must be the custom domain's URL ${hosting.origin} (it is ${String(issuer) || 'the empty string'})`);
  } else if (hosting?.kind === 'workers-dev' && issuer !== '' && workersDevTarget([String(issuer)], config.name ?? 'smurg-relay') !== issuer) {
    problems.push(`vars.RELAY_ISSUER must be the empty string (before the first deploy) or https://${config.name ?? 'smurg-relay'}.<subdomain>.workers.dev (it is ${String(issuer)})`);
  }
  if (vars['ALLOWED_ORIGINS'] !== vars['RELAY_ISSUER']) problems.push('vars.ALLOWED_ORIGINS must equal RELAY_ISSUER (the relay serves the web app itself)');
  const clientId = vars['GOOGLE_CLIENT_ID'];
  if (clientId !== '' && !(typeof clientId === 'string' && GOOGLE_CLIENT_ID.test(clientId))) problems.push(`vars.GOOGLE_CLIENT_ID is not a Google OAuth client ID (${String(clientId)})`);
  for (const [name, url] of Object.entries(GOOGLE_ENDPOINTS)) {
    if (vars[name] !== url) problems.push(`vars.${name} must be ${url}`);
  }
  if (!config.secrets?.required?.includes(SIGNING_KEY_SECRET)) problems.push(`secrets.required must list ${SIGNING_KEY_SECRET}`);
  const bindings = (config.durable_objects?.bindings ?? []).map((b) => `${b.name}:${b.class_name}`).join(',');
  if (bindings !== 'WORKSPACE:WorkspaceDO,TRANSFER:TransferDO,DEVICE_LOGIN:DeviceLoginDO') {
    problems.push('durable_objects must be WORKSPACE (WorkspaceDO), TRANSFER (TransferDO) and DEVICE_LOGIN (DeviceLoginDO)');
  }
  // Exactly the migrations already applied in production, in order, plus new tags after them: v1 was deployed on
  // 2026-10-01; a class added to v1 afterwards would never be created (Cloudflare applies each tag once).
  const migrations = (config.migrations ?? []).map((m) => `${m.tag ?? ''}:${(m.new_sqlite_classes ?? []).join('+')}:${Object.keys(m).sort().join('+')}`).join(',');
  if (migrations !== 'v1:WorkspaceDO+TransferDO:new_sqlite_classes+tag,v2:DeviceLoginDO:new_sqlite_classes+tag') {
    problems.push('migrations must be exactly v1 (new_sqlite_classes: WorkspaceDO, TransferDO) and v2 (new_sqlite_classes: DeviceLoginDO) (the Free plan only allows SQLite; a deployed v1 must not change)');
  }
  const assets = config.assets;
  if (!assets?.directory || !/(?:^|[/\\])web[/\\]dist$/.test(assets.directory)) problems.push('assets.directory must be ../web/dist');
  if (assets?.not_found_handling !== 'single-page-application') problems.push('assets.not_found_handling must be single-page-application');
  if (JSON.stringify(assets?.run_worker_first) !== JSON.stringify(RELAY_WORKER_FIRST_PATTERNS)) problems.push('assets.run_worker_first must equal RELAY_WORKER_FIRST_PATTERNS of @smurg/protocol');
  return problems;
}

export type ProductionVarName = 'RELAY_ISSUER' | 'ALLOWED_ORIGINS' | 'GOOGLE_CLIENT_ID';

/**
 * Sets string values in the TOP-LEVEL `vars` of wrangler.jsonc (production) and nothing else: comments, formatting and
 * env.dev stay as they are. Refuses unless each name appears exactly once in that block and the re-parsed result
 * equals the original with exactly those values changed.
 */
export function setProductionVars(text: string, values: Readonly<Partial<Record<ProductionVarName, string>>>): string {
  const start = /^ {2}"vars": \{[ \t]*$/m.exec(text);
  if (!start) throw new DeployError('wrangler.jsonc: the top-level "vars" block was not found');
  const bodyStart = start.index + start[0].length;
  const end = /^ {2}\},?[ \t]*$/m.exec(text.slice(bodyStart));
  if (!end) throw new DeployError('wrangler.jsonc: the end of the top-level "vars" block was not found');
  const bodyEnd = bodyStart + end.index;
  let body = text.slice(bodyStart, bodyEnd);
  for (const [name, value] of Object.entries(values) as [ProductionVarName, string][]) {
    const line = new RegExp(`^( {4}"${name}": )"(?:[^"\\\\\\n]|\\\\.)*"`, 'gm');
    const count = body.match(line)?.length ?? 0;
    if (count !== 1) throw new DeployError(`wrangler.jsonc: "${name}" appears ${count} times in the top-level vars (expected exactly once)`);
    body = body.replace(line, (_all, prefix: string) => `${prefix}${JSON.stringify(value)}`);
  }
  const out = text.slice(0, bodyStart) + body + text.slice(bodyEnd);
  const original = parseWranglerJsonc(text);
  const expected = { ...original, vars: { ...original.vars, ...values } };
  if (JSON.stringify(parseWranglerJsonc(out)) !== JSON.stringify(expected)) throw new DeployError('wrangler.jsonc: the edited text is not what was expected; nothing was written');
  return out;
}

/** The production config as wrangler resolves it (`--env ""`). */
export async function readProductionConfig(path = WRANGLER_CONFIG): Promise<ProductionConfigView & { readonly name: string }> {
  const { unstable_readConfig } = await import('wrangler');
  const config = unstable_readConfig({ config: path, env: '' }, { hideWarnings: true });
  return config as unknown as ProductionConfigView & { readonly name: string };
}

// ── wrangler output ──────────────────────────────────────────────────────────────────────────────────────────────

export type WhoAmI = { readonly loggedIn: false } | { readonly loggedIn: true; readonly accounts: readonly { readonly id: string; readonly name: string }[] };

/** `wrangler whoami --json`: `{loggedIn:true, accounts:[{id,name}], …}` (exit 0) or `{loggedIn:false}` (exit ≠ 0). */
export function parseWhoami(stdout: string, exitCode: number): WhoAmI {
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  if (exitCode !== 0 || first < 0 || last < first) return { loggedIn: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(first, last + 1));
  } catch {
    return { loggedIn: false };
  }
  const record = parsed as { loggedIn?: unknown; accounts?: unknown };
  if (record.loggedIn !== true || !Array.isArray(record.accounts)) return { loggedIn: false };
  const accounts = record.accounts
    .filter((a): a is { id: string; name: unknown } => typeof (a as { id?: unknown })?.id === 'string')
    .map((a) => ({ id: a.id, name: typeof a.name === 'string' ? a.name : a.id }));
  return { loggedIn: true, accounts };
}

export type SecretList = { readonly kind: 'names'; readonly names: readonly string[] } | { readonly kind: 'no-worker' } | { readonly kind: 'error'; readonly detail: string };

/** `wrangler secret list --format json`: `[{"name":…,"type":"secret_text"}]`, or `Worker "<name>" not found.` */
export function parseSecretList(stdout: string, stderr: string, exitCode: number): SecretList {
  if (exitCode !== 0) {
    if (/Worker "[^"]+"(?: \(env: [^)]*\))? not found/.test(`${stdout}\n${stderr}`)) return { kind: 'no-worker' };
    return { kind: 'error', detail: lastLines(`${stderr}\n${stdout}`) };
  }
  const start = stdout.search(/^\s*\[/m);
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) return { kind: 'error', detail: 'the output of wrangler secret list is not JSON' };
  try {
    const list = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    if (!Array.isArray(list)) return { kind: 'error', detail: 'the output of wrangler secret list is not an array' };
    return { kind: 'names', names: list.map((s) => (s as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string') };
  } catch {
    return { kind: 'error', detail: 'the output of wrangler secret list is not JSON' };
  }
}

/** The targets of the last `{"type":"deploy"}` entry wrangler wrote to WRANGLER_OUTPUT_FILE_PATH. */
export function deployTargets(ndjson: string): string[] {
  let targets: string[] = [];
  for (const line of ndjson.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; targets?: unknown };
      if (entry.type === 'deploy' && Array.isArray(entry.targets)) targets = entry.targets.filter((t): t is string => typeof t === 'string');
    } catch {
      // not an entry of ours
    }
  }
  return targets;
}

/** The workers.dev origin among the deploy targets, or null. */
export function workersDevTarget(targets: readonly string[], workerName: string): string | null {
  for (const target of targets) {
    try {
      return workersDevOrigin(target, workerName);
    } catch {
      // a route or custom domain: not the workers.dev URL
    }
  }
  return null;
}

/**
 * Why the deploy targets are not exactly what the hosting shape promises, or null: on workers.dev the Worker's
 * workers.dev URL equal to `url`; on a custom domain "<host> (custom domain)" and no workers.dev hostname at all.
 */
export function deployedTargetProblem(targets: readonly string[], hosting: RelayHosting, workerName: string, url: string): string | null {
  const listed = targets.join(', ') || 'none';
  if (hosting.kind === 'workers-dev') {
    const deployed = workersDevTarget(targets, workerName);
    return deployed === url ? null : `the deployed workers.dev URL is ${deployed ?? '(none)'}, not ${url} (targets: ${listed})`;
  }
  if (targets.some((target) => isWorkersDevHost(target.replace(/^https:\/\//, '').split(/[/ ]/, 1)[0] ?? ''))) {
    return `a relay on a custom domain must not also have workers.dev on (targets: ${listed})`;
  }
  if (!targets.includes(`${hosting.host}${CUSTOM_DOMAIN_TARGET_SUFFIX}`)) {
    return `the deploy result does not list the custom domain ${hosting.host}${CUSTOM_DOMAIN_TARGET_SUFFIX} (targets: ${listed})`;
  }
  return null;
}

function lastLines(text: string, count = 8): string {
  return text.trim().split('\n').slice(-count).join('\n');
}

// ── Checks from outside ──────────────────────────────────────────────────────────────────────────────────────────

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CheckOptions {
  /** Google login must be on (true in production once its client id and secret are set). */
  readonly expectGoogle: boolean;
  /** When known: the client id the login redirect must carry. */
  readonly googleClientId?: string;
  /**
   * When known: the web build the relay must serve, as the `/assets/…` files its index.html loads (`webAssetsOf`).
   * Vite names them by content, so the same sources build the same names.
   */
  readonly webAssets?: readonly string[];
  readonly fetch?: typeof fetch;
}

/**
 * The names of the outside checks: stable English ids. Tests, the deploy's output and docs/RELEASING.md refer to them,
 * so a name changes only together with those.
 */
export const CHECK_NAMES = Object.freeze({
  healthz: 'GET /healthz',
  loginOptions: 'GET /api/login-options',
  jwks: 'GET /.well-known/jwks.json',
  spaRoot: 'GET / (web app and CSP)',
  spaDeepLink: 'GET /join/... (SPA deep link and CSP)',
  googleLogin: 'GET /auth/google/login',
  webBuild: 'GET / (web app is the build of this checkout)',
  httpsRedirect: 'http:// redirects to https://',
});

async function probe(fetcher: typeof fetch, url: string, init: { readonly redirect?: 'follow' | 'manual' } = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'smurg-deploy-check' } });
  const text = await res.text();
  // Cloudflare answered instead of the relay (Bot Fight Mode, "I'm Under Attack", a WAF challenge or block rule): the
  // CLI and the daemon are not browsers and could not pass it either.
  const mitigated = res.headers.get('cf-mitigated');
  if (mitigated !== null) {
    throw new Error(`Cloudflare stopped this request (HTTP ${res.status}, cf-mitigated: ${mitigated}): turn off Bot Fight Mode and I'm Under Attack for this domain, and any WAF rule that challenges this URL (the CLI and the daemon are not browsers and cannot pass a challenge)`);
  }
  return { status: res.status, headers: res.headers, text };
}

/** The `/assets/…` files an index.html loads (entry script, module preloads, stylesheets), sorted, each once. */
export function webAssetsOf(indexHtml: string): string[] {
  return [...new Set([...indexHtml.matchAll(/\s(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1] as string))].sort();
}

/**
 * `webAssetsOf(<dir>/index.html)` when `dir` holds a web build, else null: missing, the development stand-in, no
 * index.html, or an index.html that loads nothing from /assets/. A build whose `_headers` or `.assetsignore`
 * scripts/check-web-dist.ts would refuse (for example one from before the HSTS line) still says which files it loads:
 * those problems stop a deploy (step 4), not the comparison of `--check`.
 */
export async function localWebAssets(dir: string = WEB_DIST): Promise<string[] | null> {
  const problem = webDistProblem(dir);
  if (problem === 'missing' || problem === 'stand-in' || problem === 'no-index') return null;
  const assets = webAssetsOf(await readFile(join(dir, 'index.html'), 'utf8'));
  return assets.length > 0 ? assets : null;
}

/** Whether browsers reach `hostname` over https only without the zone's help: *.workers.dev is under the HSTS-preloaded .dev. */
function httpsPreloaded(hostname: string): boolean {
  return isWorkersDevHost(hostname);
}

/**
 * Why the SPA answer is not the web app with its _headers, or null. `https` (an https relay: a custom domain or
 * workers.dev) also requires the Strict-Transport-Security of apps/web/public/_headers; a local http relay is not asked.
 */
function spaProblem(r: { status: number; headers: Headers; text: string }, https: boolean): string | null {
  if (r.status !== 200) return `HTTP ${r.status}`;
  if (!(r.headers.get('content-type') ?? '').startsWith('text/html')) return `content-type ${r.headers.get('content-type') ?? '(none)'}`;
  if (r.text.includes(STAND_IN_TEXT)) return 'this is the development stand-in page, not a web build';
  if (!r.text.includes('<div id="root"></div>') || !/<script type="module"[^>]*src="\/assets\//.test(r.text)) return "this is not the smurg web app's index.html";
  const csp = r.headers.get('content-security-policy') ?? '';
  if (!csp.includes("frame-ancestors 'none'") || !csp.includes("default-src 'self'")) return `the Content-Security-Policy of _headers is missing (${csp || 'none'})`;
  if ((r.headers.get('x-frame-options') ?? '').toUpperCase() !== 'DENY') return 'X-Frame-Options: DENY is missing';
  if (r.headers.get('x-content-type-options') !== 'nosniff') return 'X-Content-Type-Options: nosniff is missing';
  if (https) {
    // Two Strict-Transport-Security headers (_headers' and, say, the zone's HSTS setting) reach fetch() joined with
    // ', '; a browser processes only the first one (RFC 6797 §8.1), so only the first one is judged.
    const hsts = r.headers.get('strict-transport-security');
    if (hsts === null || hstsMaxAge(hsts.split(',')[0] as string) === null) {
      return `the Strict-Transport-Security of _headers is missing (max-age at least ${HSTS_MIN_MAX_AGE}; got ${hsts ?? 'none'}). If the live web app was built before apps/web/public/_headers had this line, deploy again from the commit to release: scripts/deploy-relay.sh`;
    }
  }
  return null;
}

/** One pass of the outside checks against a deployed relay (no session, nothing stored). */
export async function checkRelay(origin: string, options: CheckOptions): Promise<CheckResult[]> {
  const fetcher = options.fetch ?? fetch;
  const results: CheckResult[] = [];
  const run = async (name: string, check: () => Promise<string | null>): Promise<void> => {
    try {
      const problem = await check();
      results.push({ name, ok: problem === null, detail: problem ?? 'OK' });
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  };
  await run(CHECK_NAMES.healthz, async () => {
    const r = await probe(fetcher, relayHttpUrl(origin, RELAY_PATHS.healthz));
    return r.status === 200 && r.text.trim() === 'ok' ? null : `HTTP ${r.status}`;
  });
  await run(CHECK_NAMES.loginOptions, async () => {
    const r = await probe(fetcher, relayHttpUrl(origin, RELAY_PATHS.loginOptions));
    if (r.status !== 200) return `HTTP ${r.status}${r.status === 500 ? ' (RELAY_ISSUER or the signing key is not set up)' : ''}`;
    const parsed = relayLoginOptionsSchema.safeParse(JSON.parse(r.text));
    if (!parsed.success) return `unexpected response: ${r.text.slice(0, 200)}`;
    const { providers, dev } = parsed.data;
    const seen = `google=${providers.google} github=${providers.github} dev=${dev}`;
    if (dev) return `${seen}: the development login must be off in production`;
    if (providers.github) return `${seen}: production uses Google login only`;
    if (providers.google !== options.expectGoogle) return `${seen}: expected google=${options.expectGoogle}`;
    return null;
  });
  await run(CHECK_NAMES.jwks, async () => {
    const r = await probe(fetcher, relayHttpUrl(origin, RELAY_PATHS.jwks));
    if (r.status !== 200) return `HTTP ${r.status}${r.status === 500 ? ` (${SIGNING_KEY_SECRET} is missing or malformed)` : ''}`;
    const keys = (JSON.parse(r.text) as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length === 0) return 'no public key at all';
    for (const key of keys as Record<string, unknown>[]) {
      if (key['kty'] !== 'OKP' || key['crv'] !== 'Ed25519' || typeof key['kid'] !== 'string' || typeof key['x'] !== 'string') return 'a public key is not an Ed25519 JWK';
      if ('d' in key) return 'the private key (d) is published';
    }
    return null;
  });
  const https = new URL(origin).protocol === 'https:';
  await run(CHECK_NAMES.spaRoot, async () => spaProblem(await probe(fetcher, `${origin}/`), https));
  await run(CHECK_NAMES.spaDeepLink, async () => spaProblem(await probe(fetcher, `${origin}/join/smurg-deploy-check`), https));
  await run(CHECK_NAMES.googleLogin, async () => {
    const r = await probe(fetcher, relayHttpUrl(origin, authLoginPath('google')), { redirect: 'manual' });
    if (!options.expectGoogle) return r.status === 503 ? null : `HTTP ${r.status} (expected 503 while Google is not set up)`;
    if (r.status !== 302) return `HTTP ${r.status} (expected a redirect to Google)`;
    const location = new URL(r.headers.get('location') ?? 'about:blank');
    if (location.origin !== new URL(GOOGLE_ENDPOINTS.GOOGLE_AUTHORIZE_URL).origin) return `redirects to ${location.origin}, not to Google`;
    const redirectUri = location.searchParams.get('redirect_uri');
    if (redirectUri !== `${origin}${authCallbackPath('google')}`) return `redirect_uri is ${redirectUri ?? '(none)'}, expected ${origin}${authCallbackPath('google')} (is RELAY_ISSUER wrong?)`;
    const clientId = location.searchParams.get('client_id') ?? '';
    if (options.googleClientId !== undefined ? clientId !== options.googleClientId : !GOOGLE_CLIENT_ID.test(clientId)) return `client_id is ${clientId || '(none)'}`;
    if (https) {
      const cookie = r.headers.get('set-cookie') ?? '';
      if (!cookie.includes('__Host-') || !/;\s*Secure/i.test(cookie)) return 'an https relay must use a Secure cookie whose name starts with __Host-';
    }
    return null;
  });
  const wanted = options.webAssets;
  if (wanted !== undefined) {
    await run(CHECK_NAMES.webBuild, async () => {
      const r = await probe(fetcher, `${origin}/`);
      if (r.status !== 200) return `HTTP ${r.status}`;
      const live = webAssetsOf(r.text);
      if (live.join(' ') === wanted.join(' ')) return null;
      return (
        `the live web app loads ${live.join(' ') || '(no /assets/ files)'}, the build here is ${wanted.join(' ')}: the live web app is not the build of this checkout. ` +
        "An older web app refuses a newer daemon's channel.welcome (unknown fields), so deploy again from the commit to release: scripts/deploy-relay.sh " +
        '(if apps/web/dist is only stale or holds uncommitted changes: pnpm --filter @smurg/web build, then compare again)'
      );
    });
  }
  const { protocol, hostname } = new URL(origin);
  if (protocol === 'https:' && !isLocalHostname(hostname) && !httpsPreloaded(hostname)) {
    await run(CHECK_NAMES.httpsRedirect, async () => {
      const plain = relayHttpUrl(origin, RELAY_PATHS.healthz).replace(/^https:/, 'http:');
      const r = await probe(fetcher, plain, { redirect: 'manual' });
      const location = r.headers.get('location');
      if ((r.status === 301 || r.status === 308) && location === relayHttpUrl(origin, RELAY_PATHS.healthz)) return null;
      return (
        `${plain} answers HTTP ${r.status}${location !== null ? ` (redirecting to ${location})` : ''}, not a permanent redirect to https://: ` +
        'on a domain without HSTS preload a browser may connect over http the first time, and anyone on the network could then replace the web app. ' +
        "In the Cloudflare dashboard, open this domain's zone -> SSL/TLS -> Edge Certificates and turn on Always Use HTTPS"
      );
    });
  }
  return results;
}

/** checkRelay until everything passes or `waitMs` is over (a new workers.dev hostname or custom domain can take minutes). */
export async function checkRelayUntil(origin: string, options: CheckOptions & { readonly waitMs: number; readonly intervalMs?: number; readonly onRetry?: (failed: readonly CheckResult[]) => void }): Promise<CheckResult[]> {
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const results = await checkRelay(origin, options);
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0 || Date.now() + (options.intervalMs ?? 5_000) > deadline) return results;
    options.onRetry?.(failed);
    await new Promise((done) => setTimeout(done, options.intervalMs ?? 5_000));
  }
}

export function formatChecks(results: readonly CheckResult[]): string {
  return results.map((r) => `  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.detail}`}`).join('\n');
}

// ── Who answers at a custom domain before a deploy ───────────────────────────────────────────────────────────────

/** Nothing (the name does not resolve), a smurg relay (a redeploy), or something else (`detail` says what was seen). */
export type HostnameOccupant = { readonly kind: 'none' } | { readonly kind: 'relay' } | { readonly kind: 'other'; readonly detail: string };

/** Whether a hostname resolves; false only for "no such name" (a lookup that cannot run is an error). */
export async function hostResolves(host: string): Promise<boolean> {
  try {
    await lookup(host);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return false;
    throw new DeployError(`the DNS lookup of ${host} failed (${code ?? String(error)}): check the network and run this again`);
  }
}

/**
 * What answers at https://<host> now. A smurg relay answers /healthz with "ok" and /api/login-options with its schema
 * (or 500 while its issuer or signing key is missing); anything else that resolves would be replaced by the deploy.
 */
export async function hostnameOccupant(host: string, deps: { readonly lookupHost: (host: string) => Promise<boolean>; readonly fetch: typeof fetch }): Promise<HostnameOccupant> {
  if (!(await deps.lookupHost(host))) return { kind: 'none' };
  const origin = `https://${host}`;
  try {
    const health = await probe(deps.fetch, relayHttpUrl(origin, RELAY_PATHS.healthz), { redirect: 'manual' });
    if (health.status !== 200 || health.text.trim() !== 'ok') return { kind: 'other', detail: `${origin}/healthz answers HTTP ${health.status}` };
    const options = await probe(deps.fetch, relayHttpUrl(origin, RELAY_PATHS.loginOptions), { redirect: 'manual' });
    if (options.status === 500) return { kind: 'relay' };
    if (options.status === 200 && relayLoginOptionsSchema.safeParse(JSON.parse(options.text)).success) return { kind: 'relay' };
    return { kind: 'other', detail: `${origin}/api/login-options answers HTTP ${options.status}` };
  } catch (error) {
    return { kind: 'other', detail: `${host} has a DNS record, but ${origin} does not answer like a smurg relay (${error instanceof Error ? error.message : String(error)})` };
  }
}


// ── Running things ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the guided deploy talks to. Production uses the defaults; test/deploy-relay.test.ts replaces wrangler with a
 * fake executable, the config with a copy, the web build with nothing, and fetch with a route to a local relay.
 */
export interface DeployDeps {
  /** The wrangler executable (default: apps/relay/node_modules/.bin/wrangler), run with cwd apps/relay. */
  readonly wranglerBin?: string;
  /** The wrangler config the deploy reads and edits (default: apps/relay/wrangler.jsonc). */
  readonly configPath?: string;
  /** Step 4 (default: `pnpm --filter @smurg/web build` + scripts/check-web-dist.ts). */
  readonly buildWeb?: () => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly out?: (line: string) => void;
  readonly err?: (text: string) => void;
  /** Pause between the outside checks' retries (default 5 s). */
  readonly retryIntervalMs?: number;
  /** The web build step 4 produced and step 10 expects live (default apps/web/dist, what wrangler uploads). */
  readonly webDist?: string;
  /** Step 5 on a custom domain: whether the hostname resolves (default: a DNS lookup, `hostResolves`). */
  readonly lookupHost?: (host: string) => Promise<boolean>;
}

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command; `show` lets its output through to the operator's terminal instead of capturing it. */
function runCommand(file: string, args: readonly string[], options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly show: boolean }): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.show ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < 4_000_000) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 4_000_000) stderr += chunk;
    });
    child.once('error', fail);
    child.once('close', (code, signal) => done({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

async function buildWebDefault(): Promise<void> {
  const built = await runCommand('pnpm', ['--filter', '@smurg/web', 'build'], { cwd: REPO_ROOT, show: true });
  if (built.code !== 0) throw new DeployError(`the web build failed (pnpm --filter @smurg/web build, exit code ${built.code})`);
  const checked = await runCommand(process.execPath, [join(RELAY_DIR, 'scripts', 'check-web-dist.ts')], { cwd: RELAY_DIR, show: true });
  if (checked.code !== 0) throw new DeployError('the web build cannot be deployed (scripts/check-web-dist.ts)');
}

class Tools {
  readonly configPath: string;
  readonly buildWeb: () => Promise<void>;
  readonly fetch: typeof fetch;
  readonly retryIntervalMs: number;
  readonly webDist: string;
  readonly lookupHost: (host: string) => Promise<boolean>;
  private readonly wranglerBin: string;
  private readonly write: (line: string) => void;

  constructor(deps: DeployDeps) {
    this.wranglerBin = deps.wranglerBin ?? WRANGLER_BIN;
    this.configPath = deps.configPath ?? WRANGLER_CONFIG;
    this.buildWeb = deps.buildWeb ?? buildWebDefault;
    this.fetch = deps.fetch ?? fetch;
    this.retryIntervalMs = deps.retryIntervalMs ?? 5_000;
    this.webDist = deps.webDist ?? WEB_DIST;
    this.lookupHost = deps.lookupHost ?? hostResolves;
    this.write = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  }

  out(text = ''): void {
    this.write(text);
  }

  step(n: number, total: number, text: string): void {
    this.out(`\n── [${n}/${total}] ${text}`);
  }

  wrangler(args: readonly string[], options: { readonly show: boolean; readonly env?: NodeJS.ProcessEnv }): Promise<Ran> {
    return runCommand(this.wranglerBin, args, { cwd: RELAY_DIR, show: options.show, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...options.env } });
  }

  async whoami(): Promise<WhoAmI> {
    const ran = await this.wrangler(['whoami', '--json'], { show: false });
    return parseWhoami(ran.stdout, ran.code);
  }

  async secretList(): Promise<SecretList> {
    const ran = await this.wrangler(['secret', 'list', '--config', this.configPath, '--env=', '--format', 'json'], { show: false });
    return parseSecretList(ran.stdout, ran.stderr, ran.code);
  }

  /** `wrangler deploy --env ""` (output shown to the operator); returns the deploy targets. */
  async deploy(): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), 'smurg-deploy-'));
    try {
      const outputFile = join(dir, 'wrangler-output.ndjson');
      const ran = await this.wrangler(['deploy', '--config', this.configPath, '--env='], { show: true, env: { WRANGLER_OUTPUT_FILE_PATH: outputFile } });
      if (ran.code !== 0) {
        throw new DeployError(
          [
            `wrangler deploy failed (exit code ${ran.code}). Common causes:`,
            '  - workers.dev: the account has no workers.dev subdomain yet: open the https://dash.cloudflare.com/<account>/workers/onboarding page that wrangler printed, choose one, and run this again.',
            '  - custom domain: the zone of the domain must be on the same Cloudflare account (with Cloudflare as its DNS).',
            `  - ${SIGNING_KEY_SECRET} is missing: run  ${OWNER_COMMANDS.signingKey}`,
            '  - the login expired: log in again and run this again.',
          ].join('\n'),
        );
      }
      return deployTargets(await readFile(outputFile, 'utf8').catch(() => ''));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async dryRunDeploy(vars: Readonly<Record<string, string>>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'smurg-deploy-dry-'));
    try {
      const args = ['deploy', '--dry-run', '--config', this.configPath, '--env=', '--outdir', dir, ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`])];
      const ran = await this.wrangler(args, { show: true });
      if (ran.code !== 0) throw new DeployError(`wrangler deploy --dry-run failed (exit code ${ran.code})`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Writes the values into the config's top-level vars (atomically: a temp file renamed over it). */
  async writeProductionVars(values: Readonly<Partial<Record<ProductionVarName, string>>>): Promise<void> {
    const before = await readFile(this.configPath, 'utf8');
    const after = setProductionVars(before, values);
    if (after === before) return;
    const temp = `${this.configPath}.tmp-${process.pid}`;
    await writeFile(temp, after);
    await rename(temp, this.configPath);
  }
}

// ── The guided deploy ────────────────────────────────────────────────────────────────────────────────────────────

function googleConsoleText(url: string, hosting: RelayHosting): string {
  return [
    `  Google Cloud console -> APIs & Services -> Credentials -> your OAuth client (Web application):`,
    `    Authorized JavaScript origins: ${url}`,
    `    Authorized redirect URIs:      ${url}${authCallbackPath('google')}`,
    ...(hosting.kind === 'custom-domain'
      ? [`  Google Auth Platform -> Branding -> Authorized domains: the domain you own that ${hosting.host} belongs to (the zone on Cloudflare, e.g. app.smurg.ai -> smurg.ai)`]
      : []),
  ].join('\n');
}

/** Refuses to run outside scripts/deploy-relay.sh: wrangler's login must live in <repo>/.xdg (scripts/env.sh). */
function assertRepoEnvironment(): void {
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg === undefined || resolve(xdg) !== resolve(REPO_ROOT, '.xdg')) {
    throw new DeployError("run this through scripts/deploy-relay.sh (it sources scripts/env.sh, so wrangler keeps its login in the repository's .xdg/)", 2);
  }
}

async function requireLogin(t: Tools): Promise<void> {
  const who = await t.whoami();
  if (!who.loggedIn) {
    throw new DeployError(`wrangler is not logged in to Cloudflare (its login is kept in ${join(REPO_ROOT, '.xdg')}). From the repository root, run:\n  source scripts/env.sh\n  ${OWNER_COMMANDS.login}`, 3);
  }
  const chosen = process.env['CLOUDFLARE_ACCOUNT_ID'];
  if (who.accounts.length === 0) throw new DeployError('this Cloudflare login sees no account at all', 3);
  const account = chosen ? who.accounts.find((a) => a.id === chosen) : who.accounts.length === 1 ? who.accounts[0] : undefined;
  if (!account) {
    throw new DeployError(
      [
        chosen ? `CLOUDFLARE_ACCOUNT_ID=${chosen} is not an account this login can use.` : 'This Cloudflare login has several accounts. Say which one to deploy to:',
        ...who.accounts.map((a) => `  ${a.id}  ${a.name}`),
        '  then run: CLOUDFLARE_ACCOUNT_ID=<account ID> scripts/deploy-relay.sh ...',
      ].join('\n'),
      3,
    );
  }
  t.out(`  Logged in to the Cloudflare account ${account.name} (${account.id})`);
}

async function runDeploy(t: Tools, options: DeployOptions): Promise<number> {
  const dryRun = options.mode === 'dry-run';
  const total = 10;
  t.out(dryRun ? 'smurg relay deploy: --dry-run (no contact with the Cloudflare account: no login check, no secret check, no deploy, no change to wrangler.jsonc)' : 'smurg relay deploy (Cloudflare Workers, Free plan, Google login only)');

  t.step(1, total, 'Cloudflare login (wrangler whoami)');
  if (dryRun) t.out(`  (--dry-run: skipped. A deploy that finds no login asks you to run: ${OWNER_COMMANDS.login})`);
  else await requireLogin(t);

  t.step(2, total, `Secrets: ${SIGNING_KEY_SECRET} must exist before the first deploy`);
  if (dryRun) t.out('  (--dry-run: wrangler secret list skipped)');
  else {
    const secrets = await t.secretList();
    if (secrets.kind === 'error') throw new DeployError(`wrangler secret list failed:\n${secrets.detail}`);
    if (secrets.kind === 'no-worker' || !secrets.names.includes(SIGNING_KEY_SECRET)) {
      throw new DeployError(
        [
          secrets.kind === 'no-worker' ? 'This account has no Worker named smurg-relay yet.' : `The Worker has no ${SIGNING_KEY_SECRET}.`,
          `wrangler refuses a deploy without ${SIGNING_KEY_SECRET} (secrets.required in wrangler.jsonc). Put the signing key first`,
          '(when the Worker does not exist yet, wrangler creates an empty smurg-relay Worker for it), then run this script again. From the repository root:',
          '  source scripts/env.sh',
          `  ${OWNER_COMMANDS.signingKey}`,
          'The key only goes through the pipe to wrangler: it is never shown on screen and never written to a file.',
        ].join('\n'),
        3,
      );
    }
    t.out(`  ${SIGNING_KEY_SECRET}: set`);
  }

  t.step(3, total, 'Production settings in wrangler.jsonc');
  let config = await readProductionConfig(t.configPath);
  const problems = productionConfigProblems(config);
  if (problems.length > 0) throw new DeployError(`wrangler.jsonc is not fit for production:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  // productionConfigProblems is empty, so the config has exactly one of the two supported shapes.
  const hosting = relayHostingOf(config).hosting as RelayHosting;
  const configuredUrl = String(config.vars['RELAY_ISSUER'] ?? '');
  const configuredClientId = String(config.vars['GOOGLE_CLIENT_ID'] ?? '');
  if (hosting.kind === 'custom-domain') {
    t.out(`  Public hostname: the Cloudflare Custom Domain ${hosting.host} (workers.dev off)`);
    if (options.url !== undefined && options.url !== hosting.origin) {
      throw new DeployError(
        `--url ${options.url} is not the custom domain of wrangler.jsonc, ${hosting.origin}.` +
          (isWorkersDevHost(new URL(options.url).hostname)
            ? '\nTo deploy to workers.dev (self-hosting): in wrangler.jsonc set "workers_dev" to true, delete "routes", and set RELAY_ISSUER, ALLOWED_ORIGINS and GOOGLE_CLIENT_ID to "" (apps/relay/README.md, "Self-hosting on workers.dev").'
            : '\nTo use another domain: change routes[0].pattern, RELAY_ISSUER and ALLOWED_ORIGINS in wrangler.jsonc (apps/relay/README.md, "Self-hosting on your own domain").'),
        2,
      );
    }
  } else {
    t.out(`  Public hostname: this account's workers.dev subdomain (https://${config.name}.<subdomain>.workers.dev)`);
    if (options.url !== undefined && workersDevTarget([options.url], config.name) !== options.url) {
      throw new DeployError(
        `--url ${options.url} is not https://${config.name}.<subdomain>.workers.dev.` +
          '\nTo use a custom domain: in wrangler.jsonc set "workers_dev" to false, add "routes": [{ "pattern": "<domain>", "custom_domain": true }], and set RELAY_ISSUER and ALLOWED_ORIGINS to https://<domain> (apps/relay/README.md, "Self-hosting on your own domain").',
        2,
      );
    }
    if (options.url !== undefined && configuredUrl !== '' && options.url !== configuredUrl) {
      t.out(`  Note: RELAY_ISSUER changes from ${configuredUrl} to ${options.url} (everyone who is logged in must log in again; the CLI's DEFAULT_RELAY_URL must change with it)`);
    }
  }
  t.out('  OK');

  t.step(4, total, 'Web build (pnpm --filter @smurg/web build) and the check of apps/web/dist');
  await t.buildWeb();
  // Step 10 expects exactly this build live (the content-hashed files its index.html loads).
  const webAssets = await localWebAssets(t.webDist);
  if (webAssets === null) throw new DeployError(`${t.webDist} is not a web build (its index.html loads no /assets/ file)`);
  t.out(`  Web app: ${webAssets.join(' ')}`);

  t.step(5, total, hosting.kind === 'custom-domain' ? "The relay's URL (custom domain)" : "The relay's workers.dev URL");
  let url = hosting.kind === 'custom-domain' ? hosting.origin : (options.url ?? (configuredUrl === '' ? null : configuredUrl));
  if (url !== null) t.out(`  ${url} ${hosting.kind === 'custom-domain' ? '(routes in wrangler.jsonc)' : options.url !== undefined ? '(--url)' : '(wrangler.jsonc)'}`);
  if (hosting.kind === 'custom-domain') {
    // wrangler, as run here, replaces whatever has the hostname without asking (header comment, step 5).
    if (dryRun) t.out(`  (--dry-run: who answers at ${hosting.host} now is not checked)`);
    else if (options.takeOverHostname) t.out(`  --take-over-hostname: an existing DNS record of ${hosting.host}, or another Worker's custom domain there, is replaced by this relay`);
    else {
      const occupant = await hostnameOccupant(hosting.host, { lookupHost: t.lookupHost, fetch: t.fetch });
      if (occupant.kind === 'other') {
        throw new DeployError(
          [
            `Something already answers at ${hosting.host}, and it is not a smurg relay: ${occupant.detail}.`,
            "The wrangler this script runs (CI=true, not interactive) replaces that hostname's DNS record, or another Worker's custom domain, with this relay without asking.",
            `  - To keep it: change routes, RELAY_ISSUER and ALLOWED_ORIGINS in wrangler.jsonc to another domain.`,
            `  - To let this relay take ${hosting.host} over: remove the old DNS record or custom domain in the Cloudflare dashboard, or run this again with --take-over-hostname.`,
          ].join('\n'),
          3,
        );
      }
      t.out(occupant.kind === 'none' ? `  ${hosting.host} has no DNS record yet: Cloudflare creates the record and the certificate during the deploy` : `  ${hosting.host} is already a smurg relay: deploying again`);
    }
  } else if (url === null && dryRun) {
    t.out('  Not known yet (the first deploy names it, or give it with --url)');
  } else if (url === null) {
    t.out('  Not known yet: deploying once to learn it (RELAY_ISSUER is empty, so the relay answers 500 to everything but /healthz and the web app, and nobody can log in)...');
    const targets = await t.deploy();
    url = workersDevTarget(targets, config.name);
    if (url === null) throw new DeployError(`the deploy result lists no workers.dev URL (targets: ${targets.join(', ') || 'none'}); give it with --url https://${config.name}.<subdomain>.workers.dev`);
    t.out(`  ${url} (from the deploy result)`);
  }

  t.step(6, total, 'wrangler.jsonc: RELAY_ISSUER, ALLOWED_ORIGINS, GOOGLE_CLIENT_ID');
  const clientId = options.googleClientId ?? configuredClientId;
  const wanted: Partial<Record<ProductionVarName, string>> = {};
  if (url !== null && url !== configuredUrl) Object.assign(wanted, { RELAY_ISSUER: url, ALLOWED_ORIGINS: url });
  if (clientId !== configuredClientId) wanted.GOOGLE_CLIENT_ID = clientId;
  if (url === null) t.out('  RELAY_ISSUER, ALLOWED_ORIGINS: the URL is not known yet; the first deploy writes them');
  if (Object.keys(wanted).length === 0) {
    if (url !== null) t.out('  Already correct: nothing to change');
  } else if (dryRun) {
    setProductionVars(await readFile(t.configPath, 'utf8'), wanted); // proves the edit would apply cleanly
    for (const [name, value] of Object.entries(wanted)) t.out(`  (--dry-run, not written) ${name} = ${value}`);
  } else {
    await t.writeProductionVars(wanted);
    for (const [name, value] of Object.entries(wanted)) t.out(`  ${name} = ${value}`);
    t.out('  Written to apps/relay/wrangler.jsonc (public settings: commit the file)');
    config = await readProductionConfig(t.configPath);
    const after = productionConfigProblems(config);
    if (after.length > 0) throw new DeployError(`wrangler.jsonc has problems after the edit:\n${after.map((p) => `  - ${p}`).join('\n')}`);
  }
  if (clientId === '') t.out('  GOOGLE_CLIENT_ID is still empty: create the Google OAuth client, then run this again with --google-client-id <client ID>');

  t.step(7, total, dryRun ? 'wrangler deploy --dry-run --env "" (nothing is deployed)' : 'wrangler deploy --env ""');
  if (dryRun) {
    await t.dryRunDeploy(wanted);
  } else {
    if (String(config.vars['RELAY_ISSUER']) !== url) throw new DeployError('RELAY_ISSUER in wrangler.jsonc is not the URL being deployed: stopped');
    const targets = await t.deploy();
    const problem = deployedTargetProblem(targets, hosting, config.name, url as string);
    if (problem !== null && hosting.kind === 'workers-dev') {
      const deployed = workersDevTarget(targets, config.name);
      throw new DeployError(
        `${problem}: the account's workers.dev subdomain was changed, or this is another Cloudflare account (self-hosting).` +
          `\nTo move to the new URL, run scripts/deploy-relay.sh --url ${deployed ?? `https://${config.name}.<subdomain>.workers.dev`}` +
          " (everyone who is logged in must log in again; the URLs of the Google OAuth client and the CLI's DEFAULT_RELAY_URL must change with it).",
      );
    }
    if (problem !== null) {
      throw new DeployError(
        `${problem}. wrangler did not report attaching ${url} to this Worker: the zone of the domain must be on the same Cloudflare account. ` +
          'Check in the Cloudflare dashboard -> Workers & Pages -> smurg-relay -> Settings -> Domains & Routes.',
      );
    }
  }

  t.step(8, total, "The relay's URL and the values for Google OAuth");
  const shownUrl = url ?? `https://${config.name}.<subdomain>.workers.dev`;
  t.out(`  relay: ${shownUrl}`);
  t.out(googleConsoleText(shownUrl, hosting));
  if (url !== null && DEFAULT_RELAY_URL !== url) {
    t.out(`  The CLI's built-in relay (packages/cli/src/relay/default-relay.ts) is ${DEFAULT_RELAY_URL === null ? 'null' : DEFAULT_RELAY_URL}; once --check passes, change it to:`);
    t.out(`    export const DEFAULT_RELAY_URL: string | null = '${url}';`);
  }

  t.step(9, total, 'Secrets');
  let googleSecret = false;
  if (dryRun) {
    t.out('  (--dry-run: wrangler secret list skipped) The secrets the relay needs:');
    t.out(`    ${SIGNING_KEY_SECRET}: ${OWNER_COMMANDS.signingKey}`);
    t.out(`    ${GOOGLE_SECRET}: ${OWNER_COMMANDS.googleSecret}`);
  } else {
    const secrets = await t.secretList();
    if (secrets.kind !== 'names') throw new DeployError(`wrangler secret list failed: ${secrets.kind === 'error' ? secrets.detail : 'the Worker does not exist'}`);
    googleSecret = secrets.names.includes(GOOGLE_SECRET);
    t.out(`  ${SIGNING_KEY_SECRET}: ${secrets.names.includes(SIGNING_KEY_SECRET) ? 'set' : 'missing'}`);
    t.out(`  ${GOOGLE_SECRET}: ${googleSecret ? 'set' : `missing. From the repository root (after source scripts/env.sh) run this, and paste Google's client secret at "Enter a secret value:":\n    ${OWNER_COMMANDS.googleSecret}`}`);
    const unexpected = secrets.names.filter((n) => n !== SIGNING_KEY_SECRET && n !== GOOGLE_SECRET);
    if (unexpected.length > 0) t.out(`  Other secrets (the relay does not use them): ${unexpected.join(', ')}`);
  }

  t.step(10, total, 'Checks from outside');
  if (dryRun || url === null) {
    t.out('  (--dry-run: nothing was deployed, skipped. After a deploy: scripts/deploy-relay.sh --check <URL>)');
    t.out('\n--dry-run finished: nothing was deployed and wrangler.jsonc was not changed.');
    return 0;
  }
  const googleReady = clientId !== '' && googleSecret;
  const results = await checkRelayUntil(url, {
    expectGoogle: googleReady,
    ...(clientId !== '' ? { googleClientId: clientId } : {}),
    webAssets,
    fetch: t.fetch,
    waitMs: options.waitSeconds * 1000,
    intervalMs: t.retryIntervalMs,
    onRetry: (failed) => t.out(`  Not passing yet (${failed.map((f) => f.name).join('; ')}); trying again shortly...`),
  });
  t.out(formatChecks(results));
  if (results.some((r) => !r.ok)) {
    t.out(`\nSome checks did not pass. A new workers.dev hostname or custom domain (DNS record and certificate) can take a few minutes to come up; later, run scripts/deploy-relay.sh --check ${url}`);
    return 1;
  }
  if (!googleReady) {
    t.out('\nDeployed, but Google login is not on yet. Next:');
    if (clientId === '') t.out('  1. In the Google Cloud console, create an OAuth client (Web application) with the origin and the redirect URI above (apps/relay/README.md).');
    if (!googleSecret) t.out(`  ${clientId === '' ? 2 : 1}. Put the client secret: ${OWNER_COMMANDS.googleSecret}`);
    t.out(`  Then: scripts/deploy-relay.sh${clientId === '' ? ' --google-client-id <client ID>' : ''}`);
    return 0;
  }
  t.out(`\nDone: ${url} is deployed and passes every check (Google login is on). Commit apps/relay/wrangler.jsonc.`);
  return 0;
}

async function runCheck(t: Tools, options: DeployOptions): Promise<number> {
  const url = options.url as string;
  t.out(`Checking ${url} from outside (expected: Google login on, no GitHub login, no development login)`);
  const webDist = options.webDist ?? t.webDist;
  const webAssets = await localWebAssets(webDist);
  t.out(
    webAssets === null
      ? `  ${webDist} holds no web build: the live web app is not compared with this checkout (to compare: pnpm --filter @smurg/web build first)`
      : `  Comparing the live web app with ${webDist} (${webAssets.join(' ')})`,
  );
  const distProblem = webAssets === null ? null : webDistProblem(webDist);
  if (distProblem !== null) {
    t.out(
      `  Note: scripts/check-web-dist.ts would refuse the build in ${webDist} (${distProblem}${distProblem === 'no-hsts' ? ': built before apps/web/public/_headers had HSTS' : ''}); ` +
        'it may be older than this checkout. The comparison uses the files it loads (to compare with this checkout: pnpm --filter @smurg/web build first)',
    );
  }
  const results = await checkRelayUntil(url, {
    expectGoogle: true,
    ...(webAssets !== null ? { webAssets } : {}),
    fetch: t.fetch,
    waitMs: options.waitSeconds * 1000,
    intervalMs: t.retryIntervalMs,
    onRetry: (failed) => t.out(`  Not passing yet (${failed.map((f) => f.name).join('; ')}); trying again shortly...`),
  });
  t.out(formatChecks(results));
  const failed = results.filter((r) => !r.ok).length;
  t.out(failed === 0 ? 'All checks passed.' : `${failed} ${failed === 1 ? 'check' : 'checks'} did not pass.`);
  return failed === 0 ? 0 : 1;
}

export async function main(argv: readonly string[], deps: DeployDeps = {}): Promise<number> {
  const t = new Tools(deps);
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  try {
    const options = parseDeployArgs(argv);
    if (options === 'help') {
      t.out(DEPLOY_USAGE);
      return 0;
    }
    if (options.mode === 'check') return await runCheck(t, options);
    assertRepoEnvironment();
    return await runDeploy(t, options);
  } catch (error) {
    if (error instanceof DeployError) {
      err(`\ndeploy-relay: ${error.message}\n`);
      return error.exitCode;
    }
    err(`\ndeploy-relay: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  }
}

// Only when run directly (scripts/deploy-relay.ts imports main instead).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
