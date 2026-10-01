// scripts/publish-downloads.ts (scripts/publish-downloads.sh) without Cloudflare, GitHub or the network: the release is
// assembled by the real scripts/release-assets.sh from stand-in executables; a stub `wrangler` keeps the "bucket" in a
// local directory and records every call; a local HTTP server serves that directory as downloads.smurg.ai does (GET and
// HEAD of /<key>, the query string ignored as R2 ignores it, the Content-Type and Cache-Control each upload set) and
// answers for smurg.ai/install.sh; a stub `file` names the architecture each stand-in claims; a stub `gh` stands in for
// the private GitHub release. Covered: the dry run, refusing to overwrite (and --resume), the upload order (the version
// first, SHA256SUMS last, latest/ only after every file read back), a read-back failure stopping before latest/, --check,
// --set-latest (rolling back), pre-releases and older versions never moving latest/, and the wrapper keeping the
// person's gh login.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from '@smurg/daemon/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BINARY_TYPE,
  DOWNLOADS_ORIGIN,
  EXECUTABLES,
  IMMUTABLE,
  LATEST_CACHE,
  NOTICES,
  TEXT_TYPE,
  REHEARSAL_ENV,
  UPLOAD_ORDER,
  compareVersions,
  depsFromEnvironment,
  main,
  parsePublishArgs,
  parseSha256Sums,
  PublishError,
  type PublishDeps,
} from '../../../scripts/publish-downloads.ts';

const RELEASE_ASSETS = fileURLToPath(new URL('../../../scripts/release-assets.sh', import.meta.url));
const PUBLISH_SH = fileURLToPath(new URL('../../../scripts/publish-downloads.sh', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const HOST = `smurg-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
/** What `file -b` says about each real executable (the stub `file` repeats the line a stand-in carries). */
const FILE_SAYS: Readonly<Record<string, string>> = {
  'smurg-darwin-arm64': 'Mach-O 64-bit executable arm64',
  'smurg-darwin-x64': 'Mach-O 64-bit executable x86_64',
  'smurg-linux-x64': 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked',
  'smurg-linux-arm64': 'ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked',
};
/** The Node.js release the stand-in executables are copies of, and whose LICENSE their notices carry. */
const FAKE_NODE = '22.23.3';
/** Notices as scripts/build-sea.sh writes them: the packages, then the Node.js section with its LICENSE. */
const noticesOf = (node: string): string =>
  `smurg: third-party notices\n\nnode-pty@1.2.0  MIT\n@parcel/watcher@2.6.0  MIT\n@anthropic-ai/sandbox-runtime@0.0.77  Apache-2.0\n\n${'='.repeat(80)}\nnode@${node} (the Node.js runtime)\n\n----- LICENSE -----\nNode.js is licensed for use as follows:\n\nCopyright Node.js contributors.\n`;
const NOTICES_TEXT = noticesOf(FAKE_NODE);
/** The repository's committed notices: complete but for the Node.js section (a placeholder). */
const COMMITTED_NOTICES = fileURLToPath(new URL('../THIRD-PARTY-NOTICES.txt', import.meta.url));

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * A stand-in executable: line 2 is what the stub `file` reports; it carries the build marker and the Node.js release
 * URL a real one has (scripts/release-markers.ts); run, it says its version and Node.js as `smurg --version` does.
 */
const standIn = (name: string, version: string, node = FAKE_NODE): string =>
  `#!/bin/sh\n# file: ${FILE_SAYS[name]}\n# smurg-build-version=${version};\n# https://nodejs.org/download/release/v${node}/\necho "smurg ${version} (fake ${name}, node ${node})"\n`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

async function writeExecutable(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await chmod(path, 0o755);
}

interface Run {
  readonly code: number;
  readonly out: string;
}

function runProcess(file: string, args: readonly string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

// ── The stand-ins ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Stub `wrangler`: whoami, r2 bucket list, r2 object get --pipe and put, on the directory <r2>; every call logged. */
function stubWrangler(r2: string, ctl: string, log: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >>'${log}'
case "$1" in
  whoami)
    if [ -e '${ctl}/logged-out' ]; then echo '{"loggedIn":false}'; exit 1; fi
    echo '{"loggedIn":true,"authType":"OAuth Token","accounts":[{"id":"acc1","name":"Owner"}]}'; exit 0 ;;
  r2) shift ;;
  *) echo "stub wrangler: unexpected $*" >&2; exit 99 ;;
esac
case "$1 $2" in
  'bucket list')
    echo 'Listing buckets...'
    printf 'name:           %s\ncreation_date:  2026-09-30T08:00:00.000Z\n\n' other-bucket
    [ -e '${ctl}/no-bucket' ] || printf 'name:           \\033[90msmurg-downloads\\033[39m\\ncreation_date:  2026-10-01T08:00:00.000Z\\n'
    exit 0 ;;
  'object get')
    key="\${3#smurg-downloads/}"
    [ -f '${r2}'/"$key" ] || { echo 'X [ERROR] The specified key does not exist.' >&2; exit 1; }
    cat '${r2}'/"$key"; exit 0 ;;
  'object put')
    key="\${3#smurg-downloads/}"; shift 3
    file=''; type=''; cache=''; remote=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --file) file="$2"; shift 2 ;;
        --content-type) type="$2"; shift 2 ;;
        --cache-control) cache="$2"; shift 2 ;;
        --remote) remote=1; shift ;;
        *) echo "stub wrangler: unexpected $1" >&2; exit 98 ;;
      esac
    done
    [ "$remote" = 1 ] || { echo 'stub wrangler: not --remote' >&2; exit 97; }
    if grep -qxF "$key" '${ctl}/fail-put' 2>/dev/null; then echo 'X [ERROR] upload failed (stub)' >&2; exit 1; fi
    mkdir -p "$(dirname '${r2}'/"$key")" "$(dirname '${r2}/.meta'/"$key")"
    cp "$file" '${r2}'/"$key"
    if grep -qxF "$key" '${ctl}/corrupt' 2>/dev/null; then printf 'corrupted on the way' >>'${r2}'/"$key"; fi
    printf '%s\\n%s\\n' "$type" "$cache" >'${r2}/.meta'/"$key"
    echo 'Upload complete.'; exit 0 ;;
esac
echo "stub wrangler: unexpected r2 $*" >&2; exit 99
`;
}

/** Stub `file -b PATH`: the "# file: …" line of a stand-in, else the real file's answer. */
const STUB_FILE = `#!/bin/sh
[ "$1" = -b ] || exit 2
said="$(sed -n '2s/^# file: //p' "$2" 2>/dev/null)"
if [ -n "$said" ]; then printf '%s\\n' "$said"; else exec /usr/bin/file -b "$2"; fi
`;

/** Stub `gh`: release view / release download of one release directory; every call (and GH_CONFIG_DIR) logged. */
function stubGh(releaseDir: string, ctl: string, log: string): string {
  return `#!/bin/sh
