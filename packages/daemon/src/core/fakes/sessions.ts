// TEST ONLY. An in-memory session registry (SessionManager) over the fake agent sessions plus terminals without a PTY,
// and a HookServer that registers and hands out launch file paths without writing anything.
import {
  MAIN_ROOT,
  SmurgError,
  defaultPermissionMode,
  lineEvent,
  mayEndSession,
  worktreeRoot,
  type Actor,
  type LoginState,
  type PayloadOf,
  type Role,
  type SessionInfo,
  type TerminalSession,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type {
  ClientConnection,
  HookServer,
  HookSessionCredentials,
  HookSessionRegistration,
  LaunchProfile,
  MemberChange,
  Principal,
  Req,
  SessionAttachStart,
  SessionLaunchFiles,
  SessionManager,
  UserId,
  UserTeardown,
  WorktreeManager,
} from '../interfaces.ts';
import type { FakeAgentSessions } from './agents.ts';
import { buildTerminalSession } from './build.ts';
import { CallLog, fakeId, type FakeEnv } from './env.ts';

const SYSTEM: Actor = { kind: 'system' };

export class FakeSessionManager implements SessionManager {
  readonly log = new CallLog();
  loginState: LoginState = 'logged-in';
  private readonly env: FakeEnv;
  private readonly agents: FakeAgentSessions;
  private readonly worktrees: Pick<WorktreeManager, 'setOwner' | 'list'> | null;
  private readonly terminals = new Map<string, TerminalSession>();

  /** With `worktrees`, a handed-over work item's worktree passes to the host too (as the real teardown does). */
  constructor(env: FakeEnv, agents: FakeAgentSessions, worktrees: Pick<WorktreeManager, 'setOwner' | 'list'> | null = null) {
    this.env = env;
    this.agents = agents;
    this.worktrees = worktrees;
  }

  async create(input: Req<'session.create'>, _conn: ClientConnection, principal: Principal): Promise<SessionInfo> {
    this.log.record('create', input, principal);
    if (input.kind === 'agent') {
      const workspace = input.workspace.mode === 'main' ? ({ mode: 'main' } as const) : ({ mode: 'worktree', worktreeId: input.workspace.worktreeId ?? fakeId('wt') } as const);
      const openerName = principal.actor.kind === 'user' ? principal.actor.displayName : 'Host';
      return this.agents.start({
        purpose: 'free',
        openedBy: principal,
        responsible: null,
        ...(input.title === undefined ? {} : { title: input.title }),
        workspace,
        mode: defaultPermissionMode('free', workspace.mode === 'main' ? MAIN_ROOT : worktreeRoot(workspace.worktreeId)),
        rolePrompt: ({ smurgTag }) => `fake free session prompt [smurg ${smurgTag}]`,
        opening: msg('conversation.started.free', { name: openerName }),
        ...(input.firstMessage === undefined ? {} : { firstMessage: { kind: 'person' as const, from: principal, text: input.firstMessage, cleaned: false, origin: 'composer' as const } }),
      });
    }
    const terminal = buildTerminalSession({
      id: fakeId('sess'),
      openedBy: principal.actor.kind === 'user' ? { userId: principal.actor.userId, displayName: principal.actor.displayName } : { userId: principal.userId ?? 'dev:host', displayName: 'Host' },
      title: input.title,
      root: MAIN_ROOT,
      cols: input.cols,
      rows: input.rows,
      createdAt: this.env.clock.now(),
    });
    this.terminals.set(terminal.id, terminal);
    this.env.bus.emit('session.created', { session: structuredClone(terminal) });
    return structuredClone(terminal);
  }

  list(filter: { readonly topicId?: string } = {}): SessionInfo[] {
    const terminals: SessionInfo[] = filter.topicId === undefined ? [...this.terminals.values()] : [];
    // Oldest first; sessions of the same instant stay in the order they were made (the sort is stable).
    return [...terminals, ...this.agents.list(filter)].sort((a, b) => a.createdAt - b.createdAt).map((session) => structuredClone(session));
  }

  get(sessionId: string): SessionInfo | null {
    const terminal = this.terminals.get(sessionId);
    return terminal ? structuredClone(terminal) : this.agents.get(sessionId);
  }

  async attach(input: Req<'session.attach'>, _conn: ClientConnection, _principal: Principal): Promise<SessionAttachStart> {
    const terminal = this.terminal(input.sessionId);
    return { result: { session: structuredClone(terminal), mode: 'snapshot', data: new Uint8Array(0), cols: terminal.cols, rows: terminal.rows, nextOffset: 0 }, afterReply: () => {} };
  }

  detach(sessionId: string, channelId: string): void {
    this.log.record('detach', sessionId, channelId);
  }

  /** `session.rename` of a terminal (the real registry does it inside its handler): bus `session.updated`. */
  renameTerminal(sessionId: string, title: string): void {
    const terminal = { ...this.terminal(sessionId), title };
    this.terminals.set(sessionId, terminal);
    this.env.bus.emit('session.updated', { session: structuredClone(terminal) });
  }

  input(input: PayloadOf<'exec.input'>, _conn: ClientConnection, principal: Principal): void {
    this.log.record('input', input, principal);
    this.terminal(input.sessionId);
  }

  resize(input: PayloadOf<'exec.resize'>, _conn: ClientConnection, principal: Principal): void {
    this.log.record('resize', input, principal);
    const terminal = this.terminal(input.sessionId);
    this.terminals.set(terminal.id, { ...terminal, cols: input.cols, rows: input.rows });
  }

  async end(input: Req<'session.end'>, principal: Principal): Promise<void> {
    this.log.record('end', input, principal);
    const session = this.get(input.sessionId);
    if (!session) throw new SmurgError('not_found', msg('session.notFound'));
    const member = { userId: principal.userId ?? '', role: principal.role ?? ('viewer' as Role) };
    if (session.kind === 'agent' && session.purpose === 'discussion') throw new SmurgError('forbidden', msg('session.end.discussion'), { reason: 'discussion' });
    const allowed =
      session.kind === 'terminal'
        ? mayEndSession(member, { kind: 'terminal', openedBy: session.openedBy.userId })
        : mayEndSession(member, { kind: 'agent', purpose: session.purpose, openedBy: session.openedBy.userId, responsible: session.responsible?.userId ?? null });
    if (!allowed) throw new SmurgError('forbidden', msg('session.end.notAllowed'), { reason: 'not-allowed' });
    // `keepWorktree` is a terminal's and a free session's choice; a topic session's worktree is never released here.
    await this.finish(session, 'ended', principal.actor, session.kind === 'agent' && session.purpose !== 'free' ? true : input.keepWorktree !== false);
  }

  async terminate(sessionId: string, by: Principal): Promise<void> {
    this.log.record('terminate', sessionId, by);
    const session = this.get(sessionId);
    if (!session) throw new SmurgError('not_found', msg('session.notFound'));
    await this.finish(session, 'terminated', by.actor, true);
  }

  /**
   * The real per-session decision over the fake agents, with the lines the contract gives this method:
   * `conversation.owner.handover` / `.kicked` for a handed-over session, ONE `conversation.responsible.fallback` per
   * session whose responsible person or fallback decider was cleared.
   */
  async teardownUser(userId: UserId, change: MemberChange, to?: Role): Promise<UserTeardown> {
    this.log.record('teardownUser', userId, change, to);
    const losesSessions = change !== 'role-changed' || (to !== 'host' && to !== 'agent');
    const losesDiscuss = change !== 'role-changed' || to === 'viewer';
    const ended: string[] = [];
    const handedOver: { sessionId: string; topicId: string; stopped: boolean }[] = [];
    const host = this.env.members?.hostUserId() ?? 'dev:host';
    const hostPrincipal: Principal = { kind: 'user', actor: { kind: 'user', userId: host, displayName: this.env.members?.userRef(host)?.displayName ?? 'Host' }, userId: host, role: 'host' };
    const name = this.env.members?.userRef(userId)?.displayName ?? userId.slice(userId.indexOf(':') + 1);
    if (losesSessions) {
      for (const session of this.list()) {
        if (session.openedBy.userId !== userId) continue;
        if (session.kind === 'terminal' ? session.status === 'exited' : session.status === 'ended') continue;
        if (session.kind === 'agent' && session.topicId !== undefined) {
          if (this.agents.facts(session.id)?.ownerUserId !== userId) continue; // handed over before
          if (change === 'kicked') await this.agents.interrupt(session.id, SYSTEM);
          this.agents.setOwner(session.id, host, SYSTEM);
          const worktreeId = this.agents.facts(session.id)?.worktreeId;
          if (session.purpose === 'item' && worktreeId !== undefined) await this.worktrees?.setOwner(worktreeId, hostPrincipal);
          this.agents.append(session.id, lineEvent(change === 'kicked' ? msg('conversation.owner.handover.kicked', { name }) : msg('conversation.owner.handover', { name })));
          handedOver.push({ sessionId: session.id, topicId: session.topicId, stopped: change === 'kicked' });
        } else {
          await this.finish(session, change, SYSTEM, true);
          ended.push(session.id);
        }
      }
      // Every worktree they still own passes to the host, after a kick or a demotion (a member who leaves keeps theirs).
      if (userId !== host && change !== 'left') for (const worktree of this.worktrees?.list() ?? []) if (worktree.ownerUserId === userId) await this.worktrees?.setOwner(worktree.id, hostPrincipal);
    }
    const cleared = new Set<string>();
    if (losesDiscuss) {
      for (const sessionId of this.agents.clearFallbackDecider(userId)) cleared.add(sessionId);
      for (const session of this.agents.list()) {
        if (session.responsible?.userId !== userId) continue;
        this.agents.setResponsible(session.id, null, SYSTEM);
        cleared.add(session.id);
      }
      for (const sessionId of cleared) if (this.agents.get(sessionId)?.status !== 'ended') this.agents.append(sessionId, lineEvent(msg('conversation.responsible.fallback', { name })));
    }
    return { ended, handedOver, cleared: [...cleared] };
  }

  async loginStatus(sessionId: string, principal: Principal): Promise<LoginState> {
    this.log.record('loginStatus', sessionId, principal);
    if (this.agents.get(sessionId) === null) throw new SmurgError('bad_request', msg('session.notAgent'), { reason: 'not-an-agent' });
    return this.loginState;
  }

  agentActor(sessionId: string): Actor | null {
    return this.agents.get(sessionId) === null ? null : this.agents.agentActor(sessionId);
  }

  async stopAll(): Promise<void> {
    this.log.record('stopAll');
    for (const terminal of [...this.terminals.values()]) if (terminal.status !== 'exited') await this.finish(terminal, 'stopped', SYSTEM, true);
  }

  private terminal(sessionId: string): TerminalSession {
    const terminal = this.terminals.get(sessionId);
    if (terminal) return terminal;
    if (this.agents.get(sessionId) !== null) throw new SmurgError('bad_request', msg('session.notTerminal'), { reason: 'not-a-terminal' });
    throw new SmurgError('not_found', msg('session.notFound'));
  }

  private async finish(session: SessionInfo, reason: 'ended' | 'terminated' | 'stopped' | MemberChange, by: Actor, keepWorktree: boolean): Promise<void> {
    if (session.kind === 'agent') {
      await this.agents.end(session.id, { by, reason, keepWorktree });
      return;
    }
    const ended: TerminalSession = {
      ...session,
      status: 'exited',
      endedAt: this.env.clock.now(),
      endReason: reason,
      ...(by.kind === 'user' ? { endedBy: { userId: by.userId, displayName: by.displayName } } : {}),
    };
    this.terminals.set(session.id, ended);
    this.env.bus.emit('session.exited', { session: structuredClone(ended), reason });
  }
}

export class FakeHookServer implements HookServer {
  readonly log = new CallLog();
  readonly socketPath = '/fake/run/hook.sock';
  readonly registrations = new Map<string, HookSessionRegistration>();
  readonly profiles = new Map<string, LaunchProfile>();

  registerSession(session: HookSessionRegistration): HookSessionCredentials {
    this.log.record('registerSession', session);
    this.registrations.set(session.sessionId, { ...session });
    const token = `fake-token-${session.sessionId}`;
    return { token, env: { SMURG_HOOK_SOCKET: this.socketPath, SMURG_SESSION_TOKEN: token, SMURG_SESSION_ID: session.sessionId } };
  }

  reassignSession(sessionId: string, ownerUserId: UserId): void {
    this.log.record('reassignSession', sessionId, ownerUserId);
    const registration = this.registrations.get(sessionId);
    if (registration) this.registrations.set(sessionId, { ...registration, ownerUserId }); // pathRights untouched
  }

  unregisterSession(sessionId: string): void {
    this.log.record('unregisterSession', sessionId);
    this.registrations.delete(sessionId);
    this.profiles.delete(sessionId);
  }

  async writeSessionFiles(sessionId: string, launch: LaunchProfile): Promise<SessionLaunchFiles> {
    this.log.record('writeSessionFiles', sessionId, launch);
    if (!this.registrations.has(sessionId)) throw new SmurgError('internal', undefined, { reason: 'not-registered' });
    this.profiles.set(sessionId, launch);
    const dir = `/fake/sessions/${Buffer.from(sessionId, 'utf8').toString('hex')}`;
    const files = { dir, settingsPath: `${dir}/settings.json`, mcpConfigPath: `${dir}/mcp.json`, rolePromptPath: `${dir}/role.md` };
    return {
      ...files,
      claudeArgs: [
        '--settings', files.settingsPath,
        '--mcp-config', files.mcpConfigPath,
        '--append-system-prompt-file', files.rolePromptPath,
        '--permission-mode', launch.mode,
        '--tools', launch.tools.join(','),
        ...(launch.strictMcp ? ['--strict-mcp-config'] : []),
        ...(launch.settingSources === 'user' ? ['--setting-sources', 'user'] : []),
      ],
    };
  }

  async removeSessionFiles(sessionId: string): Promise<void> {
    this.log.record('removeSessionFiles', sessionId);
    this.profiles.delete(sessionId);
  }
}
