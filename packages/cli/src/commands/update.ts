// `smurg update [--check]` (owner decision 2026-10-02): replaces THIS single executable with the newest published one.
//
//  1. reads <downloads>/latest/VERSION (../update/downloads.ts; https://downloads.smurg.ai, or SMURG_INSTALL_BASE_URL
//     for tests and mirrors) and compares it with this executable's version as semver: the same → says so; older than
//     this one → says so (never a downgrade); `--check` stops here and only reports (exit 0 either way);
//  2. refuses while a `smurg host` of this state dir runs (a share that keeps running would mix the old daemon with the
//     new `smurg hook` / `smurg attach`): the person stops it with `smurg stop`; nothing is stopped from here;
//     a host of another version (alive behind its control socket, its answer not readable by this command) counts as
//     running: fail closed;
//  3. downloads that version's SHA256SUMS and this platform's executable into a temp file NEXT TO the current
//     executable (the same directory, so the last step is one rename), streaming, and installs it only when all of
//     this holds (fail closed, as scripts/install.sh): the size the server announced, the sha256 of SHA256SUMS, exactly
//     one build marker and it names that version (scripts/release-markers.ts), and the file starts here and says that
//     version (`--version`). On macOS the quarantine attribute, if any, is removed after the sha256 matched. The file's
//     bytes are never touched (the ad-hoc signature stays valid);
//  4. renames the temp file over process.execPath (mode 0755): atomic, and a `smurg` that is running keeps its old file.
//
// Nothing is replaced on any failure, and the temp file is removed on every way out (an error, Ctrl-C, even
// process.exit). SHA256SUMS is not signed: the trust is the installer's (https and the downloads site; ARCHITECTURE §12).
// Not the single executable (a source checkout): refused, there is nothing here to replace.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, rmSync } from 'node:fs';
import { access, lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from '../cli/args.ts';
import { CliError, isCliError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { CliIo, CliSignal } from '../cli/io.ts';
import { probeDaemons, unreadableLabel, type Daemons } from '../channel/discover.ts';
import { seaExecutable } from '../sea/native.ts';
import {
  DEFAULT_DOWNLOADS_URL,
  DownloadError,
  INSTALL_COMMAND,
  asDownloadError,
  download,
  downloadText,
  downloadsBase,
  latestVersion,
  sha256Of,
  targetName,
  withTimeout,
  type DownloadsBase,
  type FetchLike,
} from '../update/downloads.ts';
import { compareVersions, parseVersion } from '../update/versions.ts';
import { CLI_VERSION } from '../version.ts';
import { m, renderText, type Locale } from '../i18n/index.ts';
import { say, type CommandContext } from './context.ts';

/** Test seams (the real ones: this executable, its version and platform, the runtime's fetch, /usr/bin/xattr). */
export interface UpdateDeps {
  /** The single executable this process is; null: running from source. Default: seaExecutable(). */
  readonly executable?: string | null;
  /** This executable's version. Default: CLI_VERSION. */
  readonly version?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly fetch?: FetchLike;
  /** macOS's xattr tool. Default: /usr/bin/xattr (never looked up on PATH). */
  readonly xattr?: string;
  /** Timeout of the two small files (latest/VERSION, SHA256SUMS). */
  readonly metaTimeoutMs?: number;
  /** The download ends when no byte arrives for this long. */
  readonly stallTimeoutMs?: number;
}

const META_TIMEOUT_MS = 15_000;
const STALL_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 60_000;
const SUMS_MAX_BYTES = 64 * 1024;
/** An executable is about 120 MiB; anything far beyond that is not one. */
const EXECUTABLE_MAX_BYTES = 512 * 1024 * 1024;
const PROGRESS_EVERY_MS = 100;
const STALE_TEMP_MS = 24 * 3600_000;
const TEMP_NAME = /^\.smurg-update-[0-9a-f]{12}$/;
const QUARANTINE = 'com.apple.quarantine';
const SIGNALS: readonly CliSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// The start of the build marker scripts/build-sea.ts writes into every executable (scripts/release-markers.ts
// BUILD_MARKER_PREFIX; test/update.test.ts keeps the two equal). This source must never contain a complete marker (the
// prefix followed by a version and `;`): it is part of the executable, whose release checks expect exactly one.
const BUILD_MARKER_PREFIX = Buffer.from('smurg-build-version=', 'latin1');
const BUILD_MARKER_VERSION = /^([0-9A-Za-z.-]{1,60});/;
/** Longer than any marker: what a chunk keeps of the previous one, so a marker cut in two is found whole. */
const MARKER_OVERLAP = 128;

const run = promisify(execFile);

/** Every version a build marker names in the bytes pushed so far (scripts/release-markers.ts markersOfFile, streaming). */
export class BuildMarkerScanner {
  readonly versions = new Set<string>();
  private tail: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): void {
    const data = Buffer.concat([this.tail, chunk]);
    for (let at = data.indexOf(BUILD_MARKER_PREFIX); at >= 0; at = data.indexOf(BUILD_MARKER_PREFIX, at + 1)) {
      const start = at + BUILD_MARKER_PREFIX.length;
      const match = BUILD_MARKER_VERSION.exec(data.subarray(start, start + 72).toString('latin1'));
      if (match !== null) this.versions.add(match[1] as string);
    }
    this.tail = data.subarray(Math.max(0, data.length - MARKER_OVERLAP));
  }
}

function codeOf(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : err instanceof Error ? err.name : 'unknown';
}

/** A failure of the update as the person should read it. */
function updateProblem(err: unknown): CliError {
  if (isCliError(err)) return err;
  if (err instanceof DownloadError) {
    switch (err.kind) {
      case 'timeout':
        return new CliError(m('update.timeout', { url: err.url }), { hint: m('update.unchanged.checkNetwork'), cause: err });
      case 'http':
        return new CliError(m('update.http', { status: String(err.status ?? '?'), url: err.url }), { hint: m('update.unchanged'), cause: err });
      case 'redirect':
        return new CliError(m('update.redirect', { url: err.url }), { hint: m('update.redirect.hint'), cause: err });
      case 'incomplete':
        return new CliError(m('update.incomplete', { url: err.url }), { hint: m('update.unchanged.again'), cause: err });
      case 'too-large':
      case 'not-a-version':
        return new CliError(m('update.unexpectedContent', { url: err.url }), { hint: m('update.unchanged'), cause: err });
      default:
        return new CliError(m('update.unreachable', { url: err.url }), { hint: m('update.unchanged.checkNetwork'), cause: err });
    }
  }
  return new CliError(m('update.failed', { code: codeOf(err) }), { hint: m('update.unchanged'), cause: err });
}

const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1);

