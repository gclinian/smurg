// AgentSessions (ARCHITECTURE §7.2, §7.6; DESIGN §2): Claude Code in structured mode, one process per LIVE session.
// This is the service the rest of the daemon sees (core/interfaces.ts `AgentSessions`): the records, the conversation
// log and its watchers, limits, parking, the account state, and who writes which system line and audit entry. What
// one session's process does is the runner's (agent-runner.ts).
//
//  - A session survives a daemon restart as an idle session (AD-10): its transcript is on the host and the next
//    message starts a new process with `--resume`. After a restart nothing runs by itself.
//  - Watchers are keyed by the logical channel. Events go out in batches (EVENTS_BATCH_MS / EVENTS_BATCH_MAX /
//    EVENTS_BATCH_MAX_BYTES); text deltas are volatile and the runner's own.
//  - `maxLiveAgents` is NOT enforced here: that host setting is the scheduler's. This service enforces
//    `maxAgentSessions` and `maxAgentProcesses`, and emits `agent.process` on every change of `hasProcess`.
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVENTS_BATCH_MAX,
  EVENTS_BATCH_MAX_BYTES,
  EVENTS_CATCH_UP_MAX,
  EVENTS_PAGE_MAX,
  MAIN_ROOT,
  REMEMBERED_RULES_MAX,
  SMURG_TAG_ALPHABET,
  SmurgError,
  agentDisplayName,
  agentSafeName,
  agentText,
  checkRememberableRule,
  defaultPermissionMode,
  encodedSize,
  frameMessage,
  lineEvent,
  noticeEvent,
  personHeader,
  rootRefEquals,
  rootRefKey,
  ruleString,
  smurgHeader,
  suggestionHeader,
  titleFromFirstMessage,
  worktreeRoot,
  type AccountInfo,
  type Actor,
  type AgentSession,
  type ConversationEvent,
  type ConversationEventInput,
  type LoginState,
  type PayloadInputOf,
  type PermissionMode,
  type RememberedRule,
  type Role,
  type RootRef,
  type SessionEndReason,
  type UserRef,
} from '@smurg/protocol';
import { msg, renderEnglish, type MessageRef } from '@smurg/protocol/i18n';
import { ensurePrivateDirectory } from '@smurg/protocol/node';
import { claudeVersionVerdict, type AgentsConfig, type SessionLaunchConfig } from '../../core/config.ts';
import type { DaemonContext } from '../../core/context.ts';
import type {
  AgentSessionFacts,
  AgentSessions,
  AgentStartInput,
  AppendableEvent,
  AttentionFact,
  ClientConnection,
  DaemonStatus,
  EventsPage,
  OutboundMessage,
  OutboundType,
  Principal,
  Req,
  StalledBy,
  TurnMessage,
  UserId,
  WatchStart,
} from '../../core/interfaces.ts';
import { newId } from '../../core/lifecycle.ts';
import { SYSTEM_ACTOR } from '../../core/permissions.ts';
import { isStubService } from '../../core/stubs.ts';
import { ClaudeVersionProbe, parseAuthStatus, resolveClaude, type ClaudeBinary } from '../claude.ts';
import { buildHostEnv } from '../host-env.ts';
import { killTree, type ProcessInspector } from '../kill-tree.ts';
import { runningHelperPids, type ProcessRunner } from '../process-run.ts';
import { AgentRunner, type LaunchPlan, type Outgoing, type RunnerHost } from './agent-runner.ts';
import type { HostRulesImpl } from './host-rules.ts';
import { buildProfile, checkLaunchArgs, claudeModeFor, gateToolsOf } from './profiles.ts';
import type { ProjectTrustImpl } from './project-settings.ts';
import { freeRolePrompt } from './prompts.ts';
import { AgentStore, type AgentRecord } from './store.ts';
import { Transcript } from './transcript.ts';

export interface AgentSessionsDeps {
  readonly hostEnv: () => Readonly<Record<string, string | undefined>>;
  readonly launch: SessionLaunchConfig;
  readonly inspector: ProcessInspector;
  readonly runner: ProcessRunner;
  readonly killDeadlineMs: number;
  readonly maxPidsPerSession: number;
  readonly authStatusTimeoutMs: number;
  readonly trust: ProjectTrustImpl;
  readonly hostRules: HostRulesImpl;
  /** The registry's live list (live.json): an agent child is found after a hard death like a PTY child. */
  readonly live: { add(sessionId: string): void; remove(sessionId: string): void };
  /** Children of the daemon that belong to other sessions (the registry's PTY children). */
  readonly foreignChildren: () => ReadonlySet<number>;
}

interface Watcher {
  readonly userId: UserId;
  live: boolean;
  /** Events appended while the watch reply is built; null once the channel is live. */
  hold: ConversationEvent[] | null;
}

interface Entry {
  readonly runner: AgentRunner;
  readonly transcript: Transcript;
  readonly watchers: Map<string, Watcher>;
  batch: ConversationEvent[];
  batchBytes: number;
  batchTimer: ReturnType<typeof setTimeout> | undefined;
  /** `seq` of the card events appended in this run (a segment holding an open card's event is never trimmed). */
  readonly cardSeqs: Map<string, number>;
  trimmedSaid: boolean;
}

const HOLD_MAX = 5_000;
const SESSION_ID = (): string => `ses_${randomBytes(16).toString('hex')}`;

function userOf(actor: Actor): UserRef | null {
  return actor.kind === 'user' ? { userId: actor.userId, displayName: actor.displayName } : null;
}

function agentError(code: 'bad_request' | 'not_found' | 'conflict' | 'forbidden' | 'internal', text: MessageRef, reason: string): SmurgError {
  return new SmurgError(code, text, { reason });
}

export class AgentSessionsImpl implements AgentSessions {
  readonly ctx: DaemonContext;
  readonly config: AgentsConfig;
  private readonly deps: AgentSessionsDeps;
  private readonly entries = new Map<string, Entry>();
  private store: AgentStore | null = null;
  private transcriptsDir = '';
  private probe: ClaudeVersionProbe | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private started = false;
  private accountState: { state: AccountInfo['state']; resetsAt?: number; since: number } = { state: 'ok', since: 0 };
  private claudeStatus: NonNullable<DaemonStatus['claude']> | null = null;
  private loginChecked: { at: number; state: LoginState } | null = null;
  private readonly notified = new Set<string>();
  private subscriptionSaid = false;
  private storageFull = false;
  private lastRetention = 0;

  /** What a runner may ask of this service. */
  private readonly host: RunnerHost;

  constructor(ctx: DaemonContext, deps: AgentSessionsDeps) {
    this.ctx = ctx;
    this.config = ctx.config.agents;
    this.deps = deps;
    this.host = {
      ctx,
      config: this.config,
      append: (runner, input, sync) => this.push(this.need(runner.id), input, sync),
      publish: (runner, options) => this.publish(runner, options),
      save: (runner) => this.save(runner),
      processChanged: (runner, reason) => this.processChanged(runner, reason),
      prepareLaunch: (runner) => this.prepareLaunch(runner),
      releaseLaunch: (runner) => this.releaseLaunch(runner),
      kill: (runner) => this.kill(runner),
      delta: (runner, payload) => this.delta(runner, payload),
      account: (runner, signal) => this.accountSignal(runner, signal),
      hostRules: (rules) => this.deps.hostRules.report(rules),
      personalSubscription: () => this.personalSubscription(),
      agentActor: (runner) => this.agentActor(runner),
      rootGone: (runner) => this.rootGone(runner),
      rss: (pid) => this.rss(pid),
      idle: (runner) => this.idle(runner),
    };
  }