printf 'GH_CONFIG_DIR=%s %s\\n' "\${GH_CONFIG_DIR:-}" "$*" >>'${log}'
[ -e '${ctl}/gh-fails' ] && { echo 'gh: To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4; }
case "$1 $2" in
  'release view')
    draft=false; [ -e '${ctl}/gh-draft' ] && draft=true
    assets=''
    for f in '${releaseDir}'/*; do assets="$assets{\\"name\\":\\"$(basename "$f")\\"},"; done
    printf '{"tagName":"%s","isDraft":%s,"assets":[%s]}\\n' "$3" "$draft" "\${assets%,}"; exit 0 ;;
  'release download')
    dir=''; prev=''
    for a in "$@"; do [ "$prev" = --dir ] && dir="$a"; prev="$a"; done
    cp '${releaseDir}'/* "$dir"/; exit 0 ;;
esac
exit 1
`;
}

interface Downloads {
  readonly origin: string;
  readonly site: string;
  /** "METHOD /path?query" of every request. */
  readonly requests: string[];
  /** Keys answered 404 even when the bucket has them (an edge cache holding an old 404). */
  readonly hidden: Set<string>;
  siteRedirect: boolean;
  /** What smurg.ai serves as /third-party-notices.txt (null: 404). */
  siteNotices: string | null;
}

/**
 * downloads.smurg.ai over the stub's bucket directory, and smurg.ai's /install.sh (302 → latest/install.sh) and
 * /third-party-notices.txt.
 */
async function serveDownloads(r2: string): Promise<Downloads> {
  const state: Downloads = { origin: '', site: '', requests: [], hidden: new Set(), siteRedirect: true, siteNotices: NOTICES_TEXT };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    state.requests.push(`${req.method} ${req.url}`);
    if (url.pathname === '/site/install.sh') {
      if (state.siteRedirect) res.writeHead(302, { location: `${DOWNLOADS_ORIGIN}/latest/install.sh` }).end();
      else res.writeHead(404).end();
      return;
    }
    if (url.pathname === '/site/third-party-notices.txt') {
      if (state.siteNotices === null) res.writeHead(404).end();
      else res.writeHead(200, { 'content-type': TEXT_TYPE }).end(state.siteNotices);
      return;
    }
    const key = decodeURIComponent(url.pathname.replace(/^\/r2\//, ''));
    const path = join(r2, key);
    if (key.startsWith('.meta') || key.includes('..') || state.hidden.has(key) || !existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      const body = await readFile(path);
      const [type = '', cache = ''] = (await readFile(join(r2, '.meta', key), 'utf8').catch(() => '')).split('\n');
      const headers: Record<string, string> = { 'content-length': String(body.length) };
      if (type) headers['content-type'] = type;
      if (cache) headers['cache-control'] = cache;
      res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body);
    })();
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(state, { origin: `${base}/r2`, site: `${base}/site/install.sh` });
}

interface World {
  readonly dir: string;
  readonly r2: string;
  readonly ctl: string;
  readonly downloads: Downloads;
  readonly stubs: string;
  readonly wranglerLog: string;
  readonly ghLog: string;
  /** The deps main() gets: the stand-ins above, no repository environment check, fast retries. */
  deps(extra?: Partial<PublishDeps>): PublishDeps & { readonly output: () => string };
  wranglerCalls(): Promise<string[]>;
  /** A release directory of `version`, assembled by the real scripts/release-assets.sh. */
  release(version: string, options?: { readonly baseUrl?: string; readonly notices?: string; readonly tamper?: string }): Promise<string>;
  publish(args: readonly string[], extra?: Partial<PublishDeps>): Promise<Run>;
}

async function world(): Promise<World> {
  const dir = await createTempDir('publish');
  cleanups.push(() => removeTempDir(dir));
  const r2 = join(dir, 'r2');
  const ctl = join(dir, 'ctl');
  const stubs = join(dir, 'stubs');
  const wranglerLog = join(dir, 'wrangler.log');
  const ghLog = join(dir, 'gh.log');
  await mkdir(join(r2, '.meta'), { recursive: true });
  await mkdir(ctl, { recursive: true });
  await writeFile(wranglerLog, '');
  await writeFile(ghLog, '');
  await writeExecutable(join(stubs, 'wrangler'), stubWrangler(r2, ctl, wranglerLog));
  await writeExecutable(join(stubs, 'file'), STUB_FILE);
  const downloads = await serveDownloads(r2);
  const w: World = {
    dir,
    r2,
    ctl,
    downloads,
    stubs,
    wranglerLog,
    ghLog,
    deps(extra = {}) {
      const lines: string[] = [];
      return {
        wranglerBin: join(stubs, 'wrangler'),
        fileBin: join(stubs, 'file'),
        ghBin: join(stubs, 'gh'),
        origin: downloads.origin,
        siteInstallUrl: downloads.site,
        retryIntervalMs: 5,
        requireRepoEnvironment: false,
        out: (line: string) => lines.push(line),
        err: (text: string) => lines.push(text),
        ...extra,
        output: () => lines.join('\n'),
      };
    },
    wranglerCalls: async () => (await readFile(wranglerLog, 'utf8')).split('\n').filter((line) => line !== ''),
    async release(version, options = {}) {
      const base = join(dir, `release-${version}-${Math.random().toString(36).slice(2, 8)}`);
      const dist = join(base, 'dist');
      for (const name of EXECUTABLES) await writeExecutable(join(dist, name), standIn(name, version));
      await writeFile(join(dist, NOTICES), options.notices ?? NOTICES_TEXT);
      const out = join(base, 'out');
      const args = [RELEASE_ASSETS, '--version', version, '--dist', dist, '--out', out, '--require-all', '--check-arch'];
      if (options.baseUrl !== undefined) args.push('--base-url', options.baseUrl);
      const built = await runProcess('/bin/bash', args, { PATH: `${stubs}:${SYSTEM_PATH}`, HOME: '/nonexistent' });
      expect(built.out).toContain(`release-assets: ${out}`);
      expect(built.code).toBe(0);
      if (options.tamper !== undefined) await writeFile(join(out, options.tamper), `${await readFile(join(out, options.tamper), 'utf8')}# tampered\n`);
      return out;
    },
    async publish(args, extra = {}) {
      const deps = w.deps(extra);
      const code = await main(args, deps);
      return { code, out: deps.output() };
    },
  };
  return w;
}