/** One line that redraws itself on a terminal (stderr); nothing at all without one. */
function progressLine(io: CliIo, lang: Locale): { update(received: number, total: number | null): void; clear(): void } {
  if (!io.terminal.isTTY) return { update: () => {}, clear: () => {} };
  let last = 0;
  let shown = false;
  return {
    update: (received, total) => {
      const now = io.now();
      if (now - last < PROGRESS_EVERY_MS && received !== total) return;
      last = now;
      shown = true;
      const text = renderText(
        lang,
        total === null ? m('update.progress.unknown', { received: megabytes(received) }) : m('update.progress', { percent: Math.floor((received / total) * 100), received: megabytes(received), total: megabytes(total) }),
      );
      io.stderr.write(`\r\u001b[K  ${text}`);
    },
    clear: () => {
      if (shown) io.stderr.write('\r\u001b[K');
      shown = false;
    },
  };
}

interface Expected {
  readonly sha256: string;
  readonly version: string;
}

/**
 * Streams `<base>/<path>` into `temp` (created here, 0755 when complete) and checks what can be checked on the way:
 * the announced size, the sha256, the build marker. Throws without leaving a half-checked file in place: the caller
 * removes `temp` on every failure.
 */
async function downloadExecutable(
  base: DownloadsBase,
  path: string,
  temp: string,
  expected: Expected,
  options: { readonly signal: AbortSignal; readonly fetch: FetchLike | undefined; readonly stallMs: number; readonly progress: ReturnType<typeof progressLine> },
): Promise<void> {
  const url = `${base.url}/${path}`;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const stall = new AbortController();
  const signal = AbortSignal.any([options.signal, stall.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new DOMException('no data', 'TimeoutError')), options.stallMs);
  };
  alive();
  const hash = createHash('sha256');
  const markers = new BuildMarkerScanner();
  try {
    const response = await download(base, path, { signal, identity: true, ...(options.fetch ? { fetch: options.fetch } : {}) });
    // The announced size counts only when the body arrives as it is stored (a compressed body is decoded on the way).
    const encoding = response.headers.get('content-encoding');
    const announced = encoding === null || encoding === 'identity' ? response.headers.get('content-length') : null;
    const total = announced !== null && /^[0-9]{1,15}$/.test(announced) ? Number(announced) : null;
    if (total !== null && total > EXECUTABLE_MAX_BYTES) throw new DownloadError('too-large', url);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o700);
    } catch (err) {
      throw new CliError(m('update.tempCreate', { dir: dirname(temp), code: codeOf(err) }), { hint: m('update.unchanged'), cause: err });
    }
    let received = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        alive();
        received += chunk.length;
        if (received > EXECUTABLE_MAX_BYTES) throw new DownloadError('too-large', url);
        hash.update(chunk);
        markers.push(chunk);
        try {
          await handle.write(chunk);
        } catch (err) {
          throw new CliError(m('update.tempWrite', { temp, code: codeOf(err) }), { hint: m('update.tempWrite.hint'), cause: err });
        }
        options.progress.update(received, total);
      }
      if (total !== null && received !== total) throw new DownloadError('incomplete', url);
      await handle.chmod(0o755);
      await handle.sync();
    } catch (err) {
      if (isCliError(err) || err instanceof DownloadError) throw err;
      // The body ended early (the connection dropped): not "cannot connect".
      const mapped = asDownloadError(err, url, signal);
      throw mapped instanceof DownloadError && mapped.kind === 'network' ? new DownloadError('incomplete', url, { cause: err }) : mapped;
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.progress.clear();
  }
  const actual = hash.digest('hex');
  if (actual !== expected.sha256) {
    throw new CliError(m('update.sha256', { name, expected: expected.sha256, actual }), { hint: m('update.unchanged') });
  }
  const built = [...markers.versions].sort();
  if (built.length !== 1 || built[0] !== expected.version) {
    throw new CliError(built.length === 0 ? m('update.wrongBuild.none', { name, version: expected.version }) : m('update.wrongBuild', { name, version: expected.version, markers: built }), { hint: m('update.unchanged') });
  }
}

