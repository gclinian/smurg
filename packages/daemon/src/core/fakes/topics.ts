// TEST ONLY. In-memory TopicService, PlanService and ReportService. They hold topics, plans and reports and emit
// `topic.changed`, `topic.removed`, `plan.changed`, `report.changed` and `attention.changed` as the real module does;
// they parse no file and run no scheduler. A test puts the state it needs (`put`, `putPlan`, `putReport`) and reads
// what was asked of them from `log`.
import {
  SmurgError,
  defaultPermissionMode,
  lineEvent,
  MAIN_ROOT,
  slugFromName,
  takeListPage,
  unmergedError,
  type AgentSession,
  type PlanInfo,
  type RememberedRule,
  type ReportInfo,
  type ReportSummary,
  type Role,
  type StartPreflight,
  type Suggestion,
  type Topic,
  type UserRef,
  type WorkItem,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type {
  AgentSessions,
  AttentionFact,
  ConversationService,
  FileCheck,
  McpToolContext,
  MemberChange,
  PlanService,
  Principal,
  ReportService,
  Req,
  Res,
  TopicRemoval,
  TopicService,
  UserId,
  WorktreeManager,
} from '../interfaces.ts';
import { FAKE_HASH, buildAgentSession, buildPlan, buildReport, buildReportSummary, buildTopic } from './build.ts';
import { CallLog, fakeId, type FakeEnv } from './env.ts';

function userRef(principal: Principal): UserRef {
  if (principal.actor.kind === 'user') return { userId: principal.actor.userId, displayName: principal.actor.displayName };
  return { userId: principal.userId ?? 'dev:host', displayName: 'Host' };
}

export class FakeTopicService implements TopicService {
  readonly log = new CallLog();
  removal: TopicRemoval = { rules: [], disarmed: [] };
  attentionFacts: AttentionFact[] = [];
  private readonly env: FakeEnv;
  private readonly agents: AgentSessions | null;
  private readonly conversation: ConversationService | null;
  private readonly worktrees: Pick<WorktreeManager, 'unmerged' | 'releaseItem' | 'list'> | null;
  private readonly topics = new Map<string, Topic>();

  /**
   * With `agents`, `create` and `restartDiscussion` really open (fake) discussion sessions, a rename relabels the
   * topic's sessions, an archive ends them and a delete forgets them. With `worktrees`, an archive asks about
   * unmerged item worktrees and releases the others.
   */
  constructor(env: FakeEnv, agents: AgentSessions | null = null, conversation: ConversationService | null = null, worktrees: Pick<WorktreeManager, 'unmerged' | 'releaseItem' | 'list'> | null = null) {
    this.env = env;
    this.agents = agents;
    this.conversation = conversation;
    this.worktrees = worktrees;
  }

  /** Puts a topic (new or changed) and emits `topic.changed`. */
  put(topic: Topic): Topic {
    const previous = this.topics.get(topic.id) ?? null;
    this.topics.set(topic.id, structuredClone(topic));
    this.env.bus.emit('topic.changed', { topic: structuredClone(topic), previous });
    return topic;
  }

  /** Sets the attention facts of this module and emits `attention.changed`. */
  setAttention(facts: readonly AttentionFact[]): void {
    this.attentionFacts = facts.map((fact) => ({ ...fact }));
    this.env.bus.emit('attention.changed', { source: 'topics' });
  }

  async create(input: Req<'topic.create'>, principal: Principal): Promise<{ readonly topic: Topic; readonly session: AgentSession }> {
    this.log.record('create', input, principal);
    const slug = input.slug ?? slugFromName(input.name, [...this.topics.values()].map((topic) => topic.slug));
    if ([...this.topics.values()].some((topic) => topic.slug === slug)) throw new SmurgError('conflict', msg('topic.slugTaken'), { reason: 'slug-taken' });
    const id = fakeId('tp');
    // The topic exists (and is announced) BEFORE its discussion session, so a listener of `session.created` finds it.
    const created = this.put(buildTopic({ id, name: input.name, slug, createdBy: userRef(principal), createdAt: this.env.clock.now() }));
    const session = await this.discussion(created, principal, input.firstMessage, 'conversation.started.discussion');
    const topic = this.put({ ...created, discussionSessionId: session.id });
    return { topic, session };
  }

  list(input: Req<'topic.list'>): Res<'topic.list'> {
    const page = takeListPage([...this.topics.values()].filter((topic) => topic.archived === (input.archived ?? false)), input.after, (topic) => topic.id);
    return { topics: page.items.map((topic) => structuredClone(topic)), hasMore: page.hasMore };
  }

  get(topicId: string): Topic | null {
    const topic = this.topics.get(topicId);
    return topic ? structuredClone(topic) : null;
  }

  bySession(sessionId: string): Topic | null {
    const direct = [...this.topics.values()].find((topic) => topic.discussionSessionId === sessionId);
    if (direct) return structuredClone(direct);
    const topicId = this.agents?.get(sessionId)?.topicId;
    return topicId === undefined ? null : this.get(topicId);
  }

  async rename(input: Req<'topic.rename'>, principal: Principal): Promise<Topic> {
    this.log.record('rename', input, principal);
    const topic = this.put({ ...this.need(input.topicId), name: input.name });
    for (const session of this.agents?.list({ topicId: topic.id }) ?? []) this.agents?.setLabels(session.id, { topicName: input.name });
    return topic;
  }

  async archive(input: Req<'topic.archive'>, principal: Principal): Promise<Topic> {
    this.log.record('archive', input, principal);
    const topic = this.need(input.topicId);
    const archivedTopics = this.agents !== null && 'archivedTopics' in this.agents ? (this.agents.archivedTopics as Set<string>) : null;
    if (!input.archived) {
      archivedTopics?.delete(topic.id);
      return this.put({ ...topic, archived: false });
    }
    // Worktrees with changes that were never merged need a decision before anything changes.
    const unmerged = this.worktrees?.unmerged(topic.id) ?? [];
    if (unmerged.length > 0 && input.deleteUnmerged === undefined) {
      throw unmergedError(unmerged.flatMap((worktree) => (worktree.itemId === undefined ? [] : [{ itemId: worktree.itemId, worktreeId: worktree.id, branch: worktree.branch }])), msg('topic.archive.unmerged', { count: unmerged.length }));
    }
    for (const session of this.agents?.list({ topicId: topic.id }) ?? []) {
      if (session.status !== 'ended') await this.agents?.end(session.id, { by: principal.actor, reason: 'archived', keepWorktree: true });
    }
    const keep = new Set(input.deleteUnmerged === false ? unmerged.map((worktree) => worktree.id) : []);
    for (const worktree of this.worktrees?.list() ?? []) {
      if (worktree.topicId === topic.id && worktree.itemId !== undefined && !keep.has(worktree.id)) await this.worktrees?.releaseItem(worktree.id);
    }
    archivedTopics?.add(topic.id);
    return this.put({ ...topic, archived: true });
  }

  async delete(input: Req<'topic.delete'>, principal: Principal): Promise<void> {
    this.log.record('delete', input, principal);
    const topic = this.need(input.topicId);
    if (!topic.archived) throw new SmurgError('conflict', msg('topic.delete.notArchived'), { reason: 'not-archived' });
    const sessionIds = (this.agents?.list({ topicId: topic.id }) ?? []).map((session) => session.id);
    this.topics.delete(topic.id);
    // FIRST the event (listeners can still map the sessions), THEN the transcripts go.
    this.env.bus.emit('topic.removed', { topicId: topic.id, sessionIds });
    await this.agents?.forget(sessionIds);
    if (this.agents !== null && 'archivedTopics' in this.agents) (this.agents.archivedTopics as Set<string>).delete(topic.id);
  }

  async restartDiscussion(input: Req<'topic.discussion.restart'>, principal: Principal): Promise<{ readonly topic: Topic; readonly session: AgentSession }> {
    this.log.record('restartDiscussion', input, principal);
    const topic = this.need(input.topicId);
    const old = topic.discussionSessionId;
    if (this.agents !== null && old !== undefined && this.agents.get(old) !== null && this.agents.get(old)?.status !== 'ended') {
      this.agents.append(old, lineEvent(msg('conversation.discussion.replaced')));
      await this.agents.end(old, { by: { kind: 'system' }, reason: 'replaced', keepWorktree: true });
    }
    const session = await this.discussion(topic, principal, undefined, 'conversation.discussion.restarted');
    return { topic: this.put({ ...topic, discussionSessionId: session.id, discussion: 'live' }), session };
  }

  async revise(input: Req<'topic.revise'>, principal: Principal): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }> {
    this.log.record('revise', input, principal);
    const topic = this.need(input.topicId);
    if (topic.discussion === 'lost' || topic.discussionSessionId === undefined) throw new SmurgError('conflict', msg('topic.noDiscussion'), { reason: 'no-discussion' });
    if (this.conversation === null) return { messageId: fakeId('m') };
    return this.conversation.sendAs(principal, {
      sessionId: topic.discussionSessionId,
      text: input.text,
      origin: 'revise',
      target: input.target,
      topicId: topic.id,
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
      ...(input.quote === undefined ? {} : { quote: input.quote }),
    });
  }

  async requestSpec(input: Req<'topic.spec.request'>, principal: Principal): Promise<void> {
    this.log.record('requestSpec', input, principal);
    this.need(input.topicId);
  }

  async addRule(input: Req<'topic.rule.add'>, principal: Principal): Promise<Topic> {
    this.log.record('addRule', input, principal);
    await this.rememberRule(input.topicId, { tool: input.tool, pattern: input.pattern }, principal);
    return this.need(input.topicId);
  }

  async rememberRule(topicId: string, rule: { readonly tool: 'Bash' | 'WebFetch'; readonly pattern: string }, by: Principal): Promise<RememberedRule> {
    this.log.record('rememberRule', topicId, rule, by);
    const topic = this.need(topicId);
    const remembered: RememberedRule = { id: fakeId('rl'), tool: rule.tool, pattern: rule.pattern, scope: 'topic', addedBy: userRef(by), addedAt: this.env.clock.now() };
    this.put({ ...topic, rules: [...topic.rules, remembered] });
    return remembered;
  }

  async removeRule(input: Req<'topic.rule.remove'>, principal: Principal): Promise<Topic> {
    this.log.record('removeRule', input, principal);
    const topic = this.need(input.topicId);
    return this.put({ ...topic, rules: topic.rules.filter((rule) => rule.id !== input.ruleId) });
  }

  rules(topicId: string): readonly RememberedRule[] {
    return (this.topics.get(topicId)?.rules ?? []).map((rule) => ({ ...rule }));
  }

  memberRemoved(userId: UserId, change: MemberChange, to?: Role): TopicRemoval {
    this.log.record('memberRemoved', userId, change, to);
    return this.removal;
  }

  attention(): AttentionFact[] {
    return this.attentionFacts.map((fact) => ({ ...fact }));
  }

  private need(topicId: string): Topic {
    const topic = this.topics.get(topicId);
    if (!topic) throw new SmurgError('not_found', msg('topic.notFound'));
    return topic;
  }

  private async discussion(topic: Topic, principal: Principal, firstMessage: string | undefined, opening: 'conversation.started.discussion' | 'conversation.discussion.restarted'): Promise<AgentSession> {
    if (this.agents === null) return buildAgentSession({ id: fakeId('sess'), purpose: 'discussion', topicId: topic.id, topicName: topic.name, openedBy: userRef(principal), modeFixed: true });
    return this.agents.start({
      purpose: 'discussion',
      topic: { id: topic.id, slug: topic.slug, name: topic.name },
      openedBy: principal,
      responsible: null,
      workspace: { mode: 'main' },
      mode: defaultPermissionMode('discussion', MAIN_ROOT),
      rolePrompt: ({ smurgTag }) => `fake discussion prompt for specs/${topic.slug}/ [smurg ${smurgTag}]`,
      opening: msg(opening, { name: userRef(principal).displayName }),
      ...(firstMessage === undefined ? {} : { firstMessage: { kind: 'person' as const, from: principal, text: firstMessage, cleaned: false, origin: 'composer' as const } }),
    });
  }
}

