// Publishes one smurg release on https://downloads.smurg.ai (the Cloudflare R2 bucket `smurg-downloads` behind its
// custom domain) and then switches latest/. Run by a PERSON (the owner or the lead) through
// scripts/publish-downloads.sh, never by CI: no Cloudflare credential is stored in GitHub. docs/RELEASING.md §4, §7.
//
//   scripts/publish-downloads.sh --version X.Y.Z (--from-release | --dist DIR) [--dry-run] [--resume] [--no-latest] [--wait S]
//   scripts/publish-downloads.sh --check [--version X.Y.Z]
//   scripts/publish-downloads.sh --set-latest X.Y.Z [--dry-run] [--wait S]
//
// The layout (decided 2026-10-01; docs/RELEASING.md "The plan"):
//   v<X.Y.Z>/{smurg-darwin-arm64, smurg-darwin-x64, smurg-linux-x64, smurg-linux-arm64, SHA256SUMS, install.sh,
//             THIRD-PARTY-NOTICES.txt}   immutable: Cache-Control "public, max-age=31536000, immutable"; never
//                                        overwritten, never deleted
//   latest/install.sh   a copy of the newest version's install.sh (its download location is pinned to that version's
//                       prefix), Cache-Control "public, max-age=300"; https://smurg.ai/install.sh redirects here
//   latest/VERSION      "X.Y.Z\n", the same Cache-Control
// Content-Type: application/octet-stream for the executables, text/plain; charset=utf-8 for everything else (a browser
// shows install.sh instead of downloading it).
//
// Publishing (default mode):
//   1. The files: --from-release takes the assets of the GitHub release vX.Y.Z of the PRIVATE repository gclinian/smurg
//      (`gh release view` / `gh release download`, with the person's own gh login; the release workflow made it and it
//      must not be a draft), --dist DIR a local directory (what scripts/release-assets.sh --out wrote, e.g. a release
//      assembled by hand with a linux-arm64 built elsewhere).
//   2. They are checked before anything is contacted: all seven present; SHA256SUMS lists exactly the four executables
//      and each sha256 matches; `file` says each executable is the Mach-O / ELF of its name; each carries the build
//      marker of X.Y.Z and the download URL of one Node.js release, the same for all four (scripts/release-markers.ts);
//      this machine's executable runs and reports exactly `smurg X.Y.Z (… node A.B.C)`; install.sh has exactly one
//      baked download location, and it is https://downloads.smurg.ai/vX.Y.Z; the notices name what every executable
//      bundles and are complete: the Node.js section filled in (`node@A.B.C (the Node.js runtime)` and its LICENSE),
//      for the executables' Node.js.
//   3. Cloudflare (not in --dry-run): `wrangler whoami` (the repo-local login in <repo>/.xdg, scripts/env.sh), then
//      `wrangler r2 bucket list` must name smurg-downloads.
//   4. Never overwrite: every file of vX.Y.Z is looked up through the custom domain (HEAD) and, for the small ones, in
//      the bucket itself (`wrangler r2 object get … --remote --pipe`). Anything there stops the run, unless --resume
//      (an earlier run stopped halfway): then a file that is there must be byte-identical (sha256) and is skipped, and
//      one that differs stops the run.
//   5. latest/: a version with a pre-release part (X.Y.Z-rc.1) never becomes latest, nor does any version with
//      --no-latest; a version older than the current latest/VERSION stops the run (rolling back is --set-latest). A
//      --resume that finds every file already there leaves latest/ as it is when it names another version (someone may
//      have rolled it back on purpose since); it says so, and --set-latest X.Y.Z moves it.
//   6. Upload (`wrangler r2 object put smurg-downloads/<key> --file … --remote --content-type … --cache-control …`):
//      the executables, THIRD-PARTY-NOTICES.txt, install.sh and SHA256SUMS last (the installer reads SHA256SUMS first,
//      so a version cut short refuses to install instead of half-working).
//   7. Every file is read back through https://downloads.smurg.ai (with a query string that bypasses any edge cache)
//      and its sha256 compared; a wrong Content-Type or Cache-Control is reported as a warning. Any failure stops the
//      run HERE: latest/ is left as it was. An HTTP error or a timeout: run again with --resume. Other bytes than
//      uploaded: the error says the way out (docs/RELEASING.md §4 step 7).
//   8. Only then latest/install.sh and latest/VERSION, read back the same way; then whether the plain URLs (what curl
//      gets) already serve them (the edge may keep the previous ones for up to 5 minutes), whether
//      https://smurg.ai/install.sh answers 302 to https://downloads.smurg.ai/latest/install.sh (apps/site), and whether
//      https://smurg.ai/third-party-notices.txt is this version's notices (a warning until the site is redeployed with
//      them, docs/RELEASING.md §4.1).
//
// --check: read-only, no login: the version (default: latest/VERSION) through the plain public URLs: SHA256SUMS, every
//   executable's sha256 and `file` type, this machine's `--version`, install.sh's download location, the notices, the
//   headers, latest/ (when it is that version: install.sh identical), the smurg.ai redirect.
// --set-latest X.Y.Z: points latest/ at a version that is already published (a rollback, docs/RELEASING.md §7): the
//   version is verified as in --check first; then latest/install.sh (its own install.sh) and latest/VERSION.
// --dry-run: steps 1, 2, 4 (through the public custom domain only, when it answers) and 5; never runs wrangler.
//
// A rehearsal against local stand-ins (the tests; a person trying the runbook before the bucket exists), with the real
// command: SMURG_PUBLISH_TEST_ORIGIN=http://127.0.0.1:<port>/… (where the stand-in bucket is read back, instead of
// https://downloads.smurg.ai) together with SMURG_PUBLISH_TEST_WRANGLER=<absolute path of a stand-in wrangler>, and
// optionally SMURG_PUBLISH_TEST_SITE_INSTALL_URL=http://127.0.0.1:<port>/… (instead of https://smurg.ai/install.sh) and
// SMURG_PUBLISH_TEST_GH=<absolute path of a stand-in gh>. Only 127.0.0.1, [::1] and localhost are accepted, and any of
// them without both a stand-in origin and a stand-in wrangler is refused (the real wrangler would write to the real
// bucket). Every run says REHEARSAL in its first and last line.
//
// Exit codes: 0 done, 1 failed or refused, 2 usage, 3 the person must act first (log in, choose an account, create the
// bucket).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { markerProblems, markersOfFile, nodeAgreementProblems, nodeOfVersionLine } from './release-markers.ts';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BUCKET = 'smurg-downloads';
export const DOWNLOADS_ORIGIN = 'https://downloads.smurg.ai';
export const SITE_INSTALL_URL = 'https://smurg.ai/install.sh';
export const GITHUB_REPO = 'gclinian/smurg';
export const EXECUTABLES = ['smurg-darwin-arm64', 'smurg-darwin-x64', 'smurg-linux-x64', 'smurg-linux-arm64'] as const;
export const NOTICES = 'THIRD-PARTY-NOTICES.txt';
/** Every file of a version, in upload order: SHA256SUMS last (see the header, step 6). */
export const UPLOAD_ORDER: readonly string[] = [...EXECUTABLES, NOTICES, 'install.sh', 'SHA256SUMS'];
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const LATEST_CACHE = 'public, max-age=300';
export const TEXT_TYPE = 'text/plain; charset=utf-8';
export const BINARY_TYPE = 'application/octet-stream';
/** What every executable bundles; its notices must name each (scripts/release-assets.sh refuses the same). */
export const NOTICE_COMPONENTS = ['node-pty', '@parcel/watcher', 'Node.js'] as const;
/** The committed packages/cli/THIRD-PARTY-NOTICES.txt says this where the Node.js LICENSE goes: not a release's file. */
export const NOTICES_PLACEHOLDER = 'In the copy of this file that is built';
/** The first line of the Node.js LICENSE, which scripts/build-sea.ts puts into the notices' Node.js section. */
export const NODE_LICENSE_START = 'Node.js is licensed for use as follows:';
const VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,40})?$/;
const WRANGLER_BIN = join(REPO_ROOT, 'apps', 'relay', 'node_modules', '.bin', 'wrangler');
/** `file -b` of each executable (scripts/release-assets.sh --check-arch uses the same patterns). */
const ARCH_PATTERNS: Readonly<Record<string, RegExp>> = {
  'smurg-darwin-arm64': /Mach-O 64-bit.*arm64/,
  'smurg-darwin-x64': /Mach-O 64-bit.*x86_64/,
  'smurg-linux-x64': /ELF 64-bit LSB.*x86-64/,
  'smurg-linux-arm64': /ELF 64-bit LSB.*(ARM aarch64|aarch64)/,
};

