// SessionManager (R4, R2 kick, R11; ARCHITECTURE §5.5, §7.6, §11 D-3 / D-15). The registry of sessions of both kinds
// and the runner of TERMINAL sessions: launch, fan-out to attached viewers, input from every member who may drive
// sessions, opener-only resize, ending (killTree).
//
// Protocol 4 state of this file (smurg 0.5.0, foundation): terminals work as before. An AGENT session is a Claude Code
// conversation in structured mode (ctx.services.agents, AgentSessions): create / list / get / end / terminate
// delegate to it, and until the agent runtime module provides that service its stub answers "not implemented". The
// PTY agent session of 0.4.0 is gone (no terminal-style agent, ARCHITECTURE §11 D-16).
//
// Every session runs like the host's own (§11 D-15): the host's OS user, unsandboxed, the host's environment and HOME,
// whoever opened it (`session.create`: the host and Agent access). The member who opened a terminal ends it with
// session.end (the host terminates any session) and its PTY follows their viewport. Every member with
// `session.drive` may type into any terminal.
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  EXEC_OUTPUT_MAX_BYTES,
  LIST_MAX_ITEMS,
  SmurgError,
  can,
  mayEndSession,
  rootRefKey,
  titleFromFirstMessage,
  type Actor,
  type AgentSession,
  type LoginState,
  type PayloadOf,
  type ResultInputOf,
  type Role,
  type RootRef,
  type SessionEndReason,
  type SessionInfo,
  type TerminalSession,
  type TerminalStatus,
} from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';
import type { SessionLaunchConfig } from '../core/config.ts';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError, notImplemented } from '../core/errors.ts';
import type { AgentSessions, ClientConnection, MemberChange, MemberRecord, PersistentDocument, Principal, SessionAttachStart, SessionManager, UserId, UserTeardown } from '../core/interfaces.ts';
import { SYSTEM_ACTOR, principalCan } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { buildHostEnv } from './host-env.ts';
import { killTree, rememberDescendants, systemProcessInspector, type KillTreeResult, type KnownProcess, type ProcessInspector, type ProcessRow } from './kill-tree.ts';
import { removeSessionFiles } from './launch-files.ts';
import { runProcess, runningHelperPids, type ProcessRunner } from './process-run.ts';
import { PtySession, type PtyExit, type ViewerSink } from './pty-session.ts';

export type { SessionEndReason };

/** Seams for tests and for the composition (the default module passes none). */
export interface SessionsModuleOptions {
  /** The host's environment (default: process.env, read at each session start). */
  readonly hostEnv?: () => Readonly<Record<string, string | undefined>>;
  /** Overrides of config.sessions launch inputs (the agent runtime's seams: a stand-in `claude`, a hook command). */
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

/** A terminal session. `ownerUserId` / `ownerName`: the member who opened it (the wire's `openedBy`). */
interface Managed {
  readonly id: string;
  readonly ownerUserId: UserId;
  readonly ownerName: string;
  readonly root: RootRef;
  readonly worktreeId: string | null;
  readonly createdAt: number;
  /** Only a title the opener typed. Clients build the default from the opener's name, in the viewer's language. */
  readonly title: string | undefined;
  readonly pty: PtySession;
  status: TerminalStatus;
  exitCode: number | undefined;
  endedAt: number | undefined;
  ending: Promise<void> | null;
  endReason: SessionEndReason | null;
  /** Who ended it on purpose (the owner's "End", the host's terminate): shown to the owner. */
  endedBy: { readonly userId: UserId; readonly displayName: string } | null;
  cleaned: boolean;
  retentionTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Descendants of the PTY child seen by the periodic scan (pid → start time). A natural `exit` reparents background
   * jobs to init before node-pty reports it, and on macOS `ps -E` hides the environment of Apple platform binaries
   * (pty-packaging.md gotcha 9): without this, a member's `nohup … &` + `exit` would leave a job behind. Kept for every
   * session (also persisted), so a daemon that died hard can end them at its next start.
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
   * The processes of each live session (the PTY child and its descendants), refreshed every 2 s. A
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

const OUTPUT_PIECE = Math.min(EXEC_OUTPUT_MAX_BYTES, 1024 * 1024);
const DESCENDANT_SCAN_MS = 2_000;
/** Exited sessions kept for late viewers (the retention timer drops them earlier). */
const MAX_EXITED_RETAINED = 32;

function sessionError(code: 'bad_request' | 'not_found' | 'conflict' | 'internal', message: MessageRef, reason: string): SmurgError {
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
  /** Bumped by teardownUser: a creation in flight for that user must not spawn (or must die right after). */
  private readonly userEpochs = new Map<UserId, number>();
  private readonly creating = new Map<UserId, number>();
  private sessionsDir: string | null = null;
  private liveDoc: PersistentDocument<LiveDocument> | null = null;
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
    this.liveDoc = await this.ctx.state.document(LIVE_DOCUMENT, liveDocumentSchema, () => ({ live: [] }));
    // Terminals never survive the daemon: what a run that died hard left behind (its sessions' processes) goes now.
    await this.endLeftovers(this.liveDoc.get()).catch((err: unknown) => this.logError('ending the processes of a previous run failed', err));
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
      m.pty.dispose();
    }
    this.sessions.clear();
    await this.liveDoc?.flush().catch(() => {});
  }

