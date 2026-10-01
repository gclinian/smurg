// SessionManager (R4, R2 kick, R11; ARCHITECTURE §5.5, §7.6, §11 D-3 / D-15). Owns every PTY session of the daemon:
// launch, fan-out to attached viewers, input from every member who may drive sessions, owner-only resize, login
// state, ending (killTree).
//
// Every session runs like the host's own (owner decision 2026-10-01, §11 D-15): the host's OS user, unsandboxed, the
// host's environment, HOME and Claude Code login, whoever opened it (`session.create`: the host and 「可使用 agent」).
// The member who opened it is its owner: the agent is 「Claude（owner）」, its locks and edits are attributed to them,
// only they end it with session.end (the host terminates any session), and its PTY follows their viewport. Every member
// with `session.drive` (the host, 「可使用 agent」) may type into any session and accept its suggestions; editors and
// viewers suggest (R6). When the owner is kicked, leaves or is set below 「可使用 agent」, the sessions they opened end.
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, realpath, stat } from 'node:fs/promises';
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
import type { ClientConnection, HookSessionCredentials, MemberRecord, PersistentDocument, Principal, SessionAttachStart, SessionManager, UserId } from '../core/interfaces.ts';
import { SYSTEM_ACTOR, agentDisplayName, principalCan } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { ClaudeVersionProbe, LoginHintDetector, parseAuthStatus, resolveClaude, type ClaudeBinary } from './claude.ts';
import { buildHostEnv } from './host-env.ts';
import { killTree, rememberDescendants, systemProcessInspector, type KillTreeResult, type KnownProcess, type ProcessInspector, type ProcessRow } from './kill-tree.ts';
import { removeSessionFiles } from './launch-files.ts';
import { runProcess, runningHelperPids, type ProcessRunner } from './process-run.ts';
import { PtySession, type PtyExit, type ViewerSink } from './pty-session.ts';

export type SessionEndReason = 'exit' | 'ended' | 'terminated' | 'kicked' | 'left' | 'role-changed' | 'stopped';

/** Seams for tests and for the composition (the default module passes none). */
export interface SessionsModuleOptions {
  /** The host's environment (default: process.env, read at each session start). */
  readonly hostEnv?: () => Readonly<Record<string, string | undefined>>;
  /** Overrides of config.sessions launch inputs (tests: a fake `claude`, a hook command). */
  readonly launch?: Partial<Pick<SessionLaunchConfig, 'claudePath' | 'selfCommand' | 'claudeMinVersion' | 'claudeVerifiedVersions'>>;
  /** Shell of terminal sessions (default: the host's $SHELL, else /bin/zsh, /bin/bash, /bin/sh). */
  readonly hostShell?: string;
  readonly inspector?: ProcessInspector;
  readonly runner?: ProcessRunner;
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
  readonly authStatusTimeoutMs: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = Object.freeze({
  maxSessionsPerUser: 8,
  maxSessions: 64,
  killDeadlineMs: 2_500,
  maxPidsPerSession: 512,
  exitedRetentionMs: 15 * 60_000,
  authStatusTimeoutMs: 15_000,
});

interface LaunchContext {
  readonly claude: ClaudeBinary | null;
  /** The session's exact environment (`claude auth status` runs with it). */
  env: Record<string, string> | null;
  readonly cwd: string;
}

interface Managed {
  readonly id: string;
  readonly kind: SessionKind;
  readonly ownerUserId: UserId;
  readonly ownerName: string;
  readonly root: RootRef;
  readonly worktreeId: string | null;
  readonly createdAt: number;
  readonly title: string;
  readonly pty: PtySession;
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
  readonly hints: LoginHintDetector | null;
  /**
   * Descendants of the PTY child seen by the periodic scan (pid → start time). A natural `exit` reparents background
   * jobs to init before node-pty reports it, and on macOS `ps -E` hides the environment of Apple platform binaries
   * (pty-packaging.md gotcha 9): without this, a member's `nohup … &` + `exit` would leave a job behind. Kept for every
   * session (also persisted, REL-09), so a daemon that died hard can end them at its next start.
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
  /** Bumped by killAllForUser: a creation in flight for that user must not spawn (or must die right after). */
  private readonly userEpochs = new Map<UserId, number>();
  private readonly creating = new Map<UserId, number>();
  private sessionsDir: string | null = null;
  private liveDoc: PersistentDocument<LiveDocument> | null = null;
  private versionProbe: ClaudeVersionProbe | null = null;
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
    this.sessionsDir = await realpath(join(stateDir, 'sessions'));
    this.versionProbe = new ClaudeVersionProbe({ scratchParent: this.sessionsDir, run: this.runner });
    this.liveDoc = await this.ctx.state.document(LIVE_DOCUMENT, liveDocumentSchema, () => ({ live: [] }));
    // Sessions never survive the daemon: what a run that died hard left behind (its sessions' processes, REL-09;
    // version-probe scratch dirs) goes now.
    await this.endLeftovers(this.liveDoc.get()).catch((err: unknown) => this.logError('ending the processes of a previous run failed', err));
    for (const name of await readdir(this.sessionsDir).catch(() => [] as string[])) {
      if (name.startsWith('.probe-')) await removeSessionFiles(join(this.sessionsDir, name)).catch(() => {});
    }
    this.liveDoc.update((draft) => {
      draft.live = [];
      delete draft.procs;
    });
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

