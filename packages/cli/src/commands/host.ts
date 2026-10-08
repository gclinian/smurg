// `smurg host <folder> [--relay URL] [--role R] [--expires D] [--max-uses N] [--name N] [--web-origin URL]
//  [--no-keep-awake] [--no-browser] [--no-bash-attribution]`
// (SPEC R1, §6, §11; ARCHITECTURE §8): shares a folder from this machine. `--no-bash-attribution` turns off the Bash
// activity hook (config.activity.attributeBashEdits, §11 D-13). `--role agent` makes the printed link an agent-access
// invite (§11 D-15: its members open sessions that run as this machine's user, with the host's Claude login).
//
// The terminal shows only what the host uses or must act on (owner decision 2026-10-01): the two links. What the
// switch means, the SPEC §11 warnings, the fingerprint and keep-awake are explained in docs/HOSTING.md
// (https://smurg.ai/docs/hosting/, named in --help), and `smurg status` shows their state on this machine (stop.ts).
//
//  1. validates the folder (exists, a directory, not the home directory, not a parent of — or inside — the state dir)
//     and refuses a folder that is already being shared;
//  2. logs in to the relay when there is no working session (relay/login.ts ensureSession);
//  3. claims the folder's workspace id at the relay (kept in workspaces.json, so members and the audit log survive);
//  4. runs the daemon in the foreground with DEFAULT_FEATURE_MODULES and keeps the machine awake;
//  5. prints the workspace's name, the host's own link and a guest invite (its expiry, and its role and use limit when
//     the host chose them) — the links go to the terminal only, never to the log file; then, only when it happens,
//     a one-line notice the host must act on: keep-awake refused at the start. Before the links, only when it
//     happened, ONE line each (./host-state.ts): this start upgraded what an earlier smurg wrote (or found an OLDER
//     file put back), and a folder `<workspace id>.old*` lies beside the one that is opened;
//  6. tells the host when the relay link drops or recovers, when the relay refuses the host's login (and picks up a
//     renewed login from credentials.json without a restart), when that login is about to expire, when a state file
//     cannot be written, when keep-awake is lost, and (once per run and direction) when a teammate's page or smurg of
//     another protocol version was turned away;
//  7. adds ONE line under the links when a newer smurg is published (../update/notice.ts: looked up in the background
//     after the links are printed, at most 2 s, silent on every failure; never in an automated run or with
//     SMURG_NO_UPDATE_CHECK=1);
//  8. stops gracefully on Ctrl-C / SIGTERM / SIGHUP or `smurg stop` (another Ctrl-C within 2 s is ignored, a later one
//     leaves at once). A stop ends the terminals and the agents' processes; agent sessions stay (their conversations
//     are on disk) and come back idle at the next start, so the last line says how many are paused when there are any.
import { createWriteStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FEATURE_MODULES,
  HOMES_PARENTS,
  KeepAwake,
  START_FAILURE_LOGS,
  ShareError,
  ShareLockError,
  StateFileError,
  SocketPathError,
  createDaemon,
  createLineLogger,
  type Daemon,
  type FeatureModule,
  type HostSocketFactory,
  type IdentityKeySource,
  type LocalControlModule,
  type LogFields,
  type Logger,
  type PowerService,
  type PowerStatus,
  type ShareErrorReason,
} from '@smurg/daemon';
import { INVITE_EXPIRES_IN_SEC_MAX, INVITE_MAX_USES_MAX, type GuestRole } from '@smurg/protocol';
import { isRelayApiError } from '@smurg/protocol/client';
import { KeyFileError, ensurePrivateDirectory } from '@smurg/protocol/node';
import { booleanOption, parseArgs, parseCount, parseDuration, stringOption } from '../cli/args.ts';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { CliSignal } from '../cli/io.ts';
import { ctlPathFor, probeDaemon, probeDaemons } from '../channel/discover.ts';
import { ensureSession } from '../relay/login.ts';
import { pickRelay, relayApi, relayDefaultText, relayOriginOf, relayProblem } from '../relay/relay.ts';
import { loadCredentials, type StoredSession } from '../state/credentials.ts';
import { homeDirOf, hostLogPath, workspaceStateDir } from '../state/paths.ts';
import { stateProblem, stateProblemSaysWhy } from '../state/private-file.ts';
import { loadWorkspaces, newWorkspaceId, rememberSharedFolder, sharedFolderFor, type WorkspaceBook } from '../state/workspaces.ts';
import { NativeExtractionError, ensureSeaNative } from '../sea/native.ts';
import { agentsPausedNotice } from '../cli/agents-text.ts';
import { powerState } from '../cli/power-text.ts';
import { updateNotice, type UpdateNoticeDeps } from '../update/notice.ts';
import { CLI_VERSION } from '../version.ts';
import { m, renderText, roleText, type MessageId, type Text } from '../i18n/index.ts';
import type { DurationUnit } from '../i18n/en.ts';
import { say, tr, type CommandContext } from './context.ts';
import { foldersSetAside, formatTime, oldFolderNotice, stateFileProblem, upgradeNotice, wasStamped, watchRefusedPeers, type RefusalContext } from './host-state.ts';

