// Every tunable of the daemon in one place. Nothing here reads the environment or defaults to the real home
// directory: the CLI passes `stateDir` (~/.smurg in production) and tests pass a temp directory, so no test can
// touch ~/.smurg by accident (ARCHITECTURE §0 rule 4).
import { isAbsolute, join, resolve } from 'node:path';
import {
  AGENT_LOCK_TTL_MS,
  CLIENT_OFFLINE_THRESHOLD_MS,
  DEFAULT_CHUNK_SIZE,
  DISK_RESERVE_BYTES_DEFAULT,
  DISK_RESERVE_PERCENT_DEFAULT,
  HANDSHAKE_DEADLINE_MS,
  HUMAN_LOCK_IDLE_MS,
  MAX_FAILED_HANDSHAKES_PER_CONN,
  PONG_WATCHDOG_MS,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  RELAY_PING_INTERVAL_MS,
  hostSettingsSchema,
  type HostSettings,
} from '@smurg/protocol';
import { isLocalHostname, isWorkspaceId } from '@smurg/protocol/relay';
import { runPathsFor, type RunPaths } from './sockets.ts';

/** Allow-list the guests' sandboxes start with (R5); the host edits it in the console. */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = Object.freeze([
  'api.anthropic.com',
  'claude.ai',
  '*.claude.ai',
  'console.anthropic.com',
  'platform.claude.com',
  'statsig.anthropic.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
]);

export function defaultHostSettings(): HostSettings {
  return hostSettingsSchema.parse({
    humanLockIdleMs: HUMAN_LOCK_IDLE_MS,
    agentLockTimeoutMs: AGENT_LOCK_TTL_MS,
    uploadChunkSize: DEFAULT_CHUNK_SIZE,
    sharedDirs: [],
    allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
    diskReserveBytes: DISK_RESERVE_BYTES_DEFAULT,
    diskReservePercent: DISK_RESERVE_PERCENT_DEFAULT,
  });
}

export interface TimingConfig {
  /** host → relay text "ping" (relay.md §1.2). */
  readonly relayPingIntervalMs: number;
  /** No "pong" (nor anything else) for this long ⇒ terminate the host socket and reconnect. */
  readonly pongWatchdogMs: number;
  /** Encrypted presence.heartbeat on every interactive channel (clients show 「主人已離線」 after 8 s without). */
  readonly presenceHeartbeatMs: number;
  /** A Noise handshake must finish within this. */
  readonly handshakeDeadlineMs: number;
  /**
   * A relay connection that is not admitted within handshakeDeadlineMs + this after peer.open (or after its last
   * failed handshake, or after its channel ended without a kick) is dropped with peer.kick: otherwise sockets that
   * never handshake would hold the relay's per-account and per-workspace socket slots forever.
   */
  readonly idleConnGraceMs: number;
  /** Relay reconnect backoff: first delay, cap, and ± jitter fraction. */
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly reconnectJitter: number;
  /** A relay socket that does not open within this is abandoned and retried. */
  readonly relayOpenTimeoutMs: number;
  /**
   * The relay refused the host's session token (HTTP 401/403 at the upgrade: expired or revoked login). The same token
   * will not work again, so the link does not hammer the relay: it waits for a new token (Daemon.updateRelayToken) and
   * only re-tries the old one this rarely (e.g. a relay restarted with a wrong key and then fixed).
   */
  readonly relayAuthRetryMs: number;
  /** Daemon → client channel.ack: at the latest this long after the first unacknowledged client message… */
  readonly ackDelayMs: number;
  /** …or after this many. */
  readonly ackEvery: number;
  /** A disconnected logical channel (its outbox, for resume) is kept this long. */
  readonly channelRetentionMs: number;
  /** How often the identity-token verification keys are re-fetched from the relay. */
  readonly identityKeyRefreshMs: number;
  /** Minimum gap between two on-demand key refreshes (unknown `kid`). */
  readonly identityKeyMinRefreshGapMs: number;
  /** Allowed clock skew when checking identity-token times. */
  readonly identityClockSkewMs: number;
}

