// Guided, idempotent PRODUCTION deploy of the relay to a Cloudflare account on the Workers Free plan, Google login
// only (README.md「部署到 Cloudflare」). Entry point, from the repository root:
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
//      RELAY_ISSUER, no preview URLs, DEV_LOGIN "0", no tap, no GitHub vars, SQLite Durable Objects, SPA assets with
//      run_worker_first).
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
//   9. Secrets again: the exact command for each missing one (GOOGLE_CLIENT_SECRET is pasted by the owner; this script
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
// 3 the owner must act first (log in, choose an account, put the signing key).
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
import { HSTS_MIN_MAX_AGE, WEB_DIST, hstsMaxAge, webDistProblem } from './ensure-web-dist.ts';

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

/** The commands the OWNER runs (from the repository root, after `source scripts/env.sh`); printed, never run here. */
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

export const DEPLOY_USAGE = `用法（在 repo 根目錄）：
  scripts/deploy-relay.sh [--url https://<relay 網址>] [--google-client-id <client ID>] [--take-over-hostname] [--wait 秒]
  scripts/deploy-relay.sh --dry-run [--url …] [--google-client-id …]
  scripts/deploy-relay.sh --check <relay 網址> [--web-dist 目錄] [--wait 秒]

  把 relay 部署到你的 Cloudflare 帳號（Workers Free 方案、只用 Google 登入），可以重複執行。relay 只有一個公開網址，
  由 apps/relay/wrangler.jsonc 決定：workers.dev（"workers_dev": true、沒有 "routes"；自己架設時的預設），或一個
  Cloudflare 自訂網域（"workers_dev": false、routes 剛好一個 { "pattern": "<網域>", "custom_domain": true }）。
  --url                 relay 的網址。workers.dev：https://smurg-relay.<子網域>.workers.dev（第一次部署時可省略：
                        由部署結果得知，寫進 wrangler.jsonc）；自訂網域：必須等於 https://<routes 的網域>
  --google-client-id    Google OAuth client ID（Web application），寫進 wrangler.jsonc 的 GOOGLE_CLIENT_ID
  --take-over-hostname  自訂網域已經有別的網站、DNS 記錄或 Worker 在回應時仍然部署：wrangler 會不經詢問把它換成這個 relay
                        （沒有這個選項時腳本會停下來說明）
  --dry-run             只建置與檢查（wrangler deploy --dry-run）：不連 Cloudflare 帳號（不查登入與 secret）、不部署、
                        不改 wrangler.jsonc
  --check <網址>        只從外部檢查一個已部署的 relay（healthz、登入方式、JWKS、網頁與 CSP、Google 登入導向、網頁是不是
                        這個 checkout 的建置、自訂網域的 http:// 轉到 https://）
  --web-dist 目錄       --check 時比對的網頁建置（預設 apps/web/dist；裡面沒有建置結果時不比對）
  --wait 秒             外部檢查失敗時重試多久（預設：部署 180、--check 20）
  說明：apps/relay/README.md「部署到 Cloudflare」。
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
    if (next === undefined || next.startsWith('--')) throw new DeployError(`${name} 需要一個值`, 2);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--dry-run':
        if (mode === 'check') throw new DeployError('--dry-run 和 --check 不能同時使用', 2);
        mode = 'dry-run';
        break;
      case '--check':
        if (mode === 'dry-run') throw new DeployError('--dry-run 和 --check 不能同時使用', 2);
        mode = 'check';
        url = value(i, '--check');
        i++;
        break;
      case '--url':
        if (url !== undefined) throw new DeployError('--url 只能指定一次', 2);
        url = value(i, '--url');
        i++;
        break;
      case '--google-client-id':
        googleClientId = value(i, '--google-client-id');
        i++;
        break;
      case '--wait': {
        const text = value(i, '--wait');
        if (!/^\d{1,4}$/.test(text)) throw new DeployError('--wait 必須是秒數（0–9999）', 2);
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
        throw new DeployError(`不認得的參數 ${arg}（--help 看用法）`, 2);
    }
  }
  if (mode === 'check') {
    if (googleClientId !== undefined) throw new DeployError('--check 不接受 --google-client-id', 2);
    if (takeOverHostname) throw new DeployError('--check 不接受 --take-over-hostname（它只在部署時有作用）', 2);
    return { mode, url: checkTarget(url as string), waitSeconds: wait ?? 20, ...(webDist !== undefined ? { webDist } : {}) };
  }
  if (webDist !== undefined) throw new DeployError('--web-dist 只能和 --check 一起使用：部署時比對的是剛建置的 apps/web/dist', 2);
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
    if (error instanceof RelayUrlError) throw new DeployError(`--url 不是正確的網址：${text}`, 2);
    throw error;
  }
  if (origin.protocol !== 'https:') throw new DeployError(`--url 必須是 https（目前是 ${text}）`, 2);
  if (isWorkersDevHost(origin.hostname)) return workersDevOrigin(text);
  if (origin.port !== '' || customDomainHost(origin.hostname) === null) {
    throw new DeployError(`--url 必須是 https://smurg-relay.<你的子網域>.workers.dev，或 https://<自訂網域>（目前是 ${text}）`, 2);
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
    if (error instanceof RelayUrlError) throw new DeployError(`--url 不是正確的網址：${text}`, 2);
    throw error;
  }
  const pattern = new RegExp(`^https://${workerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9-]+)?\\.workers\\.dev$`);
  if (!pattern.test(origin)) throw new DeployError(`--url 必須是 https://${workerName}.<你的子網域>.workers.dev（目前是 ${text}）`, 2);
  return origin;
}

