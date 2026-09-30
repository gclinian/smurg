// Packages the `smurg` command (CLI + daemon) as ONE executable for the CURRENT platform and architecture: a Node
// single executable application (SEA), so a host needs no Node.js of their own (SPEC §6 「發佈」). Ported from the
// verified spike (docs/research/pty-packaging.md §6.5 / §6.6, verifier additions V10):
//
//   scripts/build-sea.sh [--node /path/to/node] [--out FILE] [--version X.Y.Z|vX.Y.Z] [--target PLATFORM-ARCH]
//                        [--no-smoke] [--keep-work]
//
//  0. --version (a release): the version `smurg --version` prints (esbuild `define` of __SMURG_BUILD_VERSION__, see
//     packages/cli/src/version.ts); the tag form `v0.1.0` is accepted and means 0.1.0 (the release workflow passes the
//     tag). Without it the build says `<package version>-dev`. Release assets (checksums, the installer):
//     scripts/release-assets.sh, docs/RELEASING.md, .github/workflows/release.yml.
//     --target (CI): the platform-arch this build must be for (darwin-arm64, darwin-x64, linux-x64, linux-arm64); the
//     build refuses when the machine, or the Node that becomes the executable, is anything else, so a runner label that
//     points at another architecture cannot produce a misnamed file. The output name is always
//     packages/cli/dist/smurg-<platform>-<arch> (unless --out), the asset name scripts/install.sh downloads.
//
//  1. esbuild bundles packages/cli/src/main.ts into one CommonJS file. `import.meta.url` is defined as a variable the
//     banner sets (ESM dependencies such as srt read it at load time and would crash on an empty import.meta), and
//     `node-pty` / `@parcel/watcher` are replaced by small modules that load their native parts from the extracted
//     cache (packages/cli/src/sea/native.ts).
//  2. The native parts become SEA assets with a sha256 manifest: node-pty (lib + this platform's prebuild, including
//     macOS's spawn-helper), @parcel/watcher's binding, the docs module's compute worker (bundled separately),
//     srt's package.json (its version pin check) and, on Linux, srt's apply-seccomp.
//  3. The blob is made by the SAME Node binary that becomes the executable (--node, default: the Node running this
//     script, i.e. the 22 LTS that scripts/env.sh selects; releases use it too: .github/workflows/release.yml installs
//     .nvmrc's Node on each runner, the Node the gate is verified with). Node >= 25.5 uses `node --build-sea`; older
//     ones `--experimental-sea-config` + postject. `execArgvExtension: "none"`: the host's
//     NODE_OPTIONS never reaches the daemon.
//  4. macOS: the copied node's signature is removed before injection and the result is signed ad hoc (an unsigned
//     arm64 binary is killed at start).
//  5. The executable must run here: `<out> --version` has to print `smurg <version> (…` (every platform, so a Linux
//     build is proven to start on the machine that built it even with --no-smoke).
//  6. Smoke test (unless --no-smoke): packages/cli/test/sea.test.ts runs the binary: --version, NODE_OPTIONS ignored,
//     `smurg hook` / `smurg mcp` (start-up time), login + host + a terminal session through `smurg attach` in a real
//     PTY, and `smurg stop`.
//
// Output: packages/cli/dist/smurg-<platform>-<arch> (about 110 MiB) and its sha256 on stdout. Nothing is downloaded:
// every input is already in node_modules, and the Node binary is one that is installed.
//
// What a build machine needs (each target is built on its own platform: the other platforms' optional dependencies are
// not installed, and `useCodeCache` ties the blob to the Node that runs it):
//  - a supported Node (22 LTS >= 22.18, or 24 LTS) of the TARGET architecture, `pnpm install` done (scripts/env.sh);
//  - macOS: `codesign` (Xcode command line tools; ad-hoc signature, no Apple account);
//  - Linux (glibc only; musl is not supported): nothing compiled. node-pty 1.2.0-beta.15 ships N-API prebuilds for
//    linux-x64 and linux-arm64 (pty.node only; Linux needs no spawn-helper), and its install script
//    (`node scripts/prebuild.js || node-gyp rebuild`) finds them, so no compiler runs; the build packs
//    prebuilds/<platform>-<arch> and refuses when it is missing (a node-gyp build in build/Release is never packed).
//    The prebuild needs glibc >= 2.28 and libstdc++ (GLIBCXX_3.4.22) at run time (pty-packaging.md F4, gotcha 24):
//    Ubuntu 20.04 and later have both. The other native parts come from npm too: @parcel/watcher-linux-<arch>-glibc
//    and srt's vendor/seccomp/<arch>/apply-seccomp (x64 and arm64 only). bubblewrap, socat and ripgrep are needed
//    by a HOST at run time (the guest sandbox), not by the build or the smoke test (a host terminal session only);
//    postject injects the blob into the ELF (Node < 25.5; no signing on Linux).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli');
const DAEMON = join(ROOT, 'packages', 'daemon');
const NATIVE_TS = join(CLI, 'src', 'sea', 'native.ts');
const cliRequire = createRequire(join(CLI, 'package.json'));
const daemonRequire = createRequire(join(DAEMON, 'package.json'));
const PLATFORM = `${process.platform}-${process.arch}`;
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** The part of esbuild's API this script uses (esbuild is a devDependency of packages/cli, not of the root). */
interface EsbuildPluginBuild {
  onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }): void;
  onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => { contents: string; loader: 'js'; resolveDir: string }): void;
}
interface Esbuild {
  build(options: Record<string, unknown> & { plugins?: { name: string; setup(build: EsbuildPluginBuild): void }[] }): Promise<unknown>;
}