export interface LimitsConfig {
  /** Failed handshakes on one relay connection before the daemon asks the relay to drop it. */
  readonly maxFailedHandshakesPerConn: number;
  /** Global handshake budget (token bucket refilled per minute), shared by everyone. */
  readonly handshakesPerMinute: number;
  /** Reserve that members with a registered device may use when the global budget is empty (flood by strangers). */
  readonly memberHandshakesPerMinute: number;
  /** Handshake budget of ONE relay user (fairness: one account cannot drain the global budget). */
  readonly handshakesPerUserPerMinute: number;
  /** Handshakes allowed in progress at the same time, per class (members with a device / everyone else). */
  readonly maxPendingHandshakes: number;
  /** Handshakes one relay user may have in progress at the same time. */
  readonly maxPendingHandshakesPerUser: number;
  /** Per logical channel: unacknowledged daemon → client Envelopes kept for replay. */
  readonly outboxMaxEntries: number;
  readonly outboxMaxBytes: number;
  /** Open channels per member (interactive + transfer, all devices). */
  readonly maxConnectionsPerUser: number;
  /** Undecodable / refused Envelopes on one connection before it is closed with protocol-error. */
  readonly maxProtocolErrorsPerConn: number;
  /**
   * Refused (audited) requests on one connection per minute before it is closed with protocol-error and its logical
   * channel ended (a UI never sends what the role cannot do; a flood would fill the host's audit log).
   */
  readonly maxDenialsPerConnPerMinute: number;
  /** Largest audit page (`admin.audit.query.limit`). */
  readonly auditPageMax: number;
  /** `denied` audit entries recorded per actor per minute; the rest are counted in one summary entry. */
  readonly auditDeniedPerActorPerMinute: number;
  /** audit.jsonl is rotated (audit.1.jsonl, audit.2.jsonl, 0600) when it would grow beyond this. */
  readonly auditMaxBytes: number;
}

/**
 * What the sessions / sandbox / hooks modules need to launch Claude Code (ARCHITECTURE §7.6). Seams, so tests never
 * touch the developer's real home, real `claude` or the real Anthropic API.
 */
export interface SessionLaunchConfig {
  /**
   * The host's home directory: the guests' sandbox denies reading it (R5.1) and the preflight canary lives below it.
   * createDaemon fills it from `homeDir` (default os.homedir()); tests pass a temporary fake home. null ⇒ the sandbox
   * module must refuse guest sessions (fail closed).
   */
  readonly hostHome: string | null;
  /** Absolute path of the `claude` executable; null ⇒ looked up on PATH when a session starts. */
  readonly claudePath: string | null;
  /**
   * Oldest Claude Code version guest sessions may run (refused below it, fail closed): the oldest version the hook
   * and sandbox setup is verified on. A property of smurg's setup, not of any model: which model a session uses is
   * between its owner's CLI and account. See claudeVersionVerdict().
   */
  readonly claudeMinVersion: string;
  /**
   * Versions the hook and sandbox setup is verified on end to end, ascending (claude-hooks.md ran every experiment on
   * each). A version ≥ claudeMinVersion that is not listed starts with a warning, never a refusal.
   */
  readonly claudeVerifiedVersions: readonly string[];
  /**
   * How a session runs `smurg hook` / `smurg mcp` (written into the session's settings.json / mcp.json). The daemon
   * cannot import the CLI, so the CLI passes it: process.execPath + [<cli>/src/main.ts] in dev, the SEA binary in
   * production. null ⇒ the hooks module refuses to start sessions.
   */
  readonly selfCommand: { readonly file: string; readonly args: readonly string[] } | null;
  /**
   * TEST ONLY: extra environment for guest sessions, e.g. ANTHROPIC_BASE_URL of a mock Anthropic API on 127.0.0.1
   * (the guest env allow-list otherwise forbids ANTHROPIC_*). Accepted only when the daemon has no relay or a local
   * one; resolveConfig refuses it for any other relay.
   */
  readonly testGuestEnv: Readonly<Record<string, string>> | null;
  /**
   * ARCHITECTURE §11 D-12 (implemented as recommended by the project lead; the owner's confirmation of the default is
   * pending): a guest may start their own Claude subscription login (a `login` session: the fixed `claude auth login`
   * in that guest's sandbox, which may listen on loopback). false ⇒ refused; guests log in with an API key only.
   * Published to clients as PublicSettings.guestSubscriptionLogin. Default true.
   */
  readonly guestSubscriptionLogin: boolean;
  /**
   * ARCHITECTURE §11 D-14 (owner decision 2026-10-01): a guest's sandboxed agent / terminal session may use the shared
   * MAIN workspace (workspace.mode 'main'). false ⇒ such a session.create is refused (`forbidden`, reason
   * 'main-workspace-off', audited) and guests get worktree mode only (a git share). Default: on a Linux host false
   * (bubblewrap cannot deny new nested host-only names by pattern, and the host's edits of protected entries reach a
   * running guest until the guard ends it: §12), elsewhere true (`defaultGuestMainWorkspace`). The host opens it with
   * `smurg host --allow-main-workspace-guests`. A guest's login session (kind 'login', nothing of the share) and the
   * host's own unsandboxed sessions are not affected. Published to clients as PublicSettings.guestMainWorkspace.
   */
  readonly guestMainWorkspace: boolean;
}