/** `smurg host --help`; the --relay default depends on the built-in relay (../relay/default-relay.ts). */
export function hostUsage(): Text {
  return m('usage.host', { relayDefault: relayDefaultText() });
}

/** The default of the switch (ARCHITECTURE §11 D-13; the daemon's own default is the same). */
export const HOST_SWITCH_DEFAULTS = Object.freeze({ attributeBashEdits: true });

const DEFAULT_ROLE: GuestRole = 'editor';
const DEFAULT_EXPIRES = '7d';
/** daemon.stop() reason when the summary (the invite link) could not be made; only for the log. */
const STOP_SUMMARY_FAILED = 'summary-failed';
const MIN_EXPIRES_SEC = 60;
/** How often the host command looks at the keep-awake status after the start. */
const POWER_WATCH_MS = 2_000;
/** How often the host command re-reads credentials.json for a renewed relay login. */
const CREDENTIALS_WATCH_MS = 5_000;
/** A relay login is renewed before sharing, and the host is reminded while sharing, when it has less left than this. */
export const HOST_SESSION_MIN_VALIDITY_MS = 24 * 3600_000;
/** A dropped relay link is told only when it has not come back within this time (brief blips are not news). */
const LINK_DOWN_NOTICE_MS = 3_000;
/** After the first Ctrl-C, further ones are ignored this long (the stop is running); later ones leave at once. */
const SECOND_SIGNAL_GRACE_MS = 2_000;

/** Test seams for the daemon (the in-memory relay, a test identity issuer, fewer modules, no caffeinate). */
export interface HostDeps {
  readonly daemon?: {
    readonly socketFactory?: HostSocketFactory;
    readonly identityKeys?: IdentityKeySource;
    readonly modules?: readonly FeatureModule[];
    readonly power?: PowerService;
  };
  /** Called once the summary is printed. */
  readonly onReady?: (daemon: Daemon) => void;
  /** TEST ONLY: how often credentials.json is re-read (default CREDENTIALS_WATCH_MS). */
  readonly credentialsWatchMs?: number;
  /** The update notice's seams (the executable, its version, fetch, the timeout). */
  readonly update?: UpdateNoticeDeps;
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** The realpath of a folder that may be shared, or a refusal. */
export async function validateFolder(ctx: CommandContext, folderArg: string): Promise<string> {
  const absolute = resolve(ctx.io.cwd, folderArg);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    throw usageError(m('host.folder.notFound', { folder: folderArg }));
  }
  if (!(await stat(real)).isDirectory()) throw usageError(m('host.folder.notDirectory', { folder: folderArg }));
  if (real === '/') throw usageError(m('host.folder.root'));
  const home = await realpath(homeDirOf(ctx.io.env)).catch(() => null);
  if (home !== null && real === home) throw usageError(m('host.folder.home'), m('host.folder.example', { example: join(home, 'my-project') }));
  // A folder that CONTAINS a home directory exposes ~/.ssh, ~/.aws, … to every member (the daemon refuses it too).
  const containsHome = home !== null && isInside(home, real);
  let containsHomes = false;
  for (const homes of HOMES_PARENTS) {
    const homesReal = await realpath(homes).catch(() => null);
    if (homesReal !== null && isInside(homesReal, real)) containsHomes = true;
  }
  if (containsHome || containsHomes) {
    throw usageError(m('host.folder.containsHome'), m('host.folder.containsHome.hint', home !== null ? { example: join(home, 'my-project') } : {}));
  }
  const stateDir = await realpath(ctx.paths.stateDir).catch(() => resolve(ctx.paths.stateDir));
  if (isInside(stateDir, real)) throw usageError(m('host.folder.containsState', { stateDir: ctx.paths.stateDir }), m('host.folder.containsState.hint'));
  if (isInside(real, stateDir)) throw usageError(m('host.folder.insideState'));
  return real;
}

/** Keep-awake that tells the host command when the daemon released it: the last step of daemon.stop(). */
class HostPower implements PowerService {
  private readonly inner: PowerService;
  private resolveReleased: () => void = () => {};
  readonly released: Promise<void>;

  constructor(inner: PowerService) {
    this.inner = inner;
    this.released = new Promise((resolve) => {
      this.resolveReleased = resolve;
    });
  }