/** macOS, after the sha256 matched: removes the quarantine attribute when the file carries one (scripts/install.sh). */
async function clearQuarantine(xattr: string, file: string): Promise<boolean> {
  try {
    await access(xattr, fsConstants.X_OK);
    await run(xattr, ['-p', QUARANTINE, file], { timeout: 10_000 });
  } catch {
    return false; // no xattr tool, or (the usual case) no such attribute: nothing is changed
  }
  try {
    await run(xattr, ['-d', QUARANTINE, file], { timeout: 10_000 });
  } catch (err) {
    throw new CliError(m('update.quarantine', { file, attribute: QUARANTINE }), { hint: m('update.unchanged'), cause: err });
  }
  return true;
}

/** The downloaded executable must start on this machine and be the version it was downloaded as. */
async function probe(file: string, version: string, env: Readonly<Record<string, string | undefined>>, signal: AbortSignal): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await run(file, ['--version'], { timeout: PROBE_TIMEOUT_MS, env: { ...env, SMURG_NO_UPDATE_CHECK: '1' }, signal, maxBuffer: 64 * 1024 }));
  } catch (err) {
    if (signal.aborted) throw err;
    const detail = typeof (err as { stderr?: unknown }).stderr === 'string' ? ((err as { stderr: string }).stderr.split('\n').find((line) => line.trim() !== '') ?? '') : '';
    throw new CliError(m('update.cannotRun', { version }), { hint: detail === '' ? m('update.unchanged') : m('update.cannotRun.hint', { detail: detail.trim().slice(0, 300) }), cause: err });
  }
  if (!stdout.startsWith(`smurg ${version} (`)) {
    throw new CliError(m('update.wrongVersion', { version, reported: stdout.split('\n')[0]?.slice(0, 80) ?? '' }), { hint: m('update.unchanged') });
  }
}

/** Temp files of an update that was killed before it could clean up (older than a day): removed, best effort. */
async function removeStaleTemps(dir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => TEMP_NAME.test(n))) {
    try {
      const path = join(dir, name);
      const st = await lstat(path);
      if (st.isFile() && now - st.mtimeMs > STALE_TEMP_MS) await unlink(path);
    } catch {
      // someone else's, or already gone
    }
  }
}

/**
 * A smurg host of another version is sharing (its control socket is alive, its answer not readable by this command:
 * channel/discover.ts): the executable is not replaced under it either, and the person is told why.
 */
function refuseOtherVersion(sharing: Daemons, current: string): void {
  if (sharing.unreadable.length === 0) return;
  throw new CliError(m('update.otherVersion', { labels: sharing.unreadable.map(unreadableLabel), current }), { hint: m('update.otherVersion.hint') });
}

