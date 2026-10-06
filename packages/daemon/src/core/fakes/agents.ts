// TEST ONLY. In-memory AgentSessions, ProjectTrust and HostRules (ARCHITECTURE §7.2): they hold the state the real
// ones hold, emit the same bus events and append the same system lines (core/interfaces.ts says which method writes
// which), so the conversation, topics, inbox and worktree modules are built and tested without Claude Code and
// without each other. Nothing here spawns a process or touches the disk.
//
//   const agents = new FakeAgentSessions(env);
//   const session = await agents.start({ purpose: 'free', openedBy: host, responsible: null, workspace: { mode: 'main' }, mode: 'ask-all', rolePrompt: () => '' });
//   agents.raise(session.id, { id: 'rq_1', kind: 'question', toolUseId: 'tu_1', parts });   // → bus 'agent.request'
//   agents.finishTurn(session.id, { outcome: 'completed' });                                // → bus 'agent.turn.finished'
//   agents.sentTo(session.id)                                                               // what an agent was told
//
// What it does NOT do by itself: a message for a session without a process (parked, failed) stays queued until the
// test calls `resume()` (the real runner starts the process at once); no audit entry is written.
import {
  EVENTS_CATCH_UP_MAX,
  EVENTS_PAGE_MAX,
  EVENTS_PAGE_MAX_BYTES,
  SmurgError,
  agentDisplayName,
  agentSafeName,
  encodedSize,
  lineEvent,
  noticeEvent,
  questionPartsSchema,
  rootRefKey,
  ruleString,
  takeWithinBytes,
  titleFromFirstMessage,
  worktreeRoot,
  type AccountInfo,
  type Actor,
  type AgentSession,
  type CardRef,
  type CardWithdrawnReason,
  type ConversationEvent,
  type ConversationEventInput,
  type LoginState,
  type PayloadInputOf,
  type PermissionMode,
  type ProjectSettingsState,
  type RememberedRule,
  type RootRef,
  type SessionEndReason,
  type StreamingBlock,
  type TurnOutcome,
  type UserRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type {
  AgentRequest,
  AgentSessionFacts,
  AgentSessions,
  AgentStartInput,
  AppendableEvent,
  AttentionFact,
  ClientConnection,
  DaemonStatus,
  EventsPage,
  GateRow,
  HostRules,
  OutboundMessage,
  OutboundType,
  Principal,
  ProjectTrust,
  Req,
  Res,
  StalledBy,
  TurnMessage,
  UserId,
  WatchStart,
} from '../interfaces.ts';
import { buildAgentSession } from './build.ts';
import { CallLog, fakeId, type FakeEnv } from './env.ts';

interface FakeRecord {
  session: AgentSession;
  facts: AgentSessionFacts;
  rolePrompt: string;
  smurgTag: string;
  rules: RememberedRule[];
  events: ConversationEvent[];
  sent: OutboundMessage[];
  queued: { messageId: string; message: OutboundMessage }[];
  open: Map<string, AgentRequest>;
  answers: Map<string, unknown>;
  watchers: Map<string, { userId: UserId; live: boolean }>;
  streaming: StreamingBlock[];
  turn: number;
  turnOpen: string | null;
  turnMessages: TurnMessage[];
  /** The display name of who loosened the mode (`conversation.mode.reset` names them). */
  modeChangedByName: string | null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function userOf(actor: Actor): UserRef | null {
  return actor.kind === 'user' ? { userId: actor.userId, displayName: actor.displayName } : null;
}

export class FakeAgentSessions implements AgentSessions {
  readonly log = new CallLog();
  /** Every `toWatchers` call, whether or not a channel watched. */
  readonly toWatchersLog: { sessionId: string; type: string; payload: unknown; hostPayload?: unknown }[] = [];
  /** What `start` refuses with next (a SmurgError), once. */
  failNextStart: SmurgError | null = null;
  /** What `account()` answers; change it with `setAccount` to get the events too. */
  accountState: AccountInfo = { state: 'ok', sessions: 0 };
  claudeStatus: NonNullable<DaemonStatus['claude']> | null = null;
  attentionFacts: AttentionFact[] = [];
  /** Topics that are archived: their sessions are not in `list()` without a topic (FakeTopicService keeps it current). */
  readonly archivedTopics = new Set<string>();
  private readonly env: FakeEnv;
  private readonly records = new Map<string, FakeRecord>();

  constructor(env: FakeEnv) {
    this.env = env;
  }

  // ---- AgentSessions ---------------------------------------------------------------------------------------------

  async start(input: AgentStartInput): Promise<AgentSession> {
    this.log.record('start', input);
    if (input.purpose !== 'free' && input.topic === undefined) throw new TypeError(`AgentSessions.start: a ${input.purpose} session needs \`topic\``);
    if (input.purpose === 'item' && input.item === undefined) throw new TypeError('AgentSessions.start: an item session needs `item`');
    if (input.purpose === 'free' && (input.topic !== undefined || input.item !== undefined)) throw new TypeError('AgentSessions.start: a free session has no topic and no item');
    if (input.purpose === 'discussion' && input.item !== undefined) throw new TypeError('AgentSessions.start: a discussion session has no item');
    if (this.failNextStart !== null) {
      const error = this.failNextStart;
      this.failNextStart = null;
      throw error;
    }
    const id = fakeId('sess');
    const now = this.env.clock.now();
    const openedBy = this.userRefOf(input.openedBy);
    const root: RootRef = input.workspace.mode === 'main' ? { kind: 'main' } : worktreeRoot(input.workspace.worktreeId);
    const branch = input.workspace.mode === 'worktree' ? `smurg/${input.topic?.slug ?? 'free'}/${input.item?.id ?? input.workspace.worktreeId}` : undefined;
    const smurgTag = 'k7f2';
    const first = input.firstMessage;
    // A title is only what a person gave: typed, or the start of a FREE session's first message.
    const title = input.title ?? (input.purpose === 'free' && first !== undefined && first.kind === 'person' ? titleFromFirstMessage(first.text) : undefined);
    const session = buildAgentSession({
      id,
      purpose: input.purpose,
      topicId: input.topic?.id,
      topicName: input.topic?.name,
      itemId: input.item?.id,
      item: input.item === undefined ? undefined : { number: input.item.number, title: input.item.title },
      attempt: input.item?.attempt,
      openedBy,
      responsible: input.responsible,
      title: title === '' ? undefined : title,
      root,
      branch,
      status: 'idle',
      permissionMode: input.mode,
      modeFixed: input.purpose === 'discussion',
      noteworthyAt: now,
      lastActivityAt: now,
      createdAt: now,
    });
    const record: FakeRecord = {
      session,
      facts: {
        sessionId: id,
        purpose: input.purpose,
        ...(input.topic === undefined ? {} : { topicId: input.topic.id }),
        ...(input.item === undefined ? {} : { itemId: input.item.id }),
        attempt: input.item?.attempt ?? 1,
        root,
        ...(input.workspace.mode === 'worktree' ? { worktreeId: input.workspace.worktreeId } : {}),
        openedBy,
        ownerUserId: openedBy.userId,
        pathRights: input.openedBy.role === 'host' ? 'host' : 'member',
        fallbackDecider: openedBy.userId,
        hasProcess: true,
      },
      rolePrompt: input.rolePrompt({ smurgTag, ...(branch === undefined ? {} : { branch }) }),
      smurgTag,
      rules: [],
      events: [],
      sent: [],
      queued: [],
      open: new Map(),
      answers: new Map(),
      watchers: new Map(),
      streaming: [],
      turn: 0,
      turnOpen: null,
      turnMessages: [],
      modeChangedByName: null,
    };
    this.records.set(id, record);
    this.env.bus.emit('session.created', { session: clone(record.session) });
    this.processChanged(record, 'started');
    if (input.opening !== undefined) this.push(record, lineEvent(input.opening));
    if (first !== undefined) await this.send(id, first);
    return clone(record.session);
  }

  get(sessionId: string): AgentSession | null {
    const record = this.records.get(sessionId);
    return record ? clone(record.session) : null;
  }

  list(filter: { readonly topicId?: string } = {}): AgentSession[] {
    return [...this.records.values()]
      .filter((record) => (filter.topicId === undefined ? record.session.topicId === undefined || !this.archivedTopics.has(record.session.topicId) : record.session.topicId === filter.topicId))
      .map((record) => clone(record.session));
  }

  facts(sessionId: string): AgentSessionFacts | null {
    const record = this.records.get(sessionId);
    return record ? { ...record.facts } : null;
  }

  async send(sessionId: string, message: OutboundMessage): Promise<{ readonly messageId: string; readonly seq: number }> {
    this.log.record('send', sessionId, message);
    const record = this.need(sessionId);
    if (record.session.status === 'ended') throw new SmurgError('conflict', msg('session.ended.noMessages'), { reason: 'ended' });
    const messageId = fakeId('m');
    record.sent.push(message);
    record.turnMessages.push(
      message.kind === 'person'
        ? { messageId, kind: 'person', origin: message.origin, from: this.userRefOf(message.from), ...(message.suggestion === undefined ? {} : { suggestionId: message.suggestion.id }) }
        : { messageId, kind: 'smurg', purpose: message.purpose, ...(message.by === undefined ? {} : { by: message.by }) },
    );
    const event: ConversationEventInput =
      message.kind === 'person'
        ? {
            kind: 'message',
            messageId,
            from: { ...this.userRefOf(message.from), role: message.from.role ?? 'host' },
            text: message.text,
            ...(message.cleaned ? { cleaned: true as const } : {}),
            origin: message.origin,
            ...(message.suggestion === undefined ? {} : { suggestion: message.suggestion }),
            ...(message.mentions === undefined || message.mentions.length === 0 ? {} : { mentions: [...message.mentions] }),
          }
        : { kind: 'smurg', messageId, purpose: message.purpose, text: message.text, ...(message.by === undefined ? {} : { by: message.by }) };
    const seq = this.push(record, event);
    if (!record.facts.hasProcess) {
      record.queued.push({ messageId, message });
      this.push(record, { kind: 'delivery', messageId, state: 'queued' });
    }
    if (message.kind === 'person') this.update(record, { noteworthyAt: this.env.clock.now() });
    return { messageId, seq };
  }

  cancelQueued(fromUserId: UserId): { readonly sessionId: string; readonly messageIds: readonly string[] }[] {
    this.log.record('cancelQueued', fromUserId);
    const out: { sessionId: string; messageIds: string[] }[] = [];
    for (const record of this.records.values()) {
      const mine = record.queued.filter((entry) => entry.message.kind === 'person' && entry.message.from.userId === fromUserId);
      if (mine.length === 0) continue;
      record.queued = record.queued.filter((entry) => !mine.includes(entry));
      record.turnMessages = record.turnMessages.filter((entry) => !mine.some((gone) => gone.messageId === entry.messageId));
      for (const entry of mine) this.push(record, { kind: 'delivery', messageId: entry.messageId, state: 'cancelled' });
      out.push({ sessionId: record.session.id, messageIds: mine.map((entry) => entry.messageId) });
    }
    return out;
  }

  /** Set by tests: sessions whose running turn holds an undelivered message of a member. */
  undelivered = new Map<UserId, string[]>();
  holdingUndelivered(fromUserId: UserId): string[] {
    return [...(this.undelivered.get(fromUserId) ?? [])];
  }

  async interrupt(sessionId: string, by: Actor): Promise<void> {
    this.log.record('interrupt', sessionId, by);
    const record = this.need(sessionId);
    const person = userOf(by);
    if (person !== null) this.push(record, lineEvent(msg('conversation.stopped', { name: person.displayName })));
    for (const requestId of [...record.open.keys()]) this.withdraw(sessionId, requestId, 'stopped', person ?? undefined);
    if (record.turnOpen !== null) this.finishTurn(sessionId, { outcome: 'interrupted', ...(person === null ? {} : { stoppedBy: person }) });
  }

  /** Consecutive start failures of a session (3 make a retry host-only), set by tests. */
  startFailures = new Map<string, number>();
  async retry(sessionId: string, by: Principal): Promise<AgentSession> {
    this.log.record('retry', sessionId, by);
    const record = this.need(sessionId);
    if (record.session.status !== 'failed') throw new SmurgError('conflict', msg('session.retry.notFailed'), { reason: 'not-failed' });
    if ((this.startFailures.get(sessionId) ?? 0) >= 3 && by.role !== 'host') throw new SmurgError('forbidden', msg('session.retry.hostOnly'), { reason: 'host-only' });
    this.push(record, lineEvent(msg('conversation.retry.resumed', { name: this.userRefOf(by).displayName })));
    this.update(record, { status: 'idle', retryHostOnly: undefined });
    this.resume(sessionId);
    return clone(record.session);
  }

  answerQuestion(sessionId: string, requestId: string, answer: { readonly answers: Readonly<Record<string, string>>; readonly notes: Readonly<Record<string, string>> }): void {
    this.log.record('answerQuestion', sessionId, requestId, answer);
    this.settle(sessionId, requestId, answer);
  }

  decidePermission(
    sessionId: string,
    requestId: string,
    decision: { readonly allow: true; readonly sessionRule?: { readonly tool: string; readonly pattern: string } } | { readonly allow: false; readonly message: string },
  ): void {
    this.log.record('decidePermission', sessionId, requestId, decision);
    this.settle(sessionId, requestId, decision);
  }

  async setMode(sessionId: string, mode: PermissionMode, by: Actor): Promise<void> {
    this.log.record('setMode', sessionId, mode, by);
    const record = this.need(sessionId);
    const person = userOf(by);
    if (person !== null) {
      this.push(record, lineEvent(msg('conversation.mode.changed', { by: person.displayName, mode })));
      record.facts = { ...record.facts, modeChangedBy: person.userId };
      record.modeChangedByName = person.displayName;
    } else {
      // The system puts a loosened mode back (ConversationService.memberRemoved): the line names who had changed it.
      if (record.modeChangedByName !== null) this.push(record, lineEvent(msg('conversation.mode.reset', { name: record.modeChangedByName })));
      const { modeChangedBy: _gone, ...facts } = record.facts;
      record.facts = facts;
      record.modeChangedByName = null;
    }
    this.update(record, { permissionMode: mode });
  }

  async setRules(sessionId: string, rules: readonly RememberedRule[], by: Actor): Promise<void> {
    this.log.record('setRules', sessionId, rules, by);
    const record = this.need(sessionId);
    const person = userOf(by);
    const kept = new Set(rules.map((rule) => rule.id));
    const gone = record.rules.filter((rule) => !kept.has(rule.id));
    for (const rule of gone) {
      this.push(
        record,
        lineEvent(
          person === null
            ? msg('conversation.rule.removed.member', { name: rule.addedBy.displayName, rule: ruleString(rule) })
            : msg('conversation.rule.removed', { by: person.displayName, rule: ruleString(rule) }),
        ),
      );
    }
    record.rules = rules.map((rule) => ({ ...rule }));
    this.update(record, { ruleCount: record.rules.length + this.topicRuleCount(record) });
    // A rule that went: the process starts again without it (an added rule is the caller's line, and needs no restart).
    if (gone.length > 0) await this.restartProcess(sessionId, 'rules');
  }

  rules(sessionId: string): readonly RememberedRule[] {
    return this.need(sessionId).rules.map((rule) => ({ ...rule }));
  }

  /** How many rules a session's topic contributes to `ruleCount` (tests set it; the real runner asks TopicService). */
  topicRules = new Map<string, number>();
  private topicRuleCount(record: FakeRecord): number {
    return record.session.topicId === undefined ? 0 : (this.topicRules.get(record.session.topicId) ?? 0);
  }

  setResponsible(sessionId: string, responsible: UserRef | null, by: Actor): void {
    this.log.record('setResponsible', sessionId, responsible, by);
    const record = this.need(sessionId);
    const person = userOf(by);
    // By the system (the teardown) no line is written here: teardownUser writes `conversation.responsible.fallback`.
    if (person !== null) {
      this.push(record, lineEvent(responsible === null ? msg('conversation.responsible.cleared', { by: person.displayName }) : msg('conversation.responsible.changed', { by: person.displayName, name: responsible.displayName })));
    }
    this.update(record, { responsible });
  }

  clearFallbackDecider(userId: UserId): string[] {
    this.log.record('clearFallbackDecider', userId);
    const changed: string[] = [];
    for (const record of this.records.values()) {
      if (record.facts.fallbackDecider !== userId) continue;
      record.facts = { ...record.facts, fallbackDecider: null };
      changed.push(record.session.id);
    }
    return changed;
  }

  setOwner(sessionId: string, ownerUserId: UserId, by: Actor): void {
    this.log.record('setOwner', sessionId, ownerUserId, by);
    const record = this.need(sessionId);
    record.facts = { ...record.facts, ownerUserId }; // pathRights never changes
  }

  setItemState(sessionId: string, state: { readonly reportRegistered: boolean; readonly stalled?: StalledBy }): void {
    this.log.record('setItemState', sessionId, state);
    const record = this.need(sessionId);
    if (record.session.status !== 'idle' && record.session.status !== 'done' && record.session.status !== 'stalled') return;
    this.update(record, { status: state.stalled !== undefined ? 'stalled' : state.reportRegistered ? 'done' : 'idle' });
  }

  setTitle(sessionId: string, title: string, by: Actor): void {
    this.log.record('setTitle', sessionId, title, by);
    this.update(this.need(sessionId), { title });
  }

  setLabels(sessionId: string, labels: { readonly topicName?: string; readonly item?: { readonly number: number; readonly title: string } }): void {
    this.log.record('setLabels', sessionId, labels);
    const record = this.need(sessionId);
    if (labels.topicName !== undefined && record.session.topicId === undefined) throw new TypeError('AgentSessions.setLabels: a free session has no topic');
    if (labels.item !== undefined && record.session.itemId === undefined) throw new TypeError('AgentSessions.setLabels: not an item session');
    this.update(record, { ...(labels.topicName === undefined ? {} : { topicName: labels.topicName }), ...(labels.item === undefined ? {} : { item: { ...labels.item } }) });
  }

  async end(sessionId: string, input: { readonly by: Actor; readonly reason: SessionEndReason; readonly keepWorktree: boolean }): Promise<void> {
    this.log.record('end', sessionId, input);
    const record = this.need(sessionId);
    if (record.session.status === 'ended') return;
    const person = userOf(input.by);
    if (person !== null) this.push(record, lineEvent(msg('conversation.ended', { name: person.displayName })));
    for (const requestId of [...record.open.keys()]) this.withdraw(sessionId, requestId, 'ended', person ?? undefined);
    record.turnOpen = null;
    record.queued = [];
    const hadProcess = record.facts.hasProcess;
    record.facts = { ...record.facts, hasProcess: false };
    record.session = {
      ...record.session,
      status: 'ended',
      endedAt: this.env.clock.now(),
      endReason: input.reason,
      ...(person === null ? {} : { endedBy: person }),
    };
    delete record.session.waitingSince;
    delete record.session.runningSince;
    if (hadProcess) this.env.bus.emit('agent.process', { sessionId, purpose: record.facts.purpose, ...(record.facts.topicId === undefined ? {} : { topicId: record.facts.topicId }), hasProcess: false, reason: 'ended' });
    this.env.bus.emit('session.exited', { session: clone(record.session), reason: input.reason });
  }

  async restartProcess(sessionId: string, reason: 'rules' | 'project-settings' | 'host' | 'asked' | 'slot'): Promise<void> {
    this.log.record('restartProcess', sessionId, reason);
    const record = this.need(sessionId);
    if (record.session.status === 'ended') return;
    if (reason !== 'slot') this.push(record, lineEvent(msg('conversation.agent.restarting')));
    // The fake parks at once (the real runner waits for an idle moment without an open request).
    this.park(sessionId);
  }

  async parkRoot(root: RootRef, reason: 'project-settings-changed'): Promise<void> {
    this.log.record('parkRoot', root, reason);
    for (const record of this.records.values()) {
      if (rootRefKey(record.session.root) !== rootRefKey(root) || record.session.status === 'ended') continue;
      if (record.turnOpen !== null) await this.interrupt(record.session.id, { kind: 'system' });
      this.push(record, noticeEvent('warning', msg('session.projectSettings.changed')));
      this.park(record.session.id);
    }
  }

  append(sessionId: string, event: AppendableEvent): number {
    this.log.record('append', sessionId, event);
    return this.push(this.need(sessionId), event);
  }

  async redact(sessionId: string, seq: number, by: Principal): Promise<void> {
    this.log.record('redact', sessionId, seq, by);
    const record = this.need(sessionId);
    const index = record.events.findIndex((event) => event.seq === seq);
    if (index === -1) throw new SmurgError('not_found');
    const replacement: ConversationEvent = { seq, at: (record.events[index] as ConversationEvent).at, ...noticeEvent('info', msg('conversation.redacted')) };
    record.events[index] = replacement;
    this.toWatchers(sessionId, 'session.events', { sessionId, events: [replacement] });
  }

  async watch(input: Req<'session.watch'>, conn: ClientConnection): Promise<WatchStart> {
    this.log.record('watch', input, conn.channelId);
    const record = this.need(input.sessionId);
    const lastSeq = record.events.at(-1)?.seq ?? 0;
    // The events after `haveSeq`; the NEWEST page without it or when it is too far behind.
    const from = input.haveSeq === undefined || lastSeq - input.haveSeq > EVENTS_CATCH_UP_MAX ? ({ newest: true } as const) : { after: input.haveSeq };
    const page = this.page(record, from, EVENTS_PAGE_MAX);
    return {
      ...page,
      session: clone(record.session),
      streaming: record.streaming.map((block) => ({ ...block })),
      afterReply: () => {
        record.watchers.set(conn.channelId, { userId: conn.userId, live: input.live ?? true });
      },
    };
  }

  /**
   * Makes a channel a watcher WITHOUT the request (what `session.watch` + `afterReply()` do): tests that want a member
   * to receive `session.events` and card updates and have no `session.watch` handler composed.
   */
  addWatcher(conn: Pick<ClientConnection, 'channelId' | 'userId'>, sessionId: string, live = true): void {
    this.need(sessionId).watchers.set(conn.channelId, { userId: conn.userId, live });
  }

  unwatch(sessionId: string, channelId: string): void {
    this.log.record('unwatch', sessionId, channelId);
    this.records.get(sessionId)?.watchers.delete(channelId);
  }

  async history(input: Req<'session.history'>): Promise<EventsPage> {
    this.log.record('history', input);
    const record = this.need(input.sessionId);
    return this.page(record, input.beforeSeq !== undefined ? { before: input.beforeSeq } : { after: input.afterSeq ?? 0 }, input.limit);
  }

  toWatchers<T extends OutboundType>(sessionId: string, type: T, payload: PayloadInputOf<T>, hostPayload?: PayloadInputOf<T>): void {
    this.toWatchersLog.push({ sessionId, type, payload, ...(hostPayload === undefined ? {} : { hostPayload }) });
    const record = this.records.get(sessionId);
    if (!record || this.env.hub === undefined) return;
    const channels = [...record.watchers].filter(([, watcher]) => type !== 'session.delta' || watcher.live).map(([channelId]) => channelId);
    this.env.hub.sendToChannels(channels, type, payload, hostPayload === undefined ? {} : { hostPayload });
  }

  watchers(sessionId: string): UserId[] {
    return [...new Set([...(this.records.get(sessionId)?.watchers.values() ?? [])].map((watcher) => watcher.userId))];
  }

  /** Where `storageDir` points (tests that need real files set a temp directory here). */
  storageRoot: string | null = null;
  async storageDir(sessionId: string): Promise<string> {
    this.need(sessionId);
    if (this.storageRoot === null) throw new Error('FakeAgentSessions.storageRoot is not set: give the fake a temp directory for storageDir()');
    return `${this.storageRoot}/${Buffer.from(sessionId, 'utf8').toString('hex')}`;
  }

  async forget(sessionIds: readonly string[]): Promise<void> {
    this.log.record('forget', sessionIds);
    for (const id of sessionIds) this.records.delete(id);
  }

  account(): AccountInfo {
    return { ...this.accountState };
  }

  claude(): NonNullable<DaemonStatus['claude']> | null {
    return this.claudeStatus === null ? null : { ...this.claudeStatus };
  }

  attention(): AttentionFact[] {
    return this.attentionFacts.map((fact) => ({ ...fact }));
  }

  // ---- drivers: what Claude Code, the runner and the hooks would do ------------------------------------------------

  /** The workspace's account state changes: bus `account.changed` and `attention.changed { source: 'sessions' }`. */
  setAccount(account: AccountInfo): void {
    this.accountState = { ...account };
    this.env.bus.emit('account.changed', { account: { ...account } });
    this.env.bus.emit('attention.changed', { source: 'sessions' });
  }

  /** Everything `send` was given for a session, oldest first. */
  sentTo(sessionId: string): readonly OutboundMessage[] {
    return [...this.need(sessionId).sent];
  }

  /** The whole conversation of a session. */
  eventsOf(sessionId: string): readonly ConversationEvent[] {
    return this.need(sessionId).events.map((event) => clone(event));
  }

  /** The role prompt `start` got from the caller, and the session's tag. */
  rolePromptOf(sessionId: string): { readonly rolePrompt: string; readonly smurgTag: string } {
    const record = this.need(sessionId);
    return { rolePrompt: record.rolePrompt, smurgTag: record.smurgTag };
  }

  /** The answer the conversation module gave to a request (`answerQuestion` / `decidePermission`), if any. */
  answerTo(sessionId: string, requestId: string): unknown {
    return this.need(sessionId).answers.get(requestId);
  }

  /** The process answered `initialize`: `login` / `claudeVersion` on the session, bus `agent.ready`. */
  ready(sessionId: string, facts: { readonly login?: LoginState; readonly claudeVersion?: string; readonly tools?: readonly string[] } = {}): void {
    const record = this.need(sessionId);
    const login = facts.login ?? 'logged-in';
    const claudeVersion = facts.claudeVersion ?? '2.1.288';
    this.update(record, { login, claudeVersion });
    this.env.bus.emit('agent.ready', { sessionId, claudeVersion, login, tools: [...(facts.tools ?? [])] });
  }

  /** The tool gate refused a tool call (what the hooks module emits): bus `agent.tool.gate`. */
  gateDenied(sessionId: string, denial: { readonly tool: string; readonly row: GateRow; readonly path?: string }): void {
    this.need(sessionId);
    this.env.bus.emit('agent.tool.gate', { sessionId, tool: denial.tool, row: denial.row, ...(denial.path === undefined ? {} : { path: denial.path }) });
  }

  /** A turn begins: status `running`, `runningSince`, a `turn.started` event, bus `agent.turn.started`. Returns the turn id. */
  startTurn(sessionId: string): string {
    const record = this.need(sessionId);
    if (!record.facts.hasProcess) this.resume(sessionId); // a turn needs a process
    record.turn += 1;
    const turnId = `t_${record.turn}`;
    record.turnOpen = turnId;
    this.push(record, { kind: 'turn.started', turnId });
    this.update(record, { status: 'running', runningSince: this.env.clock.now() });
    this.env.bus.emit('agent.turn.started', { sessionId, turnId });
    return turnId;
  }

  /** The agent says something: a `text` event in the open turn (one is started when none is). */
  say(sessionId: string, text: string): number {
    const record = this.need(sessionId);
    const turnId = record.turnOpen ?? this.startTurn(sessionId);
    return this.push(record, { kind: 'text', turnId, blockId: fakeId('b'), text });
  }

  /** The agent edits a file with its edit tool: `tool.started` + `tool.finished`; remembered for `finishTurn().edited`. */
  private readonly editedThisTurn = new Map<string, { file: { root: RootRef; path: string }; seq: number }[]>();
  edit(sessionId: string, file: { root: RootRef; path: string }, diff = '+changed\n'): number {
    const record = this.need(sessionId);
    const turnId = record.turnOpen ?? this.startTurn(sessionId);
    const toolUseId = fakeId('tu');
    const seq = this.push(record, { kind: 'tool.started', turnId, toolUseId, tool: { name: 'Edit', verb: 'edit', target: file.path, file } });
    this.push(record, { kind: 'tool.finished', turnId, toolUseId, ok: true, result: { additions: 1, deletions: 0, body: { kind: 'diff', text: diff, truncated: false } } });
    const list = this.editedThisTurn.get(sessionId) ?? [];
    list.push({ file, seq });
    this.editedThisTurn.set(sessionId, list);
    return seq;
  }

  /**
   * The agent asks (AskUserQuestion) or wants permission: status `waiting-…`, bus `agent.request`. As the real runner
   * guarantees, a question's `parts` pass `questionPartsSchema`: one that does not is a mistake of the test and throws
   * (the real runner refuses it towards the agent and raises nothing).
   */
  raise(sessionId: string, request: AgentRequest): void {
    const record = this.need(sessionId);
    if (request.kind === 'question') {
      const parts = questionPartsSchema.safeParse(request.parts);
      if (!parts.success) throw new TypeError(`FakeAgentSessions.raise: the runner never raises a question the wire refuses (${parts.error.issues[0]?.message ?? 'invalid parts'})`);
    }
    if (record.turnOpen === null) this.startTurn(sessionId);
    record.open.set(request.id, request);
    this.update(record, { status: request.kind === 'question' ? 'waiting-answer' : 'waiting-permission', waitingSince: this.env.clock.now() });
    this.env.bus.emit('agent.request', { sessionId, request });
  }

  /** Claude Code withdraws a request: bus `agent.request.withdrawn` (`by`: the person who stopped or ended, when one did). */
  withdraw(sessionId: string, requestId: string, reason: Exclude<CardWithdrawnReason, 'restarted'>, by?: UserRef): void {
    const record = this.need(sessionId);
    if (!record.open.delete(requestId)) return;
    this.afterSettle(record);
    this.env.bus.emit('agent.request.withdrawn', { sessionId, requestId, reason, ...(by === undefined ? {} : { by }) });
  }

  /** The turn ends: a `turn.finished` event, status back to `idle`, bus `agent.turn.finished`. */
  finishTurn(sessionId: string, result: { readonly outcome?: TurnOutcome; readonly finalText?: string; readonly stoppedBy?: UserRef } = {}): void {
    const record = this.need(sessionId);
    const turnId = record.turnOpen ?? this.startTurn(sessionId);
    const outcome = result.outcome ?? 'completed';
    if (result.finalText !== undefined) this.push(record, { kind: 'text', turnId, blockId: fakeId('b'), text: result.finalText });
    this.push(record, { kind: 'turn.finished', turnId, outcome, durationMs: 1_000, ...(result.stoppedBy === undefined ? {} : { stoppedBy: result.stoppedBy }) });
    record.turnOpen = null;
    record.streaming = [];
    const messages = record.turnMessages;
    record.turnMessages = [];
    const edited = this.editedThisTurn.get(sessionId) ?? [];
    this.editedThisTurn.delete(sessionId);
    this.update(record, { status: 'idle', waitingSince: undefined, runningSince: undefined, noteworthyAt: this.env.clock.now() });
    this.env.bus.emit('agent.turn.finished', {
      sessionId,
      turnId,
      outcome,
      ...(result.finalText === undefined ? {} : { finalText: result.finalText }),
      ...(result.stoppedBy === undefined ? {} : { stoppedBy: result.stoppedBy }),
      messages,
      edited,
    });
  }

  /** The process dies: status `failed`, open requests withdrawn (`failed`), a notice, bus `agent.process`. */
  fail(sessionId: string, exitCode = 1): void {
    const record = this.need(sessionId);
    for (const requestId of [...record.open.keys()]) this.withdraw(sessionId, requestId, 'failed');
    record.turnOpen = null;
    record.streaming = [];
    this.push(record, noticeEvent('error', msg('notice.processExited', { code: exitCode }), 'retry'));
    this.update(record, { status: 'failed', waitingSince: undefined, runningSince: undefined, noteworthyAt: this.env.clock.now() });
    if (record.facts.hasProcess) {
      record.facts = { ...record.facts, hasProcess: false };
      this.processChanged(record, 'failed');
    }
  }

  /** The session gives up its process (status stays `idle`): the next message is queued until `resume()`. Bus `agent.process`. */
  park(sessionId: string): void {
    const record = this.need(sessionId);
    if (!record.facts.hasProcess) return;
    record.facts = { ...record.facts, hasProcess: false };
    this.processChanged(record, 'parked');
  }

  /**
   * The session has a process again (what the real runner does by itself when a message arrives for a parked or
   * failed session): queued messages are delivered (`delivery` `started`), a `failed` session is `idle`. Bus `agent.process`.
   */
  resume(sessionId: string): void {
    const record = this.need(sessionId);
    if (record.session.status === 'ended' || record.facts.hasProcess) return;
    record.facts = { ...record.facts, hasProcess: true };
    for (const entry of record.queued) this.push(record, { kind: 'delivery', messageId: entry.messageId, state: 'started' });
    record.queued = [];
    if (record.session.status === 'failed') this.update(record, { status: 'idle' });
    this.processChanged(record, 'started');
  }

  /**
   * Text of a block that is streaming right now: kept for the next `watch` (`streaming`) AND sent to the live
   * watchers as `session.delta`, with the offset the block has reached.
   */
  delta(sessionId: string, block: { readonly turnId: string; readonly blockId: string; readonly parentToolUseId?: string }, text: string): void {
    const record = this.need(sessionId);
    let streaming = record.streaming.find((entry) => entry.blockId === block.blockId);
    if (streaming === undefined) {
      streaming = { turnId: block.turnId, blockId: block.blockId, text: '', ...(block.parentToolUseId === undefined ? {} : { parentToolUseId: block.parentToolUseId }) };
      record.streaming.push(streaming);
    }
    const offset = streaming.text.length;
    streaming.text += text;
    this.toWatchers(sessionId, 'session.delta', { sessionId, turnId: block.turnId, blockId: block.blockId, offset, text, ...(block.parentToolUseId === undefined ? {} : { parentToolUseId: block.parentToolUseId }) });
  }

  /** The agent thinks: a thinking delta to the live watchers (no block; a watch reply never holds it). */
  thinking(sessionId: string, block: { readonly turnId: string; readonly blockId: string }): void {
    this.need(sessionId);
    this.toWatchers(sessionId, 'session.delta', { sessionId, turnId: block.turnId, blockId: block.blockId, offset: 0, text: '', thinking: true });
  }

  /** Puts a session the test built itself into the fake (no `start`, no event). */
  adopt(session: AgentSession, facts: Partial<AgentSessionFacts> = {}): void {
    this.records.set(session.id, {
      session: clone(session),
      facts: {
        sessionId: session.id,
        purpose: session.purpose,
        ...(session.topicId === undefined ? {} : { topicId: session.topicId }),
        ...(session.itemId === undefined ? {} : { itemId: session.itemId }),
        attempt: session.attempt ?? 1,
        root: session.root,
        openedBy: session.openedBy,
        ownerUserId: session.openedBy.userId,
        pathRights: 'member',
        fallbackDecider: session.openedBy.userId,
        hasProcess: true,
        ...facts,
      },
      rolePrompt: '',
      smurgTag: 'k7f2',
      rules: [],
      events: [],
      sent: [],
      queued: [],
      open: new Map(),
      answers: new Map(),
      watchers: new Map(),
      streaming: [],
      turn: 0,
      turnOpen: null,
      turnMessages: [],
      modeChangedByName: null,
    });
  }

  /**
   * The agent's Actor, named as the real runner names it: `Claude (<label>)`, the label being the item's title, else
   * the topic's name, else the opener's display name (through `agentSafeName`).
   */
  agentActor(sessionId: string): Extract<Actor, { kind: 'agent' }> {
    const record = this.need(sessionId);
    const session = record.session;
    const label = session.item?.title ?? session.topicName ?? session.openedBy.displayName;
    return { kind: 'agent', sessionId, ownerUserId: record.facts.ownerUserId, displayName: agentDisplayName(agentSafeName(label, session.openedBy.userId)) };
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private need(sessionId: string): FakeRecord {
    const record = this.records.get(sessionId);
    if (!record) throw new SmurgError('not_found', msg('session.notFound'));
    return record;
  }

  private userRefOf(principal: Principal): UserRef {
    if (principal.actor.kind === 'user') return { userId: principal.actor.userId, displayName: principal.actor.displayName };
    return { userId: principal.userId ?? 'dev:host', displayName: 'Host' };
  }

  private processChanged(record: FakeRecord, reason: 'started' | 'parked' | 'failed'): void {
    this.env.bus.emit('agent.process', {
      sessionId: record.session.id,
      purpose: record.facts.purpose,
      ...(record.facts.topicId === undefined ? {} : { topicId: record.facts.topicId }),
      hasProcess: record.facts.hasProcess,
      reason,
    });
  }

  private update(record: FakeRecord, patch: { [K in keyof AgentSession]?: AgentSession[K] | undefined }): void {
    const next: Record<string, unknown> = { ...record.session, lastActivityAt: this.env.clock.now() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    record.session = next as AgentSession;
    this.env.bus.emit('session.updated', { session: clone(record.session) });
  }

  private push(record: FakeRecord, input: ConversationEventInput): number {
    const seq = record.events.length === 0 ? 1 : (record.events[record.events.length - 1] as ConversationEvent).seq + 1;
    const event = { ...input, seq, at: this.env.clock.now() } as ConversationEvent;
    record.events.push(event);
    record.session = { ...record.session, lastSeq: seq };
    this.toWatchers(record.session.id, 'session.events', { sessionId: record.session.id, events: [event] });
    return seq;
  }

  private settle(sessionId: string, requestId: string, answer: unknown): void {
    const record = this.need(sessionId);
    if (!record.open.has(requestId)) throw new SmurgError('conflict', undefined, { reason: 'withdrawn' });
    record.open.delete(requestId);
    record.answers.set(requestId, answer);
    this.afterSettle(record);
  }

  private afterSettle(record: FakeRecord): void {
    const left = [...record.open.values()];
    const status = left.some((request) => request.kind === 'permission') ? 'waiting-permission' : left.length > 0 ? 'waiting-answer' : record.turnOpen !== null ? 'running' : record.session.status;
    if (left.length === 0) this.update(record, { status, waitingSince: undefined });
    else this.update(record, { status });
  }

  /** THE page rule (EVENTS_PAGE_MAX events, EVENTS_PAGE_MAX_BYTES, at least one event). */
  private page(record: FakeRecord, from: { newest: true } | { after: number } | { before: number }, limit: number): EventsPage {
    const all = record.events;
    const nextSeq = (all.at(-1)?.seq ?? 0) + 1;
    let slice: ConversationEvent[];
    if ('after' in from) {
      slice = takeWithinBytes(all.filter((event) => event.seq > from.after), EVENTS_PAGE_MAX_BYTES, { atLeastOne: true, maxItems: limit }).taken;
    } else {
      const pool = 'before' in from ? all.filter((event) => event.seq < from.before) : all;
      slice = takeWithinBytes([...pool].reverse(), EVENTS_PAGE_MAX_BYTES, { atLeastOne: true, maxItems: limit }).taken.reverse();
    }
    const first = slice[0]?.seq ?? 0;
    const last = slice.at(-1)?.seq ?? 0;
    const cardRefs: CardRef[] = slice.flatMap((event) => (event.kind === 'card' ? [{ kind: event.card, id: event.id }] : []));
    // An empty page: asked after N, events at or before N are "earlier"; asked before N, events at or after N are "more".
    const hasEarlier = slice.length > 0 ? all.some((event) => event.seq < first) : 'after' in from && all.some((event) => event.seq <= from.after);
    const hasMore = slice.length > 0 ? all.some((event) => event.seq > last) : 'before' in from && all.some((event) => event.seq >= from.before);
    return { events: slice.map((event) => clone(event)), firstSeq: first, nextSeq, hasEarlier, hasMore, cardRefs, bytes: encodedSize(slice) };
  }
}

/** The trust gate: per-root states the test sets; `decide` records and flips the state. */
export class FakeProjectTrust implements ProjectTrust {
  readonly log = new CallLog();
  readonly states = new Map<string, ProjectSettingsState>();
  readonly protectedByRoot = new Map<string, Set<string>>();
  description: Res<'admin.claudeConfig.get'> = { roots: [], hasMore: false };
  attentionFacts: AttentionFact[] = [];
  private readonly env: FakeEnv;

  constructor(env: FakeEnv) {
    this.env = env;
  }

  /** Sets a root's state and emits `trust.changed`. */
  set(root: RootRef, state: ProjectSettingsState): void {
    this.states.set(rootRefKey(root), state);
    this.env.bus.emit('trust.changed', { root, state });
  }

  state(root: RootRef): ProjectSettingsState {
    return this.states.get(rootRefKey(root)) ?? 'none';
  }

  hashes(_root: RootRef): { readonly path: string; readonly hash: string }[] {
    return [];
  }

  async describe(input: Req<'admin.claudeConfig.get'>): Promise<Res<'admin.claudeConfig.get'>> {
    this.log.record('describe', input);
    return structuredClone(this.description);
  }

  async decide(input: Req<'admin.claudeConfig.decide'>, by: Principal): Promise<void> {
    this.log.record('decide', input, by);
    this.set(input.root, input.decision === 'trust' ? 'used' : 'ignored');
  }

  protectedPaths(root: RootRef): ReadonlySet<string> {
    return this.protectedByRoot.get(rootRefKey(root)) ?? new Set();
  }

  attention(): AttentionFact[] {
    return this.attentionFacts.map((fact) => ({ ...fact }));
  }
}

/** The host's own Claude Code allow rules: they apply; the host is told once. */
export class FakeHostRules implements HostRules {
  readonly log = new CallLog();
  rulesFound: { rule: string; source: 'user' | 'project' | 'local' | 'managed' }[] = [];
  seen = false;
  private readonly env: FakeEnv;

  constructor(env: FakeEnv) {
    this.env = env;
  }

  /** Agent sessions reported these rules: the host has not seen them yet; emits `attention.changed`. */
  found(rules: readonly string[]): void {
    this.rulesFound = rules.map((rule) => ({ rule, source: 'user' as const }));
    this.seen = false;
    this.env.bus.emit('attention.changed', { source: 'host-rules' });
  }

  view(): Res<'admin.hostRules.get'> {
    return { rules: this.rulesFound.map((entry) => ({ ...entry })), seen: this.seen };
  }

  async markSeen(by: Principal): Promise<void> {
    this.log.record('markSeen', by);
    this.seen = true;
    this.env.bus.emit('attention.changed', { source: 'host-rules' });
  }

  applied(): readonly string[] {
    return this.rulesFound.map((entry) => entry.rule);
  }

  attention(): AttentionFact[] {
    if (this.seen || this.rulesFound.length === 0) return [];
    const host = this.env.members?.hostUserId() ?? 'dev:host';
    return [{ subject: 'host-rules', id: 'workspace', at: this.env.clock.now(), recipients: [host], target: { kind: 'console', section: 'host-rules' }, count: this.rulesFound.length, excerpt: '' }];
  }
}
