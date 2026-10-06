// Topics, their plans and result reports (ARCHITECTURE §5.10). A topic is a feature or a task with its discussion
// session, its spec and plan files and the sessions of its work items.
//
//   topics    every topic that is not archived, live through topic.list + topic.updated / topic.removed; the archived
//             ones only after loadArchived() ("Show archived topics");
//   plans     a topic's PlanInfo (the work items with their state). Loaded on demand with ensurePlan(topicId) (an
//             expanded topic of the session list, an open plan column) and kept current by plan.updated, which
//             reaches everyone; after a full resync the plans that were asked for are fetched again;
//   reports   a work item's whole result report, loaded with loadReport() (an open report column) and kept current
//             by report.updated (a summary: when its version moved on, or when nothing a summary carries changed (a
//             follow-up was asked or answered), the whole report is fetched again);
//   notices   what a toast tells everyone: a topic was started, its spec draft or its plan is ready, the plan was
//             updated, the topic is complete (DESIGN §5.3). Derived here from topic.updated; they are not inbox items.
//
// Every request of the topic.*, plan.* and report.* families is a method here; a reply that carries a topic or a plan
// is put into the store before the promise resolves.
import {
  collectPages,
  type PayloadInputOf,
  type PlanInfo,
  type PlanMode,
  type ReportInfo,
  type ReportSummary,
  type ResultOf,
  type StartPreflight,
  type Topic,
} from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, mapFrom, mapWith, mapWithout, readyState, type AreaLifecycle, type LoadStatus, type Loadable, type StoreContext } from './base.ts';

export type TopicNoticeKind = 'started' | 'spec-ready' | 'plan-ready' | 'plan-updated' | 'complete';

export interface TopicNotice {
  readonly id: number;
  readonly kind: TopicNoticeKind;
  readonly topicId: string;
  /** The topic's name when it happened. */
  readonly name: string;
  readonly at: number;
}

export interface TopicsState extends Loadable {
  /** The topics that are not archived. */
  readonly topics: ReadonlyMap<string, Topic>;
  /** The archived topics; null until loadArchived() was asked. */
  readonly archived: ReadonlyMap<string, Topic> | null;
  /** By topic id. `null`: the topic has no plan yet. Absent: not loaded. */
  readonly plans: ReadonlyMap<string, PlanInfo | null>;
  readonly planStatus: ReadonlyMap<string, LoadStatus>;
  /** By reportKey(topicId, itemId). */
  readonly reports: ReadonlyMap<string, ReportInfo>;
  /** Oldest first, at most TOPIC_NOTICES_MAX. */
  readonly notices: readonly TopicNotice[];
}

export interface TopicsStore extends ReadableStore<TopicsState> {
  reload(): Promise<void>;
  /** Fetches the archived topics (once; afterwards topic.updated keeps them current). */
  loadArchived(): Promise<void>;

  // ---- topics
  /** session.create. The discussion session arrives in the sessions store through session.state. */
  create(input: PayloadInputOf<'topic.create'>): Promise<ResultOf<'topic.create'>>;
  rename(topicId: string, name: string): Promise<Topic>;
  /**
   * `archived: true` without `deleteUnmerged` is refused while worktrees hold changes that were never merged
   * (`unmergedWorktreesOfError(error)` lists them): ask, then send it again with `false` (keep them) or `true`.
   */
  archive(topicId: string, archived: boolean, deleteUnmerged?: boolean): Promise<Topic>;
  /** Host only; an archived topic. Its conversations go with it. */
  remove(topicId: string): Promise<void>;
  restartDiscussion(topicId: string): Promise<ResultOf<'topic.discussion.restart'>>;
  /** "Ask the agent to revise": a message for a member with agent access, a suggestion for anyone else. */
  revise(input: PayloadInputOf<'topic.revise'>): Promise<ResultOf<'topic.revise'>>;
  /** "Write the spec now". */
  requestSpec(topicId: string): Promise<void>;
  addRule(topicId: string, rule: { tool: 'Bash' | 'WebFetch'; pattern: string }): Promise<Topic>;
  removeRule(topicId: string, ruleId: string): Promise<Topic>;