/** --check: any https relay origin, or http on this machine (a local relay). */
function checkTarget(text: string): string {
  try {
    return relayOrigin(text.trim()).origin;
  } catch (error) {
    if (error instanceof RelayUrlError) throw new DeployError(`--check 的網址不正確：${text}（https，本機可用 http://127.0.0.1:埠）`, 2);
    throw error;
  }
}

const GOOGLE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.apps\.googleusercontent\.com$/;

export function googleClientIdOf(text: string): string {
  const id = text.trim();
  if (!GOOGLE_CLIENT_ID.test(id)) throw new DeployError(`--google-client-id 看起來不是 Google 的 OAuth client ID（應該是 …apps.googleusercontent.com）：${text}`, 2);
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
    throw new DeployError('無法解析 apps/relay/wrangler.jsonc（JSONC）');
  }
}

/** '' (not deployed yet) or an https origin. */
function issuerProblem(issuer: unknown): string | null {
  if (issuer === '') return null;
  if (typeof issuer !== 'string') return 'RELAY_ISSUER 必須是字串';
  try {
    const origin = relayOrigin(issuer);
    if (origin.protocol !== 'https:' || origin.origin !== issuer) return `RELAY_ISSUER 必須是 https 的網站根網址（目前是 ${issuer}）`;
  } catch {
    return `RELAY_ISSUER 不是正確的網址（${issuer}）`;
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
  if (config.route !== undefined) problems.push('不能用 "route"（單數）：自訂網域寫在 "routes"（剛好一個 custom_domain）');
  const routes: readonly unknown[] = Array.isArray(config.routes) ? config.routes : [];
  if (config.routes !== undefined && !Array.isArray(config.routes)) problems.push('"routes" 必須是陣列');
  if (config.workers_dev === true) {
    if (routes.length > 0) problems.push(`workers_dev 是 true 時不能有 routes（目前有 ${routes.length} 個）：relay 只能有一個公開網址，workers.dev 或一個自訂網域`);
    return problems.length === 0 ? { hosting: { kind: 'workers-dev' }, problems } : { hosting: null, problems };
  }
  if (config.workers_dev !== false) {
    problems.push('workers_dev 必須明確寫成 true（workers.dev）或 false（自訂網域）');
    return { hosting: null, problems };
  }
  const shape = '{ "pattern": "<網域>", "custom_domain": true }';
  if (routes.length !== 1) {
    problems.push(`workers_dev 是 false 時，routes 必須剛好是一個自訂網域 ${shape}（目前有 ${routes.length} 個）`);
    return { hosting: null, problems };
  }
  const route = routes[0] as Record<string, unknown> | null;
  if (typeof route !== 'object' || route === null || route['custom_domain'] !== true || Object.keys(route).sort().join(',') !== 'custom_domain,pattern') {
    problems.push(`routes[0] 必須剛好是 ${shape}（不是一般的 route，也不能有 zone_id、zone_name 或其他欄位）：${JSON.stringify(route)}`);
    return { hosting: null, problems };
  }
  const host = typeof route['pattern'] === 'string' ? customDomainHost(route['pattern']) : null;
  if (host === null) {
    problems.push(`routes[0].pattern 必須是一個網域名稱（小寫，不能有 *、路徑、埠，不是 workers.dev）：${JSON.stringify(route['pattern'])}`);
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
  if (config.preview_urls !== false) problems.push('preview_urls 必須是 false（每個版本都會多一個公開網址）');
  if (vars['DEV_LOGIN'] !== '0') problems.push('vars.DEV_LOGIN 在正式環境必須是 "0"');
  if (vars['RELAY_TAP_URL'] !== '') problems.push('vars.RELAY_TAP_URL 在正式環境必須是空字串');
  const github = Object.keys(vars).filter((name) => name.startsWith('GITHUB_'));
  if (github.length > 0) problems.push(`正式環境只用 Google 登入，最上層的 vars 不能有 ${github.join('、')}`);
  const issuer = vars['RELAY_ISSUER'];
  const issuerIssue = issuerProblem(issuer);
  if (issuerIssue) problems.push(issuerIssue);
  else if (hosting?.kind === 'custom-domain' && issuer !== hosting.origin) {
    problems.push(`vars.RELAY_ISSUER 必須是自訂網域的網址 ${hosting.origin}（目前是 ${String(issuer) || '空字串'}）`);
  } else if (hosting?.kind === 'workers-dev' && issuer !== '' && workersDevTarget([String(issuer)], config.name ?? 'smurg-relay') !== issuer) {
    problems.push(`vars.RELAY_ISSUER 必須是空字串（第一次部署前）或 https://${config.name ?? 'smurg-relay'}.<子網域>.workers.dev（目前是 ${String(issuer)}）`);
  }
  if (vars['ALLOWED_ORIGINS'] !== vars['RELAY_ISSUER']) problems.push('vars.ALLOWED_ORIGINS 必須和 RELAY_ISSUER 相同（relay 自己提供網頁）');
  const clientId = vars['GOOGLE_CLIENT_ID'];
  if (clientId !== '' && !(typeof clientId === 'string' && GOOGLE_CLIENT_ID.test(clientId))) problems.push(`vars.GOOGLE_CLIENT_ID 不是 Google 的 OAuth client ID（${String(clientId)}）`);
  for (const [name, url] of Object.entries(GOOGLE_ENDPOINTS)) {
    if (vars[name] !== url) problems.push(`vars.${name} 必須是 ${url}`);
  }
  if (!config.secrets?.required?.includes(SIGNING_KEY_SECRET)) problems.push(`secrets.required 必須列出 ${SIGNING_KEY_SECRET}`);
  const bindings = (config.durable_objects?.bindings ?? []).map((b) => `${b.name}:${b.class_name}`).join(',');
  if (bindings !== 'WORKSPACE:WorkspaceDO,TRANSFER:TransferDO') problems.push('durable_objects 必須是 WORKSPACE（WorkspaceDO）與 TRANSFER（TransferDO）');
  const sqlite = new Set((config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []));
  if (!sqlite.has('WorkspaceDO') || !sqlite.has('TransferDO')) problems.push('migrations 必須用 new_sqlite_classes 建立 WorkspaceDO 與 TransferDO（Free 方案只能用 SQLite）');
  const assets = config.assets;
  if (!assets?.directory || !/(?:^|[/\\])web[/\\]dist$/.test(assets.directory)) problems.push('assets.directory 必須是 ../web/dist');
  if (assets?.not_found_handling !== 'single-page-application') problems.push('assets.not_found_handling 必須是 single-page-application');
  if (JSON.stringify(assets?.run_worker_first) !== JSON.stringify(RELAY_WORKER_FIRST_PATTERNS)) problems.push('assets.run_worker_first 必須等於 @smurg/protocol 的 RELAY_WORKER_FIRST_PATTERNS');
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
  if (!start) throw new DeployError('wrangler.jsonc：找不到最上層的 "vars" 區塊');
  const bodyStart = start.index + start[0].length;
  const end = /^ {2}\},?[ \t]*$/m.exec(text.slice(bodyStart));
  if (!end) throw new DeployError('wrangler.jsonc：找不到最上層 "vars" 區塊的結尾');
  const bodyEnd = bodyStart + end.index;
  let body = text.slice(bodyStart, bodyEnd);
  for (const [name, value] of Object.entries(values) as [ProductionVarName, string][]) {
    const line = new RegExp(`^( {4}"${name}": )"(?:[^"\\\\\\n]|\\\\.)*"`, 'gm');
    const count = body.match(line)?.length ?? 0;
    if (count !== 1) throw new DeployError(`wrangler.jsonc：最上層的 vars 裡 "${name}" 出現 ${count} 次（應該剛好 1 次）`);
    body = body.replace(line, (_all, prefix: string) => `${prefix}${JSON.stringify(value)}`);
  }
  const out = text.slice(0, bodyStart) + body + text.slice(bodyEnd);
  const original = parseWranglerJsonc(text);
  const expected = { ...original, vars: { ...original.vars, ...values } };
  if (JSON.stringify(parseWranglerJsonc(out)) !== JSON.stringify(expected)) throw new DeployError('wrangler.jsonc：修改後的內容和預期不同，沒有寫入');
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
  if (start < 0 || end < start) return { kind: 'error', detail: 'wrangler secret list 的輸出不是 JSON' };
  try {
    const list = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    if (!Array.isArray(list)) return { kind: 'error', detail: 'wrangler secret list 的輸出不是陣列' };
    return { kind: 'names', names: list.map((s) => (s as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string') };
  } catch {
    return { kind: 'error', detail: 'wrangler secret list 的輸出不是 JSON' };
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
  const listed = targets.join('、') || '無';
  if (hosting.kind === 'workers-dev') {
    const deployed = workersDevTarget(targets, workerName);
    return deployed === url ? null : `部署後的 workers.dev 網址是 ${deployed ?? '（無）'}，不是 ${url}（targets：${listed}）`;
  }
  if (targets.some((target) => isWorkersDevHost(target.replace(/^https:\/\//, '').split(/[/ ]/, 1)[0] ?? ''))) {
    return `自訂網域的 relay 不能同時開著 workers.dev（targets：${listed}）`;
  }
  if (!targets.includes(`${hosting.host}${CUSTOM_DOMAIN_TARGET_SUFFIX}`)) {
    return `部署結果裡沒有自訂網域 ${hosting.host}${CUSTOM_DOMAIN_TARGET_SUFFIX}（targets：${listed}）`;
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

/** The names of the checks added after the first six (tests and messages refer to them). */
export const CHECK_NAMES = Object.freeze({
  webBuild: 'GET /（網頁是這個 checkout 的建置）',
  httpsRedirect: 'http:// 轉到 https://',
});

const STAND_IN_TEXT = '尚未建置網頁介面';

async function probe(fetcher: typeof fetch, url: string, init: { readonly redirect?: 'follow' | 'manual' } = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'smurg-deploy-check' } });
  const text = await res.text();
  // Cloudflare answered instead of the relay (Bot Fight Mode, "I'm Under Attack", a WAF challenge or block rule): the
  // CLI and the daemon are not browsers and could not pass it either.
  const mitigated = res.headers.get('cf-mitigated');
  if (mitigated !== null) {
    throw new Error(`Cloudflare 擋下了這個請求（HTTP ${res.status}，cf-mitigated: ${mitigated}）：關掉這個網域的 Bot Fight Mode、I'm Under Attack，以及會 challenge 這個網址的 WAF 規則（CLI 與 daemon 不是瀏覽器，過不了 challenge）`);
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
  if (!(r.headers.get('content-type') ?? '').startsWith('text/html')) return `content-type ${r.headers.get('content-type') ?? '（無）'}`;
  if (r.text.includes(STAND_IN_TEXT)) return '是開發用的替代頁面，不是網頁建置結果';
  if (!r.text.includes('<div id="root"></div>') || !/<script type="module"[^>]*src="\/assets\//.test(r.text)) return '不是 smurg 網頁的 index.html';
  const csp = r.headers.get('content-security-policy') ?? '';
  if (!csp.includes("frame-ancestors 'none'") || !csp.includes("default-src 'self'")) return `沒有 _headers 的 Content-Security-Policy（${csp || '無'}）`;
  if ((r.headers.get('x-frame-options') ?? '').toUpperCase() !== 'DENY') return '沒有 X-Frame-Options: DENY';
  if (r.headers.get('x-content-type-options') !== 'nosniff') return '沒有 X-Content-Type-Options: nosniff';
  if (https) {
    // Two Strict-Transport-Security headers (_headers' and, say, the zone's HSTS setting) reach fetch() joined with
    // ', '; a browser processes only the first one (RFC 6797 §8.1), so only the first one is judged.
    const hsts = r.headers.get('strict-transport-security');
    if (hsts === null || hstsMaxAge(hsts.split(',')[0] as string) === null) {
      return `沒有 _headers 的 Strict-Transport-Security（max-age 至少 ${HSTS_MIN_MAX_AGE}；收到 ${hsts ?? '無'}）。線上的網頁若是 apps/web/public/_headers 加入這一行之前的建置，從要發佈的 commit 重新部署：scripts/deploy-relay.sh`;
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
  await run('GET /healthz', async () => {
    const r = await probe(fetcher, relayHttpUrl(origin, RELAY_PATHS.healthz));
    return r.status === 200 && r.text.trim() === 'ok' ? null : `HTTP ${r.status}`;
  });
  await run('GET /api/login-options', async () => {
    const r = await probe(fetcher, relayHttpUrl(origin, RELAY_PATHS.loginOptions));
    if (r.status !== 200) return `HTTP ${r.status}${r.status === 500 ? '（RELAY_ISSUER 或簽章金鑰沒有設定好）' : ''}`;
    const parsed = relayLoginOptionsSchema.safeParse(JSON.parse(r.text));
    if (!parsed.success) return `回應格式不對：${r.text.slice(0, 200)}`;
    const { providers, dev } = parsed.data;
    const seen = `google=${providers.google} github=${providers.github} dev=${dev}`;
    if (dev) return `${seen}：正式環境不能開啟開發用登入`;
    if (providers.github) return `${seen}：正式環境只用 Google 登入`;
    if (providers.google !== options.expectGoogle) return `${seen}：預期 google=${options.expectGoogle}`;
    return null;
  });
  await run('GET /.well-known/jwks.json', async () => {
    const r = await probe(fetcher, relayHttpUrl(origin, RELAY_PATHS.jwks));
    if (r.status !== 200) return `HTTP ${r.status}${r.status === 500 ? `（${SIGNING_KEY_SECRET} 沒有設定或格式不對）` : ''}`;
    const keys = (JSON.parse(r.text) as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length === 0) return '沒有任何公鑰';
    for (const key of keys as Record<string, unknown>[]) {
      if (key['kty'] !== 'OKP' || key['crv'] !== 'Ed25519' || typeof key['kid'] !== 'string' || typeof key['x'] !== 'string') return '公鑰不是 Ed25519 JWK';
      if ('d' in key) return '公開了私鑰（d）！';
    }
    return null;
  });
  const https = new URL(origin).protocol === 'https:';
  await run('GET /（網頁與 CSP）', async () => spaProblem(await probe(fetcher, `${origin}/`), https));
  await run('GET /join/…（SPA 深層連結與 CSP）', async () => spaProblem(await probe(fetcher, `${origin}/join/smurg-deploy-check`), https));
  await run('GET /auth/google/login', async () => {
    const r = await probe(fetcher, relayHttpUrl(origin, authLoginPath('google')), { redirect: 'manual' });
    if (!options.expectGoogle) return r.status === 503 ? null : `HTTP ${r.status}（Google 尚未設定時應該是 503）`;
    if (r.status !== 302) return `HTTP ${r.status}（應該轉到 Google）`;
    const location = new URL(r.headers.get('location') ?? 'about:blank');
    if (location.origin !== new URL(GOOGLE_ENDPOINTS.GOOGLE_AUTHORIZE_URL).origin) return `轉到 ${location.origin}，不是 Google`;
    const redirectUri = location.searchParams.get('redirect_uri');
    if (redirectUri !== `${origin}${authCallbackPath('google')}`) return `redirect_uri 是 ${redirectUri ?? '（無）'}，應該是 ${origin}${authCallbackPath('google')}（RELAY_ISSUER 不對？）`;
    const clientId = location.searchParams.get('client_id') ?? '';
    if (options.googleClientId !== undefined ? clientId !== options.googleClientId : !GOOGLE_CLIENT_ID.test(clientId)) return `client_id 是 ${clientId || '（無）'}`;
    if (https) {
      const cookie = r.headers.get('set-cookie') ?? '';
      if (!cookie.includes('__Host-') || !/;\s*Secure/i.test(cookie)) return 'https 的 relay 應該用 __Host- 開頭、Secure 的 cookie';
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
        `線上的網頁載入 ${live.join(' ') || '（沒有 /assets/ 檔案）'}，這裡的建置是 ${wanted.join(' ')}：線上的網頁不是這個 checkout 建置的版本。` +
        '舊的網頁會拒絕新版 daemon 的 channel.welcome（多出的欄位），所以從要發佈的 commit 重新部署：scripts/deploy-relay.sh' +
        '（只是 apps/web/dist 舊了或含有沒提交的修改時：pnpm --filter @smurg/web build 後再比對）'
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
        `${plain} 回應 HTTP ${r.status}${location !== null ? `（轉到 ${location}）` : ''}，不是永久轉到 https://：` +
        '沒有 HSTS preload 的網域，瀏覽器第一次可能用 http 連線，網路上的人就能換掉網頁。在 Cloudflare dashboard → 這個網域的 zone → ' +
        'SSL/TLS → Edge Certificates 打開 Always Use HTTPS'
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
  return results.map((r) => `  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `：${r.detail}`}`).join('\n');
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
    throw new DeployError(`無法查詢 ${host} 的 DNS（${code ?? String(error)}）：確認網路後再執行一次`);
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
    if (health.status !== 200 || health.text.trim() !== 'ok') return { kind: 'other', detail: `${origin}/healthz 回應 HTTP ${health.status}` };
    const options = await probe(deps.fetch, relayHttpUrl(origin, RELAY_PATHS.loginOptions), { redirect: 'manual' });
    if (options.status === 500) return { kind: 'relay' };
    if (options.status === 200 && relayLoginOptionsSchema.safeParse(JSON.parse(options.text)).success) return { kind: 'relay' };
    return { kind: 'other', detail: `${origin}/api/login-options 回應 HTTP ${options.status}` };
  } catch (error) {
    return { kind: 'other', detail: `${host} 有 DNS 記錄，但 ${origin} 沒有像 smurg relay 一樣回應（${error instanceof Error ? error.message : String(error)}）` };
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

/** Runs a command; `show` lets its output through to the owner's terminal instead of capturing it. */
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
  if (built.code !== 0) throw new DeployError(`網頁建置失敗（pnpm --filter @smurg/web build，結束代碼 ${built.code}）`);
  const checked = await runCommand(process.execPath, [join(RELAY_DIR, 'scripts', 'check-web-dist.ts')], { cwd: RELAY_DIR, show: true });
  if (checked.code !== 0) throw new DeployError('網頁建置結果不能部署（scripts/check-web-dist.ts）');
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

  /** `wrangler deploy --env ""` (output shown to the owner); returns the deploy targets. */
  async deploy(): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), 'smurg-deploy-'));
    try {
      const outputFile = join(dir, 'wrangler-output.ndjson');
      const ran = await this.wrangler(['deploy', '--config', this.configPath, '--env='], { show: true, env: { WRANGLER_OUTPUT_FILE_PATH: outputFile } });
      if (ran.code !== 0) {
        throw new DeployError(
          [
            `wrangler deploy 失敗（結束代碼 ${ran.code}）。常見原因：`,
            '  · workers.dev：帳號還沒有 workers.dev 子網域：打開 wrangler 印出的 https://dash.cloudflare.com/<帳號>/workers/onboarding 選一個，再執行一次。',
            '  · 自訂網域：網域的 zone 必須在同一個 Cloudflare 帳號（而且由 Cloudflare 代管 DNS）。',
            `  · 缺少 ${SIGNING_KEY_SECRET}：執行  ${OWNER_COMMANDS.signingKey}`,
            '  · 登入過期：重新登入後再執行一次。',
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
      if (ran.code !== 0) throw new DeployError(`wrangler deploy --dry-run 失敗（結束代碼 ${ran.code}）`);
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
    `  Google Cloud console → APIs & Services → Credentials → 你的 OAuth client（Web application）：`,
    `    Authorized JavaScript origins：${url}`,
    `    Authorized redirect URIs：     ${url}${authCallbackPath('google')}`,
    ...(hosting.kind === 'custom-domain'
      ? [`  Google Auth Platform → Branding → Authorized domains：${hosting.host} 所屬、你擁有的網域（Cloudflare 上的 zone，例如 app.smurg.ai → smurg.ai）`]
      : []),
  ].join('\n');
}

/** Refuses to run outside scripts/deploy-relay.sh: wrangler's login must live in <repo>/.xdg (scripts/env.sh). */
function assertRepoEnvironment(): void {
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg === undefined || resolve(xdg) !== resolve(REPO_ROOT, '.xdg')) {
    throw new DeployError('請用 scripts/deploy-relay.sh 執行（它會 source scripts/env.sh，讓 wrangler 的登入資料留在 repo 的 .xdg/）', 2);
  }
}

async function requireLogin(t: Tools): Promise<void> {
  const who = await t.whoami();
  if (!who.loggedIn) {
    throw new DeployError(`wrangler 還沒有登入 Cloudflare（登入資料放在 ${join(REPO_ROOT, '.xdg')}）。請在 repo 根目錄執行：\n  source scripts/env.sh\n  ${OWNER_COMMANDS.login}`, 3);
  }
  const chosen = process.env['CLOUDFLARE_ACCOUNT_ID'];
  if (who.accounts.length === 0) throw new DeployError('這個 Cloudflare 登入看不到任何帳號', 3);
  const account = chosen ? who.accounts.find((a) => a.id === chosen) : who.accounts.length === 1 ? who.accounts[0] : undefined;
  if (!account) {
    throw new DeployError(
      [
        chosen ? `CLOUDFLARE_ACCOUNT_ID=${chosen} 不是這個登入可以使用的帳號。` : '這個 Cloudflare 登入有多個帳號，請指定要部署到哪一個：',
        ...who.accounts.map((a) => `  ${a.id}  ${a.name}`),
        '  然後執行：CLOUDFLARE_ACCOUNT_ID=<帳號 ID> scripts/deploy-relay.sh …',
      ].join('\n'),
      3,
    );
  }
  t.out(`  已登入 Cloudflare 帳號：${account.name}（${account.id}）`);
}

async function runDeploy(t: Tools, options: DeployOptions): Promise<number> {
  const dryRun = options.mode === 'dry-run';
  const total = 10;
  t.out(dryRun ? 'smurg relay 部署：--dry-run（不連 Cloudflare 帳號：不查登入、不查 secret、不部署、不改 wrangler.jsonc）' : 'smurg relay 部署（Cloudflare Workers，Free 方案，只用 Google 登入）');

  t.step(1, total, 'Cloudflare 登入（wrangler whoami）');
  if (dryRun) t.out(`  （--dry-run：略過。部署時若還沒登入，會請你執行：${OWNER_COMMANDS.login}）`);
  else await requireLogin(t);

  t.step(2, total, `secret：${SIGNING_KEY_SECRET} 必須在第一次部署前存在`);
  if (dryRun) t.out('  （--dry-run：略過 wrangler secret list）');
  else {
    const secrets = await t.secretList();
    if (secrets.kind === 'error') throw new DeployError(`wrangler secret list 失敗：\n${secrets.detail}`);
    if (secrets.kind === 'no-worker' || !secrets.names.includes(SIGNING_KEY_SECRET)) {
      throw new DeployError(
        [
          secrets.kind === 'no-worker' ? '這個帳號還沒有 smurg-relay 這個 Worker。' : `Worker 沒有 ${SIGNING_KEY_SECRET}。`,
          `wrangler 不接受缺少 ${SIGNING_KEY_SECRET} 的部署（wrangler.jsonc 的 secrets.required）；先放進簽章金鑰`,
          '（Worker 還不存在時，wrangler 會先建立一個空的 smurg-relay Worker），再執行一次這個腳本。在 repo 根目錄：',
          '  source scripts/env.sh',
          `  ${OWNER_COMMANDS.signingKey}`,
          '金鑰只經過管線交給 wrangler，不會顯示在畫面上，也不會寫進任何檔案。',
        ].join('\n'),
        3,
      );
    }
    t.out(`  ${SIGNING_KEY_SECRET}：已設定`);
  }

  t.step(3, total, '檢查 wrangler.jsonc 的正式環境設定');
  let config = await readProductionConfig(t.configPath);
  const problems = productionConfigProblems(config);
  if (problems.length > 0) throw new DeployError(`wrangler.jsonc 不適合正式環境：\n${problems.map((p) => `  · ${p}`).join('\n')}`);
  // productionConfigProblems is empty, so the config has exactly one of the two supported shapes.
  const hosting = relayHostingOf(config).hosting as RelayHosting;
  const configuredUrl = String(config.vars['RELAY_ISSUER'] ?? '');
  const configuredClientId = String(config.vars['GOOGLE_CLIENT_ID'] ?? '');
  if (hosting.kind === 'custom-domain') {
    t.out(`  公開網址：Cloudflare 自訂網域 ${hosting.host}（workers.dev 關閉）`);
    if (options.url !== undefined && options.url !== hosting.origin) {
      throw new DeployError(
        `--url ${options.url} 不是 wrangler.jsonc 的自訂網域 ${hosting.origin}。` +
          (isWorkersDevHost(new URL(options.url).hostname)
            ? '\n要部署到 workers.dev（自己架設）：把 wrangler.jsonc 的 "workers_dev" 改成 true、刪掉 "routes"，RELAY_ISSUER、ALLOWED_ORIGINS、GOOGLE_CLIENT_ID 改成 ""（apps/relay/README.md「自己架設：workers.dev（預設）」）。'
            : '\n要換網域：改 wrangler.jsonc 的 routes[0].pattern 與 RELAY_ISSUER、ALLOWED_ORIGINS（apps/relay/README.md）。'),
        2,
      );
    }
  } else {
    t.out(`  公開網址：這個帳號的 workers.dev 子網域（https://${config.name}.<子網域>.workers.dev）`);
    if (options.url !== undefined && workersDevTarget([options.url], config.name) !== options.url) {
      throw new DeployError(
        `--url ${options.url} 不是 https://${config.name}.<子網域>.workers.dev。` +
          '\n要用自訂網域：把 wrangler.jsonc 的 "workers_dev" 改成 false，加上 "routes": [{ "pattern": "<網域>", "custom_domain": true }]，RELAY_ISSUER、ALLOWED_ORIGINS 改成 https://<網域>（apps/relay/README.md）。',
        2,
      );
    }
    if (options.url !== undefined && configuredUrl !== '' && options.url !== configuredUrl) {
      t.out(`  注意：RELAY_ISSUER 會從 ${configuredUrl} 改成 ${options.url}（已經登入的人要重新登入；CLI 的 DEFAULT_RELAY_URL 也要一起改）`);
    }
  }
  t.out('  OK');

  t.step(4, total, '建置網頁（pnpm --filter @smurg/web build）並檢查 apps/web/dist');
  await t.buildWeb();
  // Step 10 expects exactly this build live (the content-hashed files its index.html loads).
  const webAssets = await localWebAssets(t.webDist);
  if (webAssets === null) throw new DeployError(`${t.webDist} 不是網頁的建置結果（index.html 沒有載入 /assets/ 的檔案）`);
  t.out(`  網頁：${webAssets.join(' ')}`);

  t.step(5, total, hosting.kind === 'custom-domain' ? 'relay 的網址（自訂網域）' : 'relay 的 workers.dev 網址');
  let url = hosting.kind === 'custom-domain' ? hosting.origin : (options.url ?? (configuredUrl === '' ? null : configuredUrl));
  if (url !== null) t.out(`  ${url}${hosting.kind === 'custom-domain' ? '（wrangler.jsonc 的 routes）' : options.url !== undefined ? '（--url）' : '（wrangler.jsonc）'}`);
  if (hosting.kind === 'custom-domain') {
    // wrangler, as run here, replaces whatever has the hostname without asking (header comment, step 5).
    if (dryRun) t.out(`  （--dry-run：不查 ${hosting.host} 現在由誰回應）`);
    else if (options.takeOverHostname) t.out(`  --take-over-hostname：${hosting.host} 現有的 DNS 記錄或別的 Worker 的自訂網域會被換成這個 relay`);
    else {
      const occupant = await hostnameOccupant(hosting.host, { lookupHost: t.lookupHost, fetch: t.fetch });
      if (occupant.kind === 'other') {
        throw new DeployError(
          [
            `${hosting.host} 已經有東西在回應，而且不是 smurg relay：${occupant.detail}。`,
            '這個腳本執行的 wrangler（CI=true、不互動）會不經詢問，把那個網址現有的 DNS 記錄或另一個 Worker 的自訂網域換成這個 relay。',
            `  · 要保留它：把 wrangler.jsonc 的 routes 與 RELAY_ISSUER、ALLOWED_ORIGINS 改成別的網域。`,
            `  · 確定要讓這個 relay 接手 ${hosting.host}：在 Cloudflare dashboard 移除舊的 DNS 記錄或自訂網域，或加上 --take-over-hostname 再執行一次。`,
          ].join('\n'),
          3,
        );
      }
      t.out(occupant.kind === 'none' ? `  ${hosting.host} 還沒有 DNS 記錄：部署時 Cloudflare 建立記錄與憑證` : `  ${hosting.host} 已經是 smurg relay：重新部署`);
    }
  } else if (url === null && dryRun) {
    t.out('  還不知道（第一次部署時由部署結果得知，或用 --url 指定）');
  } else if (url === null) {
    t.out('  還不知道：先部署一次（RELAY_ISSUER 是空的，relay 除了 /healthz 和網頁之外都回 500，沒有人能登入），從部署結果得知網址…');
    const targets = await t.deploy();
    url = workersDevTarget(targets, config.name);
    if (url === null) throw new DeployError(`部署結果裡沒有 workers.dev 網址（targets：${targets.join('、') || '無'}）；請用 --url https://${config.name}.<子網域>.workers.dev 指定`);
    t.out(`  ${url}（部署結果）`);
  }

  t.step(6, total, 'wrangler.jsonc：RELAY_ISSUER、ALLOWED_ORIGINS、GOOGLE_CLIENT_ID');
  const clientId = options.googleClientId ?? configuredClientId;
  const wanted: Partial<Record<ProductionVarName, string>> = {};
  if (url !== null && url !== configuredUrl) Object.assign(wanted, { RELAY_ISSUER: url, ALLOWED_ORIGINS: url });
  if (clientId !== configuredClientId) wanted.GOOGLE_CLIENT_ID = clientId;
  if (url === null) t.out('  RELAY_ISSUER、ALLOWED_ORIGINS：網址還不知道，第一次部署時寫入');
  if (Object.keys(wanted).length === 0) {
    if (url !== null) t.out('  已經是正確的值，不需要修改');
  } else if (dryRun) {
    setProductionVars(await readFile(t.configPath, 'utf8'), wanted); // proves the edit would apply cleanly
    for (const [name, value] of Object.entries(wanted)) t.out(`  （--dry-run，不寫入）${name} = ${value}`);
  } else {
    await t.writeProductionVars(wanted);
    for (const [name, value] of Object.entries(wanted)) t.out(`  ${name} = ${value}`);
    t.out('  已寫入 apps/relay/wrangler.jsonc（這是公開的設定，請提交到 git）');
    config = await readProductionConfig(t.configPath);
    const after = productionConfigProblems(config);
    if (after.length > 0) throw new DeployError(`寫入後的 wrangler.jsonc 有問題：\n${after.map((p) => `  · ${p}`).join('\n')}`);
  }
  if (clientId === '') t.out('  GOOGLE_CLIENT_ID 還是空的：建立 Google OAuth client 後，用 --google-client-id <client ID> 再執行一次');

  t.step(7, total, dryRun ? 'wrangler deploy --dry-run --env ""（不部署）' : 'wrangler deploy --env ""');
  if (dryRun) {
    await t.dryRunDeploy(wanted);
  } else {
    if (String(config.vars['RELAY_ISSUER']) !== url) throw new DeployError('wrangler.jsonc 的 RELAY_ISSUER 和要部署的網址不同，停止');
    const targets = await t.deploy();
    const problem = deployedTargetProblem(targets, hosting, config.name, url as string);
    if (problem !== null && hosting.kind === 'workers-dev') {
      const deployed = workersDevTarget(targets, config.name);
      throw new DeployError(
        `${problem}：帳號的 workers.dev 子網域改過，或這是另一個 Cloudflare 帳號（自己架設）。` +
          `\n確定要改用新網址的話，執行 scripts/deploy-relay.sh --url ${deployed ?? `https://${config.name}.<子網域>.workers.dev`}` +
          '（已經登入的人要重新登入，Google OAuth client 的網址與 CLI 的 DEFAULT_RELAY_URL 也要一起改）。',
      );
    }
    if (problem !== null) {
      throw new DeployError(
        `${problem}。wrangler 沒有回報把 ${url} 接到這個 Worker：網域的 zone 必須在同一個 Cloudflare 帳號；` +
          '在 Cloudflare dashboard → Workers & Pages → smurg-relay → Settings → Domains & Routes 確認。',
      );
    }
  }

  t.step(8, total, 'relay 網址與 Google OAuth 設定值');
  const shownUrl = url ?? `https://${config.name}.<子網域>.workers.dev`;
  t.out(`  relay：${shownUrl}`);
  t.out(googleConsoleText(shownUrl, hosting));
  if (url !== null && DEFAULT_RELAY_URL !== url) {
    t.out(`  CLI 的預設 relay（packages/cli/src/relay/default-relay.ts）目前是 ${DEFAULT_RELAY_URL === null ? 'null' : DEFAULT_RELAY_URL}；--check 全部通過後改成：`);
    t.out(`    export const DEFAULT_RELAY_URL: string | null = '${url}';`);
  }

  t.step(9, total, 'secret');
  let googleSecret = false;
  if (dryRun) {
    t.out('  （--dry-run：略過 wrangler secret list）需要的 secret：');
    t.out(`    ${SIGNING_KEY_SECRET}：${OWNER_COMMANDS.signingKey}`);
    t.out(`    ${GOOGLE_SECRET}：${OWNER_COMMANDS.googleSecret}`);
  } else {
    const secrets = await t.secretList();
    if (secrets.kind !== 'names') throw new DeployError(`wrangler secret list 失敗：${secrets.kind === 'error' ? secrets.detail : 'Worker 不存在'}`);
    googleSecret = secrets.names.includes(GOOGLE_SECRET);
    t.out(`  ${SIGNING_KEY_SECRET}：${secrets.names.includes(SIGNING_KEY_SECRET) ? '已設定' : '缺少'}`);
    t.out(`  ${GOOGLE_SECRET}：${googleSecret ? '已設定' : `缺少。在 repo 根目錄（source scripts/env.sh 之後）執行，出現 "Enter a secret value:" 時貼上 Google 的 client secret：\n    ${OWNER_COMMANDS.googleSecret}`}`);
    const unexpected = secrets.names.filter((n) => n !== SIGNING_KEY_SECRET && n !== GOOGLE_SECRET);
    if (unexpected.length > 0) t.out(`  其他 secret（relay 用不到）：${unexpected.join('、')}`);
  }

  t.step(10, total, '從外部檢查');
  if (dryRun || url === null) {
    t.out('  （--dry-run：沒有部署，略過。部署後可以用 scripts/deploy-relay.sh --check <網址> 檢查）');
    t.out('\n--dry-run 完成：沒有部署任何東西，也沒有修改 wrangler.jsonc。');
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
    onRetry: (failed) => t.out(`  尚未通過（${failed.map((f) => f.name).join('、')}），稍後重試…`),
  });
  t.out(formatChecks(results));
  if (results.some((r) => !r.ok)) {
    t.out(`\n有檢查沒有通過。新的 workers.dev 網址或自訂網域（DNS 記錄與憑證）有時要幾分鐘才能連上；稍後可以再執行 scripts/deploy-relay.sh --check ${url}`);
    return 1;
  }
  if (!googleReady) {
    t.out('\n已部署，但 Google 登入還沒有開啟。接下來：');
    if (clientId === '') t.out('  1. Google Cloud console 建立 OAuth client（Web application），填入上面的 origin 與 redirect URI（apps/relay/README.md）。');
    if (!googleSecret) t.out(`  ${clientId === '' ? 2 : 1}. 放入 client secret：${OWNER_COMMANDS.googleSecret}`);
    t.out(`  最後：scripts/deploy-relay.sh${clientId === '' ? ' --google-client-id <client ID>' : ''}`);
    return 0;
  }
  t.out(`\n完成：${url} 已部署並通過所有檢查（Google 登入已開啟）。請提交 apps/relay/wrangler.jsonc。`);
  return 0;
}

async function runCheck(t: Tools, options: DeployOptions): Promise<number> {
  const url = options.url as string;
  t.out(`從外部檢查 ${url}（預期：Google 登入開啟、沒有 GitHub 與開發用登入）`);
  const webDist = options.webDist ?? t.webDist;
  const webAssets = await localWebAssets(webDist);
  t.out(
    webAssets === null
      ? `  ${webDist} 沒有網頁的建置結果：不比對線上的網頁是不是這個 checkout 的版本（要比對：先 pnpm --filter @smurg/web build）`
      : `  比對線上的網頁與 ${webDist}（${webAssets.join(' ')}）`,
  );
  const distProblem = webAssets === null ? null : webDistProblem(webDist);
  if (distProblem !== null) {
    t.out(
      `  注意：${webDist} 是 scripts/check-web-dist.ts 不接受的建置（${distProblem}${distProblem === 'no-hsts' ? '：apps/web/public/_headers 加入 HSTS 之前的建置' : ''}），` +
        '可能比這個 checkout 舊；比對的是它載入的檔案（要比對這個 checkout：先 pnpm --filter @smurg/web build）',
    );
  }
  const results = await checkRelayUntil(url, {
    expectGoogle: true,
    ...(webAssets !== null ? { webAssets } : {}),
    fetch: t.fetch,
    waitMs: options.waitSeconds * 1000,
    intervalMs: t.retryIntervalMs,
    onRetry: (failed) => t.out(`  尚未通過（${failed.map((f) => f.name).join('、')}），稍後重試…`),
  });
  t.out(formatChecks(results));
  const failed = results.filter((r) => !r.ok).length;
  t.out(failed === 0 ? '全部通過。' : `${failed} 項沒有通過。`);
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
      err(`\ndeploy-relay：${error.message}\n`);
      return error.exitCode;
    }
    err(`\ndeploy-relay：未預期的錯誤：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  }
}

// Only when run directly (scripts/deploy-relay.ts imports main instead).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