/**
 * The default of config.sessions.guestMainWorkspace on a host platform (ARCHITECTURE §11 D-14): off on Linux only.
 * The platform is the daemon's own (createDaemon passes it; the sandbox runs on the same machine).
 */
export function defaultGuestMainWorkspace(platform: NodeJS.Platform): boolean {
  return platform !== 'linux';
}

/** What resolveConfig needs to know about the machine besides the input (createDaemon passes its own view). */
export interface ResolveConfigEnvironment {
  /** The host platform; decides the defaults that differ per platform (config.sessions.guestMainWorkspace). */
  readonly platform: NodeJS.Platform;
}

/**
 * The activity feed's attribution (ARCHITECTURE §11 D-13; implemented as recommended by the project lead, the owner's
 * confirmation of the default is pending).
 */
export interface ActivityConfig {
  /**
   * Register Bash PreToolUse / PostToolUse hooks that only tell the daemon when a session runs a shell command, so a
   * disk change inside the Bash window of exactly one agent session is attributed to that agent (never a lock, never a
   * decision; they fail open). false ⇒ the Bash hooks are not registered and Bash events are ignored. Default true.
   */
  readonly attributeBashEdits: boolean;
}

export const DEFAULT_ACTIVITY_CONFIG: ActivityConfig = Object.freeze({ attributeBashEdits: true });

/**
 * Claude Code versions the hook and sandbox setup is verified on (claude-hooks.md: the spike and its verification ran
 * on both). The session settings are written to work on each of them (ARCHITECTURE §7.6 "Claude Code version").
 * Adding one means re-running that spike (mock Anthropic API only) on it.
 */
export const CLAUDE_VERIFIED_VERSIONS: readonly string[] = Object.freeze(['2.1.220', '2.1.283']);

/** The oldest verified version: guest sessions on an older `claude` are refused. */
export const CLAUDE_MIN_VERSION = '2.1.220';

export interface DaemonConfig {
  /** `~/.smurg` in production; a temp directory in tests. Created with mode 0700. */
  readonly stateDir: string;
  /**
   * Where the Unix sockets live (`<runDir>/<short>.ctl|.hook`, created 0700). Default `<stateDir>/run`. Socket paths
   * must fit 103 bytes (macOS): tests whose state dir is deep pass a short one (testing: createTempRunDir()).
   */
  readonly runDir: string;
  /** The socket and pid paths in runDir, checked with assertSocketPath at startup (fail closed). */
  readonly runPaths: RunPaths;
  /** `<stateDir>/workspaces/<workspaceId>` (identity key, state.json, audit.jsonl, …). */
  readonly workspaceStateDir: string;
  /** Absolute path of the shared folder as given (PathGuard uses its realpath). */
  readonly shareDir: string;
  readonly workspaceId: string;
  /** Display name of the workspace; default: the shared folder's name. */
  readonly workspaceName: string | null;
  /** The host's relay identity; the host invite is bound to it. */
  readonly hostUserId: string;
  readonly hostName: string;
  /** Relay origin (`https://smurg.app`, `http://127.0.0.1:8787`); null when the daemon runs without a relay (tests). */
  readonly relayUrl: string | null;
  /** Where invite links point (`https://<web-origin>/join/…`); default: the relay origin. */
  readonly webOrigin: string;
  /** `iss` the daemon accepts on identity tokens; default: the relay origin. */
  readonly identityIssuer: string;
  /** Keep the machine awake while hosting (caffeinate / systemd-inhibit). */
  readonly keepAwake: boolean;
  /** Settings used when state.json has none yet. */
  readonly defaultSettings: HostSettings;
  readonly timing: TimingConfig;
  readonly limits: LimitsConfig;
  readonly sessions: SessionLaunchConfig;
  readonly activity: ActivityConfig;
}