const putsOf = (calls: readonly string[]): string[] =>
  calls.filter((call) => call.startsWith('r2 object put ')).map((call) => (call.split(' ')[3] as string).replace(/^smurg-downloads\//, ''));

async function bucketKeys(r2: string, prefix = ''): Promise<string[]> {
  const keys: string[] = [];
  for (const entry of await readdir(join(r2, prefix), { withFileTypes: true })) {
    if (entry.name === '.meta') continue;
    const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) keys.push(...(await bucketKeys(r2, key)));
    else keys.push(key);
  }
  return keys.sort();
}

const meta = async (r2: string, key: string): Promise<[string, string]> => {
  const [type = '', cache = ''] = (await readFile(join(r2, '.meta', key), 'utf8')).split('\n');
  return [type, cache];
};

const versionKeys = (version: string): string[] => UPLOAD_ORDER.map((name) => `v${version}/${name}`);

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('arguments', () => {
  it('publish needs a version and exactly one source; --check and --set-latest take only their own options', () => {
    expect(parsePublishArgs(['--version', '0.1.0', '--from-release'])).toEqual({ mode: 'publish', version: '0.1.0', source: { kind: 'release' }, dryRun: false, resume: false, noLatest: false, waitSeconds: 60 });
    expect(parsePublishArgs(['--version', 'v0.2.0-rc.1', '--dist', '/tmp/x', '--dry-run', '--resume', '--no-latest', '--wait', '5'])).toEqual({
      mode: 'publish',
      version: '0.2.0-rc.1',
      source: { kind: 'dist', dir: '/tmp/x' },
      dryRun: true,
      resume: true,
      noLatest: true,
      waitSeconds: 5,
    });
    expect(parsePublishArgs(['--check'])).toEqual({ mode: 'check', version: null });
    expect(parsePublishArgs(['--check', '--version', '0.1.0'])).toEqual({ mode: 'check', version: '0.1.0' });
    expect(parsePublishArgs(['--set-latest', '0.1.0', '--dry-run'])).toEqual({ mode: 'set-latest', version: '0.1.0', dryRun: true, waitSeconds: 60 });
    expect(parsePublishArgs(['--help'])).toBe('help');
    const refused = (argv: string[]): number => {
      try {
        parsePublishArgs(argv);
      } catch (error) {
        if (error instanceof PublishError) return error.exitCode;
        throw error;
      }
      return 0;
    };
    for (const argv of [
      [],
      ['--from-release'],
      ['--version', '0.1.0'],
      ['--version', '0.1.0', '--from-release', '--dist', '/tmp/x'],
      ['--version', '1.2', '--from-release'],
      ['--version', '0.1.0', '--dist'],
      ['--version', '0.1.0', '--from-release', '--wait', 'soon'],
      ['--check', '--from-release'],
      ['--check', '--dry-run'],
      ['--set-latest', '0.1.0', '--version', '0.1.0'],
      ['--set-latest', '0.1.0', '--resume'],
      ['--upload-everything'],
    ]) {
      expect(refused(argv), argv.join(' ')).toBe(2);
    }
  });

  it('versions order as semver (a pre-release before its release); SHA256SUMS must list exactly the four executables', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('0.9.0', '1.0.0-rc.1')).toBe(-1);
    const line = (name: string): string => `${'a'.repeat(64)}  ${name}\n`;
    expect(parseSha256Sums(EXECUTABLES.map(line).join('')).problems).toEqual([]);
    expect(parseSha256Sums(EXECUTABLES.slice(1).map(line).join('')).problems).toEqual(['SHA256SUMS does not list smurg-darwin-arm64']);
    expect(parseSha256Sums([...EXECUTABLES, 'install.sh'].map(line).join('')).problems).toEqual(['SHA256SUMS lists install.sh, which is not one of the four executables']);
    expect(parseSha256Sums(`${EXECUTABLES.map(line).join('')}garbage\n`).problems).toEqual(['SHA256SUMS: unreadable line "garbage"']);
  });
});