interface Options {
  readonly node: string;
  readonly out: string;
  readonly version: string;
  readonly target: string | null;
  readonly smoke: boolean;
  readonly keepWork: boolean;
}

/** The targets a release has (scripts/install.sh, scripts/release-assets.sh). */
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

function parseOptions(argv: readonly string[]): Options {
  let node = process.execPath;
  let out = join(CLI, 'dist', `smurg-${PLATFORM}`);
  let smoke = true;
  let keepWork = false;
  let target: string | null = null;
  let version = `${(JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')) as { version: string }).version}-dev`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--node') node = resolve(value());
    else if (arg === '--out') out = resolve(value());
    else if (arg === '--version') {
      // A tag (v0.1.0) is the release's version (0.1.0).
      version = value().replace(/^v(?=\d)/, '');
      if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/.test(version)) throw new Error(`--version must look like 1.2.3, 1.2.3-rc.1 or the tag v1.2.3, not ${version}`);
    } else if (arg === '--target') {
      target = value();
      if (!TARGETS.includes(target)) throw new Error(`--target must be one of ${TARGETS.join(', ')}, not ${target}`);
    } else if (arg === '--no-smoke') smoke = false;
    else if (arg === '--keep-work') keepWork = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('usage: scripts/build-sea.sh [--node /path/to/node] [--out FILE] [--version X.Y.Z|vX.Y.Z] [--target PLATFORM-ARCH] [--no-smoke] [--keep-work]\n');
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return { node, out, version, target, smoke, keepWork };
}

function run(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): void {
  process.stdout.write(`$ ${[file, ...args].join(' ')}\n`);
  execFileSync(file, args, { stdio: 'inherit', ...(env ? { env } : {}) });
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** `var __smurgImportMetaUrl`: see packages/cli/src/sea/native.ts (runs first in the bundle; builtins only). */
const BANNER = `var __smurgImportMetaUrl = (function () {
  var path = require('node:path'), url = require('node:url'), os = require('node:os'), sea = null;
  try { sea = require('node:sea'); } catch (e) { sea = null; }
  if (!sea || !sea.isSea()) return url.pathToFileURL(__filename).href;
  var manifest = JSON.parse(sea.getAsset('native/manifest.json', 'utf8'));
  var env = process.env, root;
  if (env.SMURG_CACHE_DIR && path.isAbsolute(env.SMURG_CACHE_DIR)) root = env.SMURG_CACHE_DIR;
  else if (process.platform === 'darwin') root = path.join(os.homedir(), 'Library', 'Caches', 'smurg');
  else root = path.join(env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(os.homedir(), '.cache'), 'smurg');
  var dir = path.join(root, 'native-' + manifest.id);
  globalThis.__smurgSea = { dir: dir, manifest: manifest };
  return url.pathToFileURL(path.join(dir, 'lib', 'smurg.cjs')).href;
})();`;

/** Lazy stand-ins: nothing native is extracted or loaded until the first use (so `smurg hook` stays fast). */
function nativeModule(name: string): string {
  const native = JSON.stringify(NATIVE_TS);
  if (name === 'node-pty') {
    return `const native = require(${native});
let pty = null;
const load = () => (pty ??= native.loadNodePty());
module.exports = {
  get spawn() { return load().spawn; },
  get fork() { return load().fork; },
  get createTerminal() { return load().createTerminal; },
  get open() { return load().open; },
  get native() { return load().native; },
};`;
  }
  const wrapper = JSON.stringify(daemonRequire.resolve('@parcel/watcher/wrapper.js'));
  return `const native = require(${native});
const { createWrapper } = require(${wrapper});
let watcher = null;
const load = () => (watcher ??= createWrapper(native.loadParcelWatcherBinding()));
module.exports = {
  get writeSnapshot() { return load().writeSnapshot; },
  get getEventsSince() { return load().getEventsSince; },
  get subscribe() { return load().subscribe; },
  get unsubscribe() { return load().unsubscribe; },
};`;
}

function packageDir(req: NodeJS.Require, name: string): string {
  // Some packages hide package.json behind an exports map: walk up from the main entry instead.
  let dir = dirname(req.resolve(name));
  while (!existsSync(join(dir, 'package.json')) || (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }).name !== name) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`package.json of ${name} not found`);
    dir = up;
  }
  return realpathSync(dir);
}

