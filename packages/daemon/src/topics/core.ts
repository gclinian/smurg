// The shared state of the topics module (ARCHITECTURE §5.10): the two state documents, what the wire shows of them
// (Topic, PlanInfo, WorkItem, ReportSummary), the reading and parsing of a topic's two files, and the ONE place that
// announces a change (`publish`: bus `topic.changed` / `plan.changed` and the hub fan-out, only when the wire object
// really differs; then the attention facts). TopicService, PlanService, the scheduler and ReportService all work on
// this object, so a fact has one home and no two of them announce the same change twice.
import {
  MAIN_ROOT,
  PLAN_INFO_ITEMS_MAX,
  PLAN_WAITING_FOR_MAX,
  REVIEWERS_MAX,
  SmurgError,
  agentAccessMembers,
  agentSafeName,
  can,
  permissionRecipients,
  reviewersOf,
  topicFileKind,
  topicPlanPath,
  topicSpecPath,
  wireText,
  type Actor,
  type FileRef,
  type PlanInfo,
  type ReportInfo,
  type ReportSummary,
  type RootRef,
  type Topic,
  type TopicPhase,
  type UserRef,
  type WorkItem,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { AttentionFact, PersistentDocument, Principal, UserId } from '../core/interfaces.ts';
import { SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { attentionFacts } from './attention.ts';
import { parsePlan, planFingerprint, type ParsedItem, type PlanParse } from './plan-format.ts';
import { evenSplit, SIZE_WEIGHT, type SplitPerson } from './split.ts';
import {
  REPORTS_DOCUMENT,
  TOPICS_DOCUMENT,
  initialReportsDocument,
  initialTopicsDocument,
  reportsDocumentSchema,
  topicsDocumentSchema,
  type ReportsDocument,
  type StoredItem,
  type StoredReport,
  type StoredTopic,
  type TopicsDocument,
} from './store.ts';
import { EMPTY_HASH, sha256Hex } from './text.ts';

export interface TopicsOptions {
  /** How long after a change of SPEC.md / PLAN.md on disk the files are read again (changes coalesce). */
  readonly fileDebounceMs: number;
  /** `fix-plan` / `fix-report` are sent at most this many times in a row for one file. */
  readonly maxFixesInRow: number;
}

export const DEFAULT_TOPICS_OPTIONS: TopicsOptions = Object.freeze({ fileDebounceMs: 500, maxFixesInRow: 2 });

/** The most of SPEC.md, PLAN.md or a report the daemon reads (a larger file is read up to here and then fails its format). */
export const TOPIC_FILE_MAX_BYTES = 2 * 1024 * 1024;

export interface FileContent {
  readonly text: string;
  readonly hash: string;
}

export function userRefOf(principal: Principal): UserRef {
  if (principal.actor.kind === 'user') return { userId: principal.actor.userId, displayName: principal.actor.displayName };
  throw new SmurgError('forbidden', undefined, { reason: 'not-a-member' });
}

/** An item that was started at least once, or is armed to start: it is no longer "not started" for the plan's counts. */
export function isStarted(item: StoredItem): boolean {
  return item.armed || item.sessionId !== undefined || item.sessions.length > 0;
}

function newItem(parsed: ParsedItem, now: number): StoredItem {
  return {
    id: parsed.id,
    number: parsed.number,
    title: parsed.title,
    summary: parsed.summary,
    dependsOn: [...parsed.dependsOn],
    size: parsed.size,
    touches: [...parsed.touches],
    state: 'not-started',
    since: now,
    armed: false,
    retry: false,
    responsible: null,
    chosen: false,
    sessions: [],
    attempt: 0,
    merged: false,
    checked: [],
    nudged: false,
  };
}

export class TopicsCore {
  readonly ctx: DaemonContext;
  readonly options: TopicsOptions;
  /** Asks the scheduler for another pass (set by the module). */
  requestSchedule: () => void = () => {};
  /** The main workspace is a git repository (asked of the worktree module at start and at every preflight). */
  versioned = false;
  /** Topics whose plan the agent is writing right now, with the message that asked for it (never persisted). */
  readonly generating = new Map<string, string>();
  private topicsDoc: PersistentDocument<TopicsDocument> | null = null;
  private reportsDoc: PersistentDocument<ReportsDocument> | null = null;
  /** Who last wrote a topic's spec / plan through smurg, until the next read of the file takes it (`changedBy`). */
  private readonly pendingActors = new Map<string, Actor>();
  private readonly lastTopics = new Map<string, Topic>();
  private readonly lastPlans = new Map<string, string>();
  private attentionSignature = '[]';
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(ctx: DaemonContext, options: Partial<TopicsOptions> = {}) {
    this.ctx = ctx;
    this.options = Object.freeze({ ...DEFAULT_TOPICS_OPTIONS, ...options });
  }

  // ===================================================================================================================
  // Documents
  // ===================================================================================================================

  async open(): Promise<void> {
    this.topicsDoc = await this.ctx.state.document(TOPICS_DOCUMENT, topicsDocumentSchema, initialTopicsDocument);
    this.reportsDoc = await this.ctx.state.document(REPORTS_DOCUMENT, reportsDocumentSchema, initialReportsDocument);
    // What the records said before this start is what a later `topic.changed` names as `previous` (a topic that
    // exists is never announced as just created); every plan is announced again by its first publish.
    for (const topic of this.topicsDoc.get().topics) this.lastTopics.set(topic.id, this.toTopic(topic));
  }

  get started(): boolean {
    return this.topicsDoc !== null;
  }

  async flush(): Promise<void> {
    await Promise.allSettled([this.topicsDoc?.flush(), this.reportsDoc?.flush()]);
  }

  private docs(): { readonly topics: PersistentDocument<TopicsDocument>; readonly reports: PersistentDocument<ReportsDocument> } {
    if (this.topicsDoc === null || this.reportsDoc === null) throw new SmurgError('internal', msg('topic.notStarted'), { reason: 'not-started' });
    return { topics: this.topicsDoc, reports: this.reportsDoc };
  }

  topics(): readonly StoredTopic[] {
    return this.docs().topics.get().topics;
  }

  topic(topicId: string): StoredTopic | null {
    return this.topics().find((topic) => topic.id === topicId) ?? null;
  }

  need(topicId: string): StoredTopic {
    const topic = this.topic(topicId);
    if (topic === null) throw new SmurgError('not_found', msg('topic.notFound'), { reason: 'unknown-topic' });
    return topic;
  }

  /** The check `topic-open`: an archived topic is read-only until it is restored. */
  needOpen(topicId: string): StoredTopic {
    const topic = this.need(topicId);
    if (topic.archived) throw new SmurgError('conflict', msg('topic.archived'), { reason: 'archived' });
    return topic;
  }

  item(topic: StoredTopic, itemId: string): StoredItem | null {
    return topic.items.find((item) => item.id === itemId) ?? null;
  }

  needItem(topic: StoredTopic, itemId: string): StoredItem {
    const item = this.item(topic, itemId);
    if (item === null) throw new SmurgError('not_found', msg('plan.item.unknown'), { reason: 'unknown-item' });
    return item;
  }

  /** The topic and item an agent session belongs to (a discussion: the topic alone). */
  bySession(sessionId: string): { readonly topic: StoredTopic; readonly item: StoredItem | null } | null {
    for (const topic of this.topics()) {
      if (topic.discussionSessions.includes(sessionId)) return { topic, item: null };
      const item = topic.items.find((candidate) => candidate.sessions.includes(sessionId));
      if (item !== undefined) return { topic, item };
    }
    return null;
  }

  addTopic(topic: StoredTopic): void {
    this.docs().topics.update((draft) => {
      draft.topics.push(topic);
    });
  }

  removeTopic(topicId: string): void {
    const docs = this.docs();
    docs.topics.update((draft) => {
      draft.topics = draft.topics.filter((topic) => topic.id !== topicId);
    });
    docs.reports.update((draft) => {
      draft.reports = draft.reports.filter((report) => report.topicId !== topicId);
    });
    this.lastTopics.delete(topicId);
    this.lastPlans.delete(topicId);
    this.generating.delete(topicId);
  }

  /** Changes one topic's record. Nothing is announced: call `publish(topicId)` when the change is complete. */
  update(topicId: string, mutate: (topic: StoredTopic) => void): StoredTopic {
    this.docs().topics.update((draft) => {
      const topic = draft.topics.find((candidate) => candidate.id === topicId);
      if (topic !== undefined) mutate(topic);
    });
    return this.need(topicId);
  }

  updateItem(topicId: string, itemId: string, mutate: (item: StoredItem, topic: StoredTopic) => void): void {
    this.update(topicId, (topic) => {
      const item = topic.items.find((candidate) => candidate.id === itemId);
      if (item !== undefined) mutate(item, topic);
    });
  }

  /** Sets an item's state and when it began (the time of an attention item). */
  setItemState(topicId: string, itemId: string, state: StoredItem['state'], stalledBy?: StoredItem['stalledBy']): void {
    const now = this.ctx.clock.now();
    this.updateItem(topicId, itemId, (item) => {
      if (item.state !== state || item.stalledBy !== stalledBy) item.since = now;
      item.state = state;
      if (stalledBy === undefined) delete item.stalledBy;
      else item.stalledBy = stalledBy;
    });
  }

  report(topicId: string, itemId: string): StoredReport | null {
    return this.docs().reports.get().reports.find((report) => report.topicId === topicId && report.itemId === itemId) ?? null;
  }

  reports(): readonly StoredReport[] {
    return this.docs().reports.get().reports;
  }

  putReport(report: StoredReport): void {
    this.docs().reports.update((draft) => {
      const index = draft.reports.findIndex((candidate) => candidate.topicId === report.topicId && candidate.itemId === report.itemId);
      if (index === -1) draft.reports.push(report);
      else draft.reports[index] = report;
    });
  }

  // ===================================================================================================================
  // People
  // ===================================================================================================================

  /** Members with agent access who are online right now, as the agent may be told about them (at most 20). */
  peoplePresent(): SplitPerson[] {
    const online = this.ctx.hub.onlineUserIds();
    const drivers = new Set(agentAccessMembers(this.ctx.members.routing()));
    return this.ctx.members
      .list()
      .filter((member) => member.status === 'active' && drivers.has(member.userId) && online.has(member.userId))
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .slice(0, 20)
      .map((member) => ({ userId: member.userId, name: agentSafeName(member.displayName, member.userId), joinedAt: member.joinedAt }));
  }

  /** Who is responsible for an item as routing sees it: nobody while the plan says "everyone watches" and it has no session. */
  responsibleOf(topic: StoredTopic, item: StoredItem): string | null {
    if (item.sessionId === undefined && topic.plan.mode === 'everyone') return null;
    return item.responsible?.userId ?? null;
  }

  reviewersOf(topic: StoredTopic, item: StoredItem): UserRef[] {
    return reviewersOf({ responsible: this.responsibleOf(topic, item) }, this.ctx.members.routing())
      .slice(0, REVIEWERS_MAX)
      .flatMap((userId) => {
        const ref = this.ctx.members.userRef(userId);
        return ref === null ? [] : [ref];
      });
  }

  /**
   * smurg's even split for the items of a topic that nobody is responsible for yet (in the plan, not started, not
   * chosen by a person), over `people`. Returns how many it filled. The caller publishes.
   */
  fillSplit(topicId: string, people: readonly SplitPerson[], options: { readonly redo?: 'smurg' | 'suggested' } = {}): number {
    let filled = 0;
    this.update(topicId, (topic) => {
      if (topic.plan.mode !== 'assigned' || people.length === 0) return;
      // `redo`: also split again what smurg filled before (`smurg`), or everything nobody chose by hand (`suggested`).
      const again = (source: 'agent' | 'smurg' | 'chosen'): boolean => (options.redo === 'smurg' ? source === 'smurg' : options.redo === 'suggested' ? source !== 'chosen' : false);
      const open = (item: StoredItem): boolean => item.number > 0 && !isStarted(item) && !item.chosen && (item.responsible === null || again(item.responsible.source));
      const targets = topic.items.filter(open);
      if (targets.length === 0) return;
      const loads = new Map<string, { weight: number; items: number }>();
      for (const item of topic.items) {
        if (item.responsible === null || targets.includes(item) || item.number === 0) continue;
        const load = loads.get(item.responsible.userId) ?? { weight: 0, items: 0 };
        load.weight += SIZE_WEIGHT[item.size];
        load.items += 1;
        loads.set(item.responsible.userId, load);
      }
      const assigned = evenSplit(targets, people, loads);
      for (const item of targets) {
        const userId = assigned.get(item.id);
        const ref = userId === undefined ? null : this.ctx.members.userRef(userId);
        if (ref === null) continue;
        item.responsible = { ...ref, source: 'smurg' };
        filled += 1;
      }
      if (filled > 0 && (topic.plan.split === undefined || options.redo === 'suggested')) topic.plan.split = { source: 'smurg' };
    });
    return filled;
  }

  // ===================================================================================================================
  // What the wire shows
  // ===================================================================================================================

  summaryOf(report: ReportInfo): ReportSummary {
    return {
      version: report.version,
      writtenAt: report.writtenAt,
      outcome: report.outcome,
      state: report.state,
      reviewers: report.reviewers.map((reviewer) => ({ ...reviewer })),
      checks: { ...report.checks },
      ...(report.escalatedAt === undefined ? {} : { escalatedAt: report.escalatedAt }),
      ...(report.review === undefined ? {} : { review: structuredClone(report.review) }),
      ...(report.error === undefined ? {} : { error: structuredClone(report.error) }),
    };
  }

  /** The wire's ReportInfo of a stored report (without the daemon's bookkeeping). */
  toReportInfo(stored: StoredReport): ReportInfo {
    const { contentHash: _hash, sessionId: _session, waitingSince: _since, pending: _pending, ...info } = stored;
    return structuredClone(info);
  }

  private isReviewed(topic: StoredTopic, item: StoredItem): boolean {
    return this.report(topic.id, item.id)?.state === 'reviewed';
  }

  phaseOf(topic: StoredTopic): TopicPhase {
    const inPlan = topic.items.filter((item) => item.number > 0);
    if (topic.items.some((item) => isStarted(item) || item.startedBy !== undefined)) {
      return inPlan.length > 0 && inPlan.every((item) => this.isReviewed(topic, item)) ? 'complete' : 'executing';
    }
    if (topic.plan.exists && topic.plan.valid && topic.plan.parsed) return 'plan';
    return topic.spec.exists ? 'spec' : 'discussing';
  }

  toTopic(topic: StoredTopic): Topic {
    const inPlan = topic.items.filter((item) => item.number > 0);
    const stale = topic.spec.exists && topic.plan.exists && topic.spec.changedAt !== undefined && topic.plan.changedAt !== undefined && topic.spec.changedAt > topic.plan.changedAt;
    return structuredClone({
      id: topic.id,
      name: topic.name,
      slug: topic.slug,
      phase: this.phaseOf(topic),
      archived: topic.archived,
      versioned: this.versioned,
      createdBy: topic.createdBy,
      createdAt: topic.createdAt,
      ...(topic.discussionSessionId === undefined ? {} : { discussionSessionId: topic.discussionSessionId }),
      discussion: topic.discussion,
      spec: {
        exists: topic.spec.exists,
        ...(topic.spec.changedAt === undefined ? {} : { changedAt: topic.spec.changedAt }),
        ...(topic.spec.changedBy === undefined ? {} : { changedBy: topic.spec.changedBy }),
        ...(topic.spec.lastAgentChange === undefined ? {} : { lastAgentChange: topic.spec.lastAgentChange }),
      },
      handEdits: topic.handEdits,
      plan: {
        exists: topic.plan.exists,
        valid: topic.plan.valid,
        ...(topic.plan.error === undefined ? {} : { error: topic.plan.error }),
        generating: this.generating.has(topic.id),
        stale,
        mode: topic.plan.mode,
        paused: topic.plan.paused,
        ...(topic.plan.changedAt === undefined ? {} : { changedAt: topic.plan.changedAt }),
        ...(topic.plan.changedBy === undefined ? {} : { changedBy: topic.plan.changedBy }),
        items: inPlan.length,
        started: inPlan.filter((item) => isStarted(item)).length,
        reviewed: inPlan.filter((item) => this.isReviewed(topic, item)).length,
        merged: inPlan.filter((item) => item.merged).length,
      },
      rules: topic.rules,
    });
  }

  toWorkItem(topic: StoredTopic, item: StoredItem): WorkItem {
    const report = this.report(topic.id, item.id);
    const waitsFor = item.state === 'waiting' ? this.unmergedDependencies(topic, item) : [];
    const showsResponsible = item.sessionId !== undefined || topic.plan.mode === 'assigned';
    return structuredClone({
      id: item.id,
      number: item.number,
      title: item.title,
      summary: item.summary,
      dependsOn: item.dependsOn,
      size: item.size,
      touches: item.touches,
      inPlan: item.number > 0,
      state: item.state,
      ...(item.state === 'stalled' && item.stalledBy !== undefined ? { stalledBy: item.stalledBy } : {}),
      armed: item.armed,
      ...(item.disarmed === undefined ? {} : { disarmed: item.disarmed }),
      ...(waitsFor.length === 0 ? {} : { waitsFor }),
      responsible: showsResponsible ? item.responsible : null,
      ...(item.startedBy === undefined ? {} : { startedBy: item.startedBy }),
      ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
      ...(item.worktreeId === undefined ? {} : { worktreeId: item.worktreeId }),
      attempt: item.attempt,
      ...(item.startError === undefined ? {} : { startError: item.startError }),
      ...(item.changesAsked === undefined ? {} : { changesAsked: item.changesAsked }),
      ...(report === null ? {} : { report: this.summaryOf(report) }),
      ...(item.merge === undefined ? {} : { merge: item.merge }),
    });
  }

  /** The ids an item depends on whose changes have not reached the main workspace yet. */
  unmergedDependencies(topic: StoredTopic, item: StoredItem): string[] {
    return item.dependsOn.filter((id) => topic.items.find((candidate) => candidate.id === id)?.merged !== true);
  }

  /** How many agent processes of work items run, of how many the host allows (the scheduler's ONE limit). */
  slots(): PlanInfo['slots'] {
    const max = this.ctx.settings.get().maxLiveAgents;
    const agents = this.ctx.services.agents;
    if (isStubService(agents)) return { inUse: 0, max, waitingForPeople: 0 };
    let inUse = 0;
    let waitingForPeople = 0;
    for (const session of agents.list()) {
      if (session.purpose !== 'item' || agents.facts(session.id)?.hasProcess !== true) continue;
      inUse += 1;
      if (session.status === 'waiting-answer' || session.status === 'waiting-permission') waitingForPeople += 1;
    }
    return { inUse, max, waitingForPeople };
  }

  private waitingFor(topic: StoredTopic): PlanInfo['waitingFor'] {
    const bySession = new Map<string, StoredItem>();
    for (const item of topic.items) if (item.sessionId !== undefined) bySession.set(item.sessionId, item);
    const waits = new Map<UserId, { questions: number; permissions: number; reports: number; since: number }>();
    const add = (userId: UserId, what: 'questions' | 'permissions' | 'reports', since: number): void => {
      const entry = waits.get(userId) ?? { questions: 0, permissions: 0, reports: 0, since };
      entry[what] += 1;
      entry.since = Math.min(entry.since, since);
      waits.set(userId, entry);
    };
    const members = this.ctx.members.routing();
    const conversation = this.ctx.services.conversation;
    if (!isStubService(conversation) && bySession.size > 0) {
      for (const question of conversation.openQuestions()) {
        if (bySession.has(question.sessionId) && question.decider !== null) add(question.decider.userId, 'questions', question.askedAt);
      }
      for (const request of conversation.openPermissions()) {
        const item = bySession.get(request.sessionId);
        if (item === undefined) continue;
        for (const userId of permissionRecipients({ hostOnly: request.hostOnly, escalated: request.escalatedAt !== undefined }, { responsible: this.responsibleOf(topic, item) }, members)) add(userId, 'permissions', request.askedAt);
      }
    }
    for (const item of topic.items) {
      const report = this.report(topic.id, item.id);
      if (report === null || (report.state !== 'to-review' && report.state !== 'changed-after-review')) continue;
      for (const reviewer of report.reviewers) add(reviewer.userId, 'reports', report.waitingSince);
    }
    return [...waits]
      .flatMap(([userId, entry]) => {
        const user = this.ctx.members.userRef(userId);
        return user === null ? [] : [{ user, ...entry }];
      })
      .sort((a, b) => a.since - b.since)
      .slice(0, PLAN_WAITING_FOR_MAX);
  }

  toPlan(topic: StoredTopic): PlanInfo | null {
    if (!topic.plan.parsed) return null;
    const inPlan = topic.items.filter((item) => item.number > 0).sort((a, b) => a.number - b.number);
    const gone = topic.items.filter((item) => item.number === 0).slice(0, Math.max(0, PLAN_INFO_ITEMS_MAX - inPlan.length));
    return structuredClone({
      topicId: topic.id,
      revision: topic.plan.revision,
      specHash: topic.spec.hash,
      planHash: topic.plan.hash,
      mode: topic.plan.mode,
      paused: topic.plan.paused,
      items: [...inPlan, ...gone].map((item) => this.toWorkItem(topic, item)),
      ...(topic.plan.split === undefined ? {} : { split: topic.plan.split }),
      warnings: topic.plan.warnings,
      waitingFor: this.waitingFor(topic),
      slots: this.slots(),
    });
  }

  // ===================================================================================================================
  // Announcing
  // ===================================================================================================================

  /**
   * Announces a topic and its plan when what the wire shows of them changed: bus `topic.changed` / `plan.changed`
   * (the inbox listens) and `topic.updated` / `plan.updated` to every member. Then the attention facts.
   */
  publish(topicId: string): void {
    const stored = this.topic(topicId);
    if (stored === null) return;
    const topic = this.toTopic(stored);
    const previous = this.lastTopics.get(topicId) ?? null;
    if (previous === null || JSON.stringify(previous) !== JSON.stringify(topic)) {
      this.lastTopics.set(topicId, topic);
      this.ctx.bus.emit('topic.changed', { topic: structuredClone(topic), previous: previous === null ? null : structuredClone(previous) });
      this.ctx.hub.broadcast('topic.updated', { topic });
    }
    const plan = this.toPlan(stored);
    if (plan !== null) {
      const encoded = JSON.stringify(plan);
      if (this.lastPlans.get(topicId) !== encoded) {
        this.lastPlans.set(topicId, encoded);
        this.ctx.bus.emit('plan.changed', { topicId, plan: structuredClone(plan) });
        this.ctx.hub.broadcast('plan.updated', { plan });
      }
    }
    this.publishAttention();
  }

  /** Every topic that is not archived (after something every plan shows changed: the slots, the members). */
  publishAll(): void {
    for (const topic of this.topics()) if (!topic.archived) this.publish(topic.id);
  }

  publishReport(topicId: string, itemId: string, previous: ReportSummary | null): void {
    const stored = this.report(topicId, itemId);
    if (stored === null) return;
    const report = this.summaryOf(stored);
    this.ctx.bus.emit('report.changed', { topicId, itemId, report: structuredClone(report), previous });
    this.ctx.hub.broadcast('report.updated', { topicId, itemId, report });
    this.publish(topicId);
  }

  attention(): AttentionFact[] {
    return this.started ? attentionFacts(this) : [];
  }

  publishAttention(): void {
    const signature = JSON.stringify(this.attention());
    if (signature === this.attentionSignature) return;
    this.attentionSignature = signature;
    this.ctx.bus.emit('attention.changed', { source: 'topics' });
  }

  // ===================================================================================================================
  // Files
  // ===================================================================================================================

  /** One job at a time per key (a topic's files; an item's report): awaits never interleave two state changes. */
  serialize<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    const settled = next.catch(() => {});
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }

  /** A file of a root as the daemon itself reads it (through PathGuard), or null when it is not there or not readable. */
  async readFile(root: RootRef, path: string): Promise<FileContent | null> {
    const ref: FileRef = { root, path };
    try {
      const { bytes } = await this.ctx.paths.readFile(ref, { principal: SYSTEM_PRINCIPAL, maxBytes: TOPIC_FILE_MAX_BYTES, audit: false });
      return { text: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'), hash: sha256Hex(bytes) };
    } catch (err) {
      if (err instanceof SmurgError && err.code !== 'not_found') this.ctx.log.debug('topic file not readable', { path, code: err.code });
      else if (!(err instanceof SmurgError)) this.ctx.log.debug('topic file not readable', { path, error: err instanceof Error ? err.name : 'unknown' });
      return null;
    }
  }

  /** Someone wrote a topic's spec or plan through smurg: the next read of the file names them as `changedBy`. */
  noteWriter(topicId: string, kind: 'spec' | 'plan', actor: Actor): void {
    this.pendingActors.set(`${topicId}:${kind}`, actor);
  }

  /** Which topic's spec or plan a file of the main workspace is. */
  topicFileOf(file: FileRef): { readonly topic: StoredTopic; readonly kind: 'spec' | 'plan' } | null {
    if (file.root.kind !== 'main') return null;
    for (const topic of this.topics()) {
      const kind = topicFileKind(file.path, topic.slug);
      if (kind !== null) return { topic, kind };
    }
    return null;
  }

  /**
   * Reads SPEC.md and PLAN.md of a topic again and applies what they say: whether they exist, their hashes, when and
   * by whom they changed, and the plan's work items (a parse that differs bumps `revision`; ids are the identity of
   * an item: daemon state stays with the id, new items get smurg's suggested split, an item that was started and
   * left the file stays as `inPlan: false`). Then it announces and asks the scheduler (a changed file disarms).
   */
  refreshFiles(topicId: string): Promise<{ readonly plan: PlanParse | null; readonly specChanged: boolean; readonly planChanged: boolean } | null> {
    return this.serialize(`files:${topicId}`, async () => {
      const before = this.topic(topicId);
      if (before === null) return null;
      const [spec, plan] = await Promise.all([this.readFile(MAIN_ROOT, topicSpecPath(before.slug)), this.readFile(MAIN_ROOT, topicPlanPath(before.slug))]);
      if (this.topic(topicId) === null) return null;
      const now = this.ctx.clock.now();
      const parse = plan === null ? null : parsePlan(plan.text);
      let specChanged = false;
      let planChanged = false;
      const relabel: { sessionId: string; number: number; title: string }[] = [];
      let newItems = false;
      this.update(topicId, (topic) => {
        const specHash = spec?.hash ?? EMPTY_HASH;
        if (topic.spec.hash !== specHash) {
          specChanged = true;
          topic.spec.hash = specHash;
          topic.spec.changedAt = now;
          topic.spec.changedBy = this.takeWriter(topicId, 'spec');
        }
        topic.spec.exists = spec !== null && spec.text.trim().length > 0;
        const planHash = plan?.hash ?? EMPTY_HASH;
        if (topic.plan.hash !== planHash) {
          planChanged = true;
          topic.plan.hash = planHash;
          topic.plan.changedAt = now;
          topic.plan.changedBy = this.takeWriter(topicId, 'plan');
        }
        topic.plan.exists = plan !== null;
        if (parse === null) {
          topic.plan.valid = false;
          delete topic.plan.error;
          return;
        }
        if (!parse.ok) {
          const first = parse.errors[0];
          topic.plan.valid = false;
          if (first === undefined) delete topic.plan.error;
          else topic.plan.error = { ...wireText(first.text), ...(first.line === undefined ? {} : { line: first.line }) };
          return;
        }
        topic.plan.valid = true;
        delete topic.plan.error;
        delete topic.plan.fix;
        topic.plan.warnings = parse.warnings.map((warning) => wireText(warning.text));
        const fingerprint = planFingerprint(parse.items);
        if (topic.plan.parsed && topic.plan.fingerprint === fingerprint) return;
        topic.plan.parsed = true;
        topic.plan.fingerprint = fingerprint;
        topic.plan.revision += 1;
        newItems = this.reconcileItems(topic, parse.items, now, relabel);
      });
      const agents = this.ctx.services.agents;
      if (!isStubService(agents)) {
        for (const label of relabel) {
          try {
            agents.setLabels(label.sessionId, { item: { number: label.number, title: label.title } });
          } catch (err) {
            this.ctx.log.debug('session labels not updated', { session: label.sessionId, error: err instanceof Error ? err.name : 'unknown' });
          }
        }
      }
      if (newItems) {
        const stored = this.need(topicId);
        this.fillSplit(topicId, stored.plan.people.length > 0 ? stored.plan.people : this.peoplePresent());
      }
      this.publish(topicId);
      if (specChanged || planChanged) this.requestSchedule();
      return { plan: parse, specChanged, planChanged };
    });
  }

  private takeWriter(topicId: string, kind: 'spec' | 'plan'): Actor {
    const key = `${topicId}:${kind}`;
    const actor = this.pendingActors.get(key) ?? { kind: 'system' as const };
    this.pendingActors.delete(key);
    return actor;
  }

  /** Applies a parse to a topic's items. Returns whether an item appeared that was not there before. */
  private reconcileItems(topic: StoredTopic, parsed: readonly ParsedItem[], now: number, relabel: { sessionId: string; number: number; title: string }[]): boolean {
    const existing = new Map(topic.items.map((item) => [item.id, item]));
    const next: StoredItem[] = [];
    let added = false;
    for (const definition of parsed) {
      const item = existing.get(definition.id);
      if (item === undefined) {
        next.push(newItem(definition, now));
        added = true;
        continue;
      }
      existing.delete(definition.id);
      if (item.sessionId !== undefined && (item.number !== definition.number || item.title !== definition.title)) relabel.push({ sessionId: item.sessionId, number: definition.number, title: definition.title });
      item.number = definition.number;
      item.title = definition.title;
      item.summary = definition.summary;
      item.dependsOn = [...definition.dependsOn];
      item.size = definition.size;
      item.touches = [...definition.touches];
      next.push(item);
    }
    // An item that was started and then left the file stays, below the plan; one that never started is simply gone.
    const gone = [...existing.values()].filter((item) => isStarted(item) || item.startedBy !== undefined);
    for (const item of gone) {
      if (item.sessionId !== undefined && item.number !== 0) relabel.push({ sessionId: item.sessionId, number: 0, title: item.title });
      item.number = 0;
    }
    topic.items = [...next, ...gone].slice(0, PLAN_INFO_ITEMS_MAX);
    return added;
  }

  /** Whether a member may be made responsible right now (`responsible-eligible`). */
  mayBeResponsible(userId: UserId): boolean {
    const role = this.ctx.members.roleOf(userId);
    return role !== null && can(role, 'discuss');
  }
}