export async function runUpdate(argv: readonly string[], ctx: CommandContext, deps: UpdateDeps = {}): Promise<number> {
  const args = parseArgs(argv, { options: { check: { kind: 'boolean' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, m('usage.update', { downloads: DEFAULT_DOWNLOADS_URL }));
    return EXIT.ok;
  }
  const { io } = ctx;
  const checkOnly = args.options['check'] === true;
  const executable = deps.executable === undefined ? seaExecutable() : deps.executable;
  if (executable === null) {
    throw new CliError(m('update.fromSource'), { exitCode: EXIT.usage, hint: m('update.fromSource.hint', { install: INSTALL_COMMAND }) });
  }
  const current = deps.version ?? CLI_VERSION;
  const have = parseVersion(current);
  if (have === null) throw new CliError(m('update.versionFormat', { current }), { hint: m('update.reinstall.hint', { install: INSTALL_COMMAND }) });
  const base = downloadsBase(io.env);
  const platform = deps.platform ?? process.platform;
  const name = targetName(platform, deps.arch ?? process.arch);
  if (name === null) throw new CliError(m('update.noTarget', { platform: `${platform}-${deps.arch ?? process.arch}` }));
  const fetchImpl = deps.fetch;
  const metaMs = deps.metaTimeoutMs ?? META_TIMEOUT_MS;

  // Ctrl-C (or a closed terminal) ends whatever request is running; the temp file goes on every way out.
  const stop = new AbortController();
  let interrupted = false;
  const unsubscribe = SIGNALS.map((signal) =>
    io.onSignal(signal, () => {
      interrupted = true;
      stop.abort(new Error('interrupted'));
    }),
  );
  let temp: string | null = null;
  const offExit = io.onExit(() => {
    if (temp !== null) rmSync(temp, { force: true });
  });
  const progress = progressLine(io, ctx.lang);
  try {
    const latest = await latestVersion(base, { signal: withTimeout(stop.signal, metaMs), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    const order = compareVersions(parseVersion(latest) as NonNullable<ReturnType<typeof parseVersion>>, have);
    if (order === 0) {
      say(ctx, m('update.latest', { current }));
      return EXIT.ok;
    }
    if (order < 0) {
      say(ctx, m('update.newer', { current, latest }));
      return EXIT.ok;
    }
    if (checkOnly) {
      say(ctx, m('update.available', { latest, current }));
      return EXIT.ok;
    }

    const sharing = await probeDaemons(ctx.paths);
    if (sharing.running.length > 0) {
      throw new CliError(m('update.sharing', { ids: sharing.running.map((d) => d.status.workspaceId) }), { hint: m('update.sharing.hint', { latest, current, several: sharing.running.length > 1 }) });
    }
    refuseOtherVersion(sharing, current);

    const dir = dirname(executable);
    const st = await lstat(executable).catch(() => null);
    if (st === null || !st.isFile()) throw new CliError(m('update.noExecutable', { executable }), { hint: m('update.reinstall.hint', { install: INSTALL_COMMAND }) });
    try {
      await access(dir, fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      throw new CliError(m('update.notWritable', { dir }), { hint: m('update.notWritable.hint', { executable, install: INSTALL_COMMAND }) });
    }
    await removeStaleTemps(dir, io.now());

    const release = `v${latest}`;
    const sums = await downloadText(base, `${release}/SHA256SUMS`, SUMS_MAX_BYTES, { signal: withTimeout(stop.signal, metaMs), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    const sha256 = sha256Of(sums, name);
    if (sha256 === null) throw new CliError(m('update.notInSums', { latest, name }), { hint: m('update.unchanged') });

    say(ctx, m('update.downloading', { latest, name, from: `${base.url}/${release}` }));
    temp = join(dir, `.smurg-update-${randomBytes(6).toString('hex')}`);
    await downloadExecutable(base, `${release}/${name}`, temp, { sha256, version: latest }, { signal: stop.signal, fetch: fetchImpl, stallMs: deps.stallTimeoutMs ?? STALL_TIMEOUT_MS, progress });
    const quarantineRemoved = platform === 'darwin' ? await clearQuarantine(deps.xattr ?? '/usr/bin/xattr', temp) : false;
    await probe(temp, latest, io.env, stop.signal);
    if (interrupted) throw new Error('interrupted');
    // A share that started while the download ran is not updated under either.
    const started = await probeDaemons(ctx.paths);
    if (started.running.length > 0) throw new CliError(m('update.startedSharing', { ids: started.running.map((d) => d.status.workspaceId) }), { hint: m('update.startedSharing.hint') });
    refuseOtherVersion(started, current);
    try {
      await rename(temp, executable);
    } catch (err) {
      throw new CliError(m('update.replaceFailed', { executable, code: codeOf(err) }), { hint: m('update.unchanged'), cause: err });
    }
    temp = null;
    say(ctx, m('update.done', { current, latest, executable }));
    if (quarantineRemoved) say(ctx, m('update.quarantineRemoved', { attribute: QUARANTINE }));
    say(ctx, m('update.changelog'));
    return EXIT.ok;
  } catch (err) {
    progress.clear();
    if (interrupted) {
      say(ctx, m(checkOnly ? 'update.cancelled.check' : 'update.cancelled'));
      return EXIT.interrupted;
    }
    throw updateProblem(err);
  } finally {
    if (temp !== null) await unlink(temp).catch(() => {});
    offExit();
    for (const off of unsubscribe) off();
  }
}