  // =================================================================================================================
  // Lifecycle
  // =================================================================================================================

  /** Module start: the records of earlier runs come back as idle sessions. */
  async open(): Promise<void> {
    if (this.started) return;
    const stateDir = this.ctx.config.workspaceStateDir;
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    this.transcriptsDir = join(stateDir, 'transcripts');
    await ensurePrivateDirectory(this.transcriptsDir);
    await mkdir(join(this.ctx.config.stateDir, 'sessions'), { recursive: true, mode: 0o700 });
    this.probe = new ClaudeVersionProbe({ scratchParent: join(this.ctx.config.stateDir, 'sessions'), run: this.deps.runner });
    this.store = await AgentStore.open(this.ctx.state);
    for (const record of this.store.all()) {
      // Whatever a record was doing when the daemon went away, it is idle now (parked): nothing restarts by itself.
      const unattended = record.state !== 'ended' && record.lastTurnOpen;
      if (record.state === 'failed') record.state = 'live';
      record.lastTurnOpen = false;
      const entry = await this.adopt(record, await this.readRolePrompt(record.id));
      if (unattended) {
        // The orphan could at most receive more model text: its next tool call was refused by the gate.
        this.push(entry, { kind: 'turn.finished', turnId: `t_${record.turnCounter}`, outcome: 'interrupted', durationMs: 0 }, true);
        this.push(entry, noticeEvent('warning', msg('notice.unattended')), true);
        if (record.item !== undefined) record.itemState = { reportRegistered: record.itemState?.reportRegistered ?? false, stalled: 'restart' };
      }
      this.store.save(record);
    }
    this.started = true;
    this.sweepTimer = setInterval(() => void this.sweep().catch((err: unknown) => this.logError('agent sweep failed', err)), Math.max(10, this.config.escalationSweepMs));
    this.sweepTimer.unref?.();
  }