export class FakePlanService implements PlanService {
  readonly log = new CallLog();
  /** What `preflight` answers (tests set it); default: every not-started item starts now, nothing blocks. */
  nextPreflight: StartPreflight | null = null;
  /** What `checkPlan` answers. */
  planCheck: ReturnType<PlanService['checkPlan']> = { ok: true, items: 1, warnings: [] };
  /** What `changes` answers ("Show the changes"); default: nothing changed. */
  nextChanges: Res<'plan.changes'> = { files: [] };
  private readonly env: FakeEnv;
  private readonly plans = new Map<string, PlanInfo>();

  constructor(env: FakeEnv) {
    this.env = env;
  }

  /** Puts a plan (new or changed) and emits `plan.changed`. */
  putPlan(plan: PlanInfo): PlanInfo {
    this.plans.set(plan.topicId, structuredClone(plan));
    this.env.bus.emit('plan.changed', { topicId: plan.topicId, plan: structuredClone(plan) });
    return plan;
  }

  /** Changes one item of a plan and emits `plan.changed`. */
  patchItem(topicId: string, itemId: string, patch: Partial<WorkItem>): PlanInfo {
    const plan = this.need(topicId);
    return this.putPlan({ ...plan, items: plan.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)) });
  }

  get(topicId: string): PlanInfo | null {
    const plan = this.plans.get(topicId);
    return plan ? structuredClone(plan) : null;
  }

  itemBySession(sessionId: string): { readonly topicId: string; readonly item: WorkItem } | null {
    for (const plan of this.plans.values()) {
      const item = plan.items.find((candidate) => candidate.sessionId === sessionId);
      if (item) return { topicId: plan.topicId, item: structuredClone(item) };
    }
    return null;
  }

  async generate(input: Req<'plan.generate'>, principal: Principal): Promise<void> {
    this.log.record('generate', input, principal);
  }

  async setMode(input: Req<'plan.mode.set'>, principal: Principal): Promise<PlanInfo> {
    this.log.record('setMode', input, principal);
    return this.putPlan({ ...this.need(input.topicId), mode: input.mode });
  }

  async assign(input: Req<'plan.assign'>, principal: Principal): Promise<PlanInfo> {
    this.log.record('assign', input, principal);
    const user = input.userId === null ? null : (this.env.members?.userRef(input.userId) ?? { userId: input.userId, displayName: input.userId.slice(input.userId.indexOf(':') + 1) });
    return this.patchItem(input.topicId, input.itemId, { responsible: user === null ? null : { ...user, source: 'chosen' } });
  }

  async suggest(input: Req<'plan.suggest'>, principal: Principal): Promise<PlanInfo> {
    this.log.record('suggest', input, principal);
    return this.need(input.topicId);
  }

  async preflight(input: Req<'plan.preflight'>, principal: Principal): Promise<StartPreflight> {
    this.log.record('preflight', input, principal);
    if (this.nextPreflight !== null) return structuredClone(this.nextPreflight);
    const plan = this.need(input.topicId);
    const items = plan.items.filter((item) => item.state === 'not-started' && (input.itemIds === undefined || input.itemIds.includes(item.id)));
    return {
      planRevision: plan.revision,
      specHash: plan.specHash,
      planHash: plan.planHash,
      startsNow: items.filter((item) => item.dependsOn.length === 0).map((item) => item.id),
      waits: items.filter((item) => item.dependsOn.length > 0).map((item) => ({ itemId: item.id, for: [...item.dependsOn] })),
      alreadyStarted: plan.items.filter((item) => item.state !== 'not-started').map((item) => item.id),
      responsible: items.map((item) => ({ itemId: item.id, user: item.responsible === null ? null : { userId: item.responsible.userId, displayName: item.responsible.displayName }, online: true })),
      youDecide: items.filter((item) => item.responsible === null).length,
      commit: null,
      handEdits: { spec: [], plan: [] },
      invisibleCharacters: [],
      stale: false,
      openQuestion: false,
      specOpenQuestions: 0,
      editingNow: [],
      projectSettings: 'none',
      rules: [],
      sharedDirs: [],
      blockers: [],
    };
  }

  async start(input: Req<'plan.start'>, principal: Principal): Promise<PlanInfo> {
    this.log.record('start', input, principal);
    const plan = this.need(input.topicId);
    if (input.planRevision !== plan.revision || input.specHash !== plan.specHash || input.planHash !== plan.planHash) {
      throw new SmurgError('conflict', msg('plan.start.changed'), { reason: 'plan-changed' });
    }
    const startedBy = userRef(principal);
    return this.putPlan({
      ...plan,
      items: plan.items.map((item) =>
        item.state === 'not-started' && (input.itemIds === undefined || input.itemIds.includes(item.id))
          ? { ...item, armed: true, startedBy, state: item.dependsOn.length === 0 ? ('queued' as const) : ('waiting' as const), ...(item.dependsOn.length === 0 ? {} : { waitsFor: [...item.dependsOn] }) }
          : item,
      ),
    });
  }

  async changes(input: Req<'plan.changes'>, principal: Principal): Promise<Res<'plan.changes'>> {
    this.log.record('changes', input, principal);
    return structuredClone(this.nextChanges);
  }

  async resume(input: Req<'plan.resume'>, principal: Principal): Promise<PlanInfo> {
    this.log.record('resume', input, principal);
    return this.putPlan({ ...this.need(input.topicId), paused: false });
  }

  async retryItem(input: Req<'plan.item.retry'>, principal: Principal): Promise<PlanInfo> {
    this.log.record('retryItem', input, principal);
    return this.need(input.topicId);
  }

  async continueItem(input: Req<'plan.item.continue'>, principal: Principal): Promise<void> {
    this.log.record('continueItem', input, principal);
  }

  async resolveItem(input: Req<'plan.item.resolve'>, principal: Principal): Promise<void> {
    this.log.record('resolveItem', input, principal);
  }

  checkPlan(ctx: McpToolContext): ReturnType<PlanService['checkPlan']> {
    this.log.record('checkPlan', ctx);
    return this.planCheck;
  }

  recordSplit(ctx: McpToolContext, input: { readonly items: readonly { readonly id: string; readonly person: string }[]; readonly reason: string }): { readonly ok: true; readonly assigned: number; readonly unknownPeople: number } {
    this.log.record('recordSplit', ctx, input);
    return { ok: true, assigned: input.items.length, unknownPeople: 0 };
  }

  private need(topicId: string): PlanInfo {
    const plan = this.plans.get(topicId);
    if (!plan) throw new SmurgError('not_found', msg('plan.none'));
    return plan;
  }
}