export interface DaemonConfigInput {
  readonly stateDir: string;
  readonly runDir?: string;
  readonly shareDir: string;
  readonly workspaceId: string;
  readonly hostUserId: string;
  readonly hostName: string;
  readonly workspaceName?: string;
  readonly relayUrl?: string | null;
  readonly webOrigin?: string;
  readonly identityIssuer?: string;
  readonly keepAwake?: boolean;
  readonly defaultSettings?: Partial<HostSettings>;
  readonly timing?: Partial<TimingConfig>;
  readonly limits?: Partial<LimitsConfig>;
  readonly sessions?: Partial<SessionLaunchConfig>;
  readonly activity?: Partial<ActivityConfig>;
}

export const DEFAULT_TIMING: TimingConfig = Object.freeze({
  relayPingIntervalMs: RELAY_PING_INTERVAL_MS,
  pongWatchdogMs: PONG_WATCHDOG_MS,
  presenceHeartbeatMs: PRESENCE_HEARTBEAT_INTERVAL_MS,
  handshakeDeadlineMs: HANDSHAKE_DEADLINE_MS,
  idleConnGraceMs: 5_000,
  reconnectBaseMs: 500,
  reconnectMaxMs: 30_000,
  reconnectJitter: 0.3,
  relayOpenTimeoutMs: 10_000,
  relayAuthRetryMs: 5 * 60_000,
  ackDelayMs: 250,
  ackEvery: 32,
  channelRetentionMs: 15 * 60_000,
  identityKeyRefreshMs: 10 * 60_000,
  identityKeyMinRefreshGapMs: 30_000,
  identityClockSkewMs: 60_000,
});

export const DEFAULT_LIMITS: LimitsConfig = Object.freeze({
  maxFailedHandshakesPerConn: MAX_FAILED_HANDSHAKES_PER_CONN,
  handshakesPerMinute: 120,
  memberHandshakesPerMinute: 120,
  handshakesPerUserPerMinute: 30,
  maxPendingHandshakes: 32,
  maxPendingHandshakesPerUser: 4,
  outboxMaxEntries: 20_000,
  outboxMaxBytes: 64 * 1024 * 1024,
  maxConnectionsPerUser: 16,
  maxProtocolErrorsPerConn: 50,
  maxDenialsPerConnPerMinute: 60,
  auditPageMax: 500,
  auditDeniedPerActorPerMinute: 120,
  auditMaxBytes: 32 * 1024 * 1024,
});

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`config ${name} must be a positive number`);
  return value;
}