  start(): Promise<PowerStatus> {
    return this.inner.start();
  }

  async stop(): Promise<void> {
    try {
      await this.inner.stop();
    } finally {
      this.resolveReleased();
    }
  }

  status(): PowerStatus {
    return this.inner.status();
  }
}

/** How a session runs `smurg hook` / `smurg mcp`: this binary (SEA), or node + this CLI's main.ts (source). */
export function selfCommand(): { file: string; args: string[] } {
  let sea = false;
  try {
    const mod = process.getBuiltinModule?.('node:sea') as { isSea?: () => boolean } | undefined;
    sea = mod?.isSea?.() === true;
  } catch {
    sea = false;
  }
  if (sea) return { file: process.execPath, args: [] };
  return { file: process.execPath, args: [fileURLToPath(new URL('../main.ts', import.meta.url))] };
}

function tee(a: Logger, b: Logger): Logger {
  return {
    debug: (m: string, f?: LogFields) => {
      a.debug(m, f);
      b.debug(m, f);
    },
    info: (m: string, f?: LogFields) => {
      a.info(m, f);
      b.info(m, f);
    },
    warn: (m: string, f?: LogFields) => {
      a.warn(m, f);
      b.warn(m, f);
    },
    error: (m: string, f?: LogFields) => {
      a.error(m, f);
      b.error(m, f);
    },
    child: (fields: LogFields) => tee(a.child(fields), b.child(fields)),
  };
}

/** `inner`, with every error whose message is one of `messages` passed to `held` instead (also through its children). */
function holdingBack(inner: Logger, messages: readonly string[], held: (log: () => void) => void): Logger {
  return {
    debug: (m: string, f?: LogFields) => inner.debug(m, f),
    info: (m: string, f?: LogFields) => inner.info(m, f),
    warn: (m: string, f?: LogFields) => inner.warn(m, f),
    error: (m: string, f?: LogFields) => {
      if (messages.includes(m)) held(() => inner.error(m, f));
      else inner.error(m, f);
    },
    child: (fields: LogFields) => holdingBack(inner.child(fields), messages, held),
  };
}

interface HostLog {
  readonly logger: Logger;
  readonly path: string;
  close(): Promise<void>;
  /**
   * The daemon's own line about a start it refuses (START_FAILURE_LOGS: the workspace's state was refused, the
   * composition failed) is written to the log FILE at once and held back from the terminal until the command knows
   * whether it words the failure itself: `show` true prints the line(s) as they were logged (the command has no
   * words: the line is the only place that says why), false drops them (the command's words name the file and the
   * reason). Every other error of the log reaches stderr at once, as it always has.
   */
  settleRefusal(show: boolean): void;
}

/** The daemon's log: everything from info up to `<state>/logs/<workspace>.log` (0600), errors also to stderr. */
async function openLog(ctx: CommandContext, workspaceId: string): Promise<HostLog> {
  try {
    await ensurePrivateDirectory(ctx.paths.logsDir);
  } catch (err) {
    throw stateProblem(err, 'logs');
  }
  const path = hostLogPath(ctx.paths, workspaceId);
  const stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
  stream.on('error', () => undefined);
  const file = createLineLogger({ level: 'info', write: (line) => stream.write(`${line}\n`) });
  // The terminal's lines are formatted when they are logged (their time is the log's), and one kind is held back.
  const held: string[] = [];
  let holding = false;
  const terminal = createLineLogger({ level: 'error', write: (line) => (holding ? held.push(line) : ctx.io.stderr.write(`${line}\n`)) });
  const console = holdingBack(terminal, START_FAILURE_LOGS, (log) => {
    holding = true;
    try {
      log();
    } finally {
      holding = false;
    }
  });
  return {
    logger: tee(file, console),
    path,
    close: () => new Promise<void>((done) => stream.end(() => done())),
    settleRefusal: (show) => {
      for (const line of held.splice(0)) if (show) ctx.io.stderr.write(`${line}\n`);
    },
  };
}

/** The daemon's reason codes for a folder it refuses to share (SHARE_ERROR_REASONS in @smurg/daemon). */
const SHARE_REFUSALS: Readonly<Record<ShareErrorReason, MessageId>> = {
  'not-found': 'host.share.notFound',
  'not-a-directory': 'host.share.notDirectory',
  'filesystem-root': 'host.share.root',
  'home-directory': 'host.share.home',
  'contains-home': 'host.folder.containsHome',
  'contains-homes': 'host.share.containsHomes',
  'state-dir-inside-share': 'host.share.stateInside',
  'share-inside-state-dir': 'host.folder.insideState',
  'smurg-not-a-directory': 'host.share.smurgNotDirectory',
};