describe('publishing a version (scripts/release-assets.sh → scripts/publish-downloads.ts)', () => {
  it('a dry run checks the files and prints the plan; it uploads nothing and never runs wrangler', async () => {
    const w = await world();
    const out = await w.release('9.8.7');
    const run = await w.publish(['--version', '9.8.7', '--dist', out, '--dry-run']);
    expect(run.out).toContain('dry run done');
    expect(run.code).toBe(0);
    expect(run.out).toContain(`${HOST} --version: smurg 9.8.7`);
    expect(run.out).toContain('latest/: none yet → 9.8.7 after every file of v9.8.7 has read back right');
    // The plan names every upload, in order, with its headers.
    const planned = run.out.split('\n').filter((line) => line.includes('wrangler r2 object put'));
    expect(planned.map((line) => /smurg-downloads\/(\S+)/.exec(line)?.[1])).toEqual(versionKeys('9.8.7'));
    expect(planned[0]).toContain(`--content-type '${BINARY_TYPE}' --cache-control '${IMMUTABLE}'`);
    expect(planned.at(-1)).toContain(`--content-type '${TEXT_TYPE}' --cache-control '${IMMUTABLE}'`);
    expect(await w.wranglerCalls()).toEqual([]);
    expect(await bucketKeys(w.r2)).toEqual([]);
    // It looked (past any edge cache: every request has a query string), and only looked.
    expect(w.downloads.requests.length).toBeGreaterThan(0);
    for (const request of w.downloads.requests) expect(request).toMatch(/^(HEAD|GET) \/r2\/\S+\?publish=[0-9a-f]+$/);

    // downloads.smurg.ai not answering (not set up yet): the dry run says it cannot tell, and still checks the files.
    const offline = await w.publish(['--version', '9.8.7', '--dist', out, '--dry-run'], { origin: 'http://127.0.0.1:9/r2' });
    expect(offline.code).toBe(0);
    expect(offline.out).toContain('cannot check http://127.0.0.1:9/r2');
  });

  it('uploads the version (executables, notices, install.sh, SHA256SUMS last), reads every file back, and only then switches latest/', async () => {
    const w = await world();
    const out = await w.release('9.8.7');
    const run = await w.publish(['--version', '9.8.7', '--dist', out]);
    expect(run.out).toContain('done: smurg 9.8.7 is on');
    expect(run.code).toBe(0);
    const calls = await w.wranglerCalls();
    expect(calls.slice(0, 2)).toEqual(['whoami --json', 'r2 bucket list']);
    // The small files were also looked up in the bucket itself (not only through the custom domain).
    expect(calls.filter((call) => call.startsWith('r2 object get ')).sort()).toEqual(
      ['SHA256SUMS', 'install.sh', NOTICES].map((name) => `r2 object get smurg-downloads/v9.8.7/${name} --remote --pipe`).sort(),
    );
    expect(putsOf(calls)).toEqual([...versionKeys('9.8.7'), 'latest/install.sh', 'latest/VERSION']);
    for (const call of calls.filter((c) => c.startsWith('r2 object put '))) expect(call).toContain(' --remote ');
    // The bucket now holds exactly the seven files and latest/, with their headers.
    expect(await bucketKeys(w.r2)).toEqual([...versionKeys('9.8.7'), 'latest/VERSION', 'latest/install.sh'].sort());
    for (const name of UPLOAD_ORDER) {
      expect(sha(await readFile(join(w.r2, 'v9.8.7', name)))).toBe(sha(await readFile(join(out, name))));
      expect(await meta(w.r2, `v9.8.7/${name}`)).toEqual([(EXECUTABLES as readonly string[]).includes(name) ? BINARY_TYPE : TEXT_TYPE, IMMUTABLE]);
    }
    expect(await readFile(join(w.r2, 'latest', 'install.sh'), 'utf8')).toBe(await readFile(join(out, 'install.sh'), 'utf8'));
    expect(await readFile(join(w.r2, 'latest', 'install.sh'), 'utf8')).toContain(`SMURG_RELEASE_BASE_URL='${DOWNLOADS_ORIGIN}/v9.8.7'`);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.7\n');
    expect(await meta(w.r2, 'latest/install.sh')).toEqual([TEXT_TYPE, LATEST_CACHE]);
    expect(await meta(w.r2, 'latest/VERSION')).toEqual([TEXT_TYPE, LATEST_CACHE]);
    // Every version file was read back (GET, past the edge cache) before the first latest/ request went out.
    const reads = w.downloads.requests.map((request, at) => ({ request, at }));
    const lastVersionRead = Math.max(...reads.filter((r) => /^GET \/r2\/v9\.8\.7\/SHA256SUMS\?/.test(r.request)).map((r) => r.at));
    const firstLatestRead = Math.min(...reads.filter((r) => /^GET \/r2\/latest\/install\.sh\?/.test(r.request)).map((r) => r.at));
    expect(lastVersionRead).toBeLessThan(firstLatestRead);
    expect(run.out).toContain(`ok  ${w.downloads.site} → ${DOWNLOADS_ORIGIN}/latest/install.sh`);
    expect(run.out).toContain(`ok  ${w.downloads.site.replace('install.sh', 'third-party-notices.txt')} = v9.8.7/${NOTICES}`);
    expect(run.out).toContain(`every executable: built as smurg 9.8.7, Node.js ${FAKE_NODE} (the notices' Node.js too)`);
    expect(run.out).toContain('install:  curl -fsSL https://smurg.ai/install.sh | sh');
    expect(run.out).not.toContain(' ! ');
    expect(run.out).not.toContain('REHEARSAL');
  });

  it('never overwrites: a version already there (even one file) stops the run before any upload; --resume uploads only what is missing and refuses what differs', async () => {
    const w = await world();
    const out = await w.release('9.8.7');
    // One executable of an earlier, interrupted run.
    await mkdir(join(w.r2, 'v9.8.7'), { recursive: true });
    await cp(join(out, 'smurg-linux-x64'), join(w.r2, 'v9.8.7', 'smurg-linux-x64'));
    const refused = await w.publish(['--version', '9.8.7', '--dist', out]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('v9.8.7 is already on');
    expect(refused.out).toContain('smurg-linux-x64');
    expect(refused.out).toContain('--resume');
    expect(putsOf(await w.wranglerCalls())).toEqual([]);

    const resumed = await w.publish(['--version', '9.8.7', '--dist', out, '--resume']);
    expect(resumed.out).toContain('skip v9.8.7/smurg-linux-x64 (already there, identical)');
    expect(resumed.code).toBe(0);
    expect(putsOf(await w.wranglerCalls())).toEqual([...versionKeys('9.8.7').filter((key) => key !== 'v9.8.7/smurg-linux-x64'), 'latest/install.sh', 'latest/VERSION']);

    // Another build of the same version (a file that differs) is never uploaded over the published one.
    const other = await w.release('9.8.7', { tamper: 'install.sh' });
    await writeFile(w.wranglerLog, '');
    const differs = await w.publish(['--version', '9.8.7', '--dist', other, '--resume']);
    expect(differs.code).toBe(1);
    expect(differs.out).toContain('v9.8.7/install.sh already exist with other contents');
    expect(putsOf(await w.wranglerCalls())).toEqual([]);
  });

  it('a file the custom domain does not show yet but the bucket has (an edge cache holding a 404) is found through wrangler', async () => {
    const w = await world();
    const out = await w.release('9.8.7');
    await mkdir(join(w.r2, 'v9.8.7'), { recursive: true });
    await cp(join(out, 'SHA256SUMS'), join(w.r2, 'v9.8.7', 'SHA256SUMS'));
    w.downloads.hidden.add('v9.8.7/SHA256SUMS');
    const run = await w.publish(['--version', '9.8.7', '--dist', out]);
    expect(run.code).toBe(1);
    expect(run.out).toContain('v9.8.7 is already on');
    expect(putsOf(await w.wranglerCalls())).toEqual([]);
  });

  it('a file that does not read back right stops the run before latest/; so does a failed upload', async () => {
    const w = await world();
    const out = await w.release('9.8.7');
    await writeFile(join(w.ctl, 'corrupt'), 'v9.8.7/smurg-darwin-x64\n');
    const run = await w.publish(['--version', '9.8.7', '--dist', out, '--wait', '0']);
    expect(run.code).toBe(1);
    expect(run.out).toContain('does not read back right, so latest/ was NOT switched');
    expect(run.out).toContain('v9.8.7/smurg-darwin-x64: sha256');
    expect(putsOf(await w.wranglerCalls())).toEqual(versionKeys('9.8.7'));
    expect(existsSync(join(w.r2, 'latest'))).toBe(false);
    // Other bytes than uploaded: the way out (docs/RELEASING.md §4 step 7), since --resume refuses such a file.
    expect(run.out).toContain('v9.8.7/smurg-darwin-x64 is public now with other bytes than were uploaded, but 9.8.7 never became');
    expect(run.out).toContain('pnpm --filter @smurg/relay exec wrangler r2 object delete smurg-downloads/v9.8.7/smurg-darwin-x64 --remote');
    expect(run.out).toContain('or 9.8.7 is used up: cut X.Y.(Z+1) (docs/RELEASING.md §4 step 7)');
    const again = await w.publish(['--version', '9.8.7', '--dist', out, '--resume']);
    expect(again.code).toBe(1);
    expect(again.out).toContain('v9.8.7/smurg-darwin-x64 already exist with other contents');
    expect(again.out).toContain('docs/RELEASING.md §4 step 7');
    // The owner deletes that one object (here: the stub bucket's file); --resume then uploads it again and finishes.
    await rm(join(w.ctl, 'corrupt'));
    await rm(join(w.r2, 'v9.8.7', 'smurg-darwin-x64'));
    await writeFile(w.wranglerLog, '');
    const fixed = await w.publish(['--version', '9.8.7', '--dist', out, '--resume']);
    expect(fixed.code).toBe(0);
    expect(putsOf(await w.wranglerCalls())).toEqual(['v9.8.7/smurg-darwin-x64', 'latest/install.sh', 'latest/VERSION']);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.7\n');

    // Not there yet (an HTTP error, a timeout): --resume. A run that finds every file then finishes latest/ when there
    // is none yet; otherwise it leaves latest/ alone and says --set-latest (see "latest/" below).
    const w3 = await world();
    const out3 = await w3.release('9.8.7');
    w3.downloads.hidden.add('v9.8.7/SHA256SUMS');
    const unavailable = await w3.publish(['--version', '9.8.7', '--dist', out3, '--wait', '0']);
    expect(unavailable.code).toBe(1);
    expect(unavailable.out).toContain('v9.8.7/SHA256SUMS: HTTP 404');
    expect(unavailable.out).toContain('These are HTTP errors or timeouts');
    expect(unavailable.out).toContain('with --resume (and a longer --wait)');
    expect(existsSync(join(w3.r2, 'latest'))).toBe(false);
    w3.downloads.hidden.clear();
    await writeFile(w3.wranglerLog, '');
    const finished = await w3.publish(['--version', '9.8.7', '--dist', out3, '--resume']);
    expect(finished.code).toBe(0);
    expect(putsOf(await w3.wranglerCalls())).toEqual(['latest/install.sh', 'latest/VERSION']);
    expect(await readFile(join(w3.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.7\n');

    const w2 = await world();
    const out2 = await w2.release('9.8.7');
    await writeFile(join(w2.ctl, 'fail-put'), 'v9.8.7/install.sh\n');
    const failed = await w2.publish(['--version', '9.8.7', '--dist', out2]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('wrangler r2 object put smurg-downloads/v9.8.7/install.sh failed');
    expect(failed.out).toContain('latest/ was not touched. Run the same command again with --resume.');
    expect(putsOf(await w2.wranglerCalls())).toEqual(versionKeys('9.8.7').slice(0, UPLOAD_ORDER.indexOf('install.sh') + 1));
    expect(existsSync(join(w2.r2, 'latest'))).toBe(false);
    // The resumed run finishes it.
    await rm(join(w2.ctl, 'fail-put'));
    const resumed = await w2.publish(['--version', '9.8.7', '--dist', out2, '--resume']);
    expect(resumed.code).toBe(0);
    expect(await readFile(join(w2.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.7\n');
  });

  it('the files are checked before anything is contacted: checksums, file types, the version, install.sh, the notices', async () => {
    const w = await world();
    const cases: [string, string, string][] = [
      ['9.8.7', await w.release('9.8.7', { tamper: 'smurg-linux-arm64' }), 'smurg-linux-arm64: sha256'],
      ['9.8.7', await w.release('9.8.7', { baseUrl: 'https://github.com/gclinian/smurg/releases/download/v9.8.7' }), `install.sh downloads from https://github.com/gclinian/smurg/releases/download/v9.8.7, not ${DOWNLOADS_ORIGIN}/v9.8.7`],
      ['9.8.8', await w.release('9.8.7'), `${HOST} --version said 'smurg 9.8.7 (fake ${HOST}, node ${FAKE_NODE})', not 'smurg 9.8.8 (…'`],
    ];
    const noNotices = await w.release('9.8.7');
    await writeFile(join(noNotices, NOTICES), 'smurg: third-party notices\n\nnode-pty  MIT\n');
    cases.push(['9.8.7', noNotices, `${NOTICES} does not mention @parcel/watcher, @anthropic-ai/sandbox-runtime, Node.js`]);
    // The committed notices (names everything, Node.js included, but its Node.js section is the placeholder).
    const unfilled = await w.release('9.8.7');
    await writeFile(join(unfilled, NOTICES), await readFile(COMMITTED_NOTICES));
    cases.push(['9.8.7', unfilled, `${NOTICES} is the committed packages/cli/THIRD-PARTY-NOTICES.txt, whose Node.js section is still the placeholder`]);
    const headingOnly = await w.release('9.8.7');
    await writeFile(join(headingOnly, NOTICES), NOTICES_TEXT.replace(`node@${FAKE_NODE} (the Node.js runtime)`, 'Node.js runtime'));
    cases.push(['9.8.7', headingOnly, `${NOTICES} has no complete Node.js section`]);
    // The notices of another build: their Node.js is not the executables'.
    const otherNotices = await w.release('9.8.7');
    await writeFile(join(otherNotices, NOTICES), noticesOf('22.22.1'));
    cases.push(['9.8.7', otherNotices, `the executables are Node.js ${FAKE_NODE}, but THIRD-PARTY-NOTICES.txt has the LICENSE of Node.js 22.22.1`]);
    // Executables left over from another version next to this version's (a release assembled by hand, §4.3): the
    // build markers tell, also of the three this machine cannot run.
    const older = await w.release('9.8.6');
    const stale = await w.release('9.8.7');
    let sums = await readFile(join(stale, 'SHA256SUMS'), 'utf8');
    for (const name of EXECUTABLES.filter((n) => n !== HOST)) {
      await cp(join(older, name), join(stale, name));
      sums = sums.replace(new RegExp(`^\\S+(?=  ${name}$)`, 'm'), sha(await readFile(join(older, name))));
    }
    await writeFile(join(stale, 'SHA256SUMS'), sums);
    for (const name of EXECUTABLES.filter((n) => n !== HOST)) cases.push(['9.8.7', stale, `${name} was built as smurg 9.8.6, not 9.8.7`]);
    // One executable built on another Node.js release.
    const mixedNode = await w.release('9.8.7');
    await writeFile(join(mixedNode, 'smurg-linux-arm64'), standIn('smurg-linux-arm64', '9.8.7', '22.23.2'));
    await writeFile(join(mixedNode, 'SHA256SUMS'), (await readFile(join(mixedNode, 'SHA256SUMS'), 'utf8')).replace(/^\S+(?=  smurg-linux-arm64$)/m, sha(standIn('smurg-linux-arm64', '9.8.7', '22.23.2'))));
    cases.push(['9.8.7', mixedNode, 'the executables are built on different Node.js releases']);
    cases.push(['9.8.7', mixedNode, 'smurg-linux-arm64 22.23.2']);
    // One without any build marker (not built by scripts/build-sea.sh --version).
    const unmarked = await w.release('9.8.7');
    const plain = `#!/bin/sh\n# file: ${FILE_SAYS['smurg-linux-x64']}\necho "smurg 9.8.7 (fake)"\n`;
    await writeFile(join(unmarked, 'smurg-linux-x64'), plain);
    await writeFile(join(unmarked, 'SHA256SUMS'), (await readFile(join(unmarked, 'SHA256SUMS'), 'utf8')).replace(/^\S+(?=  smurg-linux-x64$)/m, sha(plain)));
    cases.push(['9.8.7', unmarked, 'smurg-linux-x64 has no build marker (smurg-build-version=9.8.7;)']);
    cases.push(['9.8.7', unmarked, 'smurg-linux-x64: no https://nodejs.org/download/release/vX.Y.Z/ in it']);
    const misnamed = await w.release('9.8.7');
    await writeFile(join(misnamed, 'smurg-darwin-x64'), standIn('smurg-darwin-arm64', '9.8.7'));
    await writeFile(join(misnamed, 'SHA256SUMS'), (await readFile(join(misnamed, 'SHA256SUMS'), 'utf8')).replace(/^\S+(?=  smurg-darwin-x64$)/m, sha(standIn('smurg-darwin-arm64', '9.8.7'))));
    cases.push(['9.8.7', misnamed, 'smurg-darwin-x64 is not the executable its name says: Mach-O 64-bit executable arm64']);
    for (const [version, dir, problem] of cases) {
      const run = await w.publish(['--version', version, '--dist', dir]);
      expect(run.out, problem).toContain(problem);
      expect(run.out).toContain('nothing was uploaded');
      expect(run.code).toBe(1);
    }
    expect(await w.wranglerCalls()).toEqual([]);
    expect(w.downloads.requests).toEqual([]);
  });

  it('Cloudflare first: not logged in, or no bucket yet, stops with exit 3 and the next step', async () => {
    const w = await world();
    const out = await w.release('9.8.7');
    await writeFile(join(w.ctl, 'logged-out'), '');
    const login = await w.publish(['--version', '9.8.7', '--dist', out]);
    expect(login.code).toBe(3);
    expect(login.out).toContain('CI=false pnpm --filter @smurg/relay exec wrangler login');
    await rm(join(w.ctl, 'logged-out'));
    await writeFile(join(w.ctl, 'no-bucket'), '');
    const bucket = await w.publish(['--version', '9.8.7', '--dist', out]);
    expect(bucket.code).toBe(3);
    expect(bucket.out).toContain('the R2 bucket smurg-downloads does not exist yet');
    expect(putsOf(await w.wranglerCalls())).toEqual([]);
  });
});

describe('latest/', () => {
  it('never moves back by itself; a pre-release never becomes latest; --set-latest rolls back to a verified version', async () => {
    const w = await world();
    for (const version of ['9.8.6', '9.8.7']) expect((await w.publish(['--version', version, '--dist', await w.release(version)])).code).toBe(0);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.7\n');

    // An older version (a fix of an older line): refused unless --no-latest.
    const older = await w.release('9.8.5');
    const back = await w.publish(['--version', '9.8.5', '--dist', older]);
    expect(back.code).toBe(1);
    expect(back.out).toContain('latest/ is 9.8.7, newer than 9.8.5');
    expect(existsSync(join(w.r2, 'v9.8.5'))).toBe(false);
    expect((await w.publish(['--version', '9.8.5', '--dist', older, '--no-latest'])).code).toBe(0);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.7\n');

    // A pre-release: uploaded, latest/ stays.
    const rc = await w.publish(['--version', '9.9.0-rc.1', '--dist', await w.release('9.9.0-rc.1')]);
    expect(rc.code).toBe(0);
    expect(rc.out).toContain('9.9.0-rc.1 is a pre-release: it never becomes latest');
    expect(existsSync(join(w.r2, 'v9.9.0-rc.1', 'SHA256SUMS'))).toBe(true);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.7\n');

    // Roll back: latest/ → 9.8.6, its own install.sh.
    await writeFile(w.wranglerLog, '');
    const rollback = await w.publish(['--set-latest', '9.8.6']);
    expect(rollback.out).toContain('done: latest/ is 9.8.6');
    expect(rollback.code).toBe(0);
    expect(putsOf(await w.wranglerCalls())).toEqual(['latest/install.sh', 'latest/VERSION']);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.6\n');
    expect(await readFile(join(w.r2, 'latest', 'install.sh'), 'utf8')).toBe(await readFile(join(w.r2, 'v9.8.6', 'install.sh'), 'utf8'));

    // Never to a version that is not (completely) published, nor to a pre-release.
    await writeFile(w.wranglerLog, '');
    const missing = await w.publish(['--set-latest', '9.9.9']);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('v9.9.9 is not a complete, correct release, so latest/ stays');
    await rm(join(w.r2, 'v9.8.7', 'smurg-linux-arm64'));
    const broken = await w.publish(['--set-latest', '9.8.7']);
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('v9.8.7/smurg-linux-arm64: HTTP 404');
    expect((await w.publish(['--set-latest', '9.9.0-rc.1'])).code).toBe(2);
    expect(putsOf(await w.wranglerCalls())).toEqual([]);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.6\n');
  });

  it('a --resume that finds the whole version already published does not undo a rollback; --set-latest moves latest/', async () => {
    const w = await world();
    const releases = new Map<string, string>();
    for (const version of ['9.8.6', '9.8.7']) {
      releases.set(version, await w.release(version));
      expect((await w.publish(['--version', version, '--dist', releases.get(version) as string])).code).toBe(0);
    }
    expect((await w.publish(['--set-latest', '9.8.6'])).code).toBe(0);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.6\n');

    // "Run the same command again with --resume", as after an interrupted run: nothing to upload, latest/ stays.
    await writeFile(w.wranglerLog, '');
    for (const args of [['--dry-run'], []]) {
      const resumed = await w.publish(['--version', '9.8.7', '--dist', releases.get('9.8.7') as string, '--resume', ...args]);
      expect(resumed.code, args.join(' ')).toBe(0);
      expect(resumed.out).toContain('every file of v9.8.7 was already published, so this run leaves latest/ at 9.8.6');
      expect(resumed.out).toContain('scripts/publish-downloads.sh --set-latest 9.8.7');
    }
    expect(putsOf(await w.wranglerCalls())).toEqual([]);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.6\n');
    expect(await readFile(join(w.r2, 'latest', 'install.sh'), 'utf8')).toBe(await readFile(join(w.r2, 'v9.8.6', 'install.sh'), 'utf8'));

    // Moving it on purpose.
    expect((await w.publish(['--set-latest', '9.8.7'])).code).toBe(0);
    expect(await readFile(join(w.r2, 'latest', 'VERSION'), 'utf8')).toBe('9.8.7\n');
  });
});

describe('--check (read-only, as people get it)', () => {
  it('passes for a published latest version; names what is wrong otherwise; runs no wrangler', async () => {
    const w = await world();
    expect((await w.publish(['--version', '9.8.7', '--dist', await w.release('9.8.7')])).code).toBe(0);
    await writeFile(w.wranglerLog, '');
    w.downloads.requests.length = 0;
    const ok = await w.publish(['--check']);
    expect(ok.out).toContain('check smurg 9.8.7');
    expect(ok.out).toContain('all checks passed');
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`--version smurg 9.8.7`);
    expect(ok.out).toContain('= v9.8.7/install.sh');
    expect(ok.out).toContain(`ok  every executable is smurg 9.8.7 on Node.js ${FAKE_NODE}, as the notices say`);
    expect(ok.out).toContain(`= v9.8.7/${NOTICES}`);
    expect(await w.wranglerCalls()).toEqual([]);
    // The plain URLs, as curl asks for them (no cache-busting query).
    for (const request of w.downloads.requests) expect(request).not.toContain('?');

    // smurg.ai still serves the notices of another build (the deployer's own Node.js): a warning with the fix.
    w.downloads.siteNotices = noticesOf('22.22.1');
    const site = await w.publish(['--check']);
    expect(site.code).toBe(0);
    expect(site.out).toContain(`is not v9.8.7/${NOTICES} (its Node.js section: 22.22.1; the release's: ${FAKE_NODE}): redeploy smurg.ai with SMURG_SITE_THIRD_PARTY_NOTICES=<v9.8.7/${NOTICES}> (docs/RELEASING.md §4.1)`);
    expect(site.out).toContain('all checks passed (1 warning(s) above)');
    w.downloads.siteNotices = NOTICES_TEXT;

    // A file changed after publishing, latest/install.sh not the version's, and smurg.ai not redirecting.
    await writeFile(join(w.r2, 'v9.8.7', 'smurg-linux-arm64'), standIn('smurg-linux-arm64', '9.8.7').replace('fake', 'evil'));
    await writeFile(join(w.r2, 'latest', 'install.sh'), '#!/bin/sh\necho hello\n');
    w.downloads.siteRedirect = false;
    const bad = await w.publish(['--check', '--version', '9.8.7']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('3 problem(s)');
    expect(bad.out).toMatch(/v9\.8\.7\/smurg-linux-arm64: sha256 [0-9a-f]{64}, but SHA256SUMS says/);
    expect(bad.out).toContain('latest/install.sh is not v9.8.7/install.sh');
    expect(bad.out).toContain(`${w.downloads.site} answers 404, not 302 → ${DOWNLOADS_ORIGIN}/latest/install.sh`);
    expect(await w.wranglerCalls()).toEqual([]);

    // Nothing published at all.
    const empty = await world();
    const none = await empty.publish(['--check']);
    expect(none.code).toBe(1);
    expect(none.out).toContain('nothing is published yet');
  });
});

describe('a rehearsal with the real command (stand-ins named in the environment, never Cloudflare)', () => {
  const refusal = (env: Record<string, string>): string => {
    try {
      depsFromEnvironment(env);
    } catch (error) {
      if (error instanceof PublishError && error.exitCode === 2) return error.message;
      throw error;
    }
    return '';
  };

  it('takes only addresses of this machine, and never a stand-in without both the stand-in bucket and its address', () => {
    expect(depsFromEnvironment({})).toEqual({});
    expect(depsFromEnvironment({ PATH: '/usr/bin', [REHEARSAL_ENV.origin]: '' })).toEqual({});
    const deps = depsFromEnvironment({
      [REHEARSAL_ENV.origin]: 'http://127.0.0.1:18080/r2',
      [REHEARSAL_ENV.wrangler]: '/tmp/stub/wrangler',
      [REHEARSAL_ENV.siteInstallUrl]: 'http://localhost:18080/site/install.sh',
      [REHEARSAL_ENV.gh]: '/tmp/stub/gh',
    });
    expect(deps).toMatchObject({ origin: 'http://127.0.0.1:18080/r2', wranglerBin: '/tmp/stub/wrangler', siteInstallUrl: 'http://localhost:18080/site/install.sh', ghBin: '/tmp/stub/gh' });
    expect(deps.rehearsal).toContain('the bucket is /tmp/stub/wrangler, read back from http://127.0.0.1:18080/r2');
    // The real bucket's domain, another host, credentials in the URL: refused.
    for (const origin of [DOWNLOADS_ORIGIN, 'http://192.168.1.2:8080/r2', 'http://127.0.0.1.example.com/r2', 'http://user:pw@127.0.0.1:1/r2', 'file:///tmp/r2', 'not a url']) {
      expect(refusal({ [REHEARSAL_ENV.origin]: origin, [REHEARSAL_ENV.wrangler]: '/tmp/stub/wrangler' }), origin).toContain('a rehearsal only talks to this machine');
    }
    expect(refusal({ [REHEARSAL_ENV.origin]: 'http://127.0.0.1:1/r2', [REHEARSAL_ENV.wrangler]: '/tmp/stub/wrangler', [REHEARSAL_ENV.siteInstallUrl]: 'https://smurg.ai/install.sh' })).toContain(REHEARSAL_ENV.siteInstallUrl);
    // A stand-in origin (or gh, or site) with the real wrangler would upload to the real bucket.
    const halves: Record<string, string>[] = [{ [REHEARSAL_ENV.origin]: 'http://127.0.0.1:1/r2' }, { [REHEARSAL_ENV.gh]: '/tmp/stub/gh' }, { [REHEARSAL_ENV.siteInstallUrl]: 'http://127.0.0.1:1/site/install.sh' }];
    for (const env of halves) {
      expect(refusal(env)).toContain(`needs ${REHEARSAL_ENV.wrangler} too`);
    }
    expect(refusal({ [REHEARSAL_ENV.wrangler]: '/tmp/stub/wrangler' })).toContain(`needs ${REHEARSAL_ENV.origin}`);
    expect(refusal({ [REHEARSAL_ENV.origin]: 'http://127.0.0.1:1/r2', [REHEARSAL_ENV.wrangler]: 'stub/wrangler' })).toContain('give the absolute path');
  });

  it('scripts/publish-downloads.sh publishes to the stand-ins, says REHEARSAL, and --check reads them back', async () => {
    const w = await world();
    const out = await w.release('9.8.7');
    const home = join(w.dir, 'home');
    await mkdir(home, { recursive: true });
    const env: Record<string, string> = {
      PATH: `${w.stubs}:${dirname(process.execPath)}:${SYSTEM_PATH}`,
      HOME: home,
      [REHEARSAL_ENV.origin]: w.downloads.origin,
      [REHEARSAL_ENV.wrangler]: join(w.stubs, 'wrangler'),
      [REHEARSAL_ENV.siteInstallUrl]: w.downloads.site,
    };
    if (process.env['TMPDIR'] !== undefined) env['TMPDIR'] = process.env['TMPDIR'];
    const run = await runProcess('/bin/bash', [PUBLISH_SH, '--version', '9.8.7', '--dist', out], env);
    expect(run.out).toContain('done: smurg 9.8.7 is on');
    expect(run.code, run.out).toBe(0);
    expect(run.out.split('\n')[0]).toBe(`REHEARSAL, not Cloudflare: the bucket is ${join(w.stubs, 'wrangler')}, read back from ${w.downloads.origin}; smurg.ai/install.sh is ${w.downloads.site}`);
    expect(run.out.trimEnd().split('\n').at(-1)).toContain('(REHEARSAL: nothing was sent to Cloudflare;');
    expect(await bucketKeys(w.r2)).toEqual([...versionKeys('9.8.7'), 'latest/VERSION', 'latest/install.sh'].sort());
    expect((await w.wranglerCalls()).slice(0, 2)).toEqual(['whoami --json', 'r2 bucket list']);
    const check = await runProcess('/bin/bash', [PUBLISH_SH, '--check'], env);
    expect(check.out).toContain('all checks passed');
    expect(check.code).toBe(0);
    // Half a rehearsal is refused before anything runs.
    const half = await runProcess('/bin/bash', [PUBLISH_SH, '--check'], { ...env, [REHEARSAL_ENV.wrangler]: '' });
    expect(half.code).toBe(2);
    expect(half.out).toContain(`needs ${REHEARSAL_ENV.wrangler} too`);
  });
});

describe('--from-release: the private GitHub release, with the person’s gh login', () => {
  it('views and downloads the release’s seven files, refuses a draft, and says so when gh is not logged in', async () => {
    const w = await world();
    const out = await w.release('9.8.7');
    await writeExecutable(join(w.stubs, 'gh'), stubGh(out, w.ctl, w.ghLog));
    const previous = process.env['SMURG_GH_CONFIG_DIR'];
    process.env['SMURG_GH_CONFIG_DIR'] = '/home/someone/.config/gh';
    cleanups.push(() => {
      if (previous === undefined) delete process.env['SMURG_GH_CONFIG_DIR'];
      else process.env['SMURG_GH_CONFIG_DIR'] = previous;
    });
    const run = await w.publish(['--version', '9.8.7', '--from-release', '--dry-run']);
    expect(run.out).toContain('dry run done');
    expect(run.code).toBe(0);
    const calls = (await readFile(w.ghLog, 'utf8')).split('\n').filter((line) => line !== '');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('GH_CONFIG_DIR=/home/someone/.config/gh release view v9.8.7 --repo gclinian/smurg --json tagName,isDraft,assets');
    expect(calls[1]).toMatch(/^GH_CONFIG_DIR=\/home\/someone\/\.config\/gh release download v9\.8\.7 --repo gclinian\/smurg --dir \S+ /);
    expect(calls[1]).toContain(UPLOAD_ORDER.map((name) => `--pattern ${name}`).join(' '));

    await writeFile(join(w.ctl, 'gh-draft'), '');
    const draft = await w.publish(['--version', '9.8.7', '--from-release', '--dry-run']);
    expect(draft.code).toBe(1);
    expect(draft.out).toContain('the GitHub release v9.8.7 is still a draft');
    await writeFile(join(w.ctl, 'gh-fails'), '');
    const loggedOut = await w.publish(['--version', '9.8.7', '--from-release', '--dry-run']);
    expect(loggedOut.code).toBe(3);
    expect(loggedOut.out).toContain('gh is not logged in');
    expect(await w.wranglerCalls()).toEqual([]);
  });

  it('scripts/publish-downloads.sh hands gh the person’s own config dir, which scripts/env.sh would hide', async () => {
    const w = await world();
    await writeExecutable(join(w.stubs, 'gh'), stubGh(w.dir, w.ctl, w.ghLog));
    await writeFile(join(w.ctl, 'gh-fails'), '');
    const home = join(w.dir, 'home');
    await mkdir(home, { recursive: true });
    const base: Record<string, string> = { PATH: `${w.stubs}:${dirname(process.execPath)}:${SYSTEM_PATH}`, HOME: home };
    // The temporary directory of this test run, passed through as it is (main() keeps its scratch files there).
    if (process.env['TMPDIR'] !== undefined) base['TMPDIR'] = process.env['TMPDIR'];
    const cases: [Record<string, string>, string][] = [
      [{}, join(home, '.config', 'gh')],
      [{ XDG_CONFIG_HOME: '/elsewhere/config' }, '/elsewhere/config/gh'],
      [{ GH_CONFIG_DIR: '/my/gh', XDG_CONFIG_HOME: '/elsewhere/config' }, '/my/gh'],
      // A shell that already sourced scripts/env.sh: its XDG_CONFIG_HOME is the repository's, not the person's.
      [{ XDG_CONFIG_HOME: join(REPO_ROOT, '.xdg') }, join(home, '.config', 'gh')],
    ];
    for (const [env, expected] of cases) {
      await writeFile(w.ghLog, '');
      const run = await runProcess('/bin/bash', [PUBLISH_SH, '--version', '9.8.7', '--from-release', '--dry-run'], { ...base, ...env });
      expect(run.code, run.out).toBe(3);
      expect((await readFile(w.ghLog, 'utf8')).split(' ')[0]).toBe(`GH_CONFIG_DIR=${expected}`);
    }
  });
});
