// SessionManager (R4, R2 kick, R11; ARCHITECTURE §5.5, §7.6, §11 D-3 / D-9). Owns every PTY session of the daemon:
// launch (host: unsandboxed, the host's environment; runner: sandboxed, an allow-list environment, a guest dir),
// fan-out to attached viewers, owner-only input and resize, login state, ending (killTree), guest-dir lifecycle.
//
// Sandboxing is decided by the caller's ROLE (host → unsandboxed, runner → srt), never by the client. A guest session
// that cannot be sandboxed (preflight, wrap, Claude Code version) is refused with `sandbox_unavailable`, audited as
// `sandbox.refused`, and nothing is spawned. The guest's own API key lives only in this process's memory and in that
// PTY's environment: never persisted, logged or audited.
//
// Sessions of kind 'login' (ARCHITECTURE §11 D-12, login.ts): a guest's own Claude subscription login, the fixed
// `claude auth login` in that guest's sandbox (mode 'login'). Private to their owner: not in list() / get() (so no
// other module, member or MCP tool sees them), session.state goes to the owner only, only the owner attaches, and no
// bus event names them. Their output is never logged or audited; start and outcome (exit code only) are.
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  EXEC_OUTPUT_MAX_BYTES,
  LIST_MAX_ITEMS,
  SmurgError,
  can,
  rootRefKey,
  type Actor,
  type LoginState,
  type PayloadOf,
  type ResultInputOf,
  type RootRef,
  type SessionInfo,
  type SessionKind,
  type SessionStatus,
} from '@smurg/protocol';
import { claudeVersionVerdict, type SessionLaunchConfig } from '../core/config.ts';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type {
  ClientConnection,
  HookSessionCredentials,
  MemberRecord,
  PersistentDocument,
  Principal,
  SandboxSpec,
  SessionAttachStart,
  SessionManager,
  UserId,
  WrappedCommand,
} from '../core/interfaces.ts';
import { SYSTEM_ACTOR, agentDisplayName } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { ClaudeVersionProbe, LoginHintDetector, parseAuthStatus, resolveClaude, type ClaudeBinary } from './claude.ts';
import { assertGuestEnv, buildGuestEnv, buildHostEnv, claudeDirOf, withTestGuestEnv } from './guest-env.ts';
import { GuestStore, guestKeyOf, readGuestFile, writeGuestFileAtomic, type GuestPaths } from './guest-store.ts';
import { validateImport, writeImport } from './import-config.ts';
import { KeyedLock } from './keyed-lock.ts';
import { killTree, rememberDescendants, systemProcessInspector, type KillTreeResult, type KnownProcess, type ProcessInspector, type ProcessRow } from './kill-tree.ts';
import { apiKeyApprovalSuffix, mergeClaudeJson, removeSessionFiles } from './launch-files.ts';
import { LOGIN_EXITED_RETENTION_MS, LOGIN_MAX_MS, LOGIN_MESSAGES, buildLoginSandboxSpec, loginCommand } from './login.ts';
import { runProcess, runningHelperPids, type ProcessRunner } from './process-run.ts';
import { PtySession, type PtyExit, type ViewerSink } from './pty-session.ts';
import { buildSandboxSpec, guestCommand } from './sandbox-spec.ts';

export type SessionEndReason = 'exit' | 'ended' | 'terminated' | 'kicked' | 'left' | 'role-changed' | 'stopped';

/** Seams for tests and for the composition (the default module passes none). */
export interface SessionsModuleOptions {
  /** The host's environment (default: process.env, read at each session start). */
  readonly hostEnv?: () => Readonly<Record<string, string | undefined>>;
  /** Overrides of config.sessions launch inputs (tests: a fake `claude`, a hook command). */
  readonly launch?: Partial<Pick<SessionLaunchConfig, 'claudePath' | 'selfCommand' | 'claudeMinVersion' | 'claudeVerifiedVersions'>>;
  /** Shells (default: the host's $SHELL, else /bin/zsh, /bin/bash, /bin/sh). */
  readonly hostShell?: string;
  readonly guestShell?: string;
  readonly inspector?: ProcessInspector;
  readonly runner?: ProcessRunner;
  /**
   * Host-side deletion of the keychain items derived from a guest's config dir (claude-hooks.md §5.3; macOS only).
   * Default: `/usr/bin/security delete-generic-password`. Tests pass a recorder: they never touch the real keychain.
   */
  readonly keychain?: (services: readonly string[], account: string) => Promise<void>;
  readonly limits?: Partial<SessionLimits>;
}