export const USAGE = `scripts/publish-downloads.sh: publish a smurg release on ${DOWNLOADS_ORIGIN} (R2 bucket ${BUCKET}), then switch latest/

  scripts/publish-downloads.sh --version X.Y.Z --from-release [--dry-run] [--resume] [--no-latest] [--wait S]
  scripts/publish-downloads.sh --version X.Y.Z --dist DIR     [--dry-run] [--resume] [--no-latest] [--wait S]
  scripts/publish-downloads.sh --check [--version X.Y.Z]
  scripts/publish-downloads.sh --set-latest X.Y.Z [--dry-run] [--wait S]

  --from-release  the assets of the GitHub release vX.Y.Z of the private repository ${GITHUB_REPO} (your gh login)
  --dist DIR      a local directory with the seven files (scripts/release-assets.sh --out)
  --dry-run       check the files and what is published, print the plan; upload nothing, never run wrangler
  --resume        an earlier run stopped halfway: skip the files already there when byte-identical (never overwrite)
  --no-latest     upload the version only; latest/ stays as it is
  --wait S        how long the read-back may wait for the files to appear (default 60 s)
  --check         read-only: verify a published version (default: the one latest/VERSION names) as people get it
  --set-latest V  point latest/ at the published version V (a rollback), after verifying V

A rehearsal against stand-ins on this machine, never Cloudflare: SMURG_PUBLISH_TEST_ORIGIN=http://127.0.0.1:<port>/…
and SMURG_PUBLISH_TEST_WRANGLER=<stand-in>, optionally SMURG_PUBLISH_TEST_SITE_INSTALL_URL and SMURG_PUBLISH_TEST_GH.

Exit codes: 0 done, 1 failed or refused, 2 usage, 3 you must act first (log in, choose an account, create the bucket).
Runbook: docs/RELEASING.md §4 (publish), §7 (roll back).`;

export class PublishError extends Error {
  override readonly name = 'PublishError';
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────────────────────

export type Source = { readonly kind: 'release' } | { readonly kind: 'dist'; readonly dir: string };

export type PublishOptions =
  | {
      readonly mode: 'publish';
      readonly version: string;
      readonly source: Source;
      readonly dryRun: boolean;
      readonly resume: boolean;
      readonly noLatest: boolean;
      readonly waitSeconds: number;
    }
  | { readonly mode: 'check'; readonly version: string | null }
  | { readonly mode: 'set-latest'; readonly version: string; readonly dryRun: boolean; readonly waitSeconds: number };

/** X.Y.Z, or the tag form vX.Y.Z; null when it is neither. */
export function normalizeVersion(text: string): string | null {
  const version = text.startsWith('v') ? text.slice(1) : text;
  return VERSION_PATTERN.test(version) ? version : null;
}

export function parsePublishArgs(argv: readonly string[]): PublishOptions | 'help' {
  let version: string | undefined;
  let setLatest: string | undefined;
  let fromRelease = false;
  let dist: string | undefined;
  let dryRun = false;
  let resume = false;
  let noLatest = false;
  let check = false;
  let wait: number | undefined;
  const usage = (message: string): PublishError => new PublishError(`${message}\n\n${USAGE}`, 2);
  const value = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) throw usage(`${flag} needs a value`);
    return next;
  };
  const versionValue = (i: number, flag: string): string => {
    const raw = value(i, flag);
    const normalized = normalizeVersion(raw);
    if (normalized === null) throw usage(`${flag} ${raw}: not a version X.Y.Z (or X.Y.Z-pre.N)`);
    return normalized;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--version':
        version = versionValue(i, arg);
        i++;
        break;
      case '--set-latest':
        setLatest = versionValue(i, arg);
        i++;
        break;
      case '--from-release':
        fromRelease = true;
        break;
      case '--dist':
        dist = resolve(value(i, arg));
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--resume':
        resume = true;
        break;
      case '--no-latest':
        noLatest = true;
        break;
      case '--check':
        check = true;
        break;
      case '--wait': {
        const raw = value(i, arg);
        if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) > 3600) throw usage(`--wait ${raw}: seconds, 0 to 3600`);
        wait = Number(raw);
        i++;
        break;
      }
      default:
        throw usage(`unknown argument ${arg}`);
    }
  }
  const waitSeconds = wait ?? 60;
  if (check) {
    if (setLatest !== undefined || fromRelease || dist !== undefined || dryRun || resume || noLatest || wait !== undefined) {
      throw usage('--check takes only --version');
    }
    return { mode: 'check', version: version ?? null };
  }
  if (setLatest !== undefined) {
    if (version !== undefined || fromRelease || dist !== undefined || resume || noLatest) throw usage('--set-latest takes only --dry-run and --wait');
    return { mode: 'set-latest', version: setLatest, dryRun, waitSeconds };
  }
  if (version === undefined) throw usage('--version X.Y.Z is required');
  if (fromRelease === (dist !== undefined)) throw usage('give exactly one of --from-release and --dist DIR');
  const source: Source = fromRelease ? { kind: 'release' } : { kind: 'dist', dir: dist as string };
  return { mode: 'publish', version, source, dryRun, resume, noLatest, waitSeconds };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

export const versionKey = (version: string, name: string): string => `v${version}/${name}`;
export const versionBaseUrl = (version: string): string => `${DOWNLOADS_ORIGIN}/v${version}`;

export function contentTypeOf(name: string): string {
  return (EXECUTABLES as readonly string[]).includes(name) ? BINARY_TYPE : TEXT_TYPE;
}

export const isPrerelease = (version: string): boolean => version.includes('-');

/** Semver order of X.Y.Z[-pre] (a pre-release sorts before its release; pre-release parts compare as text). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string | null] => {
    const dash = v.indexOf('-');
    const core = (dash < 0 ? v : v.slice(0, dash)).split('.').map(Number);
    return [core, dash < 0 ? null : v.slice(dash + 1)];
  };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (ca[i] ?? 0) - (cb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (pa === pb) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  return pa < pb ? -1 : 1;
}

/** SHA256SUMS: `<64 hex>  <name>` lines (sha256sum / shasum output). Problems for anything else. */
export function parseSha256Sums(text: string): { readonly sums: ReadonlyMap<string, string>; readonly problems: readonly string[] } {
  const sums = new Map<string, string>();
  const problems: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
    if (match === null) {
      problems.push(`SHA256SUMS: unreadable line "${line.slice(0, 120)}"`);
      continue;
    }
    const [, sum, name] = match as unknown as [string, string, string];
    if (sums.has(name)) problems.push(`SHA256SUMS lists ${name} twice`);
    sums.set(name, sum);
  }
  for (const name of EXECUTABLES) if (!sums.has(name)) problems.push(`SHA256SUMS does not list ${name}`);
  for (const name of sums.keys()) if (!(EXECUTABLES as readonly string[]).includes(name)) problems.push(`SHA256SUMS lists ${name}, which is not one of the four executables`);
  return { sums, problems };
}

/** The download location install.sh has baked in (scripts/release-assets.sh), or a problem. */
export function bakedBaseUrl(installSh: string): { readonly url: string } | { readonly problem: string } {
  const lines = installSh.split('\n').filter((line) => line.startsWith('SMURG_RELEASE_BASE_URL='));
  if (lines.length !== 1) return { problem: `install.sh has ${lines.length} SMURG_RELEASE_BASE_URL= lines, not one` };
  const match = /^SMURG_RELEASE_BASE_URL='([^']*)'$/.exec(lines[0] as string);
  if (match === null || match[1] === '') return { problem: 'install.sh has no download location filled in (scripts/release-assets.sh writes it)' };
  return { url: match[1] as string };
}

export function installShProblems(installSh: string, version: string): string[] {
  const problems: string[] = [];
  if (!installSh.startsWith('#!/bin/sh\n')) problems.push('install.sh does not start with #!/bin/sh');
  const baked = bakedBaseUrl(installSh);
  if ('problem' in baked) problems.push(baked.problem);
  else if (baked.url !== versionBaseUrl(version)) problems.push(`install.sh downloads from ${baked.url}, not ${versionBaseUrl(version)}`);
  return problems;
}

/** The Node.js release whose LICENSE the notices carry (`node@X.Y.Z (the Node.js runtime)`, exactly one), or null. */
export function noticesNodeVersion(text: string): string | null {
  const found = [...text.matchAll(/^node@([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}) \(the Node\.js runtime\)$/gm)].map((m) => m[1] as string);
  return found.length === 1 ? (found[0] as string) : null;
}