  /** stop(): every runner ends its process; the records stay (idle). */
  async stopAll(): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        try {
          if (entry.runner.record.state !== 'ended') await entry.runner.shutdown('stop', undefined);
          this.flushBatch(entry);
          if (entry.batchTimer !== undefined) clearTimeout(entry.batchTimer);
          await entry.transcript.close();
        } catch (err) {
          this.logError('stopping an agent session failed', err);
        }
      }),
    );
    await this.store?.flush().catch(() => {});
  }

  private transcriptDir(sessionId: string): string {
    return join(this.transcriptsDir, Buffer.from(sessionId, 'utf8').toString('hex'));
  }

  private async readRolePrompt(sessionId: string): Promise<string> {
    try {
      return await readFile(join(this.transcriptDir(sessionId), 'role.md'), 'utf8');
    } catch {
      return '';
    }
  }

  private async adopt(record: AgentRecord, rolePrompt: string): Promise<Entry> {
    const transcript = await Transcript.open(this.transcriptDir(record.id), {
      segmentBytes: this.config.transcriptSegmentBytes,
      flushMs: this.config.transcriptFlushMs,
      flushBytes: this.config.transcriptFlushBytes,
      onError: (err) => this.logError('a conversation log could not be written', err),
    });
    const entry: Entry = { runner: new AgentRunner(this.host, record, rolePrompt), transcript, watchers: new Map(), batch: [], batchBytes: 0, batchTimer: undefined, cardSeqs: new Map(), trimmedSaid: false };
    this.entries.set(record.id, entry);
    return entry;
  }

  // =================================================================================================================
  // Queries
  // =================================================================================================================

  private need(sessionId: string): Entry {
    const entry = this.entries.get(sessionId);
    if (!entry) throw agentError('not_found', msg('session.notFound'), 'unknown-session');
    return entry;
  }

  private topicRules(topicId: string | undefined): readonly RememberedRule[] {
    if (topicId === undefined || isStubService(this.ctx.services.topics)) return [];
    try {
      return this.ctx.services.topics.rules(topicId);
    } catch {
      return [];
    }
  }

  private wire(entry: Entry): AgentSession {
    const { runner, transcript } = entry;
    const record = runner.record;
    const status = runner.status();
    const ended = record.state === 'ended';
    return {
      kind: 'agent',
      id: record.id,
      openedBy: { ...record.openedBy },
      root: record.root,
      createdAt: record.createdAt,
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      ...(ended && record.endReason !== undefined ? { endReason: record.endReason } : {}),
      ...(ended && record.endedBy !== undefined ? { endedBy: { ...record.endedBy } } : {}),
      purpose: record.purpose,
      ...(record.topic === undefined ? {} : { topicId: record.topic.id, topicName: record.topic.name }),
      ...(record.item === undefined ? {} : { itemId: record.item.id, item: { number: record.item.number, title: record.item.title }, attempt: record.item.attempt }),
      responsible: record.responsible === null ? null : { ...record.responsible },
      ...(record.title === undefined ? {} : { title: record.title }),
      ...(record.branch === undefined || record.branch.length === 0 ? {} : { branch: record.branch }),
      status,
      ...(runner.waitingSince !== undefined && (status === 'waiting-answer' || status === 'waiting-permission') ? { waitingSince: runner.waitingSince } : {}),
      ...(runner.runningSince !== undefined && !ended ? { runningSince: runner.runningSince } : {}),
      ...(runner.doing === undefined ? {} : { doing: runner.doing }),
      ...(status === 'failed' && record.startFailures >= this.config.startFailuresHostOnly ? { retryHostOnly: true as const } : {}),
      permissionMode: record.mode,
      modeFixed: record.purpose === 'discussion',
      ruleCount: record.rules.length + this.topicRules(record.topic?.id).length,
      login: runner.login,
      ...(record.claudeVersion === undefined ? {} : { claudeVersion: record.claudeVersion }),
      projectSettings: runner.projectSettings,
      noteworthyAt: record.noteworthyAt,
      lastSeq: transcript.lastSeq,
      lastActivityAt: record.lastActivityAt,
    };
  }

  get(sessionId: string): AgentSession | null {
    const entry = this.entries.get(sessionId);
    return entry ? this.wire(entry) : null;
  }

  private isArchived(topicId: string): boolean {
    if (isStubService(this.ctx.services.topics)) return false;
    try {
      return this.ctx.services.topics.get(topicId)?.archived === true;
    } catch {
      return false;
    }
  }

  list(filter: { readonly topicId?: string } = {}): AgentSession[] {
    const archived = new Map<string, boolean>();
    const hidden = (topicId: string): boolean => {
      let value = archived.get(topicId);
      if (value === undefined) {
        value = this.isArchived(topicId);
        archived.set(topicId, value);
      }
      return value;
    };
    return [...this.entries.values()]
      .filter((entry) => {
        const topicId = entry.runner.record.topic?.id;
        return filter.topicId === undefined ? topicId === undefined || !hidden(topicId) : topicId === filter.topicId;
      })
      .map((entry) => this.wire(entry))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Every session, those of archived topics included, oldest first (the registry's teardown). */
  everySession(): AgentSession[] {
    return [...this.entries.values()].map((entry) => this.wire(entry)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  facts(sessionId: string): AgentSessionFacts | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    const record = entry.runner.record;
    return {
      sessionId,
      purpose: record.purpose,
      ...(record.topic === undefined ? {} : { topicId: record.topic.id }),
      ...(record.item === undefined ? {} : { itemId: record.item.id }),
      attempt: record.item?.attempt ?? 1,
      root: record.root,
      ...(record.worktreeId === undefined ? {} : { worktreeId: record.worktreeId }),
      openedBy: { ...record.openedBy },
      ownerUserId: record.ownerUserId,
      pathRights: record.pathRights,
      fallbackDecider: record.fallbackDecider,
      ...(record.modeChangedBy === undefined ? {} : { modeChangedBy: record.modeChangedBy.userId }),
      hasProcess: entry.runner.hasProcess,
    };
  }

  /** The agent's name in locks, presence, the activity feed and the audit log. */
  private agentName(record: AgentRecord): string {
    const label = record.item?.title ?? record.topic?.name ?? record.openedBy.displayName;
    return agentDisplayName(agentSafeName(label, record.openedBy.userId));
  }

  agentActor(runner: AgentRunner): Actor {
    return { kind: 'agent', sessionId: runner.id, ownerUserId: runner.record.ownerUserId, displayName: this.agentName(runner.record) };
  }

  /** Actor of the session's agent, or null (the registry's `agentActor`). */
  actorOf(sessionId: string): Actor | null {
    const entry = this.entries.get(sessionId);
    return entry ? this.agentActor(entry.runner) : null;
  }

  /** Pids of the agent children (never part of another session's kill). */
  childPids(): number[] {
    const out: number[] = [];
    for (const entry of this.entries.values()) {
      const pid = entry.runner.pid;
      if (pid !== null) out.push(pid);
    }
    return out;
  }

  /** `<session id, pid>` of every running agent child (the registry records their identity in live.json). */
  liveChildren(): { readonly id: string; readonly pid: number }[] {
    const out: { id: string; pid: number }[] = [];
    for (const entry of this.entries.values()) {
      const pid = entry.runner.pid;
      if (pid !== null) out.push({ id: entry.runner.id, pid });
    }
    return out;
  }

  // =================================================================================================================
  // The log: append, fan-out, watch, history, redact
  // =================================================================================================================

  private push(entry: Entry, input: ConversationEventInput, sync = false): ConversationEvent {
    const now = this.ctx.clock.now();
    const event = entry.transcript.append(input, now, sync || input.kind === 'card');
    entry.runner.record.lastActivityAt = now;
    if (event.kind === 'card') entry.cardSeqs.set(event.id, event.seq);
    if (entry.watchers.size > 0) {
      const size = encodedSize(event);
      if (entry.batch.length > 0 && entry.batchBytes + size > EVENTS_BATCH_MAX_BYTES) this.flushBatch(entry);
      entry.batch.push(event);
      entry.batchBytes += size;
      if (entry.batch.length >= EVENTS_BATCH_MAX || entry.batchBytes >= EVENTS_BATCH_MAX_BYTES) this.flushBatch(entry);
      else if (entry.batchTimer === undefined) {
        entry.batchTimer = setTimeout(() => this.flushBatch(entry), this.config.eventsBatchMs);
        entry.batchTimer.unref?.();
      }
    }
    return event;
  }

  private flushBatch(entry: Entry): void {
    if (entry.batchTimer !== undefined) clearTimeout(entry.batchTimer);
    entry.batchTimer = undefined;
    if (entry.batch.length === 0) return;
    const events = entry.batch;
    entry.batch = [];
    entry.batchBytes = 0;
    this.fanOut(entry, events);
  }

  private fanOut(entry: Entry, events: ConversationEvent[]): void {
    const live: string[] = [];
    for (const [channelId, watcher] of entry.watchers) {
      if (watcher.hold === null) live.push(channelId);
      else if (watcher.hold.length < HOLD_MAX) watcher.hold.push(...events);
    }
    if (live.length > 0) this.ctx.hub.sendToChannels(live, 'session.events', { sessionId: entry.runner.id, events });
  }

  append(sessionId: string, event: AppendableEvent): number {
    const entry = this.need(sessionId);
    const stamped = this.push(entry, event as ConversationEventInput, event.kind === 'card');
    if (event.kind === 'card') this.touch(entry, true);
    return stamped.seq;
  }

  async redact(sessionId: string, seq: number, _by: Principal): Promise<void> {
    const entry = this.need(sessionId);
    this.flushBatch(entry);
    const replacement = await entry.transcript.redact(seq, noticeEvent('info', msg('conversation.redacted')));
    if (replacement === null) throw new SmurgError('not_found', undefined, { reason: 'unknown-event' });
    // Watchers get the replacement under a `seq` they already have: it replaces the earlier event in place.
    this.fanOut(entry, [replacement]);
  }

  async watch(input: Req<'session.watch'>, conn: ClientConnection): Promise<WatchStart> {
    const entry = this.need(input.sessionId);
    const channelId = conn.channelId;
    this.flushBatch(entry);
    const before = entry.watchers.get(channelId);
    const watcher: Watcher = { userId: conn.userId, live: input.live ?? true, hold: [] };
    entry.watchers.set(channelId, watcher);
    try {
      const lastSeq = entry.transcript.lastSeq;
      // The events after `haveSeq`; the NEWEST page without it or when it is too far behind.
      const page = await entry.transcript.page(input.haveSeq === undefined || lastSeq - input.haveSeq > EVENTS_CATCH_UP_MAX ? { newest: true } : { after: input.haveSeq }, EVENTS_PAGE_MAX);
      return {
        ...page,
        session: this.wire(entry),
        streaming: entry.runner.streaming(),
        afterReply: () => {
          if (entry.watchers.get(channelId) !== watcher) return;
          const held = watcher.hold ?? [];
          watcher.hold = null;
          const fresh = held.filter((event) => event.seq >= page.nextSeq);
          if (fresh.length > 0) this.ctx.hub.sendToChannels([channelId], 'session.events', { sessionId: entry.runner.id, events: fresh });
        },
      };
    } catch (err) {
      if (entry.watchers.get(channelId) === watcher) {
        if (before !== undefined) entry.watchers.set(channelId, before);
        else entry.watchers.delete(channelId);
      }
      throw err;
    }
  }

  unwatch(sessionId: string, channelId: string): void {
    this.entries.get(sessionId)?.watchers.delete(channelId);
  }

  /** A logical channel is gone for good: it watches nothing any more. */
  dropChannel(channelId: string): void {
    for (const entry of this.entries.values()) entry.watchers.delete(channelId);
  }

  async history(input: Req<'session.history'>): Promise<EventsPage> {
    const entry = this.need(input.sessionId);
    return entry.transcript.page(input.beforeSeq !== undefined ? { before: input.beforeSeq } : { after: input.afterSeq ?? 0 }, input.limit);
  }

  toWatchers<T extends OutboundType>(sessionId: string, type: T, payload: PayloadInputOf<T>, hostPayload?: PayloadInputOf<T>): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    // A card's update never overtakes the event that introduced it.
    this.flushBatch(entry);
    const channels: string[] = [];
    for (const [channelId, watcher] of entry.watchers) if (watcher.hold === null && (type !== 'session.delta' || watcher.live)) channels.push(channelId);
    if (channels.length > 0) this.ctx.hub.sendToChannels(channels, type, payload, hostPayload === undefined ? {} : { hostPayload });
  }

  watchers(sessionId: string): UserId[] {
    return [...new Set([...(this.entries.get(sessionId)?.watchers.values() ?? [])].map((watcher) => watcher.userId))];
  }

  async storageDir(sessionId: string): Promise<string> {
    this.need(sessionId);
    const dir = this.transcriptDir(sessionId);
    await ensurePrivateDirectory(dir);
    return dir;
  }

  // ---- what the runners ask for (RunnerHost) ------------------------------------------------------------------------

  /** `session.updated` on the bus and `session.state` to everyone. */
  private touch(entry: Entry, noteworthy: boolean): void {
    const record = entry.runner.record;
    const now = this.ctx.clock.now();
    record.lastActivityAt = now;
    if (noteworthy) record.noteworthyAt = now;
    const session = this.wire(entry);
    this.ctx.bus.emit('session.updated', { session });
    this.ctx.hub.broadcast('session.state', { session });
  }

  publish(runner: AgentRunner, options: { readonly noteworthy?: boolean } = {}): void {
    const entry = this.entries.get(runner.id);
    if (entry) this.touch(entry, options.noteworthy === true);
  }

  save(runner: AgentRunner): void {
    try {
      this.store?.save(runner.record);
    } catch (err) {
      this.logError('an agent session record could not be saved', err);
    }
  }

  processChanged(runner: AgentRunner, reason: 'started' | 'parked' | 'failed' | 'ended'): void {
    const record = runner.record;
    this.ctx.bus.emit('agent.process', { sessionId: record.id, purpose: record.purpose, ...(record.topic === undefined ? {} : { topicId: record.topic.id }), hasProcess: runner.hasProcess, reason });
  }

  delta(runner: AgentRunner, payload: Omit<PayloadInputOf<'session.delta'>, 'sessionId'>): number {
    const entry = this.entries.get(runner.id);
    if (!entry) return -1;
    const live: string[] = [];
    for (const [channelId, watcher] of entry.watchers) if (watcher.live && watcher.hold === null) live.push(channelId);
    if (live.length === 0) return -1;
    return this.ctx.hub.sendToChannels(live, 'session.delta', { sessionId: runner.id, ...payload });
  }

  idle(runner: AgentRunner): void {
    if (runner.restartPending && runner.parkable) void runner.park('restart').catch((err: unknown) => this.logError('parking an agent failed', err));
  }

  rootGone(runner: AgentRunner): void {
    void this.end(runner.id, { by: SYSTEM_ACTOR, reason: 'worktree-removed', keepWorktree: true }).catch((err: unknown) => this.logError('ending a session without a root failed', err));
  }

  rss(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
      execFile('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2_000 }, (err, stdout) => {
        const kib = Number(String(stdout).trim());
        resolve(err || !Number.isFinite(kib) || kib <= 0 ? null : kib * 1024);
      });
    });
  }

  personalSubscription(): void {
    // The host alone, once per workspace run, and only when members other than the host are present.
    if (this.subscriptionSaid) return;
    const host = this.ctx.members.hostUserId();
    if (!this.ctx.members.list().some((member) => member.userId !== host)) return;
    this.subscriptionSaid = true;
    this.notifyHost('subscription', msg('notice.personalSubscription'));
  }

  private notifyHost(key: string, ref: MessageRef): void {
    if (this.notified.has(key) || isStubService(this.ctx.services.activity)) return;
    this.notified.add(key);
    try {
      this.ctx.services.activity.notify(this.ctx.members.hostUserId(), { from: SYSTEM_ACTOR, msg: ref, fallback: renderEnglish(ref) });
    } catch (err) {
      this.logError('a notification to the host failed', err);
    }
  }

  // =================================================================================================================
  // The account (one state per workspace)
  // =================================================================================================================

  account(): AccountInfo {
    const state = this.accountState.state;
    let sessions = 0;
    if (state !== 'ok') for (const entry of this.entries.values()) if (entry.runner.blockedBy === state && entry.runner.record.state !== 'ended') sessions += 1;
    return { state, ...(state === 'usage-limit' && this.accountState.resetsAt !== undefined ? { resetsAt: this.accountState.resetsAt } : {}), sessions };
  }

  /** Applies `change` and tells everyone when the account state (or how many sessions it stops) is another one. */
  private accountChange(change: () => void): void {
    const before = JSON.stringify(this.account());
    change();
    const account = this.account();
    if (JSON.stringify(account) === before) return;
    this.ctx.bus.emit('account.changed', { account });
    this.ctx.bus.emit('attention.changed', { source: 'sessions' });
  }

  /** The account works again (a turn went through, a login check said so, the limit's reset time passed). */
  private accountOk(): void {
    this.accountChange(() => {
      for (const entry of this.entries.values()) entry.runner.blockedBy = null;
      if (this.accountState.state !== 'ok') this.accountState = { state: 'ok', since: this.ctx.clock.now() };
    });
  }

  private accountSignal(_runner: AgentRunner, signal: { readonly kind: 'ok' } | { readonly kind: 'logged-out' } | { readonly kind: 'usage-limit'; readonly resetsAt?: number }): void {
    if (signal.kind === 'ok') {
      this.accountOk();
      return;
    }
    this.accountChange(() => {
      const now = this.ctx.clock.now();
      if (signal.kind === 'logged-out') {
        if (this.accountState.state !== 'logged-out') this.accountState = { state: 'logged-out', since: now };
      } else if (this.accountState.state !== 'logged-out') {
        this.accountState = { state: 'usage-limit', since: this.accountState.state === 'usage-limit' ? this.accountState.since : now, ...(signal.resetsAt === undefined ? {} : { resetsAt: signal.resetsAt }) };
      }
    });
  }

  claude(): NonNullable<DaemonStatus['claude']> | null {
    return this.claudeStatus === null ? null : { ...this.claudeStatus };
  }

  attention(): AttentionFact[] {
    const host = this.ctx.members.hostUserId();
    const out: AttentionFact[] = [];
    const account = this.account();
    if (account.state !== 'ok') out.push({ subject: 'account', id: 'workspace', at: this.accountState.since, recipients: [host], target: { kind: 'console', section: 'sessions' }, count: account.sessions, excerpt: '' });
    if (this.storageFull) out.push({ subject: 'storage', id: 'workspace', at: this.lastRetention, recipients: [host], target: { kind: 'console', section: 'sessions' }, excerpt: '' });
    return out;
  }

  // =================================================================================================================
  // Starting: the checks, the profile, the launch files
  // =================================================================================================================

  /** `claude auth status --json` in the session's environment, at most once per `loginCheckIntervalMs`. */
  async loginState(force = false): Promise<LoginState> {
    const now = this.ctx.clock.now();
    if (!force && this.loginChecked !== null && now - this.loginChecked.at < this.config.loginCheckIntervalMs) return this.loginChecked.state;
    const binary = await resolveClaude(this.deps.launch.claudePath, this.deps.hostEnv()['PATH']);
    if (binary === null) return 'unknown';
    const env = buildHostEnv({ hostEnv: this.deps.hostEnv(), home: this.deps.launch.hostHome, sessionId: 'login-check' });
    const result = await this.deps.runner(binary.realPath, ['auth', 'status', '--json'], { env, cwd: this.ctx.roots.main.realPath, timeoutMs: this.deps.authStatusTimeoutMs, maxStdoutBytes: 16 * 1024 });
    const state = result.spawnError ? 'unknown' : parseAuthStatus(result);
    this.loginChecked = { at: now, state };
    if (this.claudeStatus !== null) this.claudeStatus = { ...this.claudeStatus, login: state };
    if (state === 'logged-out') {
      this.accountChange(() => {
        if (this.accountState.state !== 'logged-out') this.accountState = { state: 'logged-out', since: now };
      });
    } else if (state === 'logged-in' && this.accountState.state === 'logged-out') this.accountOk();
    return state;
  }

  /** What every start needs first; throws the refusal (DESIGN §2.8). */
  private async preflight(): Promise<ClaudeBinary> {
    const launch = this.deps.launch;
    if (isStubService(this.ctx.services.hooks)) throw agentError('internal', msg('session.hooks.unavailable'), 'no-hooks');
    if (launch.selfCommand === null || this.ctx.config.sessions.selfCommand === null) throw agentError('internal', msg('session.hooks.notConfigured'), 'no-self-command');
    const binary = await resolveClaude(launch.claudePath, this.deps.hostEnv()['PATH']);
    if (binary === null) throw agentError('conflict', msg('session.claudeNotFound'), 'claude-not-found');
    const output = this.probe === null ? '' : await this.probe.output(binary);
    const verdict = claudeVersionVerdict(output, launch);
    const login = this.loginChecked?.state ?? 'unknown';
    if (!verdict.ok && verdict.reason === 'below-minimum') {
      this.claudeStatus = { version: verdict.version, verdict: 'too-old', login };
      this.notifyHost(`too-old:${verdict.version}`, msg('notify.claudeVersionTooOld', { version: verdict.version ?? undefined, minVersion: launch.claudeMinVersion }));
      throw agentError('conflict', msg('session.claude.tooOld', { found: verdict.version ?? '?', min: launch.claudeMinVersion }), 'claude-too-old');
    }
    if (!verdict.ok || verdict.warning !== null) {
      // Unparsable, or not one of the verified versions: the start proceeds; the host is told once.
      this.claudeStatus = { version: verdict.version, verdict: verdict.ok ? 'unverified' : 'unknown', login };
      this.notifyHost(`unverified:${verdict.version ?? ''}`, msg('notify.claudeVersionUnverified', { version: verdict.version ?? undefined, verified: [...launch.claudeVerifiedVersions] }));
    } else this.claudeStatus = { version: verdict.version, verdict: 'verified', login };
    if ((await this.loginState()) === 'logged-out') throw agentError('conflict', msg('session.claude.notLoggedIn'), 'not-logged-in');
    return binary;
  }

  /** Room for one more process: beyond `maxAgentProcesses` the longest-idle session is parked first. */
  private async makeRoom(except: AgentRunner | null): Promise<void> {
    const max = this.config.maxAgentProcesses;
    for (let round = 0; round < 4; round++) {
      const running = [...this.entries.values()].filter((entry) => entry.runner !== except && entry.runner.hasProcess);
      if (running.length < max) return;
      const idle = running.filter((entry) => entry.runner.parkable).sort((a, b) => a.runner.idleSince - b.runner.idleSince)[0];
      if (idle === undefined || !(await idle.runner.park('park'))) break;
    }
    if ([...this.entries.values()].filter((entry) => entry.runner !== except && entry.runner.hasProcess).length >= max) {
      throw agentError('conflict', msg('session.limit.processes', { max }), 'process-limit');
    }
  }

  async prepareLaunch(runner: AgentRunner): Promise<LaunchPlan> {
    const record = runner.record;
    const ctx = this.ctx;
    const root = ctx.roots.get(record.root);
    if (root === null) {
      this.rootGone(runner);
      throw agentError('conflict', msg('session.worktreeGone'), 'worktree-removed');
    }
    const binary = await this.preflight();
    await this.makeRoom(runner);
    await this.deps.trust.refresh(record.root).catch(() => null);
    const trust = this.deps.trust.state(record.root);
    const profile = buildProfile({
      purpose: record.purpose,
      mode: record.mode,
      root: record.root,
      rootRealPath: root.realPath,
      ...(record.topic === undefined ? {} : { topicSlug: record.topic.slug }),
      rules: [...record.rules, ...this.topicRules(record.topic?.id)],
      trust,
      agentMcp: ctx.settings.get().agentMcp,
      rolePrompt: runner.rolePrompt,
    });
    const credentials = ctx.services.hooks.registerSession({
      sessionId: record.id,
      ownerUserId: record.ownerUserId,
      agentName: this.agentName(record),
      root: record.root,
      purpose: record.purpose,
      ...(record.topic === undefined ? {} : { topic: { id: record.topic.id, slug: record.topic.slug } }),
      ...(record.item === undefined ? {} : { itemId: record.item.id }),
      pathRights: record.pathRights,
      tools: gateToolsOf(profile),
    });
    let files;
    try {
      files = await ctx.services.hooks.writeSessionFiles(record.id, profile);
    } catch (err) {
      if (err instanceof SmurgError && err.text !== undefined) throw err;
      throw agentError('internal', msg('session.hooks.settingsNotWritten'), 'settings-not-written');
    }
    const problem = checkLaunchArgs(files.claudeArgs);
    if (problem !== null) {
      ctx.log.error('the launch flags of an agent session were refused', { session: record.id, problem });
      throw agentError('internal', msg('session.hooks.settingsInvalid'), 'launch-check');
    }
    const env = buildHostEnv({ hostEnv: this.deps.hostEnv(), home: this.deps.launch.hostHome, sessionId: record.id, hookEnv: credentials.env });
    this.deps.live.add(record.id);
    return { file: binary.realPath, args: files.claudeArgs, cwd: root.realPath, env, tools: profile.tools, trust };
  }

  releaseLaunch(runner: AgentRunner): void {
    try {
      if (!isStubService(this.ctx.services.hooks)) this.ctx.services.hooks.unregisterSession(runner.id);
    } catch (err) {
      this.logError('unregistering a session from the hook server failed', err);
    }
    this.deps.live.remove(runner.id);
  }

  async kill(runner: AgentRunner): Promise<void> {
    const result = await killTree(
      { rootPid: () => runner.pid, envEntry: `SMURG_SESSION_ID=${runner.id}`, protect: () => this.foreignOf(runner) },
      { inspector: this.deps.inspector, log: this.ctx.log.child({ module: 'kill-tree', session: runner.id }), deadlineMs: this.deps.killDeadlineMs, maxPids: this.deps.maxPidsPerSession },
    );
    if (result.outcome !== 'done') this.ctx.log.error('agent processes may remain', { session: runner.id, outcome: result.outcome, reason: result.reason ?? 'none' });
  }

  private foreignOf(runner: AgentRunner): Set<number> {
    const out = new Set<number>([...runningHelperPids(), ...this.deps.foreignChildren()]);
    for (const entry of this.entries.values()) {
      const pid = entry.runner.pid;
      if (entry.runner !== runner && pid !== null) out.add(pid);
    }
    return out;
  }

  // =================================================================================================================
  // AgentSessions: start, send, the turn
  // =================================================================================================================

  async start(input: AgentStartInput, internal: { readonly id?: string } = {}): Promise<AgentSession> {
    if (input.purpose !== 'free' && input.topic === undefined) throw new TypeError(`AgentSessions.start: a ${input.purpose} session needs \`topic\``);
    if (input.purpose === 'item' && input.item === undefined) throw new TypeError('AgentSessions.start: an item session needs `item`');
    if (input.purpose === 'free' && (input.topic !== undefined || input.item !== undefined)) throw new TypeError('AgentSessions.start: a free session has no topic and no item');
    if (input.purpose === 'discussion' && input.item !== undefined) throw new TypeError('AgentSessions.start: a discussion session has no item');
    if (this.stopping || !this.started || this.store === null) throw agentError('conflict', this.started ? msg('daemon.stopping') : msg('session.notStarted'), this.started ? 'stopping' : 'not-started');
    const ctx = this.ctx;
    const alive = [...this.entries.values()].filter((entry) => entry.runner.record.state !== 'ended').length;
    if (alive >= this.config.maxAgentSessions) throw agentError('conflict', msg('session.limit.agents', { max: this.config.maxAgentSessions }), 'agent-limit');
    const root: RootRef = input.workspace.mode === 'main' ? MAIN_ROOT : worktreeRoot(input.workspace.worktreeId);
    if (ctx.roots.get(root) === null) throw agentError('conflict', msg('session.worktreeGone'), 'worktree-removed');
    await this.preflight();
    await this.makeRoom(null);
    const host = ctx.members.hostUserId();
    const opener: UserRef = input.openedBy.actor.kind === 'user' ? { userId: input.openedBy.actor.userId, displayName: input.openedBy.actor.displayName } : (ctx.members.userRef(host) ?? { userId: host, displayName: 'Host' });
    const id = internal.id ?? SESSION_ID();
    const now = ctx.clock.now();
    const worktreeId = input.workspace.mode === 'worktree' ? input.workspace.worktreeId : undefined;
    const branch = worktreeId === undefined || isStubService(ctx.services.worktrees) ? undefined : (ctx.services.worktrees.get(worktreeId)?.branch ?? undefined);
    let smurgTag = '';
    for (const byte of randomBytes(4)) smurgTag += SMURG_TAG_ALPHABET[byte % SMURG_TAG_ALPHABET.length];
    const first = input.firstMessage;
    const title = input.title ?? (input.purpose === 'free' && first !== undefined && first.kind === 'person' ? titleFromFirstMessage(first.text) : undefined);
    const given = input.rolePrompt({ smurgTag, ...(branch === undefined ? {} : { branch }) });
    const rolePrompt = given.length > 0 ? given : freeRolePrompt(smurgTag);
    const record: AgentRecord = {
      id,
      purpose: input.purpose,
      ...(input.topic === undefined ? {} : { topic: { id: input.topic.id, slug: input.topic.slug, name: input.topic.name } }),
      ...(input.item === undefined ? {} : { item: { id: input.item.id, number: input.item.number, title: input.item.title, attempt: input.item.attempt } }),
      openedBy: opener,
      ownerUserId: opener.userId,
      pathRights: input.openedBy.role === 'host' || input.openedBy.kind === 'system' ? 'host' : 'member',
      responsible: input.responsible === null ? null : { ...input.responsible },
      fallbackDecider: opener.userId,
      ...(title === undefined || title.length === 0 ? {} : { title }),
      root,
      ...(worktreeId === undefined ? {} : { worktreeId }),
      ...(branch === undefined || branch.length === 0 ? {} : { branch }),
      mode: input.purpose === 'discussion' ? 'ask-all' : input.mode,
      rules: [],
      claudeSessionId: randomUUID(),
      hasConversation: false,
      turnCounter: 0,
      smurgTag,
      startFailures: 0,
      lastTurnOpen: false,
      state: 'live',
      untrustedSaid: false,
      createdAt: now,
      noteworthyAt: now,
      lastActivityAt: now,
    };
    const dir = this.transcriptDir(id);
    await ensurePrivateDirectory(dir);
    await writeFile(join(dir, 'role.md'), rolePrompt, { mode: 0o600, flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW });
    const entry = await this.adopt(record, rolePrompt);
    this.store.save(record);
    entry.runner.projectSettings = this.deps.trust.state(root);
    const session = this.wire(entry);
    ctx.bus.emit('session.created', { session });
    ctx.hub.broadcast('session.state', { session });
    if (input.opening !== undefined) this.push(entry, lineEvent(input.opening));
    if (first !== undefined) await this.send(id, first);
    else void entry.runner.launch();
    return this.wire(entry);
  }

  private roleOf(principal: Principal): Role {
    return principal.role ?? 'host';
  }

  async send(sessionId: string, message: OutboundMessage): Promise<{ readonly messageId: string; readonly seq: number }> {
    const entry = this.need(sessionId);
    const record = entry.runner.record;
    if (record.state === 'ended') throw agentError('conflict', msg('session.ended.noMessages'), 'ended');
    if (this.stopping) throw agentError('conflict', msg('daemon.stopping'), 'stopping');
    const messageId = newId('m');
    let framed: string;
    let event: ConversationEventInput;
    let turn: TurnMessage;
    let fromUserId: string | null = null;
    if (message.kind === 'person') {
      const cleaned = agentText(message.text);
      if (cleaned.text.trim().length === 0) throw agentError('bad_request', msg('session.text.invalid'), 'invalid-text');
      const actor = message.from.actor;
      const from: UserRef = actor.kind === 'user' ? { userId: actor.userId, displayName: actor.displayName } : { ...record.openedBy };
      const person = { ...from, role: this.roleOf(message.from) };
      fromUserId = from.userId;
      framed = frameMessage(message.suggestion === undefined ? personHeader(person) : suggestionHeader(person, message.suggestion.acceptedBy), cleaned.text);
      event = {
        kind: 'message',
        messageId,
        from: person,
        text: cleaned.text,
        ...(message.cleaned || cleaned.cleaned ? { cleaned: true as const } : {}),
        origin: message.origin,
        ...(message.suggestion === undefined ? {} : { suggestion: { id: message.suggestion.id, acceptedBy: { ...message.suggestion.acceptedBy }, modified: message.suggestion.modified } }),
        ...(message.mentions === undefined || message.mentions.length === 0 ? {} : { mentions: [...message.mentions] }),
      };
      turn = { messageId, kind: 'person', origin: message.origin, from, ...(message.suggestion === undefined ? {} : { suggestionId: message.suggestion.id }) };
      this.ctx.audit.record({ actor, action: 'session.message', outcome: 'ok', target: sessionId, detail: { sessionId, messageId, origin: message.origin, ...(message.suggestion === undefined ? {} : { suggestionId: message.suggestion.id }), text: cleaned.text }, fullText: ['text'] });
    } else {
      framed = frameMessage(smurgHeader(record.smurgTag), message.text);
      event = { kind: 'smurg', messageId, purpose: message.purpose, text: message.text, ...(message.by === undefined ? {} : { by: { ...message.by } }) };
      turn = { messageId, kind: 'smurg', purpose: message.purpose, ...(message.by === undefined ? {} : { by: { ...message.by } }) };
      this.ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'smurg.message', outcome: 'ok', target: sessionId, detail: { sessionId, messageId, purpose: message.purpose, ...(message.by === undefined ? {} : { by: message.by.userId }) } });
    }
    const stamped = this.push(entry, event);
    const outgoing: Outgoing = { uuid: randomUUID(), messageId, text: framed, turn, fromUserId };
    if (entry.runner.send(outgoing)) this.push(entry, { kind: 'delivery', messageId, state: 'queued' });
    if (message.kind === 'person') this.touch(entry, true);
    return { messageId, seq: stamped.seq };
  }

  cancelQueued(fromUserId: UserId): { readonly sessionId: string; readonly messageIds: readonly string[] }[] {
    const out: { sessionId: string; messageIds: string[] }[] = [];
    for (const entry of this.entries.values()) {
      const messageIds = entry.runner.cancelQueued(fromUserId);
      if (messageIds.length > 0) out.push({ sessionId: entry.runner.id, messageIds });
    }
    return out;
  }

  holdingUndelivered(fromUserId: UserId): string[] {
    return [...this.entries.values()].filter((entry) => entry.runner.holdsUndelivered(fromUserId)).map((entry) => entry.runner.id);
  }

  async interrupt(sessionId: string, by: Actor): Promise<void> {
    const entry = this.need(sessionId);
    const person = userOf(by);
    if (person !== null) {
      this.push(entry, lineEvent(msg('conversation.stopped', { name: person.displayName })));
      this.ctx.audit.record({ actor: by, action: 'session.interrupt', outcome: 'ok', target: sessionId, detail: { sessionId } });
    }
    await entry.runner.interrupt(person);
  }

  async retry(sessionId: string, by: Principal): Promise<AgentSession> {
    const entry = this.need(sessionId);
    const record = entry.runner.record;
    if (record.state !== 'failed') throw agentError('conflict', msg('session.retry.notFailed'), 'not-failed');
    if (record.startFailures >= this.config.startFailuresHostOnly && by.role !== 'host') throw agentError('forbidden', msg('session.retry.hostOnly'), 'host-only');
    const name = by.actor.kind === 'user' ? by.actor.displayName : 'smurg';
    this.push(entry, lineEvent(msg('conversation.retry.resumed', { name })));
    this.ctx.audit.record({ actor: by.actor, action: 'session.retry', outcome: 'ok', target: sessionId, detail: { sessionId, startFailures: record.startFailures } });
    void entry.runner.launch();
    return this.wire(entry);
  }

  answerQuestion(sessionId: string, requestId: string, answer: { readonly answers: Readonly<Record<string, string>>; readonly notes: Readonly<Record<string, string>> }): void {
    this.need(sessionId).runner.answerQuestion(requestId, answer);
  }

  decidePermission(sessionId: string, requestId: string, decision: { readonly allow: true; readonly sessionRule?: { readonly tool: string; readonly pattern: string } } | { readonly allow: false; readonly message: string }): void {
    this.need(sessionId).runner.decide(requestId, decision);
  }

  // =================================================================================================================
  // AgentSessions: what people change
  // =================================================================================================================

  async setMode(sessionId: string, mode: PermissionMode, by: Actor): Promise<void> {
    const entry = this.need(sessionId);
    const record = entry.runner.record;
    if (record.purpose === 'discussion') throw agentError('conflict', msg('session.mode.fixed'), 'mode-fixed');
    const person = userOf(by);
    if (person !== null) {
      this.push(entry, lineEvent(msg('conversation.mode.changed', { by: person.displayName, mode })));
      this.ctx.audit.record({ actor: by, action: 'session.mode', outcome: 'ok', target: sessionId, detail: { sessionId, mode } });
      // Remembered while the mode is not the default.
      if (mode === defaultPermissionMode(record.purpose, record.root)) delete record.modeChangedBy;
      else record.modeChangedBy = person;
    } else {
      // The system puts a loosened mode back: the line names who had changed it.
      if (record.modeChangedBy !== undefined) this.push(entry, lineEvent(msg('conversation.mode.reset', { name: record.modeChangedBy.displayName })));
      delete record.modeChangedBy;
    }
    const before = claudeModeFor(record.purpose, record.mode, record.root);
    record.mode = mode;
    this.save(entry.runner);
    this.touch(entry, false);
    const after = claudeModeFor(record.purpose, mode, record.root);
    if (before !== after) await entry.runner.setClaudeMode(after);
  }

  async setRules(sessionId: string, rules: readonly RememberedRule[], by: Actor): Promise<void> {
    const entry = this.need(sessionId);
    const record = entry.runner.record;
    if (rules.length > REMEMBERED_RULES_MAX) throw agentError('conflict', msg('rule.limit', { max: REMEMBERED_RULES_MAX }), 'rule-limit');
    const known = new Set(record.rules.map((rule) => rule.id));
    for (const rule of rules) {
      if (!known.has(rule.id) && !checkRememberableRule(rule.tool, rule.pattern).ok) throw agentError('bad_request', msg('rule.notAllowed'), 'rule-form');
    }
    const person = userOf(by);
    const kept = new Set(rules.map((rule) => rule.id));
    const gone = record.rules.filter((rule) => !kept.has(rule.id));
    for (const rule of gone) {
      const text = ruleString(rule);
      if (person === null) this.push(entry, lineEvent(msg('conversation.rule.removed.member', { name: rule.addedBy.displayName, rule: text })));
      else {
        this.push(entry, lineEvent(msg('conversation.rule.removed', { by: person.displayName, rule: text })));
        this.ctx.audit.record({ actor: by, action: 'session.rule.remove', outcome: 'ok', target: sessionId, detail: { sessionId, ruleId: rule.id, rule: text } });
      }
    }
    record.rules = rules.map((rule) => ({ ...rule, addedBy: { ...rule.addedBy } }));
    this.save(entry.runner);
    this.touch(entry, false);
    // A rule that went: the process starts again without it (an added rule needs no restart: the process has it).
    if (gone.length > 0) await this.restartProcess(sessionId, 'rules');
  }

  rules(sessionId: string): readonly RememberedRule[] {
    return this.need(sessionId).runner.record.rules.map((rule) => ({ ...rule, addedBy: { ...rule.addedBy } }));
  }

  setResponsible(sessionId: string, responsible: UserRef | null, by: Actor): void {
    const entry = this.need(sessionId);
    const person = userOf(by);
    if (person !== null) {
      this.push(entry, lineEvent(responsible === null ? msg('conversation.responsible.cleared', { by: person.displayName }) : msg('conversation.responsible.changed', { by: person.displayName, name: responsible.displayName })));
      this.ctx.audit.record({ actor: by, action: 'session.responsible', outcome: 'ok', target: sessionId, detail: { sessionId, responsible: responsible?.userId ?? null } });
    }
    entry.runner.record.responsible = responsible === null ? null : { ...responsible };
    this.save(entry.runner);
    this.touch(entry, false);
  }

  /**
   * The always-allowed kinds of a TOPIC changed (TopicService owns them; a session reads them at each process start).
   * `ruleCount` of every session of that topic counts them, so each of these sessions is announced again
   * (`session.updated`, `session.state`): without it every client would keep the old count of the topic's other
   * sessions until something else of them changed. Nothing the session did: its activity time stays.
   */
  topicRulesChanged(topicId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.runner.record.topic?.id !== topicId) continue;
      const session = this.wire(entry);
      this.ctx.bus.emit('session.updated', { session });
      this.ctx.hub.broadcast('session.state', { session });
    }
  }

  clearFallbackDecider(userId: UserId): string[] {
    const changed: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.runner.record.fallbackDecider !== userId) continue;
      entry.runner.record.fallbackDecider = null;
      this.save(entry.runner);
      changed.push(entry.runner.id);
    }
    // The fact is not on the wire's session (nothing is sent to clients), but who decides an open question follows it:
    // the inbox and the cards look again at once (bus `session.updated`) instead of at their next sweep.
    for (const sessionId of changed) {
      const entry = this.entries.get(sessionId);
      if (entry !== undefined && entry.runner.record.state !== 'ended') this.ctx.bus.emit('session.updated', { session: this.wire(entry) });
    }
    return changed;
  }

  setOwner(sessionId: string, ownerUserId: UserId, _by: Actor): void {
    const entry = this.need(sessionId);
    entry.runner.record.ownerUserId = ownerUserId; // pathRights never changes
    this.save(entry.runner);
    if (!isStubService(this.ctx.services.hooks)) this.ctx.services.hooks.reassignSession(sessionId, ownerUserId);
  }

  setItemState(sessionId: string, state: { readonly reportRegistered: boolean; readonly stalled?: StalledBy }): void {
    const entry = this.need(sessionId);
    const record = entry.runner.record;
    const before = entry.runner.status();
    record.itemState = { reportRegistered: state.reportRegistered, ...(state.stalled === undefined ? {} : { stalled: state.stalled }) };
    this.save(entry.runner);
    if (entry.runner.status() !== before) this.touch(entry, true);
  }

  setTitle(sessionId: string, title: string, _by: Actor): void {
    const entry = this.need(sessionId);
    entry.runner.record.title = title;
    this.save(entry.runner);
    this.touch(entry, false);
  }

  setLabels(sessionId: string, labels: { readonly topicName?: string; readonly item?: { readonly number: number; readonly title: string } }): void {
    const entry = this.need(sessionId);
    const record = entry.runner.record;
    if (labels.topicName !== undefined) {
      if (record.topic === undefined) throw new TypeError('AgentSessions.setLabels: a free session has no topic');
      record.topic = { ...record.topic, name: labels.topicName };
    }
    if (labels.item !== undefined) {
      if (record.item === undefined) throw new TypeError('AgentSessions.setLabels: not an item session');
      record.item = { ...record.item, number: labels.item.number, title: labels.item.title };
    }
    this.save(entry.runner);
    this.touch(entry, false);
  }

  async end(sessionId: string, input: { readonly by: Actor; readonly reason: SessionEndReason; readonly keepWorktree: boolean }): Promise<void> {
    const entry = this.need(sessionId);
    const record = entry.runner.record;
    if (record.state === 'ended') return;
    const person = userOf(input.by);
    if (person !== null) this.push(entry, lineEvent(msg('conversation.ended', { name: person.displayName })));
    record.state = 'ended';
    record.endedAt = this.ctx.clock.now();
    record.endReason = input.reason;
    if (person !== null) record.endedBy = person;
    this.save(entry.runner);
    await entry.runner.shutdown('end', person ?? undefined);
    this.accountChange(() => {
      entry.runner.blockedBy = null;
    });
    this.flushBatch(entry);
    await entry.transcript.flush();
    if (record.purpose === 'free' && record.worktreeId !== undefined && !isStubService(this.ctx.services.worktrees)) {
      await this.ctx.services.worktrees.releaseFromSession(record.worktreeId, sessionId, { keep: input.keepWorktree }).catch((err: unknown) => this.logError('worktree release failed', err));
    }
    const session = this.wire(entry);
    this.ctx.bus.emit('session.exited', { session, reason: input.reason });
    this.ctx.hub.broadcast('session.state', { session });
  }

  async restartProcess(sessionId: string, reason: 'rules' | 'project-settings' | 'host' | 'asked' | 'slot'): Promise<void> {
    const entry = this.need(sessionId);
    if (entry.runner.record.state === 'ended') return;
    if (!entry.runner.hasProcess) return; // parked already: the next message starts it with fresh launch files
    // Said once per restart: a second reason while the first restart still waits for the turn to end adds nothing.
    if (reason !== 'slot' && !entry.runner.restartPending) this.push(entry, lineEvent(msg('conversation.agent.restarting')));
    await entry.runner.restart();
  }

  async parkRoot(root: RootRef, _reason: 'project-settings-changed'): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      const { runner } = entry;
      if (!rootRefEquals(runner.record.root, root) || runner.record.state === 'ended' || !runner.hasProcess) continue;
      if (runner.turnOpen || runner.openRequests > 0) await runner.interrupt(null);
      this.push(entry, noticeEvent('warning', msg('session.projectSettings.changed')), true);
      await runner.restart();
    }
  }

  /** The sessions of a root start again at their next idle moment (the host decided about its project settings). */
  async restartRoot(root: RootRef, reason: 'project-settings' | 'host'): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (!rootRefEquals(entry.runner.record.root, root) || !entry.runner.hasProcess) continue;
      await this.restartProcess(entry.runner.id, reason);
    }
  }

  /** A host setting that shapes the launch changed (`agentMcp`): every session with a process starts again. */
  async restartAll(reason: 'host'): Promise<void> {
    for (const entry of [...this.entries.values()]) if (entry.runner.hasProcess && entry.runner.record.purpose !== 'discussion') await this.restartProcess(entry.runner.id, reason);
  }

  async forget(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const entry = this.entries.get(sessionId);
      if (!entry) continue;
      if (entry.runner.record.state !== 'ended') {
        entry.runner.record.state = 'ended';
        await entry.runner.shutdown('end', undefined).catch((err: unknown) => this.logError('stopping a forgotten session failed', err));
      }
      if (entry.batchTimer !== undefined) clearTimeout(entry.batchTimer);
      this.entries.delete(sessionId);
      await entry.transcript.remove().catch((err: unknown) => this.logError('removing a conversation log failed', err));
    }
    this.store?.remove(sessionIds);
  }

  // =================================================================================================================
  // Time: parking, the account reset, retention
  // =================================================================================================================

  private async sweep(): Promise<void> {
    if (this.stopping) return;
    const now = this.ctx.clock.now();
    for (const entry of this.entries.values()) {
      const { runner } = entry;
      if (runner.parkable && (runner.restartPending || now - runner.idleSince >= this.config.parkAfterMs)) {
        void runner.park(runner.restartPending ? 'restart' : 'park').catch((err: unknown) => this.logError('parking an agent failed', err));
      }
    }
    if (this.accountState.state === 'usage-limit' && this.accountState.resetsAt !== undefined && now >= this.accountState.resetsAt) {
      this.accountOk();
    }
    if (now - this.lastRetention >= 60 * 60_000 || this.lastRetention === 0) {
      this.lastRetention = now;
      await this.retention(now);
    }
  }

  /** DESIGN §2.4 "Bounds" and "Retention": one session's log, ended free sessions after 30 days, the workspace budget. */
  private async retention(now: number): Promise<void> {
    const expired = [...this.entries.values()].filter((entry) => {
      const record = entry.runner.record;
      return record.purpose === 'free' && record.state === 'ended' && record.endedAt !== undefined && now - record.endedAt >= this.config.freeSessionRetentionMs;
    });
    if (expired.length > 0) await this.forget(expired.map((entry) => entry.runner.id));
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.transcript.bytes > this.config.transcriptMaxSessionBytes) {
        const open = this.openCardSeqs(entry);
        if (await entry.transcript.trim(this.config.transcriptMaxSessionBytes, open)) {
          if (!entry.trimmedSaid) this.push(entry, noticeEvent('info', msg('notice.transcriptTrimmed')));
          entry.trimmedSaid = true;
        }
      }
      total += entry.transcript.bytes;
    }
    if (total > this.config.transcriptMaxBytes) {
      // The oldest ended free sessions go first; then nothing is removed silently: the host is told.
      const candidates = [...this.entries.values()].filter((entry) => entry.runner.record.purpose === 'free' && entry.runner.record.state === 'ended').sort((a, b) => (a.runner.record.endedAt ?? 0) - (b.runner.record.endedAt ?? 0));
      for (const entry of candidates) {
        if (total <= this.config.transcriptMaxBytes) break;
        total -= entry.transcript.bytes;
        await this.forget([entry.runner.id]);
      }
    }
    const full = total > this.config.transcriptMaxBytes;
    if (full !== this.storageFull) {
      this.storageFull = full;
      this.ctx.bus.emit('attention.changed', { source: 'sessions' });
    }
  }

  private openCardSeqs(entry: Entry): number[] {
    if (entry.cardSeqs.size === 0 || isStubService(this.ctx.services.conversation)) return [...entry.cardSeqs.values()];
    try {
      const open = this.ctx.services.conversation.cards(entry.runner.id, [], { includeOpen: true, budgetBytes: Number.MAX_SAFE_INTEGER, forHost: true });
      const ids = new Set([...open.questions.map((card) => card.id), ...open.permissions.map((card) => card.id), ...open.more.map((ref) => ref.id)]);
      return [...entry.cardSeqs].filter(([id]) => ids.has(id)).map(([, seq]) => seq);
    } catch {
      return [...entry.cardSeqs.values()];
    }
  }

  private logError(message: string, err: unknown): void {
    this.ctx.log.error(message, { error: err instanceof SmurgError ? `${err.code}:${String(err.detail?.['reason'] ?? '')}` : err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown' });
  }
}
