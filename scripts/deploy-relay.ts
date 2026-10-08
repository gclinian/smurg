// Guided production deploy of the relay (Cloudflare Workers Free plan, Google login; on workers.dev or one custom
// domain). Run it through scripts/deploy-relay.sh, which sources scripts/env.sh first (Node 22, the repo's pnpm, and
// wrangler's login kept in <repo>/.xdg). Steps, options and exit codes: apps/relay/scripts/deploy.ts; the guide:
// apps/relay/README.md ("Self-hosting on workers.dev", "Self-hosting on your own domain").
//   scripts/deploy-relay.sh [--url URL] [--google-client-id ID] [--take-over-hostname] [--wait S] [--keep-assets DIR]
//                           | --dry-run [...] [--keep-assets DIR]
//                           | --check URL [--web-dist DIR]
//
// --keep-assets DIR (0.5.1; docs/RELEASING.md): the web app's files of the PREVIOUS published version stay served.
//
// Why. The relay serves ONE web app to everybody (apps/relay/wrangler.jsonc: assets.directory = ../web/dist). Its
// code is split into files named by their content (`assets/<name>-<hash>.js`, Vite), loaded when a column or a dialog
// first opens. A deploy replaces the whole set: a tab that was open before the deploy then asks for a file of the old
// set, the relay answers the page itself (single-page-application fallback, HTTP 200 text/html), and that part of the
// page breaks until the person reloads; at a deploy that also changes the protocol, a reload turns a tab that was
// still working against a host that has not updated yet into a refused one. Keeping the previous version's files
// beside the new ones costs nothing (their names carry their content: an old name never means new bytes) and no open
// tab asks for a file that is gone.
//
// What it does. After the web build of step 4 (`pnpm --filter @smurg/web build`, which empties apps/web/dist) and
// before that build is checked and uploaded, every file of DIR is copied into apps/web/dist/assets/. Fail closed:
//   - DIR must hold nothing but regular files with a content-hashed name (`<name>-<8 characters>.<js|css|font|image>`):
//     a folder, a symlink, an index.html or any other name stops the deploy before anything is built;
//   - only apps/web/dist/assets/ is written: index.html, _headers and everything else at the top are always the new
//     build's (nothing of the old page can become the page);
//   - a file of the same name as a new one must be the same bytes (then it is left alone); different bytes under one
//     name stop the deploy, and no new file is ever replaced.
// The run says how many files it keeps and lists them (also under --dry-run, which deploys nothing). The outside
// checks are unchanged: they compare what the live index.html loads with the new build's.
//
// How to make DIR from the tag of the previous published version (X.Y.Z), in a scratch folder, never in this checkout:
//   scratch="$(mktemp -d)" && git archive --prefix=previous/ vX.Y.Z | tar -x -C "$scratch"
//   cd "$scratch/previous" && scripts/bootstrap-tools.sh && source scripts/env.sh
//   pnpm install --frozen-lockfile && pnpm --filter @smurg/web build
//   # DIR is "$scratch/previous/apps/web/dist/assets"
// The same sources build the same names on every machine (the deploy's own check that the live web app is "the build of
// this checkout" rests on that; it was verified for v0.5.0, 139 files, byte for byte, when this option was written).
// Keep ONE previous version: the folder of the version that is live when you deploy.
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeployError, main, type DeployDeps } from '../apps/relay/scripts/deploy.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELAY_DIR = join(REPO_ROOT, 'apps', 'relay');
/** What wrangler uploads (apps/relay/wrangler.jsonc assets.directory). */
export const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');

/**
 * A file Vite named by its content: `<name>-<hash>.<ext>`, the hash being 8 characters of [A-Za-z0-9_-]. The
 * extensions are the kinds of file a web build puts under assets/ (code, styles, fonts, images); nothing else is taken.
 */
export const HASHED_ASSET = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,150}-[A-Za-z0-9_-]{8}\.(?:js|css|ttf|otf|woff|woff2|svg|png|jpg|jpeg|gif|webp|avif|ico|wasm)$/;
/** Cloudflare's limit for one static asset of a Worker (25 MiB). */
export const ASSET_MAX_BYTES = 25 * 1024 * 1024;
/** Far more than one web build holds (0.5.0: 139 files); a folder beyond it is not a build's assets folder. */
export const KEPT_MAX_FILES = 5_000;

/** A problem with --keep-assets as the operator should read it (exit code 2: nothing was built or deployed). */
export class KeepAssetsError extends Error {
  override readonly name = 'KeepAssetsError';
}

export interface KeptAsset {
  readonly name: string;
  readonly bytes: number;
}

export interface PreviousAssets {
  /** The folder as given, resolved. */
  readonly dir: string;
  /** Its files, sorted by name. */
  readonly files: readonly KeptAsset[];
}