/**
 * A daemon start failure as the person should read it. A state file the daemon refuses is worded by its kind and
 * cause (./host-state.ts): the text names the file and the reason itself (the log has the same).
 */
async function daemonProblem(err: unknown, logPath: string, refusal: RefusalContext): Promise<CliError> {
  const workspaceDir = refusal.workspaceDir;
  if (err instanceof CliError) return err;
  if (err instanceof ShareError) {
    const text: Text = Object.hasOwn(SHARE_REFUSALS, err.reason) ? { id: SHARE_REFUSALS[err.reason] } : m('host.share.other', { reason: String(err.reason) });
    return new CliError(text, { exitCode: EXIT.usage, cause: err });
  }
  if (err instanceof ShareLockError) {
    // One daemon per folder, whatever its relay or state dir (the daemon's lock in <folder>/.smurg).
    return new CliError(m(err.reason === 'ancestor-shared' ? 'host.locked.ancestor' : 'host.locked.shared'), { hint: m('host.locked.hint'), cause: err });
  }
  if (err instanceof KeyFileError) return stateProblem(err, 'daemon-key');
  if (err instanceof StateFileError) return stateFileProblem(err, refusal);
  if (err instanceof SocketPathError) return new CliError(m('state.socketPathTooLong', { path: workspaceDir }), { hint: m('state.socketPathTooLong.hint'), cause: err });
  const named = err as { name?: unknown; code?: unknown };
  if (named?.name === 'ControlSocketError' && named.code === 'daemon-running') {
    return new CliError(m('host.alreadyRunning'), { hint: m('host.alreadyShared.hint'), cause: err });
  }
  if (named?.name === 'ControlSocketError') return new CliError(m('host.controlSocket'), { hint: m('host.seeLog', { logPath }), cause: err });
  return new CliError(m('host.daemonFailed', { name: err instanceof Error ? err.name : 'unknown' }), { hint: m('host.seeLog', { logPath }), cause: err });
}

/** 7 days, 12 hours, 30 minutes (in days rather than weeks: --expires is written in days). */
function durationOf(seconds: number): { amount: number; unit: DurationUnit } {
  if (seconds % 86_400 === 0) return { amount: seconds / 86_400, unit: 'day' };
  if (seconds % 3600 === 0) return { amount: seconds / 3600, unit: 'hour' };
  if (seconds % 60 === 0) return { amount: seconds / 60, unit: 'minute' };
  return { amount: seconds, unit: 'second' };
}

function parseRole(text: string | undefined): GuestRole {
  if (text === undefined) return 'editor';
  if (text === 'agent' || text === 'editor' || text === 'viewer') return text;
  if (text === 'host') throw usageError(m('host.role.host'), m('host.role.host.hint'));
  throw usageError(m('host.role.unknown', { role: text }), m('host.role.unknown.hint'));
}

function parseName(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  // eslint-disable-next-line no-control-regex
  if (trimmed.length === 0 || trimmed.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) throw usageError(m('host.name.invalid'));
  return trimmed;
}