interface Collected {
  readonly assets: Record<string, string>;
  readonly manifest: { id: string; files: Record<string, { sha256: string; mode: number }> };
}

function collectNative(work: string, computeWorker: string): Collected {
  const files: { rel: string; source: string; mode: number }[] = [];
  const add = (rel: string, source: string, mode = 0o600): void => {
    files.push({ rel, source, mode });
  };
  // node-pty: package.json, lib/**/*.js, prebuilds/<platform>-<arch>/* (pty.node + spawn-helper on macOS)
  const pty = packageDir(daemonRequire, 'node-pty');
  add('node-pty/package.json', join(pty, 'package.json'));
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(pty, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.js')) add(`node-pty/${child}`, join(pty, child));
    }
  };
  walk('lib');
  const prebuilds = join(pty, 'prebuilds', PLATFORM);
  if (!existsSync(prebuilds)) throw new Error(`node-pty has no prebuild for ${PLATFORM}`);
  for (const name of readdirSync(prebuilds)) {
    if (name.endsWith('.pdb')) continue;
    add(`node-pty/prebuilds/${PLATFORM}/${name}`, join(prebuilds, name), name === 'spawn-helper' ? 0o700 : 0o600);
  }
  // @parcel/watcher's binding: the platform package it would require.
  const watcherRequire = createRequire(join(packageDir(daemonRequire, '@parcel/watcher'), 'package.json'));
  let bindingPackage = `@parcel/watcher-${PLATFORM}`;
  if (process.platform === 'linux') bindingPackage += '-glibc'; // musl is not supported (pty-packaging.md gotcha 24)
  add('parcel-watcher/watcher.node', join(packageDir(watcherRequire, bindingPackage), 'watcher.node'));
  // The docs module's compute worker, found by the daemon as `./compute-worker.ts` next to import.meta.url.
  add('lib/compute-worker.ts', computeWorker);
  // srt: its version for the sandbox module's pin check, and (Linux) the seccomp helper it runs inside bwrap.
  const srt = packageDir(daemonRequire, '@anthropic-ai/sandbox-runtime');
  const srtPackage = JSON.parse(readFileSync(join(srt, 'package.json'), 'utf8')) as { name: string; version: string };
  const srtPackagePath = join(work, 'srt-package.json');
  writeFileSync(srtPackagePath, `${JSON.stringify({ name: srtPackage.name, version: srtPackage.version })}\n`);
  add('node_modules/@anthropic-ai/sandbox-runtime/package.json', srtPackagePath);
  if (process.platform === 'linux') {
    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    add(`vendor/seccomp/${arch}/apply-seccomp`, join(srt, 'vendor', 'seccomp', arch, 'apply-seccomp'), 0o700);
  }

  const assets: Record<string, string> = {};
  const manifestFiles: Record<string, { sha256: string; mode: number }> = {};
  for (const file of files) {
    manifestFiles[file.rel] = { sha256: sha256(readFileSync(file.source)), mode: file.mode };
    assets[`native/${file.rel}`] = file.source;
  }
  const id = sha256(new TextEncoder().encode(JSON.stringify(Object.entries(manifestFiles).sort(([a], [b]) => a.localeCompare(b))))).slice(0, 16);
  const manifest = { id, files: manifestFiles };
  const manifestPath = join(work, 'native-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assets['native/manifest.json'] = manifestPath;
  return { assets, manifest };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  // The native parts are this machine's (PLATFORM); the executable is a copy of options.node. All three must agree.
  const nodePlatform = execFileSync(options.node, ['-p', 'process.platform + "-" + process.arch']).toString().trim();
  if (options.target !== null && options.target !== PLATFORM) {
    throw new Error(`--target ${options.target}, but this machine is ${PLATFORM} (check the runner label)`);
  }
  if (nodePlatform !== PLATFORM) {
    throw new Error(`${options.node} is a ${nodePlatform} Node, but the native modules are for ${PLATFORM} (e.g. an x64 Node under Rosetta): use a ${PLATFORM} Node`);
  }
  const nodeVersion = execFileSync(options.node, ['-p', 'process.versions.node']).toString().trim();
  const [major, minor] = nodeVersion.split('.').map(Number) as [number, number];
  if (!((major === 22 && minor >= 18) || major === 24 || major >= 26)) {
    throw new Error(`Node ${nodeVersion} (${options.node}) is not a supported base: use Node 22 LTS (>= 22.18) or 24 LTS`);
  }
  const hasBuildSea = execFileSync(options.node, ['--help']).toString().includes('--build-sea');
  const work = join(CLI, 'dist', `sea-work-${PLATFORM}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(dirname(options.out), { recursive: true });

  const esbuild = cliRequire('esbuild') as Esbuild;
  const common = { bundle: true, platform: 'node' as const, format: 'cjs' as const, target: `node${major}`, logLevel: 'warning' as const, legalComments: 'none' as const };
  // 1. the docs compute worker (its own thread, its own file)
  const computeWorker = join(work, 'compute-worker.cjs');
  await esbuild.build({ ...common, entryPoints: [join(DAEMON, 'src', 'docs', 'compute-worker.ts')], outfile: computeWorker });
  // 2. the whole CLI + daemon
  const bundle = join(work, 'smurg.cjs');
  await esbuild.build({
    ...common,
    entryPoints: [join(CLI, 'src', 'main.ts')],
    outfile: bundle,
    define: { 'import.meta.url': '__smurgImportMetaUrl', __SMURG_BUILD_VERSION__: JSON.stringify(options.version) },
    banner: { js: BANNER },
    plugins: [
      {
        name: 'smurg-sea-native',
        setup(build) {
          build.onResolve({ filter: /^(node-pty|@parcel\/watcher)$/ }, (args) => ({ path: args.path, namespace: 'smurg-sea-native' }));
          build.onLoad({ filter: /.*/, namespace: 'smurg-sea-native' }, (args) => ({ contents: nativeModule(args.path), loader: 'js', resolveDir: ROOT }));
        },
      },
    ],
  });
  process.stdout.write(`bundle: ${(statSync(bundle).size / 1048576).toFixed(1)} MiB, compute worker: ${(statSync(computeWorker).size / 1024).toFixed(0)} KiB\n`);

  // 3. assets + manifest
  const { assets, manifest } = collectNative(work, computeWorker);
  process.stdout.write(`native assets: ${Object.keys(manifest.files).length} files, id ${manifest.id}\n`);

  // 4. the executable
  const seaConfigPath = join(work, 'sea-config.json');
  const seaConfig: Record<string, unknown> = {
    main: bundle,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets,
    execArgvExtension: 'none',
  };
  rmSync(options.out, { force: true });
  if (hasBuildSea) {
    writeFileSync(seaConfigPath, JSON.stringify({ ...seaConfig, executable: options.node, output: options.out }, null, 2));
    run(options.node, ['--build-sea', seaConfigPath]);
  } else {
    const blob = join(work, 'sea-prep.blob');
    writeFileSync(seaConfigPath, JSON.stringify({ ...seaConfig, output: blob }, null, 2));
    run(options.node, ['--experimental-sea-config', seaConfigPath]);
    copyFileSync(options.node, options.out);
    chmodSync(options.out, 0o755);
    if (process.platform === 'darwin') run('codesign', ['--remove-signature', options.out]);
    const postject = join(dirname(cliRequire.resolve('postject/package.json')), 'dist', 'cli.js');
    run(options.node, [postject, options.out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE, ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
  }
  if (process.platform === 'darwin') run('codesign', ['--sign', '-', '--force', options.out]);
  process.stdout.write(`built ${relative(ROOT, options.out)} (smurg ${options.version}, ${(statSync(options.out).size / 1048576).toFixed(1)} MiB, Node ${nodeVersion}, ${hasBuildSea ? '--build-sea' : 'postject'})\n`);

  // 5. it runs on this machine and reports the version it was built with (isolated: no NODE_OPTIONS, no smurg state)
  const reported = execFileSync(options.out, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: work, SMURG_HOME: join(work, 'smurg-home'), SMURG_NO_BROWSER: '1' }, timeout: 60_000 }).toString();
  if (!reported.startsWith(`smurg ${options.version} (`)) throw new Error(`${options.out} --version printed ${JSON.stringify(reported)}, not smurg ${options.version} (…)`);
  process.stdout.write(`${relative(ROOT, options.out)} --version: ${reported.trim()}\nsha256 ${sha256(readFileSync(options.out))}  ${relative(ROOT, options.out)}\n`);

  // 6. smoke test with the real binary
  if (options.smoke) {
    run('pnpm', ['--filter', '@smurg/cli', 'exec', 'vitest', 'run', 'test/sea.test.ts', '--silent=false'], { ...process.env, SMURG_SEA_BINARY: options.out, SMURG_SEA_VERSION: options.version });
  }
  if (!options.keepWork) rmSync(work, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  process.stderr.write(`build-sea: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