export interface SessionLimits {
  readonly maxSessionsPerUser: number;
  readonly maxSessions: number;
  /** killTree budget per session (R2: 3 s for the whole kick). */
  readonly killDeadlineMs: number;
  readonly maxPidsPerSession: number;
  /** An exited session (and its mirror, for late viewers) is kept this long. */
  readonly exitedRetentionMs: number;
  /** Guest dirs of members not seen for this long are removed (§11 D-9: 7 days). */
  readonly guestRetentionMs: number;
  readonly guestSweepIntervalMs: number;
  /** `claude auth logout` before a guest dir is removed (best effort). */
  readonly logoutTimeoutMs: number;
  readonly authStatusTimeoutMs: number;
  /** A login session (D-12) ends after this even if `claude auth login` is still waiting. */
  readonly loginMaxMs: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = Object.freeze({
  maxSessionsPerUser: 8,
  maxSessions: 64,
  killDeadlineMs: 2_500,
  maxPidsPerSession: 512,
  exitedRetentionMs: 15 * 60_000,
  guestRetentionMs: 7 * 24 * 60 * 60_000,
  guestSweepIntervalMs: 24 * 60 * 60_000,
  logoutTimeoutMs: 1_000,
  authStatusTimeoutMs: 15_000,
  loginMaxMs: LOGIN_MAX_MS,
});

interface LaunchContext {
  readonly claude: ClaudeBinary | null;
  /** The session's exact environment (guests: before srt's wrapping; holds the guest's apiKey: memory only). */
  env: Record<string, string> | null;
  readonly cwd: string;
  readonly tmpDir: string | null;
  /** Guests: the spec every helper process (auth status) is wrapped with, minus the command. */
  readonly spec: Omit<SandboxSpec, 'command'> | null;
}

interface Managed {
  readonly id: string;
  readonly kind: SessionKind;
  readonly ownerUserId: UserId;
  readonly ownerName: string;
  readonly sandboxed: boolean;
  readonly root: RootRef;
  readonly worktreeId: string | null;
  readonly createdAt: number;
  readonly title: string;
  readonly pty: PtySession;
  readonly settingsDir: string | null;
  readonly hookRegistered: boolean;
  presence: boolean;
  status: SessionStatus;
  exitCode: number | undefined;
  endedAt: number | undefined;
  login: LoginState;
  launch: LaunchContext | null;
  ending: Promise<void> | null;
  endReason: SessionEndReason | null;
  /** Who ended it on purpose (the owner's 「結束」, the host's terminate): shown to the owner (review WEB-12). */
  endedBy: { readonly userId: UserId; readonly displayName: string } | null;
  cleaned: boolean;
  loginCheck: Promise<LoginState> | null;
  loginHintTimer: ReturnType<typeof setTimeout> | undefined;
  retentionTimer: ReturnType<typeof setTimeout> | undefined;
  /** kind 'login': ends the login process after limits.loginMaxMs. */
  loginTimer: ReturnType<typeof setTimeout> | undefined;
  readonly hints: LoginHintDetector | null;
  /**
   * Descendants of the PTY child seen by the periodic scan (pid → start time). A natural `exit` reparents background
   * jobs to init before node-pty reports it, and on macOS `ps -E` hides the environment of Apple platform binaries
   * (pty-packaging.md gotcha 9): without this, a guest's `nohup … &` + `exit` would leave a job in the sandbox. Kept
   * for every session (also persisted, REL-09), so a daemon that died hard can end them at its next start.
   */
  known: Map<number, KnownProcess>;
  /** Digest list of the processes last written to live.json (unchanged scans write nothing). */
  persistedProcs: string;
}

const LIVE_DOCUMENT = 'sessions';
const SESSION_ID = /^ses_[0-9a-f]{32}$/;
/** A process of a live session as last seen: its pid and a digest of its identity (start time + command line). */
const liveProcessSchema = z.strictObject({ pid: z.int().min(2).max(2 ** 31), id: z.string().regex(/^[0-9a-f]{64}$/) });
const liveDocumentSchema = z.strictObject({
  live: z.array(z.string().regex(SESSION_ID)).max(4096),
  /**
   * Review REL-09: the processes of each live session (the PTY child and its descendants), refreshed every 2 s. A
   * daemon that died hard (SIGKILL, OOM, crash) could not end its sessions: the next start ends what is still there,
   * identity-checked (pid + start time + command line) like every kill (§7.6), never by predicate.
   */
  procs: z.record(z.string().regex(SESSION_ID), z.array(liveProcessSchema).max(512)).optional(),
});
type LiveDocument = z.infer<typeof liveDocumentSchema>;
/** Sessions of a crashed run whose leftovers are looked for at start (bounded work before the daemon is up). */
const MAX_LEFTOVER_SESSIONS = 64;

/** Digest of a process identity (identityOf): what live.json keeps instead of whole command lines. */
function identityDigest(start: string, command: string): string {
  return createHash('sha256').update(`${start}\u0000${command}`, 'utf8').digest('hex');
}

const CLAUDE_JSON_MAX_BYTES = 16 * 1024 * 1024;
const OUTPUT_PIECE = Math.min(EXEC_OUTPUT_MAX_BYTES, 1024 * 1024);
const LOGIN_HINT_DEBOUNCE_MS = 1_500;
const DESCENDANT_SCAN_MS = 2_000;
/** Exited sessions kept for late viewers (the retention timer drops them earlier). */
const MAX_EXITED_RETAINED = 32;

function sessionError(code: 'bad_request' | 'not_found' | 'conflict' | 'internal', message: string, reason: string): SmurgError {
  return new SmurgError(code, message, { reason });
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export class SessionManagerImpl implements SessionManager {
  private readonly ctx: DaemonContext;
  private readonly options: SessionsModuleOptions;
  private readonly limits: SessionLimits;
  private readonly launchConfig: SessionLaunchConfig;
  private readonly inspector: ProcessInspector;
  private readonly runner: ProcessRunner;
  private readonly sessions = new Map<string, Managed>();
  private readonly userLock = new KeyedLock();
  /** Bumped by killAllForUser: a creation in flight for that user must not spawn (or must die right after). */
  private readonly userEpochs = new Map<UserId, number>();
  private readonly creating = new Map<UserId, number>();
  /** Guests whose login session is being started (one at a time per guest, D-12). */
  private readonly loginStarting = new Set<UserId>();
  private store: GuestStore | null = null;
  private sessionsDir: string | null = null;
  private liveDoc: PersistentDocument<LiveDocument> | null = null;
  private versionProbe: ClaudeVersionProbe | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private trackTimer: ReturnType<typeof setInterval> | undefined;
  private tracking = false;
  private stopping = false;
  private started = false;

  constructor(ctx: DaemonContext, options: SessionsModuleOptions = {}) {
    this.ctx = ctx;
    this.options = options;
    this.limits = { ...DEFAULT_SESSION_LIMITS, ...options.limits };
    this.launchConfig = { ...ctx.config.sessions, ...options.launch };
    this.inspector = options.inspector ?? systemProcessInspector();
    this.runner = options.runner ?? runProcess;
  }

  // =================================================================================================================
  // Lifecycle (module start / stop)
  // =================================================================================================================

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const stateDir = this.ctx.config.stateDir;
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(join(stateDir, 'sessions'), { recursive: true, mode: 0o700 });
    // Real paths: the sandbox matches resolved paths (settings dirs are read-only carve-outs).
    this.sessionsDir = await realpath(join(stateDir, 'sessions'));
    this.versionProbe = new ClaudeVersionProbe({ scratchParent: this.sessionsDir, run: this.runner });
    this.store = await GuestStore.open(stateDir, this.ctx.config.workspaceId);
    this.liveDoc = await this.ctx.state.document(LIVE_DOCUMENT, liveDocumentSchema, () => ({ live: [] }));
    // Sessions never survive the daemon: what a run that died hard left behind (its sessions' processes, REL-09;
    // settings dirs and version-probe scratch dirs) goes now.
    await this.endLeftovers(this.liveDoc.get()).catch((err: unknown) => this.logError('ending the processes of a previous run failed', err));
    for (const id of this.liveDoc.get().live) await removeSessionFiles(join(this.sessionsDir, id)).catch(() => {});
    for (const name of await readdir(this.sessionsDir).catch(() => [] as string[])) {
      if (name.startsWith('.probe-')) await removeSessionFiles(join(this.sessionsDir, name)).catch(() => {});
    }
    this.liveDoc.update((draft) => {
      draft.live = [];
      delete draft.procs;
    });
    await this.store.sweepLeftovers().catch((err: unknown) => this.logError('guest leftover sweep failed', err));
    await this.sweepGuestDirs().catch((err: unknown) => this.logError('guest retention sweep failed', err));
    this.sweepTimer = setInterval(() => {
      void this.sweepGuestDirs().catch((err: unknown) => this.logError('guest retention sweep failed', err));
    }, this.limits.guestSweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * The previous daemon died without ending its sessions (a graceful stop leaves live.json empty). Everything positively
   * tied to one of its sessions is ended: processes it recorded (identity-checked against the digest) and processes
   * carrying the session's SMURG_SESSION_ID. killTree re-validates every candidate and signals nothing else.
   */
  private async endLeftovers(doc: Readonly<LiveDocument>): Promise<void> {
    const ids = doc.live.slice(0, MAX_LEFTOVER_SESSIONS);
    if (ids.length === 0) return;
    const rows = await this.inspector.table();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    for (const id of ids) {
      const known = new Map<number, KnownProcess>();
      for (const entry of doc.procs?.[id] ?? []) {
        const row = byPid.get(entry.pid);
        if (row?.start !== undefined && row.command !== undefined && identityDigest(row.start, row.command) === entry.id) known.set(entry.pid, { start: row.start, command: row.command });
      }
      const result = await killTree(
        { rootPid: () => null, envEntry: `SMURG_SESSION_ID=${id}`, known, protect: () => new Set(runningHelperPids()) },
        { inspector: this.inspector, log: this.ctx.log.child({ module: 'kill-tree', session: id }), deadlineMs: this.limits.killDeadlineMs, maxPids: this.limits.maxPidsPerSession },
      );
      if (result.killed.length > 0 || result.outcome !== 'done') {
        this.ctx.log.warn('ended processes a previous daemon run left behind', { session: id, killed: result.killed.length, outcome: result.outcome });
      }
    }
  }

  /** stop(): end every session and remove every guest dir (`smurg stop`: no guest credential stays behind). */
  async stopAll(): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    if (this.trackTimer !== undefined) clearInterval(this.trackTimer);
    this.trackTimer = undefined;
    await Promise.all([...this.sessions.values()].map((m) => this.finish(m, 'stopped', true)));
    const store = this.store;
    if (store) {
      const byKey = this.membersByGuestKey();
      await Promise.all(
        (await store.keys()).map(async (key) => {
          const member = byKey.get(key);
          if (member) await this.removeGuestDirNow(member.userId).catch((err: unknown) => this.logError('guest dir removal failed', err));
          else await store.removeKey(key).catch((err: unknown) => this.logError('guest dir removal failed', err));
        }),
      );
    }
    for (const m of this.sessions.values()) {
      if (m.retentionTimer !== undefined) clearTimeout(m.retentionTimer);
      if (m.loginHintTimer !== undefined) clearTimeout(m.loginHintTimer);
      if (m.loginTimer !== undefined) clearTimeout(m.loginTimer);
      m.pty.dispose();
    }
    this.sessions.clear();
    await this.liveDoc?.flush().catch(() => {});
  }

  // =================================================================================================================
  // Queries
  // =================================================================================================================

  /** Every agent / terminal session (login sessions are private to their owner: listFor). */
  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((m) => m.kind !== 'login')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-LIST_MAX_ITEMS)
      .map((m) => this.info(m));
  }

  /** session.list for one member: every agent / terminal session, plus that member's own login sessions. */
  listFor(userId: UserId | null): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((m) => m.kind !== 'login' || (userId !== null && m.ownerUserId === userId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-LIST_MAX_ITEMS)
      .map((m) => this.info(m));
  }

  /** An agent / terminal session (a login session is nobody else's business: null). */
  get(sessionId: string): SessionInfo | null {
    const m = this.sessions.get(sessionId);
    return m && m.kind !== 'login' ? this.info(m) : null;
  }

  agentActor(sessionId: string): Actor | null {
    const m = this.sessions.get(sessionId);
    if (!m || m.kind !== 'agent') return null;
    return { kind: 'agent', sessionId: m.id, ownerUserId: m.ownerUserId, displayName: agentDisplayName(m.ownerName) };
  }

  /** Where a guest's dir lives (tests, diagnostics). */
  guestPaths(userId: UserId): GuestPaths {
    return this.requireStore().pathsFor(userId);
  }

  /** Pid of the PTY child while it runs (tests, diagnostics). */
  ptyPid(sessionId: string): number | null {
    const m = this.sessions.get(sessionId);
    return m && m.pty.running ? m.pty.pid : null;
  }

  /** Absolute output offset of a session so far (tests, diagnostics). */
  outputOffset(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.pty.offset ?? null;
  }

  private info(m: Managed): SessionInfo {
    return {
      id: m.id,
      kind: m.kind,
      ownerUserId: m.ownerUserId,
      ownerName: m.ownerName,
      title: m.title,
      sandboxed: m.sandboxed,
      root: m.root,
      status: m.status,
      ...(m.exitCode !== undefined ? { exitCode: m.exitCode } : {}),
      cols: m.pty.cols,
      rows: m.pty.rows,
      createdAt: m.createdAt,
      ...(m.endedAt !== undefined ? { endedAt: m.endedAt } : {}),
      // Why it ended and who ended it (review WEB-12: a session the host terminated must not read like a normal exit).
      ...(m.status === 'exited' && m.endReason !== null ? { endReason: m.endReason } : {}),
      ...(m.status === 'exited' && m.endedBy !== null ? { endedBy: { userId: m.endedBy.userId, displayName: m.endedBy.displayName } } : {}),
      login: m.login,
      attached: m.pty.viewerCount,
    };
  }

  private publish(m: Managed, event: 'created' | 'updated'): void {
    const session = this.info(m);
    if (m.kind === 'login') {
      this.ctx.hub.sendToUser(m.ownerUserId, 'session.state', { session });
      return;
    }
    if (event === 'created') this.ctx.bus.emit('session.created', { session });
    else this.ctx.bus.emit('session.updated', { session });
    this.ctx.hub.broadcast('session.state', { session });
  }

  // =================================================================================================================
  // Create
  // =================================================================================================================