  // ---- plan
  /** Makes sure the topic's plan is in the store and stays there across a resync. Safe to call on every render. */
  ensurePlan(topicId: string): void;
  reloadPlan(topicId: string): Promise<PlanInfo | null>;
  generatePlan(topicId: string): Promise<void>;
  setPlanMode(topicId: string, mode: PlanMode): Promise<PlanInfo>;
  assign(topicId: string, itemId: string, userId: string | null): Promise<PlanInfo>;
  /** "Suggest again". */
  suggestSplit(topicId: string): Promise<PlanInfo>;
  preflight(topicId: string, itemIds?: readonly string[]): Promise<StartPreflight>;
  start(input: PayloadInputOf<'plan.start'>): Promise<PlanInfo>;
  /** "Show the changes": the spec and plan files against what the last Start confirmed. */
  changes(topicId: string): Promise<ResultOf<'plan.changes'>>;
  /** "Continue all" after the host's smurg restarted. */
  resume(topicId: string): Promise<PlanInfo>;
  retryItem(topicId: string, itemId: string): Promise<PlanInfo>;
  /** "Continue": nudges an item's session that stopped without a report. */
  continueItem(topicId: string, itemId: string): Promise<void>;
  /** "Ask the agent to resolve" a merge conflict. */
  resolveItem(topicId: string, itemId: string): Promise<void>;

  // ---- reports
  /** Fetches the whole report and keeps it current (also across a resync). */
  loadReport(topicId: string, itemId: string): Promise<ReportInfo>;
  followUp(input: PayloadInputOf<'report.followUp'>): Promise<ResultOf<'report.followUp'>>;
  review(input: PayloadInputOf<'report.review'>): Promise<ReportSummary>;

  dismissNotice(id: number): void;
}

export const TOPIC_NOTICES_MAX = 20;

export const INITIAL_TOPICS_STATE: TopicsState = Object.freeze({
  status: 'idle',
  error: null,
  topics: new Map(),
  archived: null,
  plans: new Map(),
  planStatus: new Map(),
  reports: new Map(),
  notices: [],
});

export const reportKey = (topicId: string, itemId: string): string => `${topicId}/${itemId}`;

// ---- selectors