/** `argv` without `--keep-assets DIR` (or `--keep-assets=DIR`), and DIR when it was given. */
export function takeKeepAssets(argv: readonly string[]): { readonly rest: string[]; readonly dir: string | undefined } {
  const rest: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--keep-assets') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new KeepAssetsError("--keep-assets needs a folder: the assets folder of the previous version's web build (.../apps/web/dist/assets)");
      if (dir !== undefined) throw new KeepAssetsError('--keep-assets was given twice: keep ONE previous version, the one that is live now');
      dir = value;
      i += 1;
    } else if (arg.startsWith('--keep-assets=')) {
      if (dir !== undefined) throw new KeepAssetsError('--keep-assets was given twice: keep ONE previous version, the one that is live now');
      dir = arg.slice('--keep-assets='.length);
      if (dir === '') throw new KeepAssetsError('--keep-assets needs a folder');
    } else rest.push(arg);
  }
  return { rest, dir };
}

/**
 * The files of a previous build's assets folder. Refuses (KeepAssetsError) a folder that is not exactly that: every
 * entry must be a regular file with a content-hashed name, at most ASSET_MAX_BYTES; a folder, a symlink or any other
 * name means this is not an assets folder (the build's top folder, for one, holds index.html).
 */
export async function previousAssets(dirArg: string): Promise<PreviousAssets> {
  const dir = resolve(dirArg);
  const top = await lstat(dir).catch(() => null);
  if (top === null) throw new KeepAssetsError(`--keep-assets: ${dir} does not exist`);
  if (!top.isDirectory()) throw new KeepAssetsError(`--keep-assets: ${dir} is not a folder (a symlink is not followed)`);
  const names = (await readdir(dir)).sort();
  if (names.length === 0) throw new KeepAssetsError(`--keep-assets: ${dir} is empty`);
  if (names.length > KEPT_MAX_FILES) throw new KeepAssetsError(`--keep-assets: ${dir} holds ${names.length} entries; that is not the assets folder of one web build`);
  const files: KeptAsset[] = [];
  const refused: string[] = [];
  for (const name of names) {
    const st = await lstat(join(dir, name));
    if (!st.isFile()) refused.push(`${name} (${st.isDirectory() ? 'a folder' : st.isSymbolicLink() ? 'a symlink' : 'not a regular file'})`);
    else if (!HASHED_ASSET.test(name)) refused.push(`${name} (not a content-hashed name)`);
    else if (st.size > ASSET_MAX_BYTES) refused.push(`${name} (${st.size} bytes: more than one asset may have)`);
    else files.push({ name, bytes: st.size });
  }
  if (refused.length > 0) {
    const shown = refused.slice(0, 8).map((line) => `  ${line}`);
    const hint = names.includes('index.html') || names.includes('assets') ? `\n  (this looks like the build's top folder: give its assets folder, ${join(dir, 'assets')})` : '';
    throw new KeepAssetsError(
      [`--keep-assets: ${dir} is not the assets folder of a web build. It may hold nothing but files named <name>-<hash>.<js|css|font|image>; these are not:`, ...shown, ...(refused.length > 8 ? [`  ... and ${refused.length - 8} more`] : [])].join('\n') + hint,
    );
  }
  return { dir, files };
}

export interface KeptResult {
  /** Copied into the new build's assets folder. */
  readonly added: readonly KeptAsset[];
  /** Already there with the same bytes (the new version did not change that file). */
  readonly unchanged: readonly KeptAsset[];
}

/**
 * Copies the previous version's files into `<webDist>/assets/` beside the new build's. Only that folder is written.
 * A name the new build has too must be the same bytes; different bytes under one name is a KeepAssetsError and no
 * new file is ever replaced (the copy is exclusive).
 */
export async function keepPreviousAssets(previous: PreviousAssets, webDist: string): Promise<KeptResult> {
  const target = join(webDist, 'assets');
  const st = await lstat(target).catch(() => null);
  if (st === null || !st.isDirectory()) throw new KeepAssetsError(`--keep-assets: the new web build has no assets folder (${target}); nothing was copied`);
  // First every name the new build has too is compared (a difference stops before anything is copied), then the rest
  // is copied.
  const added: KeptAsset[] = [];
  const unchanged: KeptAsset[] = [];
  for (const file of previous.files) {
    const to = join(target, file.name);
    const existing = await lstat(to).catch(() => null);
    if (existing === null) {
      added.push(file);
      continue;
    }
    const same = existing.isFile() && existing.size === file.bytes && (await readFile(to)).equals(await readFile(join(previous.dir, file.name)));
    if (!same) {
      throw new KeepAssetsError(
        `--keep-assets: ${file.name} is in the new build AND in ${previous.dir} with different bytes. A content-hashed name never means two contents: ${previous.dir} is not a web build of this project, or was changed. Nothing was copied or replaced; the deploy stops.`,
      );
    }
    unchanged.push(file);
  }
  for (const file of added) {
    try {
      await copyFile(join(previous.dir, file.name), join(target, file.name), fsConstants.COPYFILE_EXCL);
    } catch (err) {
      throw new KeepAssetsError(`--keep-assets: cannot copy ${file.name} into ${target} (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`);
    }
  }
  return { added, unchanged };
}

const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1);