function origin(name: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`config ${name} is not a URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError(`config ${name} must be http(s)`);
  return parsed.origin;
}

/**
 * Validates the input and fills in defaults. Throws on anything unusable instead of guessing (fail closed): a
 * relative state dir or share dir, an invalid workspace id, a malformed URL, a non-positive tunable. `machine` is the
 * host the daemon runs on (createDaemon's platform; tests name one): some defaults differ per platform.
 */
export function resolveConfig(input: DaemonConfigInput, machine: ResolveConfigEnvironment): DaemonConfig {
  if (!isAbsolute(input.stateDir)) throw new TypeError('config stateDir must be an absolute path');
  if (!isAbsolute(input.shareDir)) throw new TypeError('config shareDir must be an absolute path');
  if (input.runDir !== undefined && !isAbsolute(input.runDir)) throw new TypeError('config runDir must be an absolute path');
  if (!isWorkspaceId(input.workspaceId)) throw new TypeError('config workspaceId is not a valid workspace id');
  if (typeof input.hostUserId !== 'string' || input.hostUserId.length === 0) throw new TypeError('config hostUserId is required');
  if (typeof input.hostName !== 'string' || input.hostName.trim().length === 0) throw new TypeError('config hostName is required');
  const stateDir = resolve(input.stateDir);
  const relayUrl = input.relayUrl ? origin('relayUrl', input.relayUrl) : null;
  // No relay and no web origin (tests, a daemon without a relay link): invite links point at a reserved name that can
  // never resolve (RFC 2606 `.invalid`), never at a guessed public domain that would receive the invite secrets (CLI-12).
  const webOrigin = input.webOrigin ? origin('webOrigin', input.webOrigin) : (relayUrl ?? 'https://smurg.invalid');
  const identityIssuer = input.identityIssuer ? origin('identityIssuer', input.identityIssuer) : (relayUrl ?? webOrigin);
  const timing: TimingConfig = { ...DEFAULT_TIMING, ...input.timing };
  const limits: LimitsConfig = { ...DEFAULT_LIMITS, ...input.limits };
  for (const [key, value] of Object.entries(timing)) {
    if (key === 'reconnectJitter') {
      if (!(value >= 0 && value < 1)) throw new RangeError('config timing.reconnectJitter must be in [0, 1)');
    } else positive(`timing.${key}`, value);
  }
  for (const [key, value] of Object.entries(limits)) positive(`limits.${key}`, value);
  const defaultSettings = hostSettingsSchema.parse({ ...defaultHostSettings(), ...input.defaultSettings });
  const runDir = resolve(input.runDir ?? join(stateDir, 'run'));
  const sessions = resolveSessions(input.sessions ?? {}, relayUrl, machine.platform);
  const activity = resolveActivity(input.activity ?? {});
  return Object.freeze({
    stateDir,
    runDir,
    runPaths: Object.freeze(runPathsFor(runDir, input.workspaceId)),
    workspaceStateDir: join(stateDir, 'workspaces', input.workspaceId),
    shareDir: resolve(input.shareDir),
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName ?? null,
    hostUserId: input.hostUserId,
    hostName: input.hostName,
    relayUrl,
    webOrigin,
    identityIssuer,
    keepAwake: input.keepAwake ?? true,
    defaultSettings,
    timing: Object.freeze(timing),
    limits: Object.freeze(limits),
    sessions,
    activity,
  });
}

function resolveActivity(input: Partial<ActivityConfig>): ActivityConfig {
  const attributeBashEdits = input.attributeBashEdits ?? DEFAULT_ACTIVITY_CONFIG.attributeBashEdits;
  if (typeof attributeBashEdits !== 'boolean') throw new TypeError('config activity.attributeBashEdits must be a boolean');
  return Object.freeze({ attributeBashEdits });
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

function resolveSessions(input: Partial<SessionLaunchConfig>, relayUrl: string | null, platform: NodeJS.Platform): SessionLaunchConfig {
  const absoluteOrNull = (name: string, value: string | null | undefined): string | null => {
    if (value === undefined || value === null) return null;
    if (!isAbsolute(value)) throw new TypeError(`config sessions.${name} must be an absolute path`);
    return resolve(value);
  };
  const selfCommand = input.selfCommand ?? null;
  if (selfCommand !== null && (!isAbsolute(selfCommand.file) || !selfCommand.args.every((arg) => typeof arg === 'string'))) {
    throw new TypeError('config sessions.selfCommand must name an absolute executable');
  }
  const testGuestEnv = input.testGuestEnv ?? null;
  if (testGuestEnv !== null) {
    // A test seam must never reach a real deployment: only without a relay or with a local one.
    if (relayUrl !== null && !isLocalHostname(new URL(relayUrl).hostname)) throw new TypeError('config sessions.testGuestEnv is for tests with a local relay only');
    for (const [key, value] of Object.entries(testGuestEnv)) {
      if (!ENV_NAME.test(key) || typeof value !== 'string' || value.includes('\u0000')) throw new TypeError(`config sessions.testGuestEnv has an invalid entry ${key}`);
    }
  }
  const claudeMinVersion = input.claudeMinVersion ?? CLAUDE_MIN_VERSION;
  if (typeof claudeMinVersion !== 'string' || !VERSION.test(claudeMinVersion)) throw new TypeError('config sessions.claudeMinVersion must be MAJOR.MINOR.PATCH');
  const verifiedInput: readonly unknown[] = input.claudeVerifiedVersions ?? CLAUDE_VERIFIED_VERSIONS;
  if (!Array.isArray(verifiedInput) || verifiedInput.length === 0) throw new TypeError('config sessions.claudeVerifiedVersions must list at least one version');
  const verified = new Set<string>();
  for (const version of verifiedInput) {
    if (typeof version !== 'string' || !VERSION.test(version)) throw new TypeError('config sessions.claudeVerifiedVersions must hold MAJOR.MINOR.PATCH versions');
    verified.add(version);
  }
  const claudeVerifiedVersions = [...verified].sort(compareClaudeVersions);
  // A minimum above every verified version would leave only unverified versions that may start: a misconfiguration.
  if (compareClaudeVersions(claudeVerifiedVersions[claudeVerifiedVersions.length - 1] as string, claudeMinVersion) < 0) {
    throw new TypeError('config sessions.claudeMinVersion is newer than every verified version');
  }
  const guestSubscriptionLogin = input.guestSubscriptionLogin ?? true;
  if (typeof guestSubscriptionLogin !== 'boolean') throw new TypeError('config sessions.guestSubscriptionLogin must be a boolean');
  const guestMainWorkspace = input.guestMainWorkspace ?? defaultGuestMainWorkspace(platform);
  if (typeof guestMainWorkspace !== 'boolean') throw new TypeError('config sessions.guestMainWorkspace must be a boolean');
  return Object.freeze({
    hostHome: absoluteOrNull('hostHome', input.hostHome),
    claudePath: absoluteOrNull('claudePath', input.claudePath),
    claudeMinVersion,
    claudeVerifiedVersions: Object.freeze(claudeVerifiedVersions),
    selfCommand: selfCommand === null ? null : Object.freeze({ file: resolve(selfCommand.file), args: Object.freeze([...selfCommand.args]) }),
    testGuestEnv: testGuestEnv === null ? null : Object.freeze({ ...testGuestEnv }),
    guestSubscriptionLogin,
    guestMainWorkspace,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Claude Code version policy (ARCHITECTURE §7.6 "Claude Code version")
// ---------------------------------------------------------------------------------------------------------------------

/** MAJOR.MINOR.PATCH, each part a plain decimal of at most 9 digits (safe integers, no leading "v", no pre-release). */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** Numeric comparison of two MAJOR.MINOR.PATCH strings (negative: a is older). Both must match VERSION. */
export function compareClaudeVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The version `claude --version` prints first ("2.1.283 (Claude Code)"), or null when its output does not start with a
 * plain MAJOR.MINOR.PATCH. A pre-release ("2.1.300-beta.1") is not recognised: it is refused like any output the
 * daemon cannot read (fail closed), because a pre-release sorts before its release.
 */
export function parseClaudeVersion(output: string): string | null {
  const match = /^\s*(\S+?)(?:\s|\(|$)/.exec(output);
  const candidate = match?.[1];
  return candidate !== undefined && VERSION.test(candidate) ? candidate : null;
}

export type ClaudeVersionVerdict =
  /** One of claudeVerifiedVersions: start without a note. */
  | { readonly ok: true; readonly version: string; readonly warning: null }
  /**
   * Accepted but not verified: start, and warn the host (log) and the session owner. `newer-than-verified`: newer
   * than every verified version (Claude Code updates itself; an update must not lock anyone out). `unverified`: at
   * least the minimum but not listed (between two verified versions).
   */
  | { readonly ok: true; readonly version: string; readonly warning: 'newer-than-verified' | 'unverified' }
  /** Refuse guest sessions (fail closed). `unrecognized`: `claude --version` printed no version we can read. */
  | { readonly ok: false; readonly version: string | null; readonly reason: 'below-minimum' | 'unrecognized' };

/**
 * Decides what a session may do with the `claude` whose `--version` printed `versionOutput`. The caller refuses a
 * guest session on `ok: false`; a host session (the host's own, unsandboxed CLI) is not refused but gets the warning.
 */
export function claudeVersionVerdict(
  versionOutput: string,
  policy: Pick<SessionLaunchConfig, 'claudeMinVersion' | 'claudeVerifiedVersions'>,
): ClaudeVersionVerdict {
  const version = parseClaudeVersion(versionOutput);
  if (version === null) return { ok: false, version: null, reason: 'unrecognized' };
  if (compareClaudeVersions(version, policy.claudeMinVersion) < 0) return { ok: false, version, reason: 'below-minimum' };
  if (policy.claudeVerifiedVersions.some((verified) => compareClaudeVersions(verified, version) === 0)) return { ok: true, version, warning: null };
  const newest = policy.claudeVerifiedVersions.reduce((a, b) => (compareClaudeVersions(a, b) >= 0 ? a : b), policy.claudeMinVersion);
  return { ok: true, version, warning: compareClaudeVersions(version, newest) > 0 ? 'newer-than-verified' : 'unverified' };
}

/** Silence threshold the clients use; exported so tests can relate the heartbeat to it. */
export const CLIENT_SILENCE_THRESHOLD_MS = CLIENT_OFFLINE_THRESHOLD_MS;