/** Topics in the order of the session list: the ones still being worked on, newest first; complete ones after. */
export function selectTopicList(state: TopicsState): Topic[] {
  return [...state.topics.values()].sort((a, b) => Number(a.phase === 'complete') - Number(b.phase === 'complete') || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
export const selectArchivedTopics = (state: TopicsState): Topic[] => [...(state.archived?.values() ?? [])].sort((a, b) => b.createdAt - a.createdAt);
/** A topic by id, archived or not. */
export const selectTopic = (state: TopicsState, topicId: string): Topic | undefined => state.topics.get(topicId) ?? state.archived?.get(topicId);
export const selectPlan = (state: TopicsState, topicId: string): PlanInfo | null | undefined => state.plans.get(topicId);
export const selectReport = (state: TopicsState, topicId: string, itemId: string): ReportInfo | undefined => state.reports.get(reportKey(topicId, itemId));
/** Topics whose plan was paused by a restart of the host's smurg (the banner of the sessions view). */
export const selectPausedTopics = (state: TopicsState): Topic[] => selectTopicList(state).filter((topic) => topic.plan.paused);

/** What a change of a topic tells everyone, if anything. `previous` undefined: the topic is new to this client. */
export function topicNoticeKind(previous: Topic | undefined, next: Topic): TopicNoticeKind | null {
  if (next.archived) return null;
  if (previous === undefined) return next.phase === 'discussing' ? 'started' : null;
  if (previous.archived) return null;
  if (previous.phase !== next.phase) {
    if (next.phase === 'spec') return previous.phase === 'discussing' ? 'spec-ready' : null;
    if (next.phase === 'plan') return previous.phase === 'discussing' || previous.phase === 'spec' ? 'plan-ready' : null;
    if (next.phase === 'complete') return 'complete';
    return null;
  }
  // The same phase: the agent finished writing the plan again ("Update plan").
  if (previous.plan.generating && !next.plan.generating && next.plan.exists && next.plan.valid) return 'plan-updated';
  return null;
}

/** Whether a report says, in the fields a summary carries, exactly what `summary` says. */
function sameSummary(report: ReportSummary, summary: ReportSummary): boolean {
  const fields = (one: ReportSummary): unknown[] => [one.version, one.writtenAt, one.outcome, one.state, one.reviewers.map((reviewer) => [reviewer.userId, reviewer.displayName]), one.escalatedAt ?? null, one.review ?? null, one.checks, one.error ?? null];
  return JSON.stringify(fields(report)) === JSON.stringify(fields(summary));
}

export function createTopicsArea(): { store: TopicsStore; lifecycle: AreaLifecycle } {
  const state = createStore<TopicsState>(INITIAL_TOPICS_STATE);
  /** What was asked for and is fetched again after a full resync. */
  const wantedPlans = new Set<string>();
  const wantedReports = new Map<string, { topicId: string; itemId: string }>();
  let noticeId = 0;
  /**
   * Topics whose plan became ready while the agent was still in the turn that wrote it. The daemon moves the phase to
   * `plan` when PLAN.md first parses, and says `generating: false` when that turn ends: the second event is the same
   * news as the first, not an update of the plan, and is not told again.
   */
  const readyInThisTurn = new Set<string>();
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('topics store is not bound to a connection');
    return ctx;
  };

  const listTopics = (c: StoreContext, archived: boolean): Promise<Topic[]> =>
    // `topic.list` follows the list rule: read every page.
    collectPages(async (after) => {
      const page = await c.conn.request('topic.list', { ...(archived ? { archived: true } : {}), ...(after === undefined ? {} : { after }) });
      return { items: page.topics, hasMore: page.hasMore };
    }, (topic: Topic) => topic.id);

  const notice = (kind: TopicNoticeKind, topic: Topic): void => {
    noticeId += 1;
    const entry: TopicNotice = { id: noticeId, kind, topicId: topic.id, name: topic.name, at: context().scheduler.now() };
    state.setState((previous) => ({ ...previous, notices: [...previous.notices, entry].slice(-TOPIC_NOTICES_MAX) }));
  };

  /** Puts a topic where it belongs. `announce`: it came by itself (an event), so a phase change is told. */
  const upsertTopic = (topic: Topic, announce: boolean): Topic => {
    const before = state.getState();
    const known = selectTopic(before, topic.id);
    state.setState((previous) => ({
      ...previous,
      topics: topic.archived ? mapWithout(previous.topics, topic.id) : mapWith(previous.topics, topic.id, topic),
      archived: previous.archived === null ? null : topic.archived ? mapWith(previous.archived, topic.id, topic) : mapWithout(previous.archived, topic.id),
    }));
    // Before the first snapshot nothing is known: every topic would look new.
    if (announce && before.status === 'ready') {
      let kind = topicNoticeKind(known, topic);
      if (kind === 'plan-ready' && topic.plan.generating) readyInThisTurn.add(topic.id);
      else if (kind === 'plan-updated' && readyInThisTurn.has(topic.id)) kind = null;
      if (kind !== null) notice(kind, topic);
    }
    if (!topic.plan.generating) readyInThisTurn.delete(topic.id);
    return topic;
  };

  const setPlan = (topicId: string, plan: PlanInfo | null): PlanInfo | null => {
    state.setState((previous) => ({ ...previous, plans: mapWith(previous.plans, topicId, plan), planStatus: mapWith(previous.planStatus, topicId, 'ready') }));
    return plan;
  };
  const putPlan = (plan: PlanInfo): PlanInfo => setPlan(plan.topicId, plan) as PlanInfo;

  const fetchPlan = async (topicId: string): Promise<PlanInfo | null> => {
    const c = context();
    const generation = c.generation();
    state.setState((previous) => ({ ...previous, planStatus: mapWith(previous.planStatus, topicId, 'loading') }));
    try {
      const { plan } = await c.conn.request('plan.get', { topicId });
      if (c.generation() !== generation) return plan;
      return setPlan(topicId, plan);
    } catch (error) {
      if (c.generation() === generation) state.setState((previous) => ({ ...previous, planStatus: mapWith(previous.planStatus, topicId, 'error') }));
      throw error;
    }
  };

  /** The report fetches on their way, by key: a column and a resync asking in the same moment share one request. */
  const reportFlights = new Map<string, Promise<ReportInfo>>();
  const fetchReport = (topicId: string, itemId: string, options: { fresh?: boolean } = {}): Promise<ReportInfo> => {
    const c = context();
    const generation = c.generation();
    const flightKey = `${generation}\u0000${reportKey(topicId, itemId)}`;
    const flying = reportFlights.get(flightKey);
    // `fresh`: the report moved on while a fetch may be on its way; that answer would be the old version.
    if (flying && options.fresh !== true) return flying;
    const flight = c.conn
      .request('report.get', { topicId, itemId })
      .then(({ report }) => {
        if (c.generation() === generation) state.setState((previous) => ({ ...previous, reports: mapWith(previous.reports, reportKey(topicId, itemId), report) }));
        return report;
      })
      .finally(() => {
        if (reportFlights.get(flightKey) === flight) reportFlights.delete(flightKey);
      });
    reportFlights.set(flightKey, flight);
    return flight;
  };

  /** A new summary of a report: into the loaded plan's item, and into the loaded report (fetched again if it moved on). */
  const applyReportSummary = (topicId: string, itemId: string, summary: ReportSummary): void => {
    const key = reportKey(topicId, itemId);
    const loaded = state.getState().reports.get(key);
    state.setState((previous) => {
      const plan = previous.plans.get(topicId);
      const plans =
        plan && plan.items.some((item) => item.id === itemId)
          ? mapWith(previous.plans, topicId, { ...plan, items: plan.items.map((item) => (item.id === itemId ? { ...item, report: summary } : item)) })
          : previous.plans;
      const report = previous.reports.get(key);
      const reports = report ? mapWith(previous.reports, key, { ...report, ...summary }) : previous.reports;
      return { ...previous, plans, reports };
    });
    // The whole report is read again when its version moved on (new sections, new changes), and when the summary says
    // nothing new at all: then the news is in what a summary does not carry, a follow-up asked from the report or the
    // agent's answer to one (the daemon announces both with the report's unchanged summary).
    if (loaded && (loaded.version !== summary.version || sameSummary(loaded, summary))) {
      fetchReport(topicId, itemId, { fresh: true }).catch((error: unknown) => ctx?.reportError('topics', error));
    }
  };

  const load = async (): Promise<void> => {
    const c = context();
    const wantArchived = state.getState().archived !== null;
    await loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      async () => ({ open: await listTopics(c, false), archived: wantArchived ? await listTopics(c, true) : null }),
      ({ open, archived }) =>
        state.setState((previous) => ({
          ...previous,
          ...readyState(),
          topics: mapFrom(open, (t) => t.id),
          // Not asked for when this load began: what loadArchived() fetched meanwhile stays.
          archived: archived === null ? previous.archived : mapFrom(archived, (t) => t.id),
        })),
    );
    // What was asked for before is fetched again, unless a column asked again meanwhile (it is on its way then).
    for (const topicId of wantedPlans) {
      if (!state.getState().planStatus.has(topicId)) fetchPlan(topicId).catch((error: unknown) => c.reportError('topics', error));
    }
    for (const [key, { topicId, itemId }] of wantedReports) {
      if (!state.getState().reports.has(key)) fetchReport(topicId, itemId).catch((error: unknown) => c.reportError('topics', error));
    }
  };

  const store: TopicsStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    reload: load,
    async loadArchived() {
      const c = context();
      const generation = c.generation();
      const archived = await listTopics(c, true);
      if (c.generation() === generation) state.setState((previous) => ({ ...previous, archived: mapFrom(archived, (t) => t.id) }));
    },
    async create(input) {
      const result = await context().conn.request('topic.create', input);
      upsertTopic(result.topic, false);
      return result;
    },
    async rename(topicId, name) {
      return upsertTopic((await context().conn.request('topic.rename', { topicId, name })).topic, false);
    },
    async archive(topicId, archived, deleteUnmerged) {
      const payload = deleteUnmerged === undefined ? { topicId, archived } : { topicId, archived, deleteUnmerged };
      return upsertTopic((await context().conn.request('topic.archive', payload)).topic, false);
    },
    async remove(topicId) {
      await context().conn.request('topic.delete', { topicId });
    },
    async restartDiscussion(topicId) {
      const result = await context().conn.request('topic.discussion.restart', { topicId });
      upsertTopic(result.topic, false);
      return result;
    },
    revise(input) {
      return context().conn.request('topic.revise', input);
    },
    async requestSpec(topicId) {
      await context().conn.request('topic.spec.request', { topicId });
    },
    async addRule(topicId, rule) {
      return upsertTopic((await context().conn.request('topic.rule.add', { topicId, tool: rule.tool, pattern: rule.pattern })).topic, false);
    },
    async removeRule(topicId, ruleId) {
      return upsertTopic((await context().conn.request('topic.rule.remove', { topicId, ruleId })).topic, false);
    },
    ensurePlan(topicId) {
      wantedPlans.add(topicId);
      const current = state.getState();
      // Nothing to ask before the first admission: load() fetches every wanted plan.
      if (ctx === null || current.status === 'idle' || current.planStatus.has(topicId)) return;
      fetchPlan(topicId).catch((error: unknown) => ctx?.reportError('topics', error));
    },
    reloadPlan(topicId) {
      wantedPlans.add(topicId);
      return fetchPlan(topicId);
    },
    async generatePlan(topicId) {
      await context().conn.request('plan.generate', { topicId });
    },
    async setPlanMode(topicId, mode) {
      return putPlan((await context().conn.request('plan.mode.set', { topicId, mode })).plan);
    },
    async assign(topicId, itemId, userId) {
      return putPlan((await context().conn.request('plan.assign', { topicId, itemId, userId })).plan);
    },
    async suggestSplit(topicId) {
      return putPlan((await context().conn.request('plan.suggest', { topicId })).plan);
    },
    async preflight(topicId, itemIds) {
      return (await context().conn.request('plan.preflight', itemIds === undefined ? { topicId } : { topicId, itemIds: [...itemIds] })).preflight;
    },
    async start(input) {
      return putPlan((await context().conn.request('plan.start', input)).plan);
    },
    changes(topicId) {
      return context().conn.request('plan.changes', { topicId });
    },
    async resume(topicId) {
      return putPlan((await context().conn.request('plan.resume', { topicId })).plan);
    },
    async retryItem(topicId, itemId) {
      return putPlan((await context().conn.request('plan.item.retry', { topicId, itemId })).plan);
    },
    async continueItem(topicId, itemId) {
      await context().conn.request('plan.item.continue', { topicId, itemId });
    },
    async resolveItem(topicId, itemId) {
      await context().conn.request('plan.item.resolve', { topicId, itemId });
    },
    loadReport(topicId, itemId) {
      wantedReports.set(reportKey(topicId, itemId), { topicId, itemId });
      return fetchReport(topicId, itemId);
    },
    followUp(input) {
      return context().conn.request('report.followUp', input);
    },
    async review(input) {
      const { report } = await context().conn.request('report.review', input);
      applyReportSummary(input.topicId, input.itemId, report);
      return report;
    },
    dismissNotice(id) {
      state.setState((previous) => ({ ...previous, notices: previous.notices.filter((n) => n.id !== id) }));
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offs = [
        c.conn.on('topic.updated', ({ topic }) => {
          upsertTopic(topic, true);
        }),
        c.conn.on('topic.removed', ({ topicId }) => {
          wantedPlans.delete(topicId);
          for (const [key, wanted] of wantedReports) if (wanted.topicId === topicId) wantedReports.delete(key);
          state.setState((previous) => ({
            ...previous,
            topics: mapWithout(previous.topics, topicId),
            archived: previous.archived === null ? null : mapWithout(previous.archived, topicId),
            plans: mapWithout(previous.plans, topicId),
            planStatus: mapWithout(previous.planStatus, topicId),
            reports: new Map([...previous.reports].filter(([key]) => !key.startsWith(`${topicId}/`))),
          }));
        }),
        c.conn.on('plan.updated', ({ plan }) => {
          putPlan(plan);
        }),
        c.conn.on('report.updated', ({ topicId, itemId, report }) => applyReportSummary(topicId, itemId, report)),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    reset() {
      // What was asked for stays asked for (wantedPlans, wantedReports, the archived list): load() fetches it again.
      readyInThisTurn.clear();
      state.setState((previous) => ({ ...INITIAL_TOPICS_STATE, archived: previous.archived === null ? null : new Map(), notices: previous.notices }));
    },
    load,
  };
  return { store, lifecycle };
}