  async create(input: PayloadOf<'session.create'>, _conn: ClientConnection, principal: Principal): Promise<SessionInfo> {
    const userId = principal.userId;
    const member = userId !== null && principal.kind === 'user' ? this.ctx.members.active(userId) : null;
    if (!member || userId === null) throw new AuthorizationError(undefined, { reason: 'not-a-member' });
    // The ROLE decides the sandbox (ARCHITECTURE §5.5): a client can never choose it.
    let sandboxed: boolean;
    if (can(member.role, 'session.create.host')) sandboxed = false;
    else if (can(member.role, 'session.create.sandboxed')) sandboxed = true;
    else throw new AuthorizationError(undefined, { reason: 'capability' });
    if (input.kind === 'login') this.checkLoginRequest(input, member, sandboxed);
    if (input.apiKey !== undefined && !sandboxed) throw sessionError('bad_request', 'API key 只用於客人的沙盒 session', 'api-key-sandboxed-only');
    if (this.stopping || !this.started) throw sessionError('conflict', 'daemon 正在停止', 'stopping');
    const running = [...this.sessions.values()].filter((m) => m.status !== 'exited');
    if (running.length + this.inFlight() >= this.limits.maxSessions) throw sessionError('conflict', 'session 數量已達上限', 'session-limit');
    if (running.filter((m) => m.ownerUserId === userId).length + (this.creating.get(userId) ?? 0) >= this.limits.maxSessionsPerUser) {
      throw sessionError('conflict', '你的 session 數量已達上限', 'session-limit');
    }
    this.creating.set(userId, (this.creating.get(userId) ?? 0) + 1);
    try {
      if (input.kind === 'login') return await this.launchLogin(input, member);
      return await this.launch(input, member, sandboxed);
    } finally {
      const left = (this.creating.get(userId) ?? 1) - 1;
      if (left <= 0) this.creating.delete(userId);
      else this.creating.set(userId, left);
    }
  }

  private inFlight(): number {
    let total = 0;
    for (const count of this.creating.values()) total += count;
    return total;
  }

  // =================================================================================================================
  // The guest's Claude subscription login (kind 'login', ARCHITECTURE §11 D-12; login.ts)
  // =================================================================================================================

  /**
   * Who may start a login and with what: the switch (config.sessions.guestSubscriptionLogin), guests only (the host's
   * Claude is not sandboxed), the main workspace only, no API key, one at a time. A refusal is audited.
   */
  private checkLoginRequest(input: PayloadOf<'session.create'>, member: MemberRecord, sandboxed: boolean): void {
    const refuse = (code: 'forbidden' | 'bad_request' | 'conflict', message: string, reason: string): SmurgError => {
      this.ctx.audit.record({
        actor: { kind: 'user', userId: member.userId, displayName: member.displayName },
        action: 'session.create',
        outcome: 'denied',
        target: 'login',
        detail: { kind: 'login', reason },
      });
      return new SmurgError(code, message, { reason });
    };
    if (!this.launchConfig.guestSubscriptionLogin) throw refuse('forbidden', LOGIN_MESSAGES.switchedOff, 'guest-subscription-login-off');
    if (!sandboxed) throw refuse('forbidden', LOGIN_MESSAGES.guestsOnly, 'login-guests-only');
    if (input.workspace.mode !== 'main') throw refuse('bad_request', LOGIN_MESSAGES.mainOnly, 'login-main-only');
    if (input.apiKey !== undefined) throw refuse('bad_request', LOGIN_MESSAGES.noApiKey, 'login-no-api-key');
    const running = [...this.sessions.values()].some((m) => m.kind === 'login' && m.ownerUserId === member.userId && m.status !== 'exited');
    if (running || this.loginStarting.has(member.userId)) throw refuse('conflict', LOGIN_MESSAGES.running, 'login-running');
  }

  /**
   * Starts `claude auth login` for `member` in their sandbox (mode 'login'). Nothing of the request reaches the
   * process except the terminal size: the command, its arguments, its environment and its directory are the daemon's.
   */
  private async launchLogin(input: PayloadOf<'session.create'>, member: MemberRecord): Promise<SessionInfo> {
    const ctx = this.ctx;
    const userId = member.userId;
    this.loginStarting.add(userId);
    const epoch = this.userEpochs.get(userId) ?? 0;
    const id = `ses_${randomBytes(16).toString('hex')}`;
    const undo: (() => Promise<void> | void)[] = [];
    const refuseSandbox = (reason: string, detail: Record<string, unknown> = {}): SmurgError => {
      ctx.audit.record({ actor: { kind: 'user', userId, displayName: member.displayName }, action: 'sandbox.refused', outcome: 'denied', target: id, detail: { reason, kind: 'login', ...detail } });
      return new SmurgError('sandbox_unavailable', '無法啟動客人沙盒，已拒絕開啟登入程序', { reason, ...detail });
    };
    const aborted = (): boolean => this.stopping || (this.userEpochs.get(userId) ?? 0) !== epoch || ctx.members.active(userId) === null;
    try {
      let preflight;
      try {
        preflight = await ctx.services.sandbox.preflight();
      } catch (err) {
        throw refuseSandbox('preflight-error', { error: err instanceof SmurgError ? err.code : 'unknown' });
      }
      if (!preflight.ok) throw refuseSandbox(preflight.reason);
      const hostEnv = this.hostEnv();
      const claude = await resolveClaude(this.launchConfig.claudePath, hostEnv['PATH']);
      if (!claude) throw refuseSandbox('claude-not-found');
      const verdict = claudeVersionVerdict(await this.requireProbe().output(claude), this.launchConfig);
      if (!verdict.ok) throw refuseSandbox('claude-version', { version: verdict.version ?? 'unrecognized', minimum: this.launchConfig.claudeMinVersion });
      if (verdict.warning !== null) this.warnVersion(member, verdict.version, verdict.warning);
      // The daemon-owned working directory (read-only inside): no `.claude/` a guest could plant settings in.
      const settingsDir = join(this.requireSessionsDir(), id);
      this.liveDoc?.update((draft) => {
        draft.live.push(id);
      });
      undo.push(() => this.forgetLive(id));
      undo.push(() => removeSessionFiles(settingsDir));
      await mkdir(settingsDir, { mode: 0o700 });
      const m = await this.userLock.run(userId, async (): Promise<Managed> => {
        const guest = await this.prepareGuestDir(userId, null);
        const browser = (await isExecutable('/usr/bin/true')) ? '/usr/bin/true' : '/bin/true';
        const env = buildGuestEnv({
          home: guest.home,
          configDir: guest.cfg,
          tmpDir: guest.tmp,
          hostEnv,
          claudeDir: claudeDirOf(claude.realPath),
          shell: '/bin/sh',
          browser,
          sessionId: id,
        });
        assertGuestEnv(env, { apiKeyAllowed: false });
        withTestGuestEnv(env, this.launchConfig.testGuestEnv);
        const spec = buildLoginSandboxSpec({
          sessionId: id,
          command: loginCommand({ tmpDir: guest.tmp, cwd: settingsDir, claude: claude.realPath, browser }),
          guestDir: guest.root,
          guestHome: guest.home,
          settingsDir,
          claudeRealPath: claude.realPath,
          hookSocketPath: ctx.config.runPaths.hook,
          env,
          programs: [claude.realPath, browser, ...((await isExecutable('/usr/bin/security')) ? ['/usr/bin/security'] : [])],
        });
        let wrapped: WrappedCommand;
        try {
          wrapped = await ctx.services.sandbox.wrap(spec);
        } catch (err) {
          if (err instanceof SmurgError && err.code === 'sandbox_unavailable') throw err;
          throw refuseSandbox('wrap-failed', { error: err instanceof SmurgError ? err.code : 'unknown' });
        }
        let managed: Managed | null = null;
        let pty: PtySession;
        try {
          this.assertWrapped(wrapped, false);
          if (aborted()) throw new AuthorizationError(undefined, { reason: 'owner-removed' });
          pty = new PtySession({
            ownerUserId: userId,
            spawn: { file: wrapped.file, args: [...wrapped.args], cwd: wrapped.cwd, env: { ...wrapped.env }, cols: input.cols, rows: input.rows },
            log: ctx.log.child({ module: 'pty', session: id }),
            onResize: () => {
              if (managed) this.publish(managed, 'updated');
            },
            onExit: (exit) => {
              this.releaseWrapped(wrapped);
              if (managed) this.onPtyExit(managed, exit);
            },
          });
        } catch (err) {
          this.releaseWrapped(wrapped); // never started
          throw err;
        }
        managed = this.newManaged({ id, kind: 'login', member, sandboxed: true, root: { kind: 'main' }, worktreeId: null, title: `Claude 訂閱登入（${member.displayName}）`, pty, settingsDir, hookRegistered: false });
        managed.launch = { claude, env, cwd: settingsDir, tmpDir: guest.tmp, spec: null };
        return managed;
      });
      this.sessions.set(m.id, m);
      undo.length = 0;
      if (aborted()) {
        await this.finish(m, 'kicked', true);
        throw new AuthorizationError(undefined, { reason: 'owner-removed' });
      }
      m.loginTimer = setTimeout(() => void this.finish(m, 'terminated', true), this.limits.loginMaxMs);
      m.loginTimer.unref?.();
      ctx.audit.record({ actor: { kind: 'user', userId, displayName: member.displayName }, action: 'session.create', outcome: 'ok', target: m.id, detail: { sessionId: m.id, kind: 'login', sandboxed: true } });
      this.publish(m, 'created');
      this.ensureDescendantTracking();
      return this.info(m);
    } catch (err) {
      for (const step of undo.reverse()) {
        try {
          await step();
        } catch (stepErr) {
          this.logError('login rollback step failed', stepErr);
        }
      }
      throw err;
    } finally {
      this.loginStarting.delete(userId);
    }
  }