  // =================================================================================================================
  // Queries
  // =================================================================================================================

  /** The agent sessions service, when its module is composed (else the stub: null). */
  private agents(): AgentSessions | null {
    const agents = this.ctx.services.agents;
    return isStubService(agents) ? null : agents;
  }

  /**
   * Terminals, agent sessions of topics that are not archived, free sessions; with `topicId` every agent session of
   * that topic. Oldest first (by creation, then id); everything: the `session.list` handler pages it (the list rule).
   */
  list(filter: { readonly topicId?: string } = {}): SessionInfo[] {
    const terminals: SessionInfo[] = filter.topicId === undefined ? [...this.sessions.values()].map((m) => this.info(m)) : [];
    const agents: SessionInfo[] = this.agents()?.list(filter.topicId === undefined ? {} : { topicId: filter.topicId }) ?? [];
    return [...terminals, ...agents].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get(sessionId: string): SessionInfo | null {
    const m = this.sessions.get(sessionId);
    return m ? this.info(m) : (this.agents()?.get(sessionId) ?? null);
  }

  /** A terminal has no agent; an agent session's actor is the agent runtime's to name (it knows the session's label). */
  agentActor(_sessionId: string): Actor | null {
    return null;
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

  private info(m: Managed): TerminalSession {
    return {
      kind: 'terminal',
      id: m.id,
      openedBy: { userId: m.ownerUserId, displayName: m.ownerName },
      ...(m.title !== undefined ? { title: m.title } : {}),
      root: m.root,
      status: m.status,
      ...(m.exitCode !== undefined ? { exitCode: m.exitCode } : {}),
      cols: m.pty.cols,
      rows: m.pty.rows,
      createdAt: m.createdAt,
      ...(m.endedAt !== undefined ? { endedAt: m.endedAt } : {}),
      // Why it ended and who ended it (a session the host terminated must not read like a normal exit).
      ...(m.status === 'exited' && m.endReason !== null ? { endReason: m.endReason } : {}),
      ...(m.status === 'exited' && m.endedBy !== null ? { endedBy: { userId: m.endedBy.userId, displayName: m.endedBy.displayName } } : {}),
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
    // The member's CURRENT role (the router checked it for this message as well): the host and Agent access.
    if (!can(member.role, 'session.create')) throw new AuthorizationError(undefined, { reason: 'capability' });
    if (this.stopping || !this.started) throw sessionError('conflict', msg('daemon.stopping'), 'stopping');
    if (input.kind === 'agent') return this.createFree(input, principal);
    const running = [...this.sessions.values()].filter((m) => m.status !== 'exited');
    if (running.length + this.inFlight() >= this.limits.maxSessions) throw sessionError('conflict', msg('session.limit'), 'session-limit');
    if (running.filter((m) => m.ownerUserId === userId).length + (this.creating.get(userId) ?? 0) >= this.limits.maxSessionsPerUser) {
      throw sessionError('conflict', msg('session.limitOwner'), 'session-limit');
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

  /**
   * A free agent session (no topic): the caller is `openedBy`, nobody is responsible. In the main workspace it asks
   * before edits and commands; in a worktree of its own before commands. The stub of AgentSessions answers
   * "not implemented" until the agent runtime module is composed.
   */
  private async createFree(input: Extract<PayloadOf<'session.create'>, { kind: 'agent' }>, principal: Principal): Promise<AgentSession> {
    const ctx = this.ctx;
    const firstMessage = input.firstMessage;
    let workspace: { mode: 'main' } | { mode: 'worktree'; worktreeId: string } = { mode: 'main' };
    let release: (() => Promise<void>) | null = null;
    const sessionKey = `free_${randomBytes(8).toString('hex')}`;
    if (input.workspace.mode === 'worktree') {
      const handle = await ctx.services.worktrees.acquireForSession({ owner: principal, sessionId: sessionKey, ...(input.workspace.worktreeId !== undefined ? { worktreeId: input.workspace.worktreeId } : {}) });
      workspace = { mode: 'worktree', worktreeId: handle.worktree.id };
      release = () => ctx.services.worktrees.releaseFromSession(handle.worktree.id, sessionKey, { keep: true });
    }
    try {
      return await ctx.services.agents.start({
        purpose: 'free',
        openedBy: principal,
        responsible: null,
        ...(input.title !== undefined ? { title: input.title } : firstMessage !== undefined ? { title: titleFromFirstMessage(firstMessage) } : {}),
        workspace,
        mode: workspace.mode === 'main' ? 'ask-all' : 'ask-commands',
        // The agent runtime owns the role prompts; a free session's is its four fixed sentences.
        rolePrompt: () => '',
        ...(firstMessage === undefined ? {} : { firstMessage: { kind: 'person' as const, from: principal, text: firstMessage, cleaned: false, origin: 'composer' as const } }),
      });
    } catch (err) {
      await release?.().catch(() => {});
      throw err;
    }
  }

  private inFlight(): number {
    let total = 0;
    for (const count of this.creating.values()) total += count;
    return total;
  }

  /**
   * Starts `member`'s terminal exactly like the host's own (ARCHITECTURE §11 D-15): the host's environment (minus what
   * a parent Claude Code session injects) and HOME = config.sessions.hostHome.
   */
  private async launch(input: Extract<PayloadOf<'session.create'>, { kind: 'terminal' }>, member: MemberRecord): Promise<SessionInfo> {
    const ctx = this.ctx;
    const userId = member.userId;
    const epoch = this.userEpochs.get(userId) ?? 0;
    const id = `ses_${randomBytes(16).toString('hex')}`;
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

      // 2. Environment and command, then spawn.
      const hostEnv = this.hostEnv();
      const env = buildHostEnv({ hostEnv, home: this.launchConfig.hostHome, sessionId: id, hookEnv: {} });
      const file = await this.pickShell(this.options.hostShell, hostEnv['SHELL']);
      const args = ['-l'];
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
      });
      m = this.newManaged({
        id,
        member,
        root,
        worktreeId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        pty,
      });
      this.sessions.set(m.id, m);
      // Every session is in live.json while it runs: its processes are found after a hard death.
      this.liveDoc?.update((draft) => {
        draft.live.push(id);
      });
      // Everything below belongs to the session now: ending it releases its worktree.
      undo.length = 0;
      if (aborted()) {
        await this.finish(m, 'kicked', true);
        throw new AuthorizationError(undefined, { reason: 'owner-removed' });
      }
      ctx.audit.record({
        actor: { kind: 'user', userId, displayName: member.displayName },
        action: 'session.create',
        outcome: 'ok',
        target: m.id,
        detail: { sessionId: m.id, kind: 'terminal', root: rootRefKey(root), ...(worktreeId ? { worktreeId } : {}) },
      });
      this.publish(m, 'created');
      this.ensureDescendantTracking();
      return this.info(m);
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  private newManaged(input: {
    readonly id: string;
    readonly member: MemberRecord;
    readonly root: RootRef;
    readonly worktreeId: string | null;
    readonly title?: string;
    readonly pty: PtySession;
  }): Managed {
    return {
      id: input.id,
      ownerUserId: input.member.userId,
      ownerName: input.member.displayName,
      root: input.root,
      worktreeId: input.worktreeId,
      createdAt: this.ctx.clock.now(),
      title: input.title,
      pty: input.pty,
      status: 'running',
      exitCode: undefined,
      endedAt: undefined,
      ending: null,
      endReason: null,
      endedBy: null,
      cleaned: false,
      retentionTimer: undefined,
      known: new Map(),
      persistedProcs: '',
    };
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
    throw sessionError('internal', msg('session.noShell'), 'no-shell');
  }

  // =================================================================================================================
  // Attach / detach / input / resize
  // =================================================================================================================

  async attach(input: PayloadOf<'session.attach'>, conn: ClientConnection, principal: Principal): Promise<SessionAttachStart> {
    const m = this.requireTerminal(input.sessionId);
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
      // relay): the PTY pauses while it is too much.
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

  /** Keystrokes from any member who may drive sessions (`session.drive`: the host, Agent access), into any session. */
  input(input: PayloadOf<'exec.input'>, conn: ClientConnection, principal: Principal): void {
    const m = this.requireTerminal(input.sessionId);
    this.requireDriver(principal);
    if (!m.pty.input(conn.channelId, input.data)) throw sessionError('conflict', msg('session.exited'), 'session-exited');
  }

  resize(input: PayloadOf<'exec.resize'>, conn: ClientConnection, principal: Principal): void {
    const m = this.requireTerminal(input.sessionId);
    this.requireOwnerPrincipal(m, principal);
    m.pty.ownerViewport(conn.channelId, input.cols, input.rows);
  }

  /** A terminal, or `bad_request` reason `not-a-terminal` for an agent session (it has no PTY: `session.notTerminal`). */
  private requireTerminal(sessionId: string): Managed {
    const m = this.sessions.get(sessionId);
    if (m) return m;
    if (this.agents()?.get(sessionId)) throw sessionError('bad_request', msg('session.notTerminal'), 'not-a-terminal');
    throw sessionError('not_found', msg('session.notFound'), 'unknown-session');
  }

  private requireSession(sessionId: string): Managed {
    const m = this.sessions.get(sessionId);
    if (!m) throw sessionError('not_found', msg('session.notFound'), 'unknown-session');
    return m;
  }

  private requireOwnerPrincipal(m: Managed, principal: Principal): void {
    if (principal.userId === null || principal.userId !== m.ownerUserId) {
      throw new AuthorizationError(undefined, { reason: 'not-owner:session' });
    }
  }

  /** `session.drive` (the host, Agent access): may type into any session and decide its suggestions (§11 D-15). */
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

  /** Agent sessions only; the check itself (`claude auth status --json`) is the agent runtime's. */
  async loginStatus(sessionId: string, principal: Principal): Promise<LoginState> {
    this.requireDriver(principal);
    if (this.sessions.has(sessionId)) throw sessionError('bad_request', msg('session.notAgent'), 'not-an-agent');
    if (!this.agents()?.get(sessionId)) throw sessionError('not_found', msg('session.notFound'), 'unknown-session');
    throw notImplemented('session.loginStatus');
  }

  // =================================================================================================================
  // Ending
  // =================================================================================================================

  async end(input: PayloadOf<'session.end'>, principal: Principal): Promise<void> {
    // C17: only an explicit keepWorktree: false removes the worktree with the session.
    const keep = input.keepWorktree !== false;
    const m = this.sessions.get(input.sessionId);
    if (!m) {
      await this.endAgent(input.sessionId, principal, keep);
      return;
    }
    this.requireOwnerPrincipal(m, principal);
    const already = m.ending !== null;
    await this.finish(m, 'ended', keep, principal);
    if (!already) {
      this.ctx.audit.record({ actor: principal.actor, action: 'session.end', outcome: 'ok', target: m.id, detail: { sessionId: m.id, kind: 'terminal', keepWorktree: keep } });
    }
  }

  /** An agent session: the host, or a member with agent access who opened it or is responsible for it; never a discussion. */
  private async endAgent(sessionId: string, principal: Principal, keepWorktree: boolean): Promise<void> {
    const agents = this.agents();
    const session = agents?.get(sessionId) ?? null;
    if (!agents || !session) throw sessionError('not_found', msg('session.notFound'), 'unknown-session');
    if (session.purpose === 'discussion') throw new AuthorizationError(msg('session.end.discussion'), { reason: 'discussion' });
    const member = principal.userId !== null && principal.role !== null ? { userId: principal.userId, role: principal.role } : null;
    if (!member || !mayEndSession(member, { kind: 'agent', purpose: session.purpose, openedBy: session.openedBy.userId, responsible: session.responsible?.userId ?? null })) {
      throw new AuthorizationError(msg('session.end.notAllowed'), { reason: 'not-allowed:session' });
    }
    // `keepWorktree` is a free session's choice. A work item's worktree is the item's: only PlanService releases it.
    const keep = session.purpose === 'free' ? keepWorktree : true;
    await agents.end(sessionId, { by: principal.actor, reason: 'ended', keepWorktree: keep });
    this.ctx.audit.record({ actor: principal.actor, action: 'session.end', outcome: 'ok', target: sessionId, detail: { sessionId, kind: 'agent', purpose: session.purpose, ...(session.topicId === undefined ? {} : { topicId: session.topicId }), ...(session.itemId === undefined ? {} : { itemId: session.itemId }), keepWorktree: keep } });
  }

  async terminate(sessionId: string, by: Principal): Promise<void> {
    const m = this.sessions.get(sessionId);
    if (!m) {
      const agents = this.agents();
      const session = agents?.get(sessionId) ?? null;
      if (!agents || !session) throw sessionError('not_found', msg('session.notFound'), 'unknown-session');
      await agents.end(sessionId, { by: by.actor, reason: 'terminated', keepWorktree: true });
      this.ctx.audit.record({ actor: by.actor, action: 'session.terminate', outcome: 'ok', target: sessionId, detail: { sessionId, openedBy: session.openedBy.userId, kind: 'agent', purpose: session.purpose } });
      return;
    }
    await this.finish(m, 'terminated', true, by);
    this.ctx.audit.record({ actor: by.actor, action: 'session.terminate', outcome: 'ok', target: m.id, detail: { sessionId: m.id, openedBy: m.ownerUserId, kind: 'terminal' } });
  }

  /**
   * A member was kicked, left, or lost a role (ARCHITECTURE §3 "When a member goes"). Foundation state: the
   * TERMINALS they opened end when they may no longer open sessions, each audited `session.terminate` by the system;
   * a creation in flight for them is abandoned (userEpochs). What happens to their agent sessions (free sessions end,
   * topic sessions pass to the host, they are cleared as responsible person and fallback decider) is the agent
   * runtime's part of this method.
   */
  async teardownUser(userId: UserId, change: MemberChange, to?: Role): Promise<UserTeardown> {
    const maySessions = change === 'role-changed' && to !== undefined && can(to, 'session.create');
    if (maySessions) return { ended: [], handedOver: [], cleared: [] };
    this.userEpochs.set(userId, (this.userEpochs.get(userId) ?? 0) + 1);
    const mine = [...this.sessions.values()].filter((m) => m.ownerUserId === userId && m.status !== 'exited' && m.ending === null);
    await Promise.all(
      mine.map(async (m) => {
        await this.finish(m, change, true);
        this.ctx.audit.record({
          actor: SYSTEM_ACTOR,
          action: 'session.terminate',
          outcome: 'ok',
          target: m.id,
          detail: { sessionId: m.id, openedBy: m.ownerUserId, kind: 'terminal', reason: change },
        });
      }),
    );
    return { ended: mine.map((m) => m.id), handedOver: [], cleared: [] };
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

  /** Descendants, remembered every 2 s while a session runs (see Managed.known), and persisted. */
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
    m.status = 'exited';
    m.endedAt = this.ctx.clock.now();
    const exit = m.pty.exit;
    if (exit) m.exitCode = exit.exitCode;
    m.known = new Map();
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

  private logError(message: string, err: unknown): void {
    this.ctx.log.error(message, { error: err instanceof SmurgError ? `${err.code}:${String(err.detail?.['reason'] ?? '')}` : err instanceof Error ? err.name : 'unknown' });
  }
}