  /** stop(): end every session (`smurg stop`). */
  async stopAll(): Promise<void> {
    this.stopping = true;
    if (this.trackTimer !== undefined) clearInterval(this.trackTimer);
    this.trackTimer = undefined;
    await Promise.all([...this.sessions.values()].map((m) => this.finish(m, 'stopped', true)));
    for (const m of this.sessions.values()) {
      if (m.retentionTimer !== undefined) clearTimeout(m.retentionTimer);
      if (m.loginHintTimer !== undefined) clearTimeout(m.loginHintTimer);
      m.pty.dispose();
    }
    this.sessions.clear();
    await this.liveDoc?.flush().catch(() => {});
  }

  // =================================================================================================================
  // Queries
  // =================================================================================================================

  /** Every session, oldest first (session.list: every member sees every session, R4 / SPEC §8). */
  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-LIST_MAX_ITEMS)
      .map((m) => this.info(m));
  }

  get(sessionId: string): SessionInfo | null {
    const m = this.sessions.get(sessionId);
    return m ? this.info(m) : null;
  }

  agentActor(sessionId: string): Actor | null {
    const m = this.sessions.get(sessionId);
    if (!m || m.kind !== 'agent') return null;
    return { kind: 'agent', sessionId: m.id, ownerUserId: m.ownerUserId, displayName: agentDisplayName(m.ownerName) };
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
    // The member's CURRENT role (the router checked it for this message as well): the host and 「可使用 agent」.
    if (!can(member.role, 'session.create')) throw new AuthorizationError(undefined, { reason: 'capability' });
    if (this.stopping || !this.started) throw sessionError('conflict', 'daemon 正在停止', 'stopping');
    const running = [...this.sessions.values()].filter((m) => m.status !== 'exited');
    if (running.length + this.inFlight() >= this.limits.maxSessions) throw sessionError('conflict', 'session 數量已達上限', 'session-limit');
    if (running.filter((m) => m.ownerUserId === userId).length + (this.creating.get(userId) ?? 0) >= this.limits.maxSessionsPerUser) {
      throw sessionError('conflict', '你的 session 數量已達上限', 'session-limit');
    }
    this.creating.set(userId, (this.creating.get(userId) ?? 0) + 1);
    try {
      return await this.launch(input, member);
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

  /**
   * Starts `member`'s session exactly like the host's own (ARCHITECTURE §11 D-15): the host's environment (minus what
   * a parent Claude Code session injects), HOME = config.sessions.hostHome, the host's `claude` and its login.
   */
  private async launch(input: PayloadOf<'session.create'>, member: MemberRecord): Promise<SessionInfo> {
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
    const aborted = (): boolean => this.stopping || (this.userEpochs.get(userId) ?? 0) !== epoch || ctx.members.active(userId) === null;

    try {
      // 1. The root: the main share, or the session's worktree (the WorktreeManager registers it as a root).
      let root: RootRef = { kind: 'main' };
      let rootPath = ctx.roots.main.realPath;
      let worktreeId: string | null = null;
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
      }

      // 2. The claude binary and its version (agent sessions). A version smurg did not verify only warns: it is the
      //    host's own CLI (Claude Code updates itself; an update must not lock anyone out).
      const hostEnv = this.hostEnv();
      let claude: ClaudeBinary | null = null;
      if (kind === 'agent') {
        claude = await resolveClaude(this.launchConfig.claudePath, hostEnv['PATH']);
        if (!claude) throw sessionError('not_found', '找不到 claude 指令', 'claude-not-found');
        const output = await this.requireProbe().output(claude);
        const verdict = claudeVersionVerdict(output, this.launchConfig);
        if (!verdict.ok) this.warnVersion(member, verdict.version, 'below-minimum');
        else if (verdict.warning !== null) this.warnVersion(member, verdict.version, verdict.warning);
      }

      // 3. Hooks (agent sessions): the per-session token and the daemon-owned launch files.
      let hookEnv: Readonly<Record<string, string>> = {};
      let hookRegistered = false;
      let claudeArgs: string[] = [];
      const self = this.launchConfig.selfCommand;
      if (kind === 'agent') {
        if (self === null) throw sessionError('internal', 'smurg hook 未設定，無法啟動 agent session', 'hooks-unavailable');
        let credentials: HookSessionCredentials;
        try {
          credentials = ctx.services.hooks.registerSession({ sessionId: id, ownerUserId: userId, agentName: agentDisplayName(member.displayName), root });
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
        claudeArgs = (await this.checkedLaunchFiles(written)).claudeArgs;
      }

      // 4. Environment and command, then spawn.
      const env = buildHostEnv({ hostEnv, home: this.launchConfig.hostHome, sessionId: id, hookEnv });
      let file: string;
      let args: string[];
      if (kind === 'agent') {
        file = (claude as ClaudeBinary).realPath;
        args = claudeArgs;
      } else {
        file = await this.pickShell(this.options.hostShell, hostEnv['SHELL']);
        args = ['-l'];
      }
      if (aborted()) throw new AuthorizationError(undefined, { reason: 'owner-removed' });
      let m: Managed | null = null;
      const pty = new PtySession({
        ownerUserId: userId,
        spawn: { file, args, cwd: rootPath, env, cols: input.cols, rows: input.rows },
        log: ctx.log.child({ module: 'pty', session: id }),
        onResize: () => {
          if (m) this.publish(m, 'updated');
        },
        onExit: (exit) => {
          if (m) this.onPtyExit(m, exit);
        },
        onOutput: (chunk) => {
          if (m) this.observeLoginHints(m, chunk);
        },
      });
      m = this.newManaged({
        id,
        kind,
        member,
        root,
        worktreeId,
        title: input.title ?? (kind === 'agent' ? agentDisplayName(member.displayName) : `終端機（${member.displayName}）`),
        pty,
        hookRegistered,
      });
      m.launch = { claude, env, cwd: rootPath };
      this.sessions.set(m.id, m);
      // Every session is in live.json while it runs: its processes are found after a hard death (REL-09).
      this.liveDoc?.update((draft) => {
        draft.live.push(id);
      });
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
        detail: { sessionId: m.id, kind, root: rootRefKey(root), ...(worktreeId ? { worktreeId } : {}) },
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
    readonly root: RootRef;
    readonly worktreeId: string | null;
    readonly title: string;
    readonly pty: PtySession;
    readonly hookRegistered: boolean;
  }): Managed {
    return {
      id: input.id,
      kind: input.kind,
      ownerUserId: input.member.userId,
      ownerName: input.member.displayName,
      root: input.root,
      worktreeId: input.worktreeId,
      createdAt: this.ctx.clock.now(),
      title: input.title,
      pty: input.pty,
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
      hints: input.kind === 'agent' ? new LoginHintDetector() : null,
      known: new Map(),
      persistedProcs: '',
    };
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
  private async checkedLaunchFiles(files: unknown): Promise<{ dir: string; claudeArgs: string[] }> {
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
    if (list.some((arg) => /^--(dangerously-skip-permissions|allow-dangerously-skip-permissions|permission-mode)/.test(arg))) throw bad('permissions');
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) throw bad('dir');
    return { dir: await realpath(dir), claudeArgs: [...list] };
  }

  private hostEnv(): Readonly<Record<string, string | undefined>> {
    return this.options.hostEnv ? this.options.hostEnv() : process.env;
  }

  /** The first usable shell: the configured one, the host's $SHELL, then system shells. */
  private async pickShell(configured: string | undefined, envShell: string | undefined): Promise<string> {
    const candidates = [configured, envShell, '/bin/zsh', '/bin/bash', '/bin/sh'];
    for (const candidate of candidates) {
      if (!candidate || !isAbsolute(candidate)) continue;
      if (await isExecutable(candidate)) return candidate;
    }
    throw sessionError('internal', '找不到可用的 shell', 'no-shell');
  }

  // =================================================================================================================
  // Attach / detach / input / resize
  // =================================================================================================================

  async attach(input: PayloadOf<'session.attach'>, conn: ClientConnection, principal: Principal): Promise<SessionAttachStart> {
    const m = this.requireSession(input.sessionId);
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

  /** Keystrokes from any member who may drive sessions (`session.drive`: the host, 「可使用 agent」), into any session. */
  input(input: PayloadOf<'exec.input'>, conn: ClientConnection, principal: Principal): void {
    const m = this.requireSession(input.sessionId);
    this.requireDriver(principal);
    if (!m.pty.input(conn.channelId, input.data)) throw sessionError('conflict', 'session 已結束', 'session-exited');
  }

  resize(input: PayloadOf<'exec.resize'>, conn: ClientConnection, principal: Principal): void {
    const m = this.requireSession(input.sessionId);
    this.requireOwnerPrincipal(m, principal);
    m.pty.ownerViewport(conn.channelId, input.cols, input.rows);
  }

  /**
   * The ONLY path of suggestion text into a PTY (R6), called after a member who may drive the session accepted it: a
   * paste, then Enter. Like a terminal, the paste is bracketed when the program enabled bracketed paste (Claude Code
   * does), so newlines inside the suggestion stay part of one prompt instead of submitting it line by line.
   */
  pasteSuggestion(sessionId: string, text: string, acceptedBy: Principal): void {
    const m = this.requireSession(sessionId);
    this.requireDriver(acceptedBy);
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

  /** `session.drive` (the host, 「可使用 agent」): may type into any session and decide its suggestions (§11 D-15). */
  private requireDriver(principal: Principal): void {
    if (principal.kind !== 'user' || principal.userId === null || !principalCan(principal, 'session.drive')) {
      throw new AuthorizationError(undefined, { reason: 'capability' });
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
    this.requireDriver(principal);
    if (m.kind !== 'agent' || m.status === 'exited') return m.login;
    return this.checkLogin(m);
  }

  /** `claude auth status --json` in the session's exact environment (the host's Claude login, §11 D-15). */
  private checkLogin(m: Managed): Promise<LoginState> {
    if (m.loginCheck) return m.loginCheck;
    const run = async (): Promise<LoginState> => {
      const launch = m.launch;
      if (!launch?.claude || !launch.env || m.status === 'exited') return m.login;
      const result = await this.runner(launch.claude.realPath, ['auth', 'status', '--json'], { env: launch.env, cwd: launch.cwd, timeoutMs: this.limits.authStatusTimeoutMs, maxStdoutBytes: 64 * 1024 });
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
  // Ending
  // =================================================================================================================

  async end(input: PayloadOf<'session.end'>, principal: Principal): Promise<void> {
    const m = this.requireSession(input.sessionId);
    this.requireOwnerPrincipal(m, principal);
    // C17: only an explicit keepWorktree: false removes the worktree with the session.
    const keep = input.keepWorktree !== false;
    const already = m.ending !== null;
    await this.finish(m, 'ended', keep, principal);
    if (!already) {
      this.ctx.audit.record({ actor: principal.actor, action: 'session.end', outcome: 'ok', target: m.id, detail: { sessionId: m.id, kind: m.kind, keepWorktree: keep } });
    }
  }

  async terminate(sessionId: string, by: Principal): Promise<void> {
    const m = this.requireSession(sessionId);
    await this.finish(m, 'terminated', true, by);
    this.ctx.audit.record({ actor: by.actor, action: 'session.terminate', outcome: 'ok', target: m.id, detail: { sessionId: m.id, ownerUserId: m.ownerUserId, kind: m.kind } });
  }

  /**
   * The member who opened these sessions was kicked, left, or lost 「可使用 agent」 (§11 D-15): every session they
   * opened ends, each audited as `session.terminate` by the system with the reason. A creation in flight for them is
   * abandoned (userEpochs).
   */
  async killAllForUser(userId: UserId, reason: 'kicked' | 'left' | 'role-changed'): Promise<void> {
    this.userEpochs.set(userId, (this.userEpochs.get(userId) ?? 0) + 1);
    const mine = [...this.sessions.values()].filter((m) => m.ownerUserId === userId && m.status !== 'exited' && m.ending === null);
    await Promise.all(
      mine.map(async (m) => {
        await this.finish(m, reason, true);
        this.ctx.audit.record({
          actor: SYSTEM_ACTOR,
          action: 'session.terminate',
          outcome: 'ok',
          target: m.id,
          detail: { sessionId: m.id, ownerUserId: m.ownerUserId, kind: m.kind, reason },
        });
      }),
    );
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

  /** The PTY exited on its own (`exit`, a crash). */
  private onPtyExit(m: Managed, exit: PtyExit): void {
    m.exitCode = exit.exitCode;
    if (m.ending) return; // an explicit end is already tearing it down
    m.endReason = 'exit';
    m.ending = (async () => {
      // A session another member opened runs as the host: its leftovers (background jobs) go with it, found by the
      // env marker and the remembered descendants (the PTY child is reaped: its pid may be reused, so it counts no
      // more), so that removing that member later ends everything they started. The host's own nohup jobs are theirs
      // to keep, as in any terminal.
      if (m.ownerUserId !== this.ctx.members.hostUserId()) await this.killSessionProcesses(m, false);
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
    const running = [...this.sessions.values()].filter((m) => m.pty.running && m.ending === null);
    if (running.length === 0) {
      if (this.trackTimer !== undefined) clearInterval(this.trackTimer);
      this.trackTimer = undefined;
      return;
    }
    this.tracking = true;
    try {
      const rows = await this.inspector.table();
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
      for (const m of running) {
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
    m.status = 'exited';
    m.endedAt = this.ctx.clock.now();
    const exit = m.pty.exit;
    if (exit) m.exitCode = exit.exitCode;
    m.launch = null;
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

  private requireSessionsDir(): string {
    if (!this.sessionsDir) throw sessionError('internal', 'session 服務尚未啟動', 'not-started');
    return this.sessionsDir;
  }

  private requireProbe(): ClaudeVersionProbe {
    if (!this.versionProbe) throw sessionError('internal', 'session 服務尚未啟動', 'not-started');
    return this.versionProbe;
  }
}