  private async launch(input: PayloadOf<'session.create'>, member: MemberRecord, sandboxed: boolean): Promise<SessionInfo> {
    const ctx = this.ctx;
    const userId = member.userId;
    const epoch = this.userEpochs.get(userId) ?? 0;
    const id = `ses_${randomBytes(16).toString('hex')}`;
    const kind = input.kind;
    const undo: (() => Promise<void> | void)[] = [];
    const rollback = async (): Promise<void> => {
      for (const step of undo.reverse()) {
        try {
          await step();
        } catch (err) {
          this.logError('session rollback step failed', err);
        }
      }
    };
    const refuseSandbox = (reason: string, detail: Record<string, unknown> = {}): SmurgError => {
      ctx.audit.record({ actor: { kind: 'user', userId, displayName: member.displayName }, action: 'sandbox.refused', outcome: 'denied', target: id, detail: { reason, kind, ...detail } });
      return new SmurgError('sandbox_unavailable', '無法啟動客人沙盒，已拒絕開啟 session', { reason, ...detail });
    };
    const aborted = (): boolean => this.stopping || (this.userEpochs.get(userId) ?? 0) !== epoch || ctx.members.active(userId) === null;

    try {
      // 1. The sandbox first: nothing is prepared or spawned for a guest the daemon cannot confine.
      if (sandboxed) {
        let preflight;
        try {
          preflight = await ctx.services.sandbox.preflight();
        } catch (err) {
          throw refuseSandbox('preflight-error', { error: err instanceof SmurgError ? err.code : 'unknown' });
        }
        if (!preflight.ok) throw refuseSandbox(preflight.reason);
      }

      // 2. The root: the main share, or the session's worktree (the WorktreeManager registers it as a root).
      let root: RootRef = { kind: 'main' };
      let rootPath = ctx.roots.main.realPath;
      let worktreeId: string | null = null;
      let sharedLinks = ctx.roots.main.sharedLinks;
      if (input.workspace.mode === 'worktree') {
        const principal = ctx.members.principalOf(userId);
        if (!principal) throw new AuthorizationError(undefined, { reason: 'not-a-member' });
        const handle = await ctx.services.worktrees.acquireForSession({
          owner: principal,
          sessionId: id,
          ...(input.workspace.worktreeId !== undefined ? { worktreeId: input.workspace.worktreeId } : {}),
        });
        worktreeId = handle.worktree.id;
        const acquired = worktreeId;
        undo.push(() => ctx.services.worktrees.releaseFromSession(acquired, id, { keep: true }));
        root = handle.root.ref;
        rootPath = handle.root.realPath;
        sharedLinks = handle.root.sharedLinks;
      }

      // 3. The claude binary and its version (agent sessions; guest terminals only use it for PATH).
      const hostEnv = this.hostEnv();
      let claude: ClaudeBinary | null = null;
      if (kind === 'agent') {
        claude = await resolveClaude(this.launchConfig.claudePath, hostEnv['PATH']);
        if (!claude) {
          if (sandboxed) throw refuseSandbox('claude-not-found');
          throw sessionError('not_found', '找不到 claude 指令', 'claude-not-found');
        }
        const output = await this.requireProbe().output(claude);
        const verdict = claudeVersionVerdict(output, this.launchConfig);
        if (!verdict.ok) {
          if (sandboxed) throw refuseSandbox('claude-version', { version: verdict.version ?? 'unrecognized', minimum: this.launchConfig.claudeMinVersion });
          this.warnVersion(member, verdict.version, 'below-minimum');
        } else if (verdict.warning !== null) {
          this.warnVersion(member, verdict.version, verdict.warning);
        }
      } else if (sandboxed) {
        claude = await resolveClaude(this.launchConfig.claudePath, hostEnv['PATH']).catch(() => null);
      }

      // 4. Hooks (agent sessions): the per-session token and the daemon-owned launch files.
      let hookEnv: Readonly<Record<string, string>> = {};
      let hookRegistered = false;
      /** A dir under <stateDir>/sessions this module created (removed when the session ends). */
      let settingsDir: string | null = null;
      /** The session's daemon-owned launch dir (the sandbox's read-only settingsDir). */
      let launchDir: string | null = null;
      let claudeArgs: string[] = [];
      const self = this.launchConfig.selfCommand;
      const ownDir = async (): Promise<string> => {
        const dir = join(this.requireSessionsDir(), id);
        this.liveDoc?.update((draft) => {
          draft.live.push(id);
        });
        undo.push(() => this.forgetLive(id));
        undo.push(() => removeSessionFiles(dir));
        return dir;
      };
      if (kind === 'agent') {
        if (self === null) throw sessionError('internal', 'smurg hook 未設定，無法啟動 agent session', 'hooks-unavailable');
        let credentials: HookSessionCredentials;
        try {
          credentials = ctx.services.hooks.registerSession({ sessionId: id, ownerUserId: userId, agentName: agentDisplayName(member.displayName), root, sandboxed });
        } catch (err) {
          this.logError('hook registration failed', err);
          throw sessionError('internal', 'hook 服務無法使用，無法啟動 agent session', 'hooks-unavailable');
        }
        hookRegistered = true;
        undo.push(() => ctx.services.hooks.unregisterSession(id));
        hookEnv = credentials.env;
        if (hookEnv['SMURG_SESSION_ID'] !== undefined && hookEnv['SMURG_SESSION_ID'] !== id) ctx.log.warn('hook env names another session; using ours', { session: id });
        // The hooks module is the one writer of the launch files (ARCHITECTURE §7.6); it removes them on unregister.
        let written: unknown;
        try {
          written = await ctx.services.hooks.writeSessionFiles(id);
        } catch (err) {
          this.logError('hook launch files could not be written', err);
          throw sessionError('internal', 'hook 設定檔無法寫入，無法啟動 agent session', 'hooks-unavailable');
        }
        const files = await this.checkedLaunchFiles(written, sandboxed);
        launchDir = files.dir;
        claudeArgs = files.claudeArgs;
      }
      if (sandboxed && launchDir === null) {
        // Terminals have no launch files, but the sandbox wants an existing daemon-owned settings dir: an empty one.
        settingsDir = await ownDir();
        await mkdir(settingsDir, { mode: 0o700 });
        launchDir = settingsDir;
      }

      // 5. Environment and command, then spawn. Guests: under the per-guest lock (their dir must not change meanwhile).
      const spawnSession = async (): Promise<Managed> => {
        let file: string;
        let args: string[];
        let env: Record<string, string>;
        let cwd = rootPath;
        let launch: LaunchContext;
        /** Guests: what the sandbox handed out, released when the process exits or never starts (release()). */
        let wrappedCommand: WrappedCommand | null = null;
        if (!sandboxed) {
          env = buildHostEnv({ hostEnv, home: this.launchConfig.hostHome, sessionId: id, hookEnv });
          if (kind === 'agent') {
            file = (claude as ClaudeBinary).realPath;
            args = claudeArgs;
          } else {
            file = await this.pickShell(this.options.hostShell, hostEnv['SHELL'], null);
            args = ['-l'];
          }
          launch = { claude, env, cwd, tmpDir: null, spec: null };
        } else {
          const guest = await this.prepareGuestDir(userId, kind === 'agent' ? { projectPath: rootPath, ...(input.apiKey !== undefined ? { apiKeySuffix: apiKeyApprovalSuffix(input.apiKey) } : {}) } : null);
          const shell = await this.pickShell(this.options.guestShell, hostEnv['SHELL'], this.launchConfig.hostHome);
          const guestEnv = buildGuestEnv({
            home: guest.home,
            configDir: guest.cfg,
            tmpDir: guest.tmp,
            hostEnv,
            claudeDir: claudeDirOf(claude?.realPath ?? null),
            shell,
            browser: (await isExecutable('/usr/bin/true')) ? '/usr/bin/true' : '/bin/true',
            sessionId: id,
            hookEnv,
          });
          if (input.apiKey !== undefined) guestEnv['ANTHROPIC_API_KEY'] = input.apiKey;
          assertGuestEnv(guestEnv, { apiKeyAllowed: input.apiKey !== undefined });
          withTestGuestEnv(guestEnv, this.launchConfig.testGuestEnv);
          const inner = kind === 'agent' ? guestCommand(guest.tmp, (claude as ClaudeBinary).realPath, claudeArgs) : guestCommand(guest.tmp, shell, ['-l']);
          const specBase: Omit<SandboxSpec, 'command'> = (() => {
            const { command: _command, ...rest } = buildSandboxSpec({
              sessionId: id,
              command: inner,
              rootPath,
              shareRealPath: ctx.roots.main.realPath,
              worktree: worktreeId === null ? null : { worktreesDir: ctx.roots.worktreesDir, sharedLinks },
              guestDir: guest.root,
              settingsDir: launchDir as string,
              claudeRealPath: claude?.realPath ?? null,
              hookSocketPath: ctx.config.runPaths.hook,
              env: guestEnv,
            });
            return rest;
          })();
          let wrapped: WrappedCommand;
          try {
            wrapped = await ctx.services.sandbox.wrap({ ...specBase, command: inner });
          } catch (err) {
            // wrap() audits its own sandbox_unavailable refusals; anything else is refused (and audited) here.
            if (err instanceof SmurgError && err.code === 'sandbox_unavailable') throw err;
            throw refuseSandbox('wrap-failed', { error: err instanceof SmurgError ? err.code : 'unknown' });
          }
          wrappedCommand = wrapped;
          try {
            this.assertWrapped(wrapped, input.apiKey !== undefined);
          } catch (err) {
            this.releaseWrapped(wrapped); // never started
            throw err;
          }
          file = wrapped.file;
          args = [...wrapped.args];
          env = { ...wrapped.env };
          cwd = wrapped.cwd;
          launch = { claude, env: guestEnv, cwd: rootPath, tmpDir: guest.tmp, spec: specBase };
        }
        let m: Managed | null = null;
        let pty: PtySession;
        try {
          if (aborted()) throw new AuthorizationError(undefined, { reason: 'owner-removed' });
          pty = new PtySession({
            ownerUserId: userId,
            spawn: { file, args, cwd, env, cols: input.cols, rows: input.rows },
            log: ctx.log.child({ module: 'pty', session: id }),
            onResize: () => {
              if (m) this.publish(m, 'updated');
            },
            onExit: (exit) => {
              this.releaseWrapped(wrappedCommand);
              if (m) this.onPtyExit(m, exit);
            },
            onOutput: (chunk) => {
              if (m) this.observeLoginHints(m, chunk);
            },
          });
        } catch (err) {
          this.releaseWrapped(wrappedCommand); // never started
          throw err;
        }
        m = this.newManaged({
          id,
          kind,
          member,
          sandboxed,
          root,
          worktreeId,
          title: input.title ?? (kind === 'agent' ? agentDisplayName(member.displayName) : `終端機（${member.displayName}）`),
          pty,
          settingsDir,
          hookRegistered,
        });
        m.launch = launch;
        return m;
      };
      const m = sandboxed ? await this.userLock.run(userId, spawnSession) : await spawnSession();
      this.sessions.set(m.id, m);
      // Every session is in live.json while it runs (agent sessions already are, with their settings dir).
      if (!(this.liveDoc?.get().live.includes(m.id) ?? true)) {
        this.liveDoc?.update((draft) => {
          draft.live.push(m.id);
        });
      }
      // Everything below belongs to the session now: ending it releases hooks, settings, worktree.
      undo.length = 0;
      if (aborted()) {
        await this.finish(m, 'kicked', true);
        throw new AuthorizationError(undefined, { reason: 'owner-removed' });
      }
      m.presence = kind === 'agent' && this.setPresence(m, member);
      ctx.audit.record({
        actor: { kind: 'user', userId, displayName: member.displayName },
        action: 'session.create',
        outcome: 'ok',
        target: m.id,
        detail: { sessionId: m.id, kind, sandboxed, root: rootRefKey(root), ...(worktreeId ? { worktreeId } : {}), apiKeySupplied: input.apiKey !== undefined },
      });
      this.publish(m, 'created');
      this.ensureDescendantTracking();
      if (kind === 'agent') void this.checkLogin(m).catch(() => {});
      return this.info(m);
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  private newManaged(input: {
    readonly id: string;
    readonly kind: SessionKind;
    readonly member: MemberRecord;
    readonly sandboxed: boolean;
    readonly root: RootRef;
    readonly worktreeId: string | null;
    readonly title: string;
    readonly pty: PtySession;
    readonly settingsDir: string | null;
    readonly hookRegistered: boolean;
  }): Managed {
    return {
      id: input.id,
      kind: input.kind,
      ownerUserId: input.member.userId,
      ownerName: input.member.displayName,
      sandboxed: input.sandboxed,
      root: input.root,
      worktreeId: input.worktreeId,
      createdAt: this.ctx.clock.now(),
      title: input.title,
      pty: input.pty,
      settingsDir: input.settingsDir,
      hookRegistered: input.hookRegistered,
      presence: false,
      status: 'running',
      exitCode: undefined,
      endedAt: undefined,
      login: 'unknown',
      launch: null,
      ending: null,
      endReason: null,
      endedBy: null,
      cleaned: false,
      loginCheck: null,
      loginHintTimer: undefined,
      retentionTimer: undefined,
      loginTimer: undefined,
      hints: input.kind === 'agent' ? new LoginHintDetector() : null,
      known: new Map(),
      persistedProcs: '',
    };
  }

  /** srt adds its proxy variables; it must never add a credential (fail closed if a wrapper ever does). */
  private assertWrapped(wrapped: WrappedCommand, apiKeyAllowed: boolean): void {
    if (typeof wrapped.file !== 'string' || !isAbsolute(wrapped.file) || !Array.isArray(wrapped.args)) throw new SmurgError('sandbox_unavailable', undefined, { reason: 'wrap-invalid' });
    const credentials = Object.keys(wrapped.env).filter(
      (name) =>
        (/^ANTHROPIC_/.test(name) && !(apiKeyAllowed && name === 'ANTHROPIC_API_KEY') && !(this.launchConfig.testGuestEnv && name in this.launchConfig.testGuestEnv)) ||
        /^(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_[A-Z_]+|AWS_[A-Z_]+|SSH_AUTH_SOCK|NODE_OPTIONS)$/.test(name),
    );
    if (credentials.length > 0) throw new SmurgError('sandbox_unavailable', undefined, { reason: 'wrap-env' });
  }

  private setPresence(m: Managed, member: MemberRecord): boolean {
    const presence = this.ctx.services.presence;
    if (isStubService(presence)) return false;
    try {
      presence.setAgent({ sessionId: m.id, ownerUserId: m.ownerUserId, displayName: agentDisplayName(member.displayName), color: member.color, status: 'running' });
      return true;
    } catch (err) {
      this.logError('presence.setAgent failed', err);
      return false;
    }
  }

  private warnVersion(member: MemberRecord, version: string | null, warning: string): void {
    this.ctx.log.warn('Claude Code version is not verified for smurg', { version: version ?? 'unrecognized', warning, owner: member.userId });
    const activity = this.ctx.services.activity;
    if (isStubService(activity)) return;
    const text =
      warning === 'below-minimum'
        ? `注意：Claude Code ${version ?? '（版本不明）'} 低於 smurg 驗證過的最低版本 ${this.launchConfig.claudeMinVersion}，檔案鎖與 hooks 可能無法正常運作。`
        : `注意：Claude Code ${version ?? ''} 尚未經過 smurg 驗證（已驗證：${this.launchConfig.claudeVerifiedVersions.join('、')}），如遇問題請回報。`;
    try {
      activity.notify(member.userId, { from: SYSTEM_ACTOR, text });
    } catch (err) {
      this.logError('version warning notification failed', err);
    }
  }

  /** Fail closed on launch files that do not look like smurg's: a missing flag must never start a hook-less agent. */
  private async checkedLaunchFiles(files: unknown, sandboxed: boolean): Promise<{ dir: string; claudeArgs: string[] }> {
    const record = files !== null && typeof files === 'object' ? (files as Record<string, unknown>) : {};
    const dir = record['dir'];
    const args = record['claudeArgs'];
    const bad = (why: string): SmurgError => {
      this.ctx.log.error('hook launch files refused', { why });
      return sessionError('internal', 'hook 設定檔不正確，無法啟動 agent session', 'hooks-unavailable');
    };
    if (typeof dir !== 'string' || !isAbsolute(dir) || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw bad('shape');
    const list = args as string[];
    if (!list.includes('--settings') || !list.includes('--mcp-config')) throw bad('flags');
    if (sandboxed && !list.includes('--strict-mcp-config')) throw bad('strict');
    if (list.some((arg) => /^--(dangerously-skip-permissions|allow-dangerously-skip-permissions|permission-mode)/.test(arg))) throw bad('permissions');
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) throw bad('dir');
    return { dir: await realpath(dir), claudeArgs: [...list] };
  }

  private hostEnv(): Readonly<Record<string, string | undefined>> {
    return this.options.hostEnv ? this.options.hostEnv() : process.env;
  }

  /** The first usable shell: the configured one, the host's $SHELL, then system shells. Guests: never one in the host home. */
  private async pickShell(configured: string | undefined, envShell: string | undefined, deniedHome: string | null): Promise<string> {
    const candidates = [configured, envShell, '/bin/zsh', '/bin/bash', '/bin/sh'];
    for (const candidate of candidates) {
      if (!candidate || !isAbsolute(candidate)) continue;
      if (deniedHome && (candidate === deniedHome || candidate.startsWith(`${deniedHome}/`))) continue;
      if (await isExecutable(candidate)) return candidate;
    }
    throw sessionError('internal', '找不到可用的 shell', 'no-shell');
  }

  // =================================================================================================================
  // Guest dirs
  // =================================================================================================================

  /**
   * The guest's dir for a new session. The trust seed is written only when the guest has no running session (see
   * guest-store.ts: never write into a guest tree a guest process could race); with sessions running, the existing dir
   * is used as is and Claude may show its trust dialog for a new root. Runs under the per-guest lock.
   */
  private async prepareGuestDir(userId: UserId, seed: { readonly projectPath: string; readonly apiKeySuffix?: string } | null): Promise<GuestPaths> {
    const store = this.requireStore();
    const busy = [...this.sessions.values()].some((m) => m.ownerUserId === userId && m.sandboxed && m.status !== 'exited');
    if (busy) {
      if (!(await store.exists(userId))) throw sessionError('internal', '客人的暫存目錄不見了', 'guest-dir-missing');
      if (seed) this.ctx.log.info('guest has a running session: trust seed skipped', { user: userId });
      return store.pathsFor(userId);
    }
    await store.withQuarantine(userId, async (paths) => {
      if (!seed) return;
      const existing = await readGuestFile(join(paths.cfg, '.claude.json'), CLAUDE_JSON_MAX_BYTES);
      let parsed: unknown = {};
      if (existing) {
        try {
          parsed = JSON.parse(existing.toString('utf8'));
        } catch {
          parsed = {};
        }
      }
      const merged = mergeClaudeJson(parsed, seed);
      await writeGuestFileAtomic(paths.cfg, '.claude.json', new TextEncoder().encode(`${JSON.stringify(merged, null, 2)}\n`));
    });
    return store.pathsFor(userId);
  }

  private membersByGuestKey(): Map<string, MemberRecord> {
    const out = new Map<string, MemberRecord>();
    const store = this.store;
    if (!store) return out;
    for (const member of this.ctx.members.list({ includeKicked: true })) out.set(guestKeyOf(member.userId), member);
    return out;
  }

  /** §11 D-9 retention: at start and daily, the dirs of members not connected for 7 days (and orphans) go. */
  async sweepGuestDirs(): Promise<number> {
    const store = this.store;
    if (!store || this.stopping) return 0;
    const byKey = this.membersByGuestKey();
    const now = this.ctx.clock.now();
    let removed = 0;
    for (const key of await store.keys()) {
      // The member as they are NOW (the loop awaits): a member who disconnected a moment ago was seen then (a
      // disconnect updates lastSeenAt), not at the connect of a connection that lasted for days.
      const known = byKey.get(key);
      const member = known ? (this.ctx.members.get(known.userId) ?? known) : undefined;
      if (!member || member.status === 'kicked') {
        if (member) await this.removeGuestDirNow(member.userId);
        else await store.removeKey(key);
        removed++;
        continue;
      }
      if (member.role === 'host') continue;
      if (this.ctx.hub.isOnline(member.userId)) continue;
      if ([...this.sessions.values()].some((m) => m.ownerUserId === member.userId && m.status !== 'exited')) continue;
      if (now - member.lastSeenAt < this.limits.guestRetentionMs) continue;
      await this.removeGuestDirNow(member.userId);
      removed++;
    }
    return removed;
  }

  /** Kill sessions, best-effort `claude auth logout` (1 s), `rm -rf` the guest dir, keychain cleanup (macOS). */
  async removeGuestDir(userId: UserId): Promise<void> {
    await this.killAllForUser(userId, 'left');
    await this.removeGuestDirNow(userId);
  }

  private async removeGuestDirNow(userId: UserId): Promise<void> {
    const store = this.store;
    if (!store) return;
    const paths = store.pathsFor(userId);
    let claudeRan = false;
    const removed = await this.userLock.run(userId, async () => {
      if (!(await store.exists(userId))) return false;
      // Claude Code writes <cfg>/.claude.json on its first start (and the daemon seeds it for agent sessions): without
      // it, claude never ran with this config dir and cannot have created keychain items for it (see below).
      claudeRan = (await Promise.all(['.claude.json', '.credentials.json'].map((name) => lstat(join(paths.cfg, name)).catch(() => null)))).some((st) => st !== null);
      // Logout runs first: afterwards there is nothing it could use (the credential is in the dir), and it must not
      // run after the removal (it could re-create the config dir). rm -rf is what really removes the credential.
      await this.logout(paths).catch((err: unknown) => this.logError('guest logout failed', err));
      await store.remove(userId);
      this.ctx.log.info('guest dir removed', { user: userId });
      return true;
    });
    // Only when claude ran with this config dir: the host's keychain is not touched for a guest who only used a
    // terminal (nothing there to delete; tests with the production composition kick such guests).
    if (removed && claudeRan) await this.deleteDerivedKeychainItems(paths.cfg).catch((err: unknown) => this.logError('keychain cleanup failed', err));
  }

  /** `claude auth logout` inside the guest's own sandbox (never unsandboxed: the guest controls that config). */
  private async logout(paths: GuestPaths): Promise<void> {
    const credentials = await lstat(join(paths.cfg, '.credentials.json')).catch(() => null);
    if (!credentials?.isFile()) return;
    if (isStubService(this.ctx.services.sandbox)) return;
    const hostEnv = this.hostEnv();
    const claude = await resolveClaude(this.launchConfig.claudePath, hostEnv['PATH']);
    if (!claude) return;
    const id = `ses_${randomBytes(16).toString('hex')}`;
    const env = buildGuestEnv({
      home: paths.home,
      configDir: paths.cfg,
      tmpDir: paths.tmp,
      hostEnv,
      claudeDir: claudeDirOf(claude.realPath),
      shell: '/bin/sh',
      browser: '/usr/bin/true',
      sessionId: id,
    });
    const command = guestCommand(paths.tmp, claude.realPath, ['auth', 'logout']);
    const settingsDir = join(this.requireSessionsDir(), id);
    await mkdir(settingsDir, { mode: 0o700 });
    try {
      const spec = buildSandboxSpec({
        sessionId: id,
        command,
        rootPath: this.ctx.roots.main.realPath,
        shareRealPath: this.ctx.roots.main.realPath,
        worktree: null,
        guestDir: paths.root,
        settingsDir,
        claudeRealPath: claude.realPath,
        hookSocketPath: this.ctx.config.runPaths.hook,
        env,
      });
      const wrapped = await this.ctx.services.sandbox.wrap(spec);
      try {
        await this.runner(wrapped.file, wrapped.args, { env: wrapped.env, cwd: wrapped.cwd, timeoutMs: this.limits.logoutTimeoutMs, maxStdoutBytes: 4096 });
      } finally {
        this.releaseWrapped(wrapped);
      }
    } finally {
      await removeSessionFiles(settingsDir).catch(() => {});
    }
  }

  /**
   * claude-hooks.md §5.3: the two keychain items Claude Code derives from a config dir, deleted host-side as belt and
   * braces (a hardened sandbox makes the login fall back to cfg/.credentials.json). Only those two exact names.
   */
  private async deleteDerivedKeychainItems(configDir: string): Promise<void> {
    if (process.platform !== 'darwin' && this.options.keychain === undefined) return;
    const h8 = createHash('sha256').update(configDir.normalize('NFC'), 'utf8').digest('hex').slice(0, 8);
    const services = [`Claude Code-credentials-${h8}`, `Claude Code-${h8}`];
    const account = this.hostEnv()['USER'] ?? '';
    if (this.options.keychain) {
      await this.options.keychain(services, account);
      return;
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(account)) return;
    const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
    if (this.launchConfig.hostHome) env['HOME'] = this.launchConfig.hostHome;
    await Promise.all(
      services.map((service) => this.runner('/usr/bin/security', ['delete-generic-password', '-a', account, '-s', service], { env, cwd: '/', timeoutMs: 3_000, maxStdoutBytes: 4096 })),
    );
  }

  // =================================================================================================================
  // Attach / detach / input / resize
  // =================================================================================================================

  async attach(input: PayloadOf<'session.attach'>, conn: ClientConnection, principal: Principal): Promise<SessionAttachStart> {
    const m = this.requireSession(input.sessionId);
    // A login shows its owner a login URL and takes their pasted code: nobody else may watch it (D-12).
    if (m.kind === 'login' && principal.userId !== m.ownerUserId) throw sessionError('not_found', '找不到這個 session', 'unknown-session');
    const channelId = conn.channelId;
    const sessionId = m.id;
    const hub = this.ctx.hub;
    const sink: ViewerSink = {
      output: (offset, data) => {
        for (let start = 0; start < data.byteLength; start += OUTPUT_PIECE) {
          const piece = data.subarray(start, Math.min(data.byteLength, start + OUTPUT_PIECE));
          hub.send(channelId, 'exec.output', { sessionId, offset: offset + start, data: piece });
        }
      },
      resize: (cols, rows) => {
        hub.send(channelId, 'exec.resize', { sessionId, cols, rows });
      },
      // What this channel's current socket still has queued (all relay members share the host's one socket to the
      // relay): the PTY pauses while it is too much (REL-06).
      backlog: () => {
        for (const recipient of hub.recipients({ userId: conn.userId, purpose: 'interactive' })) {
          if (recipient.channelId === channelId) return recipient.conn?.isOpen === true ? recipient.conn.bufferedAmount : 0;
        }
        return 0;
      },
    };
    const isOwner = principal.userId === m.ownerUserId;
    const viewport = isOwner && input.cols !== undefined && input.rows !== undefined ? { cols: input.cols, rows: input.rows } : null;
    const plan = await m.pty.attach(channelId, principal.userId ?? 'unknown', sink, viewport, input.haveOffset);
    this.publish(m, 'updated');
    const result: ResultInputOf<'session.attach'> = {
      session: this.info(m),
      mode: plan.mode,
      data: plan.data,
      cols: plan.cols,
      rows: plan.rows,
      nextOffset: plan.nextOffset,
    };
    return { result, afterReply: () => plan.commit() };
  }

  detach(sessionId: string, channelId: string): void {
    const m = this.sessions.get(sessionId);
    if (m && m.pty.detach(channelId)) this.publish(m, 'updated');
  }

  /** Every viewer of a logical channel that is gone for good (channel.discarded). */
  detachChannel(channelId: string): void {
    for (const m of this.sessions.values()) if (m.pty.detach(channelId)) this.publish(m, 'updated');
  }

  input(input: PayloadOf<'exec.input'>, conn: ClientConnection, principal: Principal): void {
    const m = this.requireSession(input.sessionId);
    this.requireOwnerPrincipal(m, principal);
    if (!m.pty.input(conn.channelId, input.data)) throw sessionError('conflict', 'session 已結束', 'session-exited');
  }

  resize(input: PayloadOf<'exec.resize'>, conn: ClientConnection, principal: Principal): void {
    const m = this.requireSession(input.sessionId);
    this.requireOwnerPrincipal(m, principal);
    m.pty.ownerViewport(conn.channelId, input.cols, input.rows);
  }

  /**
   * The ONLY path of suggestion text into a PTY (R6), called after the owner accepted it: a paste, then Enter. Like a
   * terminal, the paste is bracketed when the program enabled bracketed paste (Claude Code does), so newlines inside
   * the suggestion stay part of one prompt instead of submitting it line by line.
   */
  pasteSuggestion(sessionId: string, text: string, acceptedBy: Principal): void {
    const m = this.requireSession(sessionId);
    this.requireOwnerPrincipal(m, acceptedBy);
    // No escape (it could end the paste early and inject keys) and no other control characters but tab and newline.
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\r?\n/g, '\r');
    // Bracketing and the Enter afterwards: PtySession.paste, once the mirror has parsed what the program printed.
    if (!m.pty.paste(clean)) throw sessionError('conflict', 'session 已結束', 'session-exited');
  }

  private requireSession(sessionId: string): Managed {
    const m = this.sessions.get(sessionId);
    if (!m) throw sessionError('not_found', '找不到這個 session', 'unknown-session');
    return m;
  }

  private requireOwnerPrincipal(m: Managed, principal: Principal): void {
    if (principal.userId === null || principal.userId !== m.ownerUserId) {
      throw new AuthorizationError(undefined, { reason: 'not-owner:session' });
    }
  }

  ownerOf(sessionId: string): UserId | null {
    return this.sessions.get(sessionId)?.ownerUserId ?? null;
  }

  // =================================================================================================================
  // Login
  // =================================================================================================================

  async loginStatus(sessionId: string, principal: Principal): Promise<LoginState> {
    const m = this.requireSession(sessionId);
    this.requireOwnerPrincipal(m, principal);
    if (m.kind !== 'agent' || m.status === 'exited') return m.login;
    return this.checkLogin(m);
  }

  /** `claude auth status --json` in the session's exact environment (guests: inside their sandbox). */
  private checkLogin(m: Managed): Promise<LoginState> {
    if (m.loginCheck) return m.loginCheck;
    const run = async (): Promise<LoginState> => {
      const launch = m.launch;
      if (!launch?.claude || !launch.env || m.status === 'exited') return m.login;
      let result;
      if (!m.sandboxed) {
        result = await this.runner(launch.claude.realPath, ['auth', 'status', '--json'], { env: launch.env, cwd: launch.cwd, timeoutMs: this.limits.authStatusTimeoutMs, maxStdoutBytes: 64 * 1024 });
      } else {
        if (!launch.spec || !launch.tmpDir) return m.login;
        const command = guestCommand(launch.tmpDir, launch.claude.realPath, ['auth', 'status', '--json']);
        // A helper, not the agent: without the hook token (it needs none, and the sandbox tests the hook only for the
        // agent's own launch).
        const env = Object.fromEntries(Object.entries(launch.spec.env).filter(([name]) => name !== 'SMURG_SESSION_TOKEN' && name !== 'SMURG_HOOK_SOCKET'));
        const wrapped = await this.ctx.services.sandbox.wrap({ ...launch.spec, env, command });
        try {
          result = await this.runner(wrapped.file, wrapped.args, { env: wrapped.env, cwd: wrapped.cwd, timeoutMs: this.limits.authStatusTimeoutMs, maxStdoutBytes: 64 * 1024 });
        } finally {
          this.releaseWrapped(wrapped);
        }
      }
      const login = parseAuthStatus(result);
      // The session may have ended while the check ran.
      if (login !== m.login && (m.status as SessionStatus) !== 'exited') {
        m.login = login;
        this.publish(m, 'updated');
      }
      return m.login;
    };
    const pending = run().catch((err: unknown) => {
      this.logError('login status check failed', err);
      return m.login;
    });
    m.loginCheck = pending;
    void pending.finally(() => {
      if (m.loginCheck === pending) m.loginCheck = null;
    });
    return pending;
  }

  /** TUI hints only trigger a re-check (debounced); they never decide the login state themselves. */
  private observeLoginHints(m: Managed, chunk: Uint8Array): void {
    if (!m.hints || m.status === 'exited' || !m.hints.push(chunk)) return;
    if (m.loginHintTimer !== undefined) clearTimeout(m.loginHintTimer);
    m.loginHintTimer = setTimeout(() => {
      m.loginHintTimer = undefined;
      void this.checkLogin(m);
    }, LOGIN_HINT_DEBOUNCE_MS);
    m.loginHintTimer.unref?.();
  }

  // =================================================================================================================
  // Import config
  // =================================================================================================================

  async importConfig(input: PayloadOf<'session.importConfig'>, principal: Principal): Promise<ResultInputOf<'session.importConfig'>> {
    const userId = principal.userId;
    const member = userId !== null && principal.kind === 'user' ? this.ctx.members.active(userId) : null;
    // own-guest-dir: only a sandboxed session owner (runner) has a guest dir; the payload names no user at all.
    if (!member || userId === null || !can(member.role, 'session.create.sandboxed')) throw new AuthorizationError(undefined, { reason: 'not-a-guest' });
    const files = validateImport(input.files, (path) => this.ctx.paths.lexical(path));
    const store = this.requireStore();
    const written = await this.userLock.run(userId, async () => {
      if ([...this.sessions.values()].some((m) => m.ownerUserId === userId && m.status !== 'exited')) {
        throw sessionError('conflict', '請先結束你所有的 session，再匯入個人設定', 'sessions-running');
      }
      return store.withQuarantine(userId, (paths) => writeImport(paths.cfg, files));
    });
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'session.import-config',
      outcome: 'ok',
      target: userId,
      // Names only: the files are the member's personal configuration.
      detail: { count: written.length, names: written },
    });
    return { written };
  }

  // =================================================================================================================
  // Ending
  // =================================================================================================================

  async end(input: PayloadOf<'session.end'>, principal: Principal): Promise<void> {
    const m = this.requireSession(input.sessionId);
    this.requireOwnerPrincipal(m, principal);
    // C17: only an explicit keepWorktree: false removes the worktree with the session.
    const keep = input.keepWorktree !== false;
    const already = m.ending !== null;
    await this.finish(m, 'ended', keep, principal);
    // A login's end is audited once, with its outcome (cleanupLogin).
    if (!already && m.kind !== 'login') {
      this.ctx.audit.record({ actor: principal.actor, action: 'session.end', outcome: 'ok', target: m.id, detail: { sessionId: m.id, kind: m.kind, keepWorktree: keep } });
    }
  }

  async terminate(sessionId: string, by: Principal): Promise<void> {
    const m = this.requireSession(sessionId);
    await this.finish(m, 'terminated', true, by);
    this.ctx.audit.record({ actor: by.actor, action: 'session.terminate', outcome: 'ok', target: m.id, detail: { sessionId: m.id, ownerUserId: m.ownerUserId, kind: m.kind } });
  }

  async killAllForUser(userId: UserId, reason: 'kicked' | 'left' | 'role-changed'): Promise<void> {
    this.userEpochs.set(userId, (this.userEpochs.get(userId) ?? 0) + 1);
    const mine = [...this.sessions.values()].filter((m) => m.ownerUserId === userId && m.status !== 'exited');
    await Promise.all(mine.map((m) => this.finish(m, reason, true)));
  }

  /** Idempotent: the first reason wins; every caller waits for the same teardown. */
  private finish(m: Managed, reason: SessionEndReason, keepWorktree: boolean, by?: Principal): Promise<void> {
    if (m.ending) return m.ending;
    m.endReason = reason;
    if (by !== undefined && by.actor.kind === 'user') m.endedBy = { userId: by.actor.userId, displayName: by.actor.displayName };
    m.ending = (async () => {
      const result = await this.killSessionProcesses(m, m.pty.running);
      if (result.outcome !== 'done') this.ctx.log.error('session processes may remain', { session: m.id, outcome: result.outcome, reason: result.reason ?? 'none' });
      if (!(await m.pty.waitExit(1_500))) {
        m.pty.hangup();
        await m.pty.waitExit(500);
      }
      await this.cleanup(m, reason, keepWorktree);
    })().catch((err: unknown) => this.logError('session teardown failed', err));
    return m.ending;
  }

  /**
   * A guest process started from `wrapped` exited or never started: the sandbox may drop its count of it (Linux:
   * srt removes bubblewrap's mount points for absent write-denied names from the share once no guest process runs).
   * Idempotent; nothing for a host process.
   */
  private releaseWrapped(wrapped: WrappedCommand | null): void {
    if (wrapped === null) return;
    try {
      this.ctx.services.sandbox.release?.(wrapped);
    } catch (err) {
      this.logError('sandbox release failed', err);
    }
  }

  /** The PTY exited on its own (`exit`, a crash). */
  private onPtyExit(m: Managed, exit: PtyExit): void {
    m.exitCode = exit.exitCode;
    if (m.ending) return; // an explicit end is already tearing it down
    m.endReason = 'exit';
    m.ending = (async () => {
      // A guest's leftovers (background jobs) would keep the sandbox's write access after the session is gone: they
      // go too, found by the env marker and the remembered descendants (the PTY child is reaped: its pid may be
      // reused, so it counts no more). A host's nohup jobs are theirs to keep, as in any terminal.
      if (m.sandboxed) await this.killSessionProcesses(m, false);
      await this.cleanup(m, 'exit', true);
    })().catch((err: unknown) => this.logError('session exit handling failed', err));
  }

  private killSessionProcesses(m: Managed, useRoot: boolean): Promise<KillTreeResult> {
    return killTree(
      // The PTY child counts only while node-pty has not reported its exit: after that its pid may be reused.
      {
        rootPid: () => (useRoot && m.pty.running ? m.pty.pid : null),
        envEntry: `SMURG_SESSION_ID=${m.id}`,
        known: m.known,
        protect: () => this.foreignChildren(m),
      },
      { inspector: this.inspector, log: this.ctx.log.child({ module: 'kill-tree', session: m.id }), deadlineMs: this.limits.killDeadlineMs, maxPids: this.limits.maxPidsPerSession },
    );
  }

  /** The daemon's other children (other sessions' PTY children, helpers): never part of session `m`. */
  private foreignChildren(m: Managed): Set<number> {
    const out = new Set<number>(runningHelperPids());
    for (const other of this.sessions.values()) if (other !== m && other.pty.running) out.add(other.pty.pid);
    return out;
  }

  /** Descendants, remembered every 2 s while a session runs (see Managed.known), and persisted (REL-09). */
  private ensureDescendantTracking(): void {
    if (this.trackTimer !== undefined || this.stopping) return;
    this.trackTimer = setInterval(() => void this.trackDescendants(), DESCENDANT_SCAN_MS);
    this.trackTimer.unref?.();
    void this.trackDescendants();
  }

  private async trackDescendants(): Promise<void> {
    if (this.tracking) return;
    const guests = [...this.sessions.values()].filter((m) => m.pty.running && m.ending === null);
    if (guests.length === 0) {
      if (this.trackTimer !== undefined) clearInterval(this.trackTimer);
      this.trackTimer = undefined;
      return;
    }
    this.tracking = true;
    try {
      const rows = await this.inspector.table();
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
      for (const m of guests) {
        if (!m.pty.running || m.ending !== null) continue;
        // Keep what is still the same process (an orphaned job has no ppid link any more), add today's descendants.
        const next = new Map<number, KnownProcess>();
        for (const [pid, was] of m.known) {
          const row = byPid.get(pid);
          if (row && row.start === was.start && row.command === was.command) next.set(pid, was);
        }
        for (const [pid, known] of rememberDescendants(rows, m.pty.pid, process.pid, uid, this.limits.maxPidsPerSession)) {
          if (next.size >= this.limits.maxPidsPerSession) break;
          next.set(pid, known);
        }
        m.known = next;
        this.persistProcs(m, byPid.get(m.pty.pid) ?? null);
      }
    } catch (err) {
      this.logError('descendant scan failed', err);
    } finally {
      this.tracking = false;
    }
  }

  private async cleanup(m: Managed, reason: SessionEndReason, keepWorktree: boolean): Promise<void> {
    if (m.cleaned) return;
    m.cleaned = true;
    const services = this.ctx.services;
    if (m.loginHintTimer !== undefined) clearTimeout(m.loginHintTimer);
    if (m.loginTimer !== undefined) clearTimeout(m.loginTimer);
    if (m.kind === 'login') {
      await this.cleanupLogin(m, reason);
      return;
    }
    m.status = 'exited';
    m.endedAt = this.ctx.clock.now();
    const exit = m.pty.exit;
    if (exit) m.exitCode = exit.exitCode;
    m.launch = null; // the guest's apiKey leaves memory with it
    m.known = new Map();
    if (m.hookRegistered) {
      this.safely('hooks.unregisterSession', () => services.hooks.unregisterSession(m.id));
      // The launch files are gone when the session is (unregisterSession starts their removal; wait for it here).
      if (m.kind === 'agent') await services.hooks.removeSessionFiles(m.id).catch((err: unknown) => this.logError('session launch files removal failed', err));
    }
    if (!isStubService(services.locks)) this.safely('locks.releaseAllForSession', () => services.locks.releaseAllForSession(m.id, reason === 'kicked' ? 'kicked' : 'session-ended'));
    if (m.presence && !isStubService(services.presence)) this.safely('presence.removeAgent', () => services.presence.removeAgent(m.id));
    if (m.kind === 'agent' && !isStubService(services.docs)) this.safely('docs.clearAgentPresence', () => services.docs.clearAgentPresence(m.id));
    if (m.worktreeId !== null) {
      try {
        await services.worktrees.releaseFromSession(m.worktreeId, m.id, { keep: keepWorktree });
      } catch (err) {
        this.logError('worktree release failed', err);
      }
    }
    if (m.settingsDir) await removeSessionFiles(m.settingsDir).catch((err: unknown) => this.logError('session files removal failed', err));
    this.forgetLive(m.id);
    const session = this.info(m);
    this.ctx.bus.emit('session.exited', { session, reason });
    this.ctx.hub.broadcast('session.state', { session });
    // Late viewers still get the final screen for a while; then the mirror's memory (≈17 MiB each) goes.
    if (!this.stopping) {
      m.retentionTimer = setTimeout(() => this.forget(m), this.limits.exitedRetentionMs);
      m.retentionTimer.unref?.();
      const exited = [...this.sessions.values()].filter((other) => other.status === 'exited').sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
      for (const old of exited.slice(0, Math.max(0, exited.length - MAX_EXITED_RETAINED))) this.forget(old);
    }
  }

  /**
   * A login process ended (D-12): its outcome is audited (the exit code only: its output is the owner's), the owner's
   * clients learn it, and the owner's agent sessions check their login again (the credential is in the guest dir).
   */
  private async cleanupLogin(m: Managed, reason: SessionEndReason): Promise<void> {
    // Everything anyone can observe changes at once (status, audit, the owner's session.state); the files go after.
    m.status = 'exited';
    m.endedAt = this.ctx.clock.now();
    const exit = m.pty.exit;
    if (exit) m.exitCode = exit.exitCode;
    m.launch = null;
    m.known = new Map();
    this.forgetLive(m.id);
    this.ctx.audit.record({
      actor: { kind: 'user', userId: m.ownerUserId, displayName: m.ownerName },
      action: 'session.end',
      outcome: 'ok',
      target: m.id,
      detail: { sessionId: m.id, kind: 'login', reason, ...(m.exitCode !== undefined ? { exitCode: m.exitCode } : {}) },
    });
    this.publish(m, 'updated');
    if (m.settingsDir) await removeSessionFiles(m.settingsDir).catch((err: unknown) => this.logError('session files removal failed', err));
    for (const agent of this.sessions.values()) {
      if (agent.kind === 'agent' && agent.ownerUserId === m.ownerUserId && agent.status !== 'exited') void this.checkLogin(agent).catch(() => {});
    }
    if (!this.stopping) {
      m.retentionTimer = setTimeout(() => this.forget(m), Math.min(this.limits.exitedRetentionMs, LOGIN_EXITED_RETENTION_MS));
      m.retentionTimer.unref?.();
    }
  }

  private forget(m: Managed): void {
    if (m.retentionTimer !== undefined) clearTimeout(m.retentionTimer);
    if (this.sessions.get(m.id) === m) this.sessions.delete(m.id);
    m.pty.dispose();
  }

  private forgetLive(id: string): void {
    this.liveDoc?.update((draft) => {
      draft.live = draft.live.filter((entry) => entry !== id);
      if (draft.procs) {
        delete draft.procs[id];
        if (Object.keys(draft.procs).length === 0) delete draft.procs;
      }
    });
  }

  /** Writes the session's processes (the PTY child while it is ours, and its known descendants) when they changed. */
  private persistProcs(m: Managed, root: ProcessRow | null): void {
    if (!this.liveDoc || m.cleaned || !this.liveDoc.get().live.includes(m.id)) return;
    const entries: { pid: number; id: string }[] = [];
    if (root?.start !== undefined && root.command !== undefined && root.ppid === process.pid) entries.push({ pid: root.pid, id: identityDigest(root.start, root.command) });
    for (const [pid, known] of m.known) {
      if (entries.length >= this.limits.maxPidsPerSession) break;
      entries.push({ pid, id: identityDigest(known.start, known.command) });
    }
    const key = entries.map((entry) => `${entry.pid}:${entry.id}`).join(',');
    if (key === m.persistedProcs) return;
    m.persistedProcs = key;
    try {
      this.liveDoc.update((draft) => {
        draft.procs = { ...(draft.procs ?? {}), [m.id]: entries.slice(0, 512) };
      });
    } catch (err) {
      this.logError('live session processes not recorded', err);
    }
  }

  // =================================================================================================================
  // Helpers
  // =================================================================================================================

  private safely(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logError(`${label} failed`, err);
    }
  }

  private logError(message: string, err: unknown): void {
    this.ctx.log.error(message, { error: err instanceof SmurgError ? `${err.code}:${String(err.detail?.['reason'] ?? '')}` : err instanceof Error ? err.name : 'unknown' });
  }

  private requireStore(): GuestStore {
    if (!this.store) throw sessionError('internal', 'session 服務尚未啟動', 'not-started');
    return this.store;
  }

  private requireSessionsDir(): string {
    if (!this.sessionsDir) throw sessionError('internal', 'session 服務尚未啟動', 'not-started');
    return this.sessionsDir;
  }

  private requireProbe(): ClaudeVersionProbe {
    if (!this.versionProbe) throw sessionError('internal', 'session 服務尚未啟動', 'not-started');
    return this.versionProbe;
  }
}