export async function runHost(argv: readonly string[], ctx: CommandContext, deps: HostDeps = {}): Promise<number> {
  const args = parseArgs(argv, {
    options: {
      relay: { kind: 'string' },
      role: { kind: 'string' },
      expires: { kind: 'string' },
      'max-uses': { kind: 'string' },
      name: { kind: 'string' },
      'web-origin': { kind: 'string' },
      'keep-awake': { kind: 'boolean' },
      browser: { kind: 'boolean' },
      'bash-attribution': { kind: 'boolean' },
      help: { kind: 'boolean', short: 'h' },
    },
    positionals: [m('arg.folder')],
    minPositionals: 1,
  });
  if (args.options['help']) {
    say(ctx, hostUsage());
    return EXIT.ok;
  }
  const { io } = ctx;
  const role = parseRole(stringOption(args, 'role'));
  const expiresText = stringOption(args, 'expires') ?? DEFAULT_EXPIRES;
  const expiresInSec = parseDuration(expiresText);
  if (expiresInSec === null) throw usageError(m('host.expires.unreadable', { text: expiresText }), m('host.expires.unreadable.hint'));
  if (expiresInSec < MIN_EXPIRES_SEC || expiresInSec > INVITE_EXPIRES_IN_SEC_MAX) throw usageError(m('host.expires.range'));
  const maxUsesText = stringOption(args, 'max-uses');
  const maxUses = maxUsesText === undefined ? undefined : parseMaxUses(maxUsesText);
  const name = parseName(stringOption(args, 'name'));
  const keepAwake = booleanOption(args, 'keep-awake') !== false;
  // ARCHITECTURE §11 D-13: on unless the host switches it off (`--no-bash-attribution`; `--x --no-x` is refused).
  const attributeBashEdits = booleanOption(args, 'bash-attribution') ?? HOST_SWITCH_DEFAULTS.attributeBashEdits;
  const webOriginFlag = stringOption(args, 'web-origin');
  // The same rule as for a relay: https, or http on a local hostname (the link carries the invite secret).
  const webOrigin =
    webOriginFlag === undefined ? undefined : relayOriginOf(webOriginFlag, 'web-origin');
  const folder = await validateFolder(ctx, args.positionals[0] as string);

  const origin = pickRelay(stringOption(args, 'relay'), io, await loadCredentials(ctx.paths)).origin;
  const existing = sharedFolderFor(await loadWorkspaces(ctx.paths), folder, origin);
  const workspaceId = existing?.workspaceId ?? newWorkspaceId();
  // Before any login: a folder that is already shared needs no browser. A smurg host of another version (alive, its
  // answer not readable by this command: channel/discover.ts) shares the folder just the same.
  const sharing = await probeDaemon(ctlPathFor(ctx.paths, workspaceId));
  if (sharing.kind === 'running') throw new CliError(m('host.alreadyShared'), { hint: m('host.alreadyShared.hint') });
  if (sharing.kind === 'unreadable') throw new CliError(m('host.otherVersion', { current: CLI_VERSION, why: sharing.daemon.why }), { hint: m('otherVersion.hint') });
  await refuseOverlappingShare(ctx, folder);
  // No notice for the built-in relay here (owner decision 2026-10-01: the start shows only the links): a login names
  // the relay it opens, and `smurg status` names the relay of a running share.
  const { session, user } = await ensureSession(ctx, origin, {
    interactive: true,
    noBrowser: booleanOption(args, 'browser') === false,
    minValidityMs: HOST_SESSION_MIN_VALIDITY_MS,
  });
  try {
    await relayApi(io, origin, { kind: 'bearer', token: session.token }).claimWorkspace(workspaceId);
  } catch (err) {
    if (isRelayApiError(err) && err.status === 409) {
      throw new CliError(m('host.workspaceTaken', { workspaceId }), { hint: m('host.workspaceTaken.hint', { name: user.displayName, userId: user.userId }) });
    }
    throw relayProblem(err, origin, 'claim');
  }
  if (!existing) await rememberSharedFolder(ctx.paths, { folder, relay: origin, workspaceId, createdAt: io.now() });

  // The single executable's native parts (node-pty, the file watcher, …) are extracted and verified before the daemon
  // loads any of them; running from source this does nothing.
  try {
    ensureSeaNative();
  } catch (err) {
    if (err instanceof NativeExtractionError) throw new CliError(m('host.native', { reason: err.message }), { hint: m('host.native.hint'), cause: err });
    throw err;
  }
  const log = await openLog(ctx, workspaceId);
  const workspaceDir = workspaceStateDir(ctx.paths, workspaceId);
  const refusal: RefusalContext = { io, workspaceId, workspaceDir, ...(deps.update ? { update: deps.update } : {}) };
  // Whether a smurg that stamps its folders has opened this workspace's folder before (asked before the daemon
  // writes the stamp): the line about a folder set aside is said at the first such start only.
  const stampedBefore = await wasStamped(workspaceDir);
  const modules = deps.daemon?.modules ?? DEFAULT_FEATURE_MODULES;
  const power = new HostPower(deps.daemon?.power ?? new KeepAwake({ enabled: keepAwake, log: log.logger.child({ module: 'power' }) }));
  let daemon: Daemon;
  try {
    daemon = await createDaemon({
      config: {
        stateDir: ctx.paths.stateDir,
        shareDir: folder,
        workspaceId,
        hostUserId: user.userId,
        hostName: user.displayName,
        relayUrl: origin,
        ...(webOrigin !== undefined ? { webOrigin } : {}),
        keepAwake,
        ...(name !== undefined ? { workspaceName: name } : {}),
        sessions: { selfCommand: selfCommand() },
        activity: { attributeBashEdits },
      },
      relay: { token: session.token, ...(deps.daemon?.socketFactory ? { socketFactory: deps.daemon.socketFactory } : {}) },
      ...(deps.daemon?.identityKeys ? { identityKeys: deps.daemon.identityKeys } : {}),
      modules,
      log: log.logger,
      power,
      homeDir: homeDirOf(io.env),
    });
  } catch (err) {
    // createDaemon logged why (the state it refused, review F3); the log is flushed before the hint names it.
    // That line is in the log file. On the terminal it is shown only when the command has no words of its own for
    // the refusal: a StateFileError (./host-state.ts) and a KeyFileError with a text name the file and the reason.
    log.settleRefusal(!(err instanceof StateFileError || stateProblemSaysWhy(err)));
    await log.close();
    throw await daemonProblem(err, log.path, refusal);
  }
  // Nothing was refused: nothing is held (a line that were would be shown, never lost).
  log.settleRefusal(true);

  // What this start found in the workspace's folder, ONE line each, before the links (the daemon wrote an upgrade in
  // createDaemon, so it is said now: a start that fails later would never say it again). The log gets the same.
  const found: (Text | null)[] = [upgradeNotice(daemon), stampedBefore ? null : oldFolderNotice(await foldersSetAside(workspaceDir))];
  for (const line of found) {
    if (line === null) continue;
    say(ctx, line);
    log.logger.info(renderText('en', line));
  }

  // Stop requests: a signal (Ctrl-C, SIGTERM, a closed terminal) or `smurg stop` on the control socket.
  let stopping: { readonly source: 'signal' | 'control'; readonly reason: string } | null = null;
  let stopStartedAt = 0;
  let wake: () => void = () => {};
  const stopRequested = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const onSignal = (signal: CliSignal): void => {
    if (stopping !== null) {
      // A double Ctrl-C is usually one impatient key press; leaving in the middle of ending the sessions'
      // processes is what can leave them stopped. Only a later Ctrl-C leaves at once.
      if (io.now() - stopStartedAt < SECOND_SIGNAL_GRACE_MS) {
        say(ctx, m('host.stopping.wait'));
        return;
      }
      say(ctx, m('host.stopping.again'));
      io.exit(EXIT.interrupted);
      return;
    }
    stopStartedAt = io.now();
    stopping = { source: 'signal', reason: signal };
    say(ctx, m('host.stopping.signal', { signal }));
    wake();
  };
  const unsubscribe = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => io.onSignal(signal, () => onSignal(signal)));
  // Stops are told apart by what this command knows, never by the reason text (verification F-2: anyone who reaches
  // the control socket used to choose it, and 'start-failed' / 'summary-failed' passed for this command's own stops,
  // so the daemon stopped while the host's terminal still said to press Ctrl-C). Every daemon stop this command
  // did not start itself is a stop request; while the daemon is still starting it is told once the start returned (a
  // failed start stops the daemon too, and that failure is reported instead).
  let selfStop = false;
  let starting = true;
  const announceControlStop = (): void => say(ctx, m('host.stopping.control'));
  // The agent sessions as the stop begins (the event comes before any module stops): what the last line counts.
  let agentsAtStop: ReturnType<Daemon['status']>['agents'];
  const stoppingListener = daemon.ctx.bus.on('daemon.stopping', () => {
    agentsAtStop = daemon.status().agents;
    if (stopping !== null || selfStop) return;
    stopping = { source: 'control', reason: 'control' };
    stopStartedAt = io.now();
    if (!starting) announceControlStop();
    wake();
  });
  let powerWatch: ReturnType<typeof setInterval> | undefined;
  let relayWatch: { dispose(): void } | undefined;
  // A teammate's page or smurg of another protocol version that was turned away: heard from the first connection
  // on (teammates' open tabs reconnect the moment the daemon is at the relay), told under the links.
  const peerWatch = watchRefusedPeers(daemon, (direction, text) => {
    log.logger.info('a known peer of another protocol version was turned away', { direction });
    if (stopping === null) say(ctx, text);
  });
  const updateCheck = new AbortController();
  const cleanup = async (): Promise<void> => {
    updateCheck.abort();
    if (powerWatch !== undefined) clearInterval(powerWatch);
    relayWatch?.dispose();
    peerWatch.dispose();
    for (const off of unsubscribe) off();
    stoppingListener.dispose();
    // The control socket closes just after the rest of the daemon stopped (src/local/module.ts in @smurg/daemon):
    // `smurg stop` in another terminal returns when it is gone, so this process ends right after.
    await Promise.all(modules.map((m) => ('whenClosed' in m ? (m as LocalControlModule).whenClosed() : undefined)));
    await log.close();
  };

  try {
    await daemon.start();
  } catch (err) {
    await cleanup();
    throw await daemonProblem(err, log.path, refusal);
  }
  starting = false;
  if ((stopping as { readonly source: 'signal' | 'control' } | null)?.source === 'control') announceControlStop();

  if (stopping === null) {
    try {
      printSummary(ctx, daemon, { role, expiresInSec, maxUses, userId: user.userId });
    } catch (err) {
      selfStop = true;
      await daemon.stop(STOP_SUMMARY_FAILED).catch(() => {});
      await cleanup();
      throw err instanceof CliError ? err : new CliError(m('host.inviteFailed'), { cause: err });
    }
    // Keep-awake the system refused at the start (polkit over SSH, no systemd-inhibit): one line, after the links.
    // Switched off with --no-keep-awake (reason 'disabled') is the host's own choice: nothing to tell.
    const startPower = daemon.status().power;
    if (!startPower.active && startPower.reason !== 'disabled') say(ctx, m('host.keepAwake.notice', { state: powerState(startPower) }));
    // Keep-awake that is lost later (the inhibitor exited, e.g. no logind session) is told here, not only in the log.
    let keptAwake = startPower.active;
    powerWatch = setInterval(() => {
      const power = daemon.status().power;
      if (keptAwake && !power.active && stopping === null) say(ctx, m('host.keepAwake.lost', { state: powerState(power) }));
      keptAwake = power.active;
    }, POWER_WATCH_MS);
    powerWatch.unref?.();
    relayWatch = watchRelay(ctx, daemon, { origin, userId: user.userId, session }, () => stopping !== null, deps.credentialsWatchMs ?? CREDENTIALS_WATCH_MS);
    peerWatch.release();
    // A newer version: one line under the links, whenever the answer comes (never awaited: the start is not delayed).
    void updateNotice(io, updateCheck.signal, deps.update).then((line) => {
      if (line !== null && stopping === null) say(ctx, `\n${tr(ctx, line)}`);
    });
    deps.onReady?.(daemon);
  }

  await stopRequested;
  const how = stopping as unknown as { source: 'signal' | 'control'; reason: string };
  if (how.source === 'signal') await daemon.stop(how.reason);
  else await power.released; // daemon.stop() is already running (started from the control socket); keep-awake is its last step
  await cleanup();
  say(ctx, m('host.stopped'));
  const paused = agentsPausedNotice(agentsAtStop);
  if (paused !== null) say(ctx, paused);
  return EXIT.ok;
}