export function noticesProblems(text: string): string[] {
  if (text.trim() === '') return [`${NOTICES} is empty`];
  const problems: string[] = [];
  const missing = NOTICE_COMPONENTS.filter((component) => !text.includes(component));
  if (missing.length > 0) problems.push(`${NOTICES} does not mention ${missing.join(', ')} (bundled in every executable)`);
  if (text.includes(NOTICES_PLACEHOLDER)) {
    problems.push(`${NOTICES} is the committed packages/cli/THIRD-PARTY-NOTICES.txt, whose Node.js section is still the placeholder: a release has the file scripts/build-sea.sh writes next to the executable`);
  } else if (noticesNodeVersion(text) === null || !text.includes(NODE_LICENSE_START)) {
    problems.push(`${NOTICES} has no complete Node.js section (exactly one line "node@X.Y.Z (the Node.js runtime)" and the Node.js LICENSE): not the notices scripts/build-sea.sh writes`);
  }
  return problems;
}

/** This machine's executable name, or null when none of the four runs here. */
export function hostExecutable(platform: string = process.platform, arch: string = process.arch): string | null {
  if ((platform !== 'darwin' && platform !== 'linux') || (arch !== 'arm64' && arch !== 'x64')) return null;
  return `smurg-${platform}-${arch}`;
}

const normalizeHeader = (value: string | null): string => (value ?? '').toLowerCase().replace(/\s+/g, '');

/** Warnings when the served Content-Type / Cache-Control differ from what the upload set. */
export function headerWarnings(key: string, headers: Headers, contentType: string, cacheControl: string): string[] {
  const warnings: string[] = [];
  const type = headers.get('content-type');
  if (normalizeHeader(type) !== normalizeHeader(contentType)) warnings.push(`${key}: served with Content-Type ${type ?? '(none)'}, uploaded as ${contentType}`);
  const cache = headers.get('cache-control');
  if (normalizeHeader(cache) !== normalizeHeader(cacheControl)) {
    warnings.push(`${key}: served with Cache-Control ${cache ?? '(none)'}, uploaded with ${cacheControl} (a Cache Rule or the zone's Browser Cache TTL overrides it?)`);
  }
  return warnings;
}

const mib = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`);
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function lastLines(text: string, count = 8): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-count)
    .map((line) => `    ${line}`)
    .join('\n');
}

// ── Processes ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Ran {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function runCommand(file: string, args: readonly string[], options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number }): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64 * 1024 * 1024) stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 1_000_000) stderr += chunk;
    });
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      fail(error);
    });
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      done({ code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(stdout), stderr });
    });
  });
}

// ── The tools: wrangler, gh, file, HTTP ─────────────────────────────────────────────────────────────────────────

export interface PublishDeps {
  /** wrangler (default: the repository's, apps/relay/node_modules/.bin/wrangler). */
  readonly wranglerBin?: string;
  /** gh (default: `gh` on PATH). */
  readonly ghBin?: string;
  /** file (default: `file` on PATH). */
  readonly fileBin?: string;
  /** Where the bucket is read back (default https://downloads.smurg.ai; tests: a local stand-in). */
  readonly origin?: string;
  /** The product page's install URL (default https://smurg.ai/install.sh). */
  readonly siteInstallUrl?: string;
  readonly fetch?: typeof fetch;
  readonly retryIntervalMs?: number;
  /** Check that wrangler's login is the repository's (<repo>/.xdg, scripts/env.sh). Default true; tests turn it off. */
  readonly requireRepoEnvironment?: boolean;
  /** A rehearsal against local stand-ins (depsFromEnvironment): said in the first and the last line of every run. */
  readonly rehearsal?: string;
  readonly out?: (line: string) => void;
  readonly err?: (text: string) => void;
}

/** The environment variables of a rehearsal (the header; depsFromEnvironment). */
export const REHEARSAL_ENV = {
  origin: 'SMURG_PUBLISH_TEST_ORIGIN',
  siteInstallUrl: 'SMURG_PUBLISH_TEST_SITE_INSTALL_URL',
  wrangler: 'SMURG_PUBLISH_TEST_WRANGLER',
  gh: 'SMURG_PUBLISH_TEST_GH',
} as const;

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * The stand-ins a rehearsal names in the environment (see the header), or {} for the real thing. Refuses (exit 2) an
 * address that is not this machine, a stand-in origin without a stand-in wrangler and the other way round, and a
 * relative program path.
 */
export function depsFromEnvironment(env: NodeJS.ProcessEnv): PublishDeps {
  const get = (name: string): string | undefined => (env[name] === undefined || env[name] === '' ? undefined : env[name]);
  const origin = get(REHEARSAL_ENV.origin);
  const site = get(REHEARSAL_ENV.siteInstallUrl);
  const wrangler = get(REHEARSAL_ENV.wrangler);
  const gh = get(REHEARSAL_ENV.gh);
  if (origin === undefined && site === undefined && wrangler === undefined && gh === undefined) return {};
  const local = (name: string, value: string): string => {
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:') || !LOCAL_HOSTS.includes(url.hostname) || url.username !== '' || url.password !== '') {
      throw new PublishError(`${name}=${value}: a rehearsal only talks to this machine (http://127.0.0.1:<port>/…, http://localhost:<port>/…)`, 2);
    }
    return value;
  };
  const program = (name: string, value: string): string => {
    if (!isAbsolute(value)) throw new PublishError(`${name}=${value}: give the absolute path of the stand-in`, 2);
    return value;
  };
  // Any stand-in makes it a rehearsal, and a rehearsal never reaches the real bucket: the real wrangler would upload to
  // it (also the files of a stand-in gh), and the stand-in bucket can only be read back from its stand-in address.
  if (wrangler === undefined) {
    throw new PublishError(`a rehearsal (${REHEARSAL_ENV.origin}, ${REHEARSAL_ENV.siteInstallUrl}, ${REHEARSAL_ENV.gh}) needs ${REHEARSAL_ENV.wrangler} too: it never runs the real wrangler, which would upload to the real bucket ${BUCKET}`, 2);
  }
  if (origin === undefined) {
    throw new PublishError(`${REHEARSAL_ENV.wrangler} needs ${REHEARSAL_ENV.origin}: the stand-in bucket is read back from its stand-in address, not from ${DOWNLOADS_ORIGIN}`, 2);
  }
  const deps: { -readonly [K in keyof PublishDeps]: PublishDeps[K] } = {
    origin: local(REHEARSAL_ENV.origin, origin),
    wranglerBin: program(REHEARSAL_ENV.wrangler, wrangler),
  };
  const said: string[] = [`the bucket is ${wrangler}, read back from ${origin}`];
  if (site !== undefined) {
    deps.siteInstallUrl = local(REHEARSAL_ENV.siteInstallUrl, site);
    said.push(`smurg.ai/install.sh is ${site}`);
  }
  if (gh !== undefined) {
    deps.ghBin = program(REHEARSAL_ENV.gh, gh);
    said.push(`gh is ${gh}`);
  }
  deps.rehearsal = said.join('; ');
  return deps;
}

type Lookup = { readonly kind: 'absent' } | { readonly kind: 'present'; readonly bytes: Buffer } | { readonly kind: 'error'; readonly detail: string };

interface Fetched {
  readonly status: number;
  readonly headers: Headers;
  readonly location: string | null;
}

class Tools {
  readonly origin: string;
  readonly siteInstallUrl: string;
  /** smurg.ai's copy of the executables' notices (next to its install.sh: https://smurg.ai/third-party-notices.txt). */
  readonly siteNoticesUrl: string;
  readonly retryIntervalMs: number;
  readonly requireRepoEnvironment: boolean;
  readonly rehearsal: string | null;
  private readonly wranglerBin: string;
  private readonly ghBin: string;
  private readonly fileBin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly write: (line: string) => void;
  readonly warnings: string[] = [];

  constructor(deps: PublishDeps) {
    this.wranglerBin = deps.wranglerBin ?? WRANGLER_BIN;
    this.ghBin = deps.ghBin ?? 'gh';
    this.fileBin = deps.fileBin ?? 'file';
    this.origin = (deps.origin ?? DOWNLOADS_ORIGIN).replace(/\/+$/, '');
    this.siteInstallUrl = deps.siteInstallUrl ?? SITE_INSTALL_URL;
    this.siteNoticesUrl = new URL('third-party-notices.txt', this.siteInstallUrl).href;
    this.fetchImpl = deps.fetch ?? fetch;
    this.retryIntervalMs = deps.retryIntervalMs ?? 5_000;
    this.requireRepoEnvironment = deps.requireRepoEnvironment ?? true;
    this.rehearsal = deps.rehearsal ?? null;
    this.write = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  }