/** A plan with one not-started item per id, for tests: `planOf('tp_1', ['cart-api', 'checkout-page'])`. */
export function planOf(topicId: string, itemIds: readonly string[]): PlanInfo {
  const base = buildPlan({ topicId });
  const template = base.items[0] as WorkItem;
  return { ...base, specHash: FAKE_HASH, planHash: FAKE_HASH, items: itemIds.map((id, index) => ({ ...template, id, number: index + 1, title: id })) };
}

export class FakeReportService implements ReportService {
  readonly log = new CallLog();
  /** What `checkReport` answers. */
  reportCheck: FileCheck = { ok: true };
  private readonly env: FakeEnv;
  private readonly conversation: ConversationService | null;
  private readonly plans: PlanService | null;
  private readonly reports = new Map<string, ReportInfo>();

  /** With `conversation` and `plans`, a follow-up really goes to the item's (fake) session. */
  constructor(env: FakeEnv, conversation: ConversationService | null = null, plans: PlanService | null = null) {
    this.env = env;
    this.conversation = conversation;
    this.plans = plans;
  }

  /** Registers a report version (new or changed) and emits `report.changed`. */
  putReport(report: ReportInfo): ReportInfo {
    const key = `${report.topicId}/${report.itemId}`;
    const previous = this.reports.get(key);
    this.reports.set(key, structuredClone(report));
    this.env.bus.emit('report.changed', { topicId: report.topicId, itemId: report.itemId, report: summaryOf(report), previous: previous ? summaryOf(previous) : null });
    return report;
  }