/**
 * A folder inside, or around, a folder that a running `smurg host` of this state dir shares, whatever the
 * relay. The daemon's own lock (`<folder>/.smurg/daemon-lock.json`) also covers other state dirs sharing the same
 * folder or one of its ancestors.
 */
async function refuseOverlappingShare(ctx: CommandContext, folder: string): Promise<void> {
  const { running, unreadable } = await probeDaemons(ctx.paths);
  if (running.length === 0 && unreadable.length === 0) return;
  const book: WorkspaceBook = await loadWorkspaces(ctx.paths);
  // A host of another version is in the way too, as far as workspaces.json says which folder its socket belongs to
  // (the daemon's own lock in the folder covers the rest: it needs no answer anyone has to read).
  const sharing = [
    ...running.map((daemon) => ({ workspaceId: daemon.status.workspaceId, otherVersion: false })),
    ...unreadable.flatMap((daemon) => (daemon.workspaceId === null ? [] : [{ workspaceId: daemon.workspaceId, otherVersion: true }])),
  ];
  for (const daemon of sharing) {
    for (const entry of book.shared.filter((e) => e.workspaceId === daemon.workspaceId)) {
      if (!isInside(folder, entry.folder) && !isInside(entry.folder, folder)) continue;
      const what =
        entry.folder === folder
          ? m('host.overlap.same')
          : isInside(folder, entry.folder)
            ? m('host.overlap.ancestor', { folder: entry.folder })
            : m('host.overlap.inside', { folder: entry.folder });
      throw new CliError(what, {
        hint: daemon.otherVersion
          ? m('host.overlap.otherVersion.hint', { workspaceId: daemon.workspaceId, current: CLI_VERSION })
          : m('host.overlap.hint', { workspaceId: daemon.workspaceId, relay: entry.relay }),
      });
    }
  }
}