/** What the run says about the kept files: the count, the size, and every name (a dry run shows the same). */
export function keptReport(previous: PreviousAssets, result: KeptResult): string[] {
  const total = (files: readonly KeptAsset[]): number => files.reduce((sum, file) => sum + file.bytes, 0);
  return [
    `  --keep-assets ${previous.dir}`,
    `  Kept beside the new build in apps/web/dist/assets: ${result.added.length} ${result.added.length === 1 ? 'file' : 'files'} of the previous version (${megabytes(total(result.added))} MB), so that a tab opened before this deploy still finds them.`,
    ...(result.unchanged.length > 0 ? [`  Already in the new build under the same name and bytes (unchanged since then): ${result.unchanged.length}.`] : []),
    ...result.added.map((file) => `    assets/${file.name}  (${file.bytes} bytes)`),
    '  index.html and everything outside assets/ are the new build only.',
  ];
}

function runShown(file: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', fail);
    child.once('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

/** Seams of step 4 with --keep-assets (the real ones: the repository's web build, its check, apps/web/dist, stdout). */
export interface KeepDeps {
  /** `pnpm --filter @smurg/web build` (it empties apps/web/dist first). */
  readonly build?: () => Promise<void>;
  /** apps/relay/scripts/check-web-dist.ts: what the default step 4 runs after the build. */
  readonly check?: () => Promise<void>;
  readonly webDist?: string;
  readonly out?: (line: string) => void;
}

/**
 * Step 4 of the guided deploy when a previous version's files are kept: the web build, THEN the copy, THEN the check
 * of the folder as it will be uploaded. (Without --keep-assets the deploy's own step 4 runs, unchanged. This repeats
 * its two commands: apps/relay/scripts/deploy.ts buildWebDefault.)
 */
export function buildWebKeeping(previous: PreviousAssets, deps: KeepDeps = {}): () => Promise<void> {
  const build =
    deps.build ??
    (async () => {
      const code = await runShown('pnpm', ['--filter', '@smurg/web', 'build'], REPO_ROOT);
      if (code !== 0) throw new KeepAssetsError(`the web build failed (pnpm --filter @smurg/web build, exit code ${code})`);
    });
  const check =
    deps.check ??
    (async () => {
      const code = await runShown(process.execPath, [join(RELAY_DIR, 'scripts', 'check-web-dist.ts')], RELAY_DIR);
      if (code !== 0) throw new KeepAssetsError('the web build cannot be deployed (scripts/check-web-dist.ts)');
    });
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  return async () => {
    await build();
    const result = await keepPreviousAssets(previous, deps.webDist ?? WEB_DIST);
    for (const line of keptReport(previous, result)) out(line);
    await check();
  };
}

export const KEEP_ASSETS_USAGE = `  --keep-assets DIR     With a deploy or --dry-run: also serve the web app files of the PREVIOUS published version, so
                        that a tab opened before the deploy still finds the code it loads later. DIR is the assets
                        folder of that version's web build (.../apps/web/dist/assets), made from its tag in a scratch
                        folder: git archive --prefix=previous/ vX.Y.Z | tar -x -C "$scratch"; there:
                        scripts/bootstrap-tools.sh, source scripts/env.sh, pnpm install --frozen-lockfile,
                        pnpm --filter @smurg/web build. Only files named <name>-<hash>.<ext> are taken, only into
                        apps/web/dist/assets; index.html is always the new build's (details: scripts/deploy-relay.ts)
`;

/** The guided deploy with `--keep-assets` understood; every other argument is apps/relay/scripts/deploy.ts's. */
export async function run(argv: readonly string[], deps: DeployDeps = {}, keep: KeepDeps = {}): Promise<number> {
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  let previous: PreviousAssets | undefined;
  let rest: string[];
  try {
    const taken = takeKeepAssets(argv);
    rest = taken.rest;
    const help = rest.includes('--help') || rest.includes('-h');
    if (taken.dir !== undefined && !help) {
      if (rest.includes('--check')) throw new KeepAssetsError('--keep-assets goes with a deploy or --dry-run: --check deploys nothing');
      // Looked at before anything is built or contacted.
      previous = await previousAssets(taken.dir);
    }
    if (help) {
      const code = await main(rest, deps);
      (deps.out ?? keep.out ?? ((line: string) => process.stdout.write(`${line}\n`)))(KEEP_ASSETS_USAGE);
      return code;
    }
  } catch (error) {
    if (error instanceof KeepAssetsError) {
      err(`\ndeploy-relay: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (previous === undefined) return main(rest, deps);
  const out = deps.out ?? keep.out;
  const buildWeb = buildWebKeeping(previous, { ...keep, ...(out ? { out } : {}) });
  return main(rest, {
    ...deps,
    buildWeb: async () => {
      try {
        await buildWeb();
      } catch (error) {
        // In the guided deploy's own words ("deploy-relay: ..."), not as an unexpected error with a stack.
        if (error instanceof KeepAssetsError) throw new DeployError(error.message);
        throw error;
      }
    },
  });
}

// Only when run directly (scripts/deploy-relay.sh runs this file).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