  /** A report to review for an item, with defaults. */
  register(topicId: string, itemId: string, summary: Partial<ReportSummary> = {}): ReportInfo {
    return this.putReport(buildReport({ ...buildReportSummary(summary), topicId, itemId }));
  }

  get(topicId: string, itemId: string): ReportInfo | null {
    const report = this.reports.get(`${topicId}/${itemId}`);
    return report ? structuredClone(report) : null;
  }

  toReview(): { readonly topicId: string; readonly itemId: string; readonly report: ReportSummary }[] {
    return [...this.reports.values()]
      .filter((report) => report.state === 'to-review' || report.state === 'changed-after-review')
      .map((report) => ({ topicId: report.topicId, itemId: report.itemId, report: summaryOf(report) }));
  }

  async followUp(input: Req<'report.followUp'>, principal: Principal): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }> {
    this.log.record('followUp', input, principal);
    this.need(input.topicId, input.itemId);
    const sessionId = this.plans?.get(input.topicId)?.items.find((item) => item.id === input.itemId)?.sessionId;
    if (this.conversation === null || sessionId === undefined) return { messageId: fakeId('m') };
    return this.conversation.sendAs(principal, { sessionId, text: input.text, origin: 'follow-up', topicId: input.topicId, itemId: input.itemId, ...(input.mentions === undefined ? {} : { mentions: input.mentions }) });
  }

  async review(input: Req<'report.review'>, principal: Principal): Promise<ReportSummary> {
    this.log.record('review', input, principal);
    const report = this.need(input.topicId, input.itemId);
    if (input.version !== report.version) throw new SmurgError('conflict', msg('report.changed'), { reason: 'report-changed' });
    if (report.outcome !== 'complete' && input.acknowledgeUnfinished !== true) throw new SmurgError('conflict', msg('report.unfinished'), { reason: 'unfinished' });
    return summaryOf(this.putReport({ ...report, state: 'reviewed', review: { by: userRef(principal), at: this.env.clock.now(), version: report.version } }));
  }

  checkReport(ctx: McpToolContext): FileCheck {
    this.log.record('checkReport', ctx);
    return this.reportCheck;
  }

  private need(topicId: string, itemId: string): ReportInfo {
    const report = this.reports.get(`${topicId}/${itemId}`);
    if (!report) throw new SmurgError('not_found', msg('report.none'));
    return report;
  }
}

/** The summary part of a report (what `report.updated` and a work item carry). */
export function summaryOf(report: ReportInfo): ReportSummary {
  const { version, writtenAt, outcome, state, reviewers, escalatedAt, review, checks, error } = report;
  return structuredClone({
    version,
    writtenAt,
    outcome,
    state,
    reviewers,
    checks,
    ...(escalatedAt === undefined ? {} : { escalatedAt }),
    ...(review === undefined ? {} : { review }),
    ...(error === undefined ? {} : { error }),
  });
}