interface RelayWatchTarget {
  readonly origin: string;
  readonly userId: string;
  readonly session: StoredSession;
}

/**
 * What the daemon only logged is told on the host's terminal — the relay
 * link dropping and coming back, the relay refusing the host's login (members cannot connect until the host logs in
 * again), a login that is about to expire, and a state file the disk refuses. A renewed login (`smurg login` in another
 * terminal writes credentials.json) is handed to the running daemon (Daemon.updateRelayToken): no restart, no new links.
 */
export function watchRelay(ctx: CommandContext, daemon: Daemon, target: RelayWatchTarget, stopped: () => boolean, intervalMs: number): { dispose(): void } {
  let token = target.session.token;
  let expiresAt = target.session.expiresAt;
  let expiryWarned = false;
  let otherAccountWarned: string | null = null;
  let shown: 'online' | 'down' | 'auth' = 'online';
  let downTimer: ReturnType<typeof setTimeout> | undefined;
  const tell = (text: Text): void => {
    if (!stopped()) say(ctx, text);
  };
  const cancelDownNotice = (): void => {
    if (downTimer !== undefined) clearTimeout(downTimer);
    downTimer = undefined;
  };
  const onLink = daemon.ctx.bus.on('relay.link', ({ purpose, state }) => {
    if (purpose !== 'interactive') return; // the transfer link follows the same login and network: one notice is enough
    if (state === 'online') {
      cancelDownNotice();
      if (shown !== 'online') tell(m('host.relay.back'));
      shown = 'online';
    } else if (state === 'auth-rejected') {
      cancelDownNotice();
      if (shown !== 'auth') tell(m('host.relay.authRejected', { origin: target.origin }));
      shown = 'auth';
    } else if (state === 'waiting' && shown === 'online' && downTimer === undefined) {
      downTimer = setTimeout(() => {
        downTimer = undefined;
        if (shown !== 'online') return;
        shown = 'down';
        tell(m('host.relay.down'));
      }, LINK_DOWN_NOTICE_MS);
      downTimer.unref?.();
    }
    // 'connecting' changes nothing that was told; 'replaced' is logged as an error by the daemon (stderr).
  });
  const unsaved = new Set<string>();
  const onState = daemon.ctx.bus.on('state.write', ({ document, ok }) => {
    if (!ok) {
      const first = unsaved.size === 0;
      unsaved.add(document);
      if (first) tell(m('host.state.unsaved'));
    } else if (unsaved.delete(document) && unsaved.size === 0) {
      tell(m('host.state.saved'));
    }
  });
  let busy = false;
  const poll = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      let stored: StoredSession | undefined;
      try {
        stored = (await loadCredentials(ctx.paths)).relays[target.origin];
      } catch {
        stored = undefined; // an unreadable file: keep the current login
      }
      const now = ctx.io.now();
      if (stored !== undefined && stored.token !== token && stored.expiresAt > now) {
        if (stored.userId !== target.userId) {
          // The workspace belongs to the account that claimed it: another account's token would be refused anyway.
          if (otherAccountWarned !== stored.token) tell(m('host.login.otherAccount', { origin: target.origin, name: stored.displayName }));
          otherAccountWarned = stored.token;
        } else {
          token = stored.token;
          expiresAt = stored.expiresAt;
          expiryWarned = false;
          daemon.updateRelayToken(token);
          tell(m('host.login.renewed'));
        }
      }
      if (!expiryWarned && expiresAt - now < HOST_SESSION_MIN_VALIDITY_MS) {
        expiryWarned = true;
        tell(m('host.login.expiring', { time: formatTime(expiresAt), origin: target.origin }));
      }
    })().finally(() => {
      busy = false;
    });
  }, intervalMs);
  poll.unref?.();
  return {
    dispose: () => {
      clearInterval(poll);
      cancelDownNotice();
      onLink.dispose();
      onState.dispose();
    },
  };
}