  out(text = ''): void {
    this.write(text);
  }

  step(n: number, total: number, text: string): void {
    this.out(`\n── [${n}/${total}] ${text}`);
  }

  warn(text: string): void {
    this.warnings.push(text);
    this.out(`  ! ${text}`);
  }

  /** The public URL of a key; `bypass` adds a query string no edge cache has seen (R2 ignores it). */
  url(key: string, bypass = false): string {
    return `${this.origin}/${key}${bypass ? `?publish=${randomBytes(8).toString('hex')}` : ''}`;
  }

  // ── HTTP

  async head(url: string): Promise<Fetched | { readonly error: string }> {
    try {
      const response = await this.fetchImpl(url, { method: 'HEAD', redirect: 'manual' });
      return { status: response.status, headers: response.headers, location: response.headers.get('location') };
    } catch (error) {
      return { error: describeFetchError(error) };
    }
  }

  async getText(url: string): Promise<(Fetched & { readonly body: Buffer }) | { readonly error: string }> {
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual' });
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, location: response.headers.get('location'), body };
    } catch (error) {
      return { error: describeFetchError(error) };
    }
  }

  /** GET into a file, hashing on the way. */
  async getToFile(url: string, path: string): Promise<(Fetched & { readonly sha256: string; readonly size: number }) | { readonly error: string }> {
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual' });
      if (response.status !== 200 || response.body === null) {
        await response.body?.cancel();
        return { status: response.status, headers: response.headers, location: response.headers.get('location'), sha256: '', size: 0 };
      }
      const hash = createHash('sha256');
      let size = 0;
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
      body.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
      });
      await pipeline(body, createWriteStream(path));
      return { status: response.status, headers: response.headers, location: null, sha256: hash.digest('hex'), size };
    } catch (error) {
      return { error: describeFetchError(error) };
    }
  }

  // ── wrangler (the repo-local login; scripts/env.sh)

  private wrangler(args: readonly string[]): Promise<Ran> {
    return runCommand(this.wranglerBin, args, { cwd: REPO_ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  }

  async requireLogin(): Promise<void> {
    const ran = await this.wrangler(['whoami', '--json']);
    const text = ran.stdout.toString('utf8');
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    let parsed: { loggedIn?: unknown; accounts?: unknown } = {};
    if (ran.code === 0 && first >= 0 && last > first) {
      try {
        parsed = JSON.parse(text.slice(first, last + 1)) as typeof parsed;
      } catch {
        parsed = {};
      }
    }
    const login = 'CI=false pnpm --filter @smurg/relay exec wrangler login';
    if (parsed.loggedIn !== true || !Array.isArray(parsed.accounts)) {
      throw new PublishError(`wrangler is not logged in to Cloudflare (its login lives in ${join(REPO_ROOT, '.xdg')}). From the repository root:\n  source scripts/env.sh\n  ${login}`, 3);
    }
    const accounts = (parsed.accounts as { id?: unknown; name?: unknown }[])
      .filter((a): a is { id: string; name?: unknown } => typeof a?.id === 'string')
      .map((a) => ({ id: a.id, name: typeof a.name === 'string' ? a.name : a.id }));
    const chosen = process.env['CLOUDFLARE_ACCOUNT_ID'];
    const account = chosen ? accounts.find((a) => a.id === chosen) : accounts.length === 1 ? accounts[0] : undefined;
    if (account === undefined) {
      throw new PublishError(
        [
          chosen ? `CLOUDFLARE_ACCOUNT_ID=${chosen} is not an account of this login:` : 'This Cloudflare login has several accounts; choose the one that holds smurg.ai:',
          ...accounts.map((a) => `  ${a.id}  ${a.name}`),
          '  then: CLOUDFLARE_ACCOUNT_ID=<account id> scripts/publish-downloads.sh …',
        ].join('\n'),
        3,
      );
    }
    this.out(`  Cloudflare account: ${account.name} (${account.id})`);
  }

  /** `wrangler r2 bucket list` (not `bucket info`, which also queries the analytics API) must name the bucket. */
  async requireBucket(): Promise<void> {
    const ran = await this.wrangler(['r2', 'bucket', 'list']);
    // Without colours (wrangler colours its labels when it thinks it has a terminal).
    const all = `${ran.stdout.toString('utf8')}\n${ran.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
    if (ran.code !== 0) throw new PublishError(`wrangler r2 bucket list failed (exit ${ran.code}):\n${lastLines(all)}`);
    if (new RegExp(`^name:\\s+${BUCKET}\\s*$`, 'm').test(all)) {
      this.out(`  R2 bucket ${BUCKET}: there`);
      return;
    }
    throw new PublishError(`the R2 bucket ${BUCKET} does not exist yet: create it and connect ${DOWNLOADS_ORIGIN.replace('https://', '')} first (docs/RELEASING.md §1.5)`, 3);
  }

  /** A small object straight from the bucket (bypassing the custom domain). */
  async bucketObject(key: string): Promise<Lookup> {
    const ran = await this.wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--pipe']);
    if (ran.code === 0) return { kind: 'present', bytes: ran.stdout };
    if (/The specified key does not exist/.test(ran.stderr) || /The specified key does not exist/.test(ran.stdout.toString('utf8'))) return { kind: 'absent' };
    return { kind: 'error', detail: lastLines(`${ran.stderr}\n${ran.stdout.toString('utf8')}`) };
  }

  async put(key: string, file: string, contentType: string, cacheControl: string): Promise<void> {
    const ran = await this.wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--remote', '--content-type', contentType, '--cache-control', cacheControl]);
    if (ran.code !== 0) throw new PublishError(`wrangler r2 object put ${BUCKET}/${key} failed (exit ${ran.code}):\n${lastLines(`${ran.stderr}\n${ran.stdout.toString('utf8')}`)}`);
  }

  // ── gh (the person's own login; scripts/publish-downloads.sh passes its config dir, which scripts/env.sh hides)

  private gh(args: readonly string[]): Promise<Ran> {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
    const configDir = process.env['SMURG_GH_CONFIG_DIR'];
    if (configDir) env['GH_CONFIG_DIR'] = configDir;
    return runCommand(this.ghBin, args, { cwd: REPO_ROOT, env }).catch((error: unknown) => {
      throw new PublishError(`cannot run gh (${error instanceof Error ? error.message : String(error)}): --from-release needs the GitHub CLI logged in to an account with access to ${GITHUB_REPO}`, 3);
    });
  }

  private ghFailure(what: string, ran: Ran): PublishError {
    const all = `${ran.stderr}\n${ran.stdout.toString('utf8')}`;
    if (/gh auth login|not logged in|authentication|HTTP 401/i.test(all)) return new PublishError(`${what}: gh is not logged in (run gh auth login, outside scripts/env.sh):\n${lastLines(all)}`, 3);
    return new PublishError(`${what} failed (exit ${ran.code}):\n${lastLines(all)}`);
  }

  async releaseAssets(version: string, dir: string): Promise<void> {
    const tag = `v${version}`;
    const viewed = await this.gh(['release', 'view', tag, '--repo', GITHUB_REPO, '--json', 'tagName,isDraft,assets']);
    if (viewed.code !== 0) throw this.ghFailure(`gh release view ${tag} --repo ${GITHUB_REPO}`, viewed);
    let release: { tagName?: unknown; isDraft?: unknown; assets?: unknown };
    try {
      release = JSON.parse(viewed.stdout.toString('utf8')) as typeof release;
    } catch {
      throw new PublishError(`gh release view ${tag}: the output is not JSON`);
    }
    if (release.tagName !== tag) throw new PublishError(`gh release view ${tag}: got the release ${String(release.tagName)}`);
    if (release.isDraft !== false) throw new PublishError(`the GitHub release ${tag} is still a draft: the release workflow did not finish its checks (docs/RELEASING.md §4)`);
    const names = Array.isArray(release.assets) ? release.assets.map((a) => (a as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string') : [];
    const missing = UPLOAD_ORDER.filter((name) => !names.includes(name));
    if (missing.length > 0) throw new PublishError(`the GitHub release ${tag} has no ${missing.join(', ')}`);
    this.out(`  GitHub release ${tag} (${GITHUB_REPO}): published, with all seven files; downloading…`);
    const downloaded = await this.gh(['release', 'download', tag, '--repo', GITHUB_REPO, '--dir', dir, ...UPLOAD_ORDER.flatMap((name) => ['--pattern', name])]);
    if (downloaded.code !== 0) throw this.ghFailure(`gh release download ${tag}`, downloaded);
  }

  // ── file

  async describe(path: string): Promise<string> {
    const ran = await runCommand(this.fileBin, ['-b', path], { cwd: REPO_ROOT }).catch((error: unknown) => ({ code: -1, stdout: Buffer.alloc(0), stderr: error instanceof Error ? error.message : String(error) }));
    return ran.code === 0 ? ran.stdout.toString('utf8').trim() : `(file failed: ${ran.stderr.trim()})`;
  }

  async sleep(): Promise<void> {
    await new Promise((done) => setTimeout(done, this.retryIntervalMs));
  }
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    return `${error.message}${detail}`;
  }
  return String(error);
}

// ── Verifying the files ──────────────────────────────────────────────────────────────────────────────────────────

export interface LocalFile {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * Runs this machine's executable (a 0755 copy in `scratch`): it must say exactly `smurg <version> (`, and end with
 * `node <node>)` when the Node.js of the notices is known.
 */
async function versionProblem(path: string, name: string, version: string, node: string | null, scratch: string): Promise<string | null> {
  const copy = join(scratch, `${name}.version-check`);
  await copyFile(path, copy);
  await chmod(copy, 0o755);
  try {
    const ran = await runCommand(copy, ['--version'], { cwd: scratch, timeoutMs: 60_000 });
    const reported = ran.stdout.toString('utf8').trim();
    if (ran.code !== 0 || !reported.startsWith(`smurg ${version} (`)) {
      return `${name} --version said '${reported || ran.stderr.trim().split('\n')[0] || `exit ${ran.code}`}', not 'smurg ${version} (…'`;
    }
    if (node !== null && nodeOfVersionLine(reported) !== node) return `${name} --version said '${reported}': not Node.js ${node}, whose LICENSE the notices carry`;
    return null;
  } finally {
    await rm(copy, { force: true });
  }
}

/** The build marker and the Node.js release of each executable (scripts/release-markers.ts), and whether they agree. */
class MarkerCheck {
  private readonly nodes = new Map<string, string>();
  private readonly version: string;
  readonly problems: string[] = [];

  constructor(version: string) {
    this.version = version;
  }

  async add(name: string, path: string): Promise<void> {
    const markers = await markersOfFile(path);
    this.problems.push(...markerProblems(name, markers, this.version));
    if (markers.nodeVersions.length === 1) this.nodes.set(name, markers.nodeVersions[0] as string);
  }

  /** Every problem, the disagreements with the notices' Node.js (`noticesNode`) included. */
  finish(noticesNode: string | null): string[] {
    return [...this.problems, ...nodeAgreementProblems(this.nodes, noticesNode)];
  }

  /** "Node.js X.Y.Z" when every executable checked so far is the same one. */
  get node(): string | null {
    const versions = new Set(this.nodes.values());
    return versions.size === 1 ? ([...versions][0] as string) : null;
  }
}

/** Step 2: everything about the seven local files that can be checked without the network. */
async function verifyLocalRelease(t: Tools, dir: string, version: string, scratch: string): Promise<Map<string, LocalFile>> {
  const files = new Map<string, LocalFile>();
  const problems: string[] = [];
  for (const name of UPLOAD_ORDER) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) {
      problems.push(`${path} is missing`);
      continue;
    }
    if (info.size === 0) problems.push(`${path} is empty`);
    files.set(name, { name, path, sha256: await sha256OfFile(path), size: info.size });
  }
  const sumsFile = files.get('SHA256SUMS');
  if (sumsFile !== undefined) {
    const parsed = parseSha256Sums(await readFile(sumsFile.path, 'utf8'));
    problems.push(...parsed.problems);
    for (const name of EXECUTABLES) {
      const file = files.get(name);
      const expected = parsed.sums.get(name);
      if (file !== undefined && expected !== undefined && file.sha256 !== expected) problems.push(`${name}: sha256 ${file.sha256}, but SHA256SUMS says ${expected}`);
    }
  }
  const markers = new MarkerCheck(version);
  for (const name of EXECUTABLES) {
    const file = files.get(name);
    if (file === undefined) continue;
    const described = await t.describe(file.path);
    if (!(ARCH_PATTERNS[name] as RegExp).test(described)) problems.push(`${name} is not the executable its name says: ${described}`);
    await markers.add(name, file.path);
  }
  const noticesFile = files.get(NOTICES);
  const noticesText = noticesFile === undefined ? null : await readFile(noticesFile.path, 'utf8');
  if (noticesText !== null) problems.push(...noticesProblems(noticesText));
  const noticesNode = noticesText === null ? null : noticesNodeVersion(noticesText);
  const markerProblemList = markers.finish(noticesNode);
  problems.push(...markerProblemList);
  if (markerProblemList.length === 0 && markers.node !== null) t.out(`  every executable: built as smurg ${version}, Node.js ${markers.node} (the notices' Node.js too)`);
  const host = hostExecutable();
  const hostFile = host === null ? undefined : files.get(host);
  if (host === null) t.warn(`no executable of the four runs on this machine (${process.platform}-${process.arch}): the version is not run`);
  else if (hostFile !== undefined) {
    const problem = await versionProblem(hostFile.path, host, version, noticesNode, scratch);
    if (problem === null) t.out(`  ${host} --version: smurg ${version} (…${noticesNode === null ? '' : ` node ${noticesNode}`})`);
    else problems.push(problem);
  }
  const installFile = files.get('install.sh');
  if (installFile !== undefined) problems.push(...installShProblems(await readFile(installFile.path, 'utf8'), version));
  if (problems.length > 0) throw new PublishError(`the files of ${version} are not right; nothing was uploaded:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return files;
}

// ── What is published ────────────────────────────────────────────────────────────────────────────────────────────

type RemoteState = { readonly kind: 'absent' } | { readonly kind: 'same' } | { readonly kind: 'different'; readonly sha256: string } | { readonly kind: 'error'; readonly detail: string };

/** Is `key` there, and is it `expected`? Through the custom domain (bypassing the edge cache); never writes. */
async function remoteState(t: Tools, key: string, expected: string, scratch: string): Promise<RemoteState> {
  const headed = await t.head(t.url(key, true));
  if ('error' in headed) return { kind: 'error', detail: `${t.url(key)}: ${headed.error}` };
  if (headed.status === 404) return { kind: 'absent' };
  if (headed.status !== 200) return { kind: 'error', detail: `${t.url(key)}: HTTP ${headed.status}` };
  const path = join(scratch, `remote-${randomBytes(6).toString('hex')}`);
  try {
    const got = await t.getToFile(t.url(key, true), path);
    if ('error' in got) return { kind: 'error', detail: `${t.url(key)}: ${got.error}` };
    if (got.status !== 200) return { kind: 'error', detail: `${t.url(key)}: HTTP ${got.status} after HEAD 200` };
    return got.sha256 === expected ? { kind: 'same' } : { kind: 'different', sha256: got.sha256 };
  } finally {
    await rm(path, { force: true });
  }
}

/** latest/VERSION as served (bypassing the edge cache): the version, null when there is none yet. */
async function currentLatest(t: Tools, bypass: boolean): Promise<{ readonly version: string | null } | { readonly error: string }> {
  const got = await t.getText(t.url('latest/VERSION', bypass));
  if ('error' in got) return { error: got.error };
  if (got.status === 404) return { version: null };
  if (got.status !== 200) return { error: `HTTP ${got.status}` };
  const version = got.body.toString('utf8').trim();
  if (normalizeVersion(version) !== version) return { error: `latest/VERSION says "${version.slice(0, 40)}", not a version` };
  return { version };
}

/**
 * Reads `key` back until it is `expected` (sha256) or the time is up. Returns the headers of the matching answer, or
 * the last problem: `mismatch` when the domain served other bytes, `unavailable` for an HTTP error or no answer.
 */
async function readBack(
  t: Tools,
  key: string,
  expected: string,
  waitSeconds: number,
  scratch: string,
): Promise<{ readonly headers: Headers } | { readonly problem: string; readonly key: string; readonly kind: 'mismatch' | 'unavailable' }> {
  const deadline = Date.now() + waitSeconds * 1000;
  const path = join(scratch, `readback-${randomBytes(6).toString('hex')}`);
  try {
    for (;;) {
      const got = await t.getToFile(t.url(key, true), path);
      let problem: string;
      let kind: 'mismatch' | 'unavailable' = 'unavailable';
      if ('error' in got) problem = got.error;
      else if (got.status !== 200) problem = `HTTP ${got.status}`;
      else if (got.sha256 !== expected) {
        problem = `sha256 ${got.sha256}, expected ${expected}`;
        kind = 'mismatch';
      } else return { headers: got.headers };
      if (Date.now() >= deadline) return { problem: `${t.url(key)}: ${problem}`, key, kind };
      await t.sleep();
    }
  } finally {
    await rm(path, { force: true });
  }
}

// ── latest/ ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Uploads latest/install.sh (a copy of `installSh`, the version's own) and latest/VERSION, and reads them back. */
async function switchLatest(t: Tools, version: string, installSh: string, waitSeconds: number, scratch: string): Promise<void> {
  const versionFile = join(scratch, 'VERSION');
  await writeFile(versionFile, `${version}\n`);
  const latest: readonly [string, string][] = [
    ['latest/install.sh', installSh],
    ['latest/VERSION', versionFile],
  ];
  for (const [key, file] of latest) {
    t.out(`  uploading ${key}`);
    await t.put(key, file, TEXT_TYPE, LATEST_CACHE);
  }
  for (const [key, file] of latest) {
    const expected = await sha256OfFile(file);
    const back = await readBack(t, key, expected, waitSeconds, scratch);
    if ('problem' in back) throw new PublishError(`latest/ was uploaded but does not read back right: ${back.problem}. Run again with --set-latest ${version}.`);
    for (const warning of headerWarnings(key, back.headers, TEXT_TYPE, LATEST_CACHE)) t.warn(warning);
    t.out(`  ok  ${t.url(key)}`);
  }
  // What curl gets right now (the edge may still hold the previous copy, for at most max-age=300).
  const plain = await t.getText(t.url('latest/VERSION'));
  if ('error' in plain || plain.status !== 200 || plain.body.toString('utf8').trim() !== version) {
    t.warn(`${t.url('latest/VERSION')} does not say ${version} yet (an edge cache: up to 5 minutes); check again with --check`);
  }
}

/** https://smurg.ai/install.sh must answer 302 to latest/install.sh (apps/site). */
async function siteRedirectProblem(t: Tools): Promise<string | null> {
  const target = `${DOWNLOADS_ORIGIN}/latest/install.sh`;
  const headed = await t.head(t.siteInstallUrl);
  if ('error' in headed) return `${t.siteInstallUrl}: ${headed.error}`;
  if (headed.status !== 302 || headed.location !== target) return `${t.siteInstallUrl} answers ${headed.status}${headed.location ? ` → ${headed.location}` : ''}, not 302 → ${target} (redeploy apps/site: docs/RELEASING.md §4.1)`;
  return null;
}

/**
 * smurg.ai publishes the executables' notices too: they should be the latest version's file byte for byte (the site is
 * deployed with SMURG_SITE_THIRD_PARTY_NOTICES=<that file>, docs/RELEASING.md §4.1). A warning, not a failure: the site
 * is redeployed after the release is published.
 */
async function siteNoticesWarning(t: Tools, version: string, notices: Buffer): Promise<string | null> {
  const got = await t.getText(t.siteNoticesUrl);
  const redeploy = `redeploy smurg.ai with SMURG_SITE_THIRD_PARTY_NOTICES=<v${version}/${NOTICES}> (docs/RELEASING.md §4.1)`;
  if ('error' in got) return `${t.siteNoticesUrl}: ${got.error}`;
  if (got.status !== 200) return `${t.siteNoticesUrl} answers ${got.status}: ${redeploy}`;
  if (!got.body.equals(notices)) {
    const node = (text: Buffer): string => noticesNodeVersion(text.toString('utf8')) ?? 'none';
    return `${t.siteNoticesUrl} is not v${version}/${NOTICES} (its Node.js section: ${node(got.body)}; the release's: ${node(notices)}): ${redeploy}`;
  }
  return null;
}

// ── A published version, as people get it ───────────────────────────────────────────────────────────────────────

interface VerifiedVersion {
  readonly installShPath: string;
  /** THIRD-PARTY-NOTICES.txt as served, when it could be read. */
  readonly notices: string | null;
  readonly problems: readonly string[];
}

/**
 * Every file of v<version> through the public URLs (`bypass`: past the edge cache): SHA256SUMS, each executable's
 * sha256 and type, this machine's --version, install.sh's download location, the notices, the headers (warnings).
 * Returns the problems and keeps install.sh in `scratch`.
 */
async function verifyPublishedVersion(t: Tools, version: string, scratch: string, bypass: boolean): Promise<VerifiedVersion> {
  const problems: string[] = [];
  const text = async (name: string): Promise<string | null> => {
    const key = versionKey(version, name);
    const got = await t.getText(t.url(key, bypass));
    if ('error' in got) {
      problems.push(`${t.url(key)}: ${got.error}`);
      return null;
    }
    if (got.status !== 200) {
      problems.push(`${t.url(key)}: HTTP ${got.status}`);
      return null;
    }
    for (const warning of headerWarnings(key, got.headers, TEXT_TYPE, IMMUTABLE)) t.warn(warning);
    t.out(`  ok  ${t.url(key)}`);
    return got.body.toString('utf8');
  };
  const installShPath = join(scratch, 'install.sh');
  const sumsText = await text('SHA256SUMS');
  const installSh = await text('install.sh');
  if (installSh !== null) {
    await writeFile(installShPath, installSh);
    problems.push(...installShProblems(installSh, version));
  }
  const notices = await text(NOTICES);
  if (notices !== null) problems.push(...noticesProblems(notices));
  const noticesNode = notices === null ? null : noticesNodeVersion(notices);
  if (sumsText === null) return { installShPath, notices, problems };
  const sums = parseSha256Sums(sumsText);
  problems.push(...sums.problems);
  const host = hostExecutable();
  const markers = new MarkerCheck(version);
  for (const name of EXECUTABLES) {
    const expected = sums.sums.get(name);
    if (expected === undefined) continue;
    const key = versionKey(version, name);
    const path = join(scratch, name);
    try {
      const got = await t.getToFile(t.url(key, bypass), path);
      if ('error' in got) {
        problems.push(`${t.url(key)}: ${got.error}`);
        continue;
      }
      if (got.status !== 200) {
        problems.push(`${t.url(key)}: HTTP ${got.status}`);
        continue;
      }
      if (got.sha256 !== expected) {
        problems.push(`${t.url(key)}: sha256 ${got.sha256}, but SHA256SUMS says ${expected}`);
        continue;
      }
      for (const warning of headerWarnings(key, got.headers, BINARY_TYPE, IMMUTABLE)) t.warn(warning);
      const described = await t.describe(path);
      if (!(ARCH_PATTERNS[name] as RegExp).test(described)) problems.push(`${t.url(key)} is not the executable its name says: ${described}`);
      await markers.add(name, path);
      if (name === host) {
        const problem = await versionProblem(path, name, version, noticesNode, scratch);
        if (problem !== null) problems.push(problem);
      }
      t.out(`  ok  ${t.url(key)} (${mib(got.size)}, sha256 matches${name === host ? `, --version smurg ${version}` : ''})`);
    } finally {
      await rm(path, { force: true });
    }
  }
  const markerProblemList = markers.finish(noticesNode);
  problems.push(...markerProblemList);
  if (markerProblemList.length === 0 && markers.node !== null) t.out(`  ok  every executable is smurg ${version} on Node.js ${markers.node}, as the notices say`);
  return { installShPath, notices, problems };
}

// ── The modes ────────────────────────────────────────────────────────────────────────────────────────────────────

function assertRepoEnvironment(t: Tools): void {
  if (!t.requireRepoEnvironment) return;
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg === undefined || resolve(xdg) !== resolve(REPO_ROOT, '.xdg')) {
    throw new PublishError("run it as scripts/publish-downloads.sh (it sources scripts/env.sh, so wrangler uses the repository's own login in .xdg/)", 2);
  }
}

async function runPublish(t: Tools, options: Extract<PublishOptions, { mode: 'publish' }>, scratch: string): Promise<number> {
  const { version, dryRun } = options;
  const total = dryRun ? 4 : 7;
  let n = 0;
  t.out(`publish smurg ${version} on ${t.origin}${dryRun ? ' (dry run: nothing is uploaded)' : ''}`);

  t.step(++n, total, options.source.kind === 'release' ? `The files: the GitHub release v${version} of ${GITHUB_REPO}` : `The files: ${options.source.dir}`);
  let dir: string;
  if (options.source.kind === 'release') {
    dir = join(scratch, 'release');
    await mkdir(dir, { recursive: true });
    await t.releaseAssets(version, dir);
  } else {
    dir = options.source.dir;
  }

  t.step(++n, total, 'Checking them (SHA256SUMS, file types, the version, install.sh, the notices)');
  const files = await verifyLocalRelease(t, dir, version, scratch);
  for (const name of UPLOAD_ORDER) {
    const file = files.get(name) as LocalFile;
    t.out(`  ${name.padEnd(24)} ${mib(file.size).padStart(10)}  ${file.sha256}`);
  }

  if (!dryRun) {
    t.step(++n, total, 'Cloudflare: the login and the bucket');
    assertRepoEnvironment(t);
    await t.requireLogin();
    await t.requireBucket();
  }

  t.step(++n, total, `What ${t.url(`v${version}/`)} and latest/ hold now`);
  const states = new Map<string, RemoteState>();
  for (const name of UPLOAD_ORDER) {
    const file = files.get(name) as LocalFile;
    const key = versionKey(version, name);
    let state = await remoteState(t, key, file.sha256, scratch);
    // The small files straight from the bucket too (a `get` of an executable would download it): the custom domain
    // might not show everything (an edge cache holding a 404).
    if (!dryRun && state.kind === 'absent' && !(EXECUTABLES as readonly string[]).includes(name)) {
      const inBucket = await t.bucketObject(key);
      if (inBucket.kind === 'error') state = { kind: 'error', detail: `wrangler r2 object get ${BUCKET}/${key}:\n${inBucket.detail}` };
      else if (inBucket.kind === 'present') state = sha256(inBucket.bytes) === file.sha256 ? { kind: 'same' } : { kind: 'different', sha256: sha256(inBucket.bytes) };
    }
    states.set(name, state);
  }
  const errors = [...states.entries()].filter((entry): entry is [string, Extract<RemoteState, { kind: 'error' }>] => entry[1].kind === 'error');
  if (errors.length > 0) {
    const detail = errors.map(([, s]) => `  - ${s.detail}`).join('\n');
    if (!dryRun) throw new PublishError(`cannot tell whether v${version} is already published, so nothing is uploaded:\n${detail}\n(is ${t.origin} connected to the bucket? docs/RELEASING.md §1.5)`);
    t.warn(`cannot check ${t.origin} (not set up yet?), so the dry run does not know what is published:\n${detail}`);
  }
  const there = [...states.entries()].filter(([, s]) => s.kind === 'same' || s.kind === 'different');
  const differing = there.filter(([, s]) => s.kind === 'different').map(([name]) => name);
  if (there.length > 0 && !options.resume) {
    throw new PublishError(
      [
        `v${version} is already on ${t.origin} (${there.map(([name]) => name).join(', ')}): a published version is never overwritten.`,
        '  If an earlier run stopped halfway, run the same command again with --resume (it uploads only the missing files',
        '  and refuses any that differ). Otherwise this version number is used up: cut X.Y.(Z+1) (docs/RELEASING.md §4).',
      ].join('\n'),
    );
  }
  if (differing.length > 0) {
    throw new PublishError(
      [
        `--resume: ${differing.map((name) => versionKey(version, name)).join(', ')} already exist with other contents than these files; a published file is never overwritten.`,
        '  Are these the files of the first run? If they are, and the bucket holds other bytes than were uploaded, see',
        `  docs/RELEASING.md §4 step 7 ("other bytes"): the owner deletes only those objects, or ${version} is used up.`,
      ].join('\n'),
    );
  }
  for (const [name, state] of states) t.out(`  ${versionKey(version, name).padEnd(36)} ${state.kind === 'same' ? 'already there, identical (skipped)' : state.kind === 'absent' ? 'not there yet' : 'unknown'}`);
  /** --resume found the whole version already published: this run uploads nothing. */
  const complete = UPLOAD_ORDER.every((name) => states.get(name)?.kind === 'same');

  let latestPlan: 'switch' | 'keep';
  const latest = await currentLatest(t, true);
  const latestText = 'error' in latest ? `unknown (${latest.error})` : (latest.version ?? 'none yet');
  let keptHint: string | null = null;
  if (isPrerelease(version)) {
    latestPlan = 'keep';
    t.out(`  latest/: ${latestText}; stays (${version} is a pre-release: it never becomes latest)`);
  } else if (options.noLatest) {
    latestPlan = 'keep';
    t.out(`  latest/: ${latestText}; stays (--no-latest)`);
  } else if ('error' in latest) {
    if (!dryRun) throw new PublishError(`cannot read ${t.url('latest/VERSION')}: ${latest.error}`);
    latestPlan = 'switch';
    t.warn(`cannot read ${t.url('latest/VERSION')}: ${latest.error}`);
  } else if (complete && latest.version !== null && latest.version !== version) {
    // Every file was already there: an earlier run uploaded them all, and latest/ may have been moved away from this
    // version on purpose since (a rollback, docs/RELEASING.md §7). Resuming does not undo that.
    latestPlan = 'keep';
    keptHint = `every file of v${version} was already published, so this run leaves latest/ at ${latest.version}. If the earlier run stopped before switching latest/ (and nobody rolled it back since), make ${version} the latest version with:  scripts/publish-downloads.sh --set-latest ${version}`;
    t.out(`  latest/: ${latestText}; stays: ${keptHint}`);
  } else if (latest.version !== null && compareVersions(latest.version, version) > 0) {
    throw new PublishError(
      `latest/ is ${latest.version}, newer than ${version}: publishing ${version} would move it back. Use --no-latest to upload ${version} without switching, or --set-latest ${version} later to roll back on purpose (docs/RELEASING.md §7).`,
    );
  } else {
    latestPlan = 'switch';
    t.out(`  latest/: ${latestText} → ${version} after every file of v${version} has read back right`);
  }

  if (dryRun) {
    t.step(++n, total, 'The plan (dry run: nothing uploaded)');
    for (const name of UPLOAD_ORDER) {
      if (states.get(name)?.kind === 'same') continue;
      t.out(`  wrangler r2 object put ${BUCKET}/${versionKey(version, name)} --file ${(files.get(name) as LocalFile).path} --remote --content-type '${contentTypeOf(name)}' --cache-control '${IMMUTABLE}'`);
    }
    if (latestPlan === 'switch') {
      t.out(`  then, after reading every file back: latest/install.sh (= v${version}/install.sh) and latest/VERSION (${version}), --cache-control '${LATEST_CACHE}'`);
    }
    t.out(`\ndry run done: the files of ${version} are right${t.warnings.length > 0 ? ` (${t.warnings.length} warning(s) above)` : ''}. Without --dry-run this uploads them.`);
    return 0;
  }

  t.step(++n, total, `Uploading v${version}/ (immutable: ${IMMUTABLE})`);
  for (const name of UPLOAD_ORDER) {
    const file = files.get(name) as LocalFile;
    const key = versionKey(version, name);
    if (states.get(name)?.kind === 'same') {
      t.out(`  skip ${key} (already there, identical)`);
      continue;
    }
    t.out(`  uploading ${key} (${mib(file.size)}, ${contentTypeOf(name)})…`);
    try {
      await t.put(key, file.path, contentTypeOf(name), IMMUTABLE);
    } catch (error) {
      if (error instanceof PublishError) throw new PublishError(`${error.message}\nlatest/ was not touched. Run the same command again with --resume.`);
      throw error;
    }
  }

  t.step(++n, total, `Reading every file back through ${t.origin}`);
  const readProblems: { readonly problem: string; readonly key: string; readonly kind: 'mismatch' | 'unavailable' }[] = [];
  for (const name of UPLOAD_ORDER) {
    const file = files.get(name) as LocalFile;
    const key = versionKey(version, name);
    const back = await readBack(t, key, file.sha256, options.waitSeconds, scratch);
    if ('problem' in back) {
      readProblems.push(back);
      continue;
    }
    for (const warning of headerWarnings(key, back.headers, contentTypeOf(name), IMMUTABLE)) t.warn(warning);
    t.out(`  ok  ${t.url(key)}`);
  }
  if (readProblems.length > 0) {
    const mismatched = readProblems.filter((p) => p.kind === 'mismatch').map((p) => p.key);
    const next =
      mismatched.length === 0
        ? [
            'These are HTTP errors or timeouts: the files may not have reached the custom domain yet. Run the same command again',
            `with --resume (and a longer --wait): it uploads only what is missing. If it then says every file of v${version} was`,
            `already published, finish with  scripts/publish-downloads.sh --set-latest ${version}  (docs/RELEASING.md §4 step 7).`,
          ]
        : [
            `${mismatched.join(', ')} ${mismatched.length === 1 ? 'is' : 'are'} public now with other bytes than were uploaded, but ${version} never became`,
            'latest. Nothing is overwritten automatically, and --resume refuses such a file. Find out why first (download it and',
            'compare). Then either the owner deletes only those objects:',
            ...mismatched.map((key) => `  pnpm --filter @smurg/relay exec wrangler r2 object delete ${BUCKET}/${key} --remote`),
            `and runs the same command again with --resume, or ${version} is used up: cut X.Y.(Z+1) (docs/RELEASING.md §4 step 7).`,
          ];
    throw new PublishError(`v${version} does not read back right, so latest/ was NOT switched:\n${readProblems.map((p) => `  - ${p.problem}`).join('\n')}\n${next.join('\n')}`);
  }

  t.step(++n, total, latestPlan === 'switch' ? `latest/ → ${version}` : 'latest/ stays');
  if (latestPlan === 'switch') {
    await switchLatest(t, version, (files.get('install.sh') as LocalFile).path, options.waitSeconds, scratch);
    const redirect = await siteRedirectProblem(t);
    if (redirect === null) t.out(`  ok  ${t.siteInstallUrl} → ${DOWNLOADS_ORIGIN}/latest/install.sh`);
    else t.warn(redirect);
    const notices = await siteNoticesWarning(t, version, await readFile((files.get(NOTICES) as LocalFile).path));
    if (notices === null) t.out(`  ok  ${t.siteNoticesUrl} = v${version}/${NOTICES}`);
    else t.warn(notices);
  } else {
    t.out(`  latest/ is still ${latestText}`);
  }

  t.out('');
  t.out(`done: smurg ${version} is on ${t.origin}/v${version}/${latestPlan === 'switch' ? ' and is the latest version' : ''}.`);
  if (latestPlan === 'switch') t.out('  install:  curl -fsSL https://smurg.ai/install.sh | sh');
  if (keptHint !== null) t.out(`  ${keptHint}`);
  t.out(`  this version:  curl -fsSL ${versionBaseUrl(version)}/install.sh | sh`);
  t.out(`  check again later:  scripts/publish-downloads.sh --check --version ${version}`);
  if (t.warnings.length > 0) t.out(`  ${t.warnings.length} warning(s) above.`);
  return 0;
}

async function runSetLatest(t: Tools, options: Extract<PublishOptions, { mode: 'set-latest' }>, scratch: string): Promise<number> {
  const { version, dryRun } = options;
  if (isPrerelease(version)) throw new PublishError(`${version} is a pre-release: it never becomes latest`, 2);
  const total = dryRun ? 2 : 4;
  let n = 0;
  t.out(`latest/ → ${version} on ${t.origin}${dryRun ? ' (dry run: nothing is uploaded)' : ''}`);
  t.step(++n, total, `Verifying v${version}/ as published`);
  const verified = await verifyPublishedVersion(t, version, scratch, true);
  if (verified.problems.length > 0) throw new PublishError(`v${version} is not a complete, correct release, so latest/ stays:\n${verified.problems.map((p) => `  - ${p}`).join('\n')}`);
  const latest = await currentLatest(t, true);
  const latestText = 'error' in latest ? `unknown (${latest.error})` : (latest.version ?? 'none yet');
  t.step(++n, total, `latest/: ${latestText} → ${version}`);
  if (dryRun) {
    t.out(`  dry run: would upload latest/install.sh (= v${version}/install.sh) and latest/VERSION, --cache-control '${LATEST_CACHE}'`);
    return 0;
  }
  t.step(++n, total, 'Cloudflare: the login and the bucket');
  assertRepoEnvironment(t);
  await t.requireLogin();
  await t.requireBucket();
  t.step(++n, total, `Uploading latest/`);
  await switchLatest(t, version, verified.installShPath, options.waitSeconds, scratch);
  if (verified.notices !== null) {
    const notices = await siteNoticesWarning(t, version, Buffer.from(verified.notices, 'utf8'));
    if (notices !== null) t.warn(notices);
  }
  t.out(`\ndone: latest/ is ${version}. Hosts who installed another version: run the install line again.`);
  return 0;
}

async function runCheck(t: Tools, options: Extract<PublishOptions, { mode: 'check' }>, scratch: string): Promise<number> {
  const problems: string[] = [];
  const latest = await currentLatest(t, false);
  const version = options.version ?? ('error' in latest ? null : latest.version);
  if (version === null) {
    throw new PublishError('error' in latest ? `cannot read ${t.url('latest/VERSION')}: ${latest.error}` : `${t.url('latest/VERSION')} does not exist: nothing is published yet`);
  }
  t.out(`check smurg ${version} on ${t.origin} (read-only, as people get it)`);
  t.step(1, 3, `v${version}/`);
  const verified = await verifyPublishedVersion(t, version, scratch, false);
  problems.push(...verified.problems);

  t.step(2, 3, 'latest/');
  if ('error' in latest) problems.push(`${t.url('latest/VERSION')}: ${latest.error}`);
  else if (latest.version === null) t.out('  latest/VERSION: none yet');
  else if (latest.version !== version) t.out(`  latest/VERSION: ${latest.version} (not ${version})`);
  else {
    t.out(`  ok  ${t.url('latest/VERSION')}: ${version}`);
    const got = await t.getText(t.url('latest/install.sh'));
    if ('error' in got) problems.push(`${t.url('latest/install.sh')}: ${got.error}`);
    else if (got.status !== 200) problems.push(`${t.url('latest/install.sh')}: HTTP ${got.status}`);
    else {
      const local = await readFile(verified.installShPath).catch(() => null);
      if (local === null || sha256(local) !== sha256(got.body)) problems.push(`${t.url('latest/install.sh')} is not v${version}/install.sh`);
      else t.out(`  ok  ${t.url('latest/install.sh')} = v${version}/install.sh`);
      for (const warning of headerWarnings('latest/install.sh', got.headers, TEXT_TYPE, LATEST_CACHE)) t.warn(warning);
    }
  }

  t.step(3, 3, t.siteInstallUrl);
  const redirect = await siteRedirectProblem(t);
  if (redirect === null) t.out(`  ok  ${t.siteInstallUrl} → ${DOWNLOADS_ORIGIN}/latest/install.sh`);
  else problems.push(redirect);
  // smurg.ai's copy of the notices belongs to the latest version (a warning: the site is redeployed after publishing).
  if (!('error' in latest) && latest.version === version && verified.notices !== null) {
    const notices = await siteNoticesWarning(t, version, Buffer.from(verified.notices, 'utf8'));
    if (notices === null) t.out(`  ok  ${t.siteNoticesUrl} = v${version}/${NOTICES}`);
    else t.warn(notices);
  }

  t.out('');
  if (problems.length > 0) {
    t.out(`${problems.length} problem(s):`);
    for (const problem of problems) t.out(`  - ${problem}`);
    return 1;
  }
  t.out(`all checks passed${t.warnings.length > 0 ? ` (${t.warnings.length} warning(s) above)` : ''}.`);
  return 0;
}

/** Runs one command. `deps` default: the real tools, or the stand-ins a rehearsal names in the environment. */
export async function main(argv: readonly string[], deps?: PublishDeps): Promise<number> {
  const err = deps?.err ?? ((text: string) => process.stderr.write(text));
  let t: Tools | undefined;
  let scratch: string | undefined;
  try {
    t = new Tools(deps ?? depsFromEnvironment(process.env));
    if (t.rehearsal !== null) t.out(`REHEARSAL, not Cloudflare: ${t.rehearsal}`);
    const options = parsePublishArgs(argv);
    if (options === 'help') {
      t.out(USAGE);
      return 0;
    }
    scratch = await mkdtemp(join(tmpdir(), 'smurg-publish-'));
    if (options.mode === 'check') return await runCheck(t, options, scratch);
    if (options.mode === 'set-latest') return await runSetLatest(t, options, scratch);
    return await runPublish(t, options, scratch);
  } catch (error) {
    if (error instanceof PublishError) {
      err(`\npublish-downloads: ${error.message}\n`);
      return error.exitCode;
    }
    err(`\npublish-downloads: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    if (t?.rehearsal) t.out(`(REHEARSAL: nothing was sent to Cloudflare; ${t.rehearsal})`);
  }
}

// Only when run directly (scripts/publish-downloads.sh runs this file).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