/** "Link for your teammates (...):": the expiry always, the use limit and the role only when chosen. */
export function inviteHeading(role: GuestRole, expiresInSec: number, maxUses: number | undefined): Text {
  return m('host.invite.heading', { ...durationOf(expiresInSec), ...(maxUses !== undefined ? { maxUses } : {}), ...(role !== DEFAULT_ROLE ? { role: roleText(role) } : {}) });
}

/**
 * The start summary (owner decision 2026-10-01): the workspace's name, the two links, how to stop. Nothing else: the
 * rest is in docs/HOSTING.md and `smurg status`. The links carry their one-time secrets: the terminal only, never the
 * log.
 */
function printSummary(ctx: CommandContext, daemon: Daemon, s: { role: GuestRole; expiresInSec: number; maxUses: number | undefined; userId: string }): void {
  const principal = daemon.ctx.members.principalOf(s.userId);
  if (!principal) throw new CliError(m('host.noHostMember'));
  const { url } = daemon.ctx.invites.create({ role: s.role, expiresInSec: s.expiresInSec, ...(s.maxUses !== undefined ? { maxUses: s.maxUses } : {}) }, principal);
  say(
    ctx,
    m('host.summary', {
      name: daemon.ctx.workspace.info.name,
      ...(daemon.hostInviteUrl !== undefined && daemon.hostInviteUrl !== null ? { hostUrl: daemon.hostInviteUrl } : {}),
      inviteHeading: inviteHeading(s.role, s.expiresInSec, s.maxUses),
      inviteUrl: url,
    }),
  );
}

/** --max-uses: a whole number within the protocol's range. */
function parseMaxUses(text: string): number {
  const value = parseCount(text);
  if (value === null) throw usageError(m('host.maxUses.notInteger', { text }));
  if (value < 1 || value > INVITE_MAX_USES_MAX) throw usageError(m('host.maxUses.range', { min: 1, max: INVITE_MAX_USES_MAX }));
  return value;
}
