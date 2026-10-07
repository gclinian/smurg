// The scheduler of work items (ARCHITECTURE §7.8 "Execution"; design §4.5). It runs on every relevant event (a
// start, a merge decided, a session's status, the plan re-parsed, a change of the two files, `plan.resume`, a member
// removed, an agent process started or gone) and does, for each armed item in plan order:
//
//   PIN CHECK   SPEC.md and PLAN.md hash as pinned in the working tree AND at the main workspace's HEAD
//               → otherwise the item is disarmed (`plan-changed`): it never starts from a content nobody confirmed
//   waiting → queued     when everything it depends on is merged          (the only step a paused plan still takes)
//   queued  → running    when a slot is free: the item's own worktree, its session, the first message `start-item`
//   a failure on the way: the item is disarmed (`start-failed`) with what went wrong
//
// It never commits and never reads a newer plan than the pinned one. The host setting `maxLiveAgents` is enforced
// HERE and nowhere else: it counts the item sessions that hold a process, starts a queued item only below it, and may
// ask the runtime to park the longest-idle item session (`restartProcess(…, 'slot')`).
//
// The same file keeps an item's state in step with its session (failed, ended, a turn started), with its merge
// request, and finishes an item that is merged and reviewed (its session ends, its worktree goes): never while the
// item's worktree holds something the main workspace does not have.
import {
  LIST_MAX_ITEMS,
  MAIN_ROOT,
  SmurgError,
  defaultPermissionMode,
  lineEvent,
  topicPlanPath,
  topicSpecPath,
  wireText,
  worktreeRoot,
  type MergeRequest,
  type SessionEndReason,
  type SessionInfo,
  type WireText,
} from '@smurg/protocol';
import { defaultErrorRef, msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { SYSTEM_ACTOR, SYSTEM_PRINCIPAL, principalCan } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { pausedItems } from './attention.ts';
import type { TopicsCore } from './core.ts';
import { continueItemMessage, executionRolePrompt, retryItemMessage, startItemMessage } from './prompts.ts';
import type { StoredItem } from './store.ts';
import { EMPTY_HASH } from './text.ts';

/** What the scheduler needs of the report service (reports are checked once when smurg starts; reviewers follow who is responsible). */
export interface SchedulerReports {
  checkAfterRestart(topicId: string, itemId: string): Promise<boolean>;
  refreshReviewers(): void;
  isReviewed(topicId: string, itemId: string): boolean;
  hasReport(topicId: string, itemId: string): boolean;
}

export type DisarmReason = NonNullable<StoredItem['disarmed']>;

export class Scheduler {
  private readonly ctx: DaemonContext;
  private readonly core: TopicsCore;
  private reports: SchedulerReports | null = null;
  private loop: Promise<void> | null = null;
  private again = false;
  /** `afterRestart` has run: until then no pass does anything (nothing may start before the plans are paused). */
  private restored = false;
  /** Item sessions the scheduler asked to give up their process, until they did. */
  private readonly parking = new Set<string>();
  /** What each item session last looked like to the plans (its status and who is responsible): only a change is announced. */
  private readonly seen = new Map<string, string>();

  constructor(ctx: DaemonContext, core: TopicsCore) {
    this.ctx = ctx;
    this.core = core;
  }

  attach(reports: SchedulerReports): void {
    this.reports = reports;
  }

  // ===================================================================================================================
  // Running
  // ===================================================================================================================

  /** Asks for a pass; several requests while one runs become one more pass. */
  request(): void {
    void this.runNow().catch(() => {});
  }

  /** Resolves when a pass that began after this call has finished. */
  runNow(): Promise<void> {
    this.again = true;
    if (this.loop === null) {
      this.loop = this.drain().finally(() => {
        this.loop = null;
      });
    }
    return this.loop;
  }

  private async drain(): Promise<void> {
    // Not in the caller's stack: a request made inside a bus listener must not run the pass inside that listener.
    await Promise.resolve();
    while (this.again) {
      this.again = false;
      try {
        await this.pass();
      } catch (err) {
        this.ctx.log.error('scheduler pass failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }

  private async pass(): Promise<void> {
    if (!this.core.started || !this.restored || this.ctx.stopping.aborted) return;
    const agents = this.ctx.services.agents;
    const worktrees = this.ctx.services.worktrees;
    if (isStubService(agents) || isStubService(worktrees)) return;
    for (const listed of this.core.topics()) {
      if (listed.archived || !listed.items.some((item) => item.armed)) continue;
      const topicId = listed.id;
      // ---- PIN CHECK (not for a retried item: its worktree already holds the copy it was started from; not while
      //      the plan is paused: nothing can start then, and the check runs before anything does after "Continue all") ----
      const pinned = listed.plan.paused ? [] : listed.items.filter((item) => item.armed && !item.retry);
      if (pinned.length > 0) {
        const specPath = topicSpecPath(listed.slug);
        const planPath = topicPlanPath(listed.slug);
        const [spec, plan, head] = await Promise.all([
          this.core.readFile(MAIN_ROOT, specPath),
          this.core.readFile(MAIN_ROOT, planPath),
          worktrees.headBlobs([specPath, planPath]).catch(() => null),
        ]);
        for (const item of pinned) {
          const pin = item.pin;
          const asPinned =
            pin !== undefined &&
            item.number > 0 &&
            (spec?.hash ?? EMPTY_HASH) === pin.specHash &&
            (plan?.hash ?? EMPTY_HASH) === pin.planHash &&
            head !== null &&
            (head[specPath] ?? null) === pin.specBlob &&
            (head[planPath] ?? null) === pin.planBlob;
          if (!asPinned) this.disarm(topicId, item.id, 'plan-changed');
        }
      }
      // ---- waiting → queued: everything it depends on is merged (this is all a paused plan does) ----
      const afterPins = this.core.topic(topicId);
      if (afterPins === null || afterPins.archived) continue;
      for (const item of afterPins.items) {
        if (!item.armed) continue;
        const state = this.core.unmergedDependencies(afterPins, item).length === 0 ? 'queued' : 'waiting';
        if (item.state !== state) this.core.setItemState(topicId, item.id, state);
      }
      this.core.publish(topicId);
      if (afterPins.plan.paused) continue;
      // ---- queued → running, in plan order, while a slot is free ----
      const queued = [...(this.core.topic(topicId)?.items ?? [])].filter((item) => item.armed && item.state === 'queued').sort((a, b) => a.number - b.number);
      for (const item of queued) {
        if (this.ctx.stopping.aborted) return;
        const slots = this.core.slots();
        if (slots.inUse >= slots.max) {
          this.freeSlot();
          break;
        }
        await this.startItem(topicId, item.id);
      }
      this.core.publish(topicId);
    }
  }

  /** Asks the longest-idle item session that holds a process and waits for nobody to give it up. */
  private freeSlot(): void {
    const agents = this.ctx.services.agents;
    const candidates = agents
      .list()
      .filter((session) => session.purpose === 'item' && (session.status === 'idle' || session.status === 'done' || session.status === 'stalled'))
      .filter((session) => agents.facts(session.id)?.hasProcess === true && !this.parking.has(session.id))
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const session = candidates[0];
    if (session === undefined || this.parking.size > 0) return;
    this.parking.add(session.id);
    void agents.restartProcess(session.id, 'slot').catch((err: unknown) => {
      this.parking.delete(session.id);
      this.ctx.log.warn('slot not freed', { session: session.id, error: err instanceof Error ? err.name : 'unknown' });
    });
  }

  private async startItem(topicId: string, itemId: string): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || !item.armed) return;
    const agents = this.ctx.services.agents;
    const worktrees = this.ctx.services.worktrees;
    // The session is opened as the member who pressed Start (or "Try again"): they must still be allowed to.
    const starter = item.startedBy === undefined ? null : this.ctx.members.principalOf(item.startedBy.userId);
    if (starter === null || !principalCan(starter, 'session.create')) {
      this.disarm(topicId, itemId, 'starter-removed');
      return;
    }
    const retry = item.retry;
    const attempt = item.attempt + 1;
    const responsibleId = this.core.responsibleOf(topic, item);
    const responsible = responsibleId !== null && this.core.mayBeResponsible(responsibleId) ? this.ctx.members.userRef(responsibleId) : null;
    try {
      // 1. the item's own worktree at the main workspace's HEAD (a retry reuses it; an existing report file is removed)
      const handle = await worktrees.acquireForItem({ topic: { id: topic.id, slug: topic.slug }, itemId, owner: starter });
      const worktreeId = handle.worktree.id;
      // 2. its session: edits in the worktree are automatic, commands ask
      const session = await agents.start({
        purpose: 'item',
        topic: { id: topic.id, slug: topic.slug, name: topic.name },
        item: { id: item.id, number: item.number, title: item.title, attempt },
        openedBy: starter,
        responsible,
        workspace: { mode: 'worktree', worktreeId },
        mode: defaultPermissionMode('item', worktreeRoot(worktreeId)),
        rolePrompt: ({ smurgTag, branch }) => executionRolePrompt({ slug: topic.slug, itemId: item.id, smurgTag, branch: branch ?? handle.worktree.branch }),
        opening: retry ? msg('conversation.retry', { name: item.startedBy?.displayName ?? '', attempt }) : msg('conversation.started.item', { number: item.number, branch: handle.worktree.branch }),
        firstMessage: retry
          ? { kind: 'smurg', purpose: 'retry-item', text: retryItemMessage(), ...(item.startedBy === undefined ? {} : { by: item.startedBy }) }
          : { kind: 'smurg', purpose: 'start-item', text: startItemMessage({ slug: topic.slug, itemId: item.id, number: item.number, responsible }) },
      });
      // 3. the item knows its session
      const now = this.ctx.clock.now();
      this.core.updateItem(topicId, itemId, (draft) => {
        draft.sessionId = session.id;
        draft.sessions = [...draft.sessions, session.id].slice(-64);
        draft.worktreeId = worktreeId;
        draft.attempt = attempt;
        draft.armed = false;
        draft.retry = false;
        draft.state = 'running';
        draft.since = now;
        draft.nudged = false;
        delete draft.stalledBy;
        delete draft.disarmed;
        delete draft.startError;
        delete draft.fix;
        if (responsible === null) draft.responsible = null;
      });
      this.ctx.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'scheduler.start',
        outcome: 'ok',
        target: topicId,
        detail: {
          topicId,
          itemId,
          sessionId: session.id,
          worktreeId,
          attempt,
          startedBy: item.startedBy?.userId,
          ...(item.pin === undefined ? {} : { planRevision: item.pin.planRevision, specHash: item.pin.specHash, planHash: item.pin.planHash, commit: item.pin.commit }),
        },
      });
    } catch (err) {
      this.disarm(topicId, itemId, 'start-failed', err);
    }
  }

  /** An armed item will not start by itself any more: it stays, with why, until someone presses "Start again". */
  disarm(topicId: string, itemId: string, reason: DisarmReason, cause?: unknown): void {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null) return;
    let why: WireText;
    if (reason === 'plan-changed') why = wireText(msg('plan.item.disarmed.changed'));
    else if (reason === 'starter-removed') why = wireText(msg('plan.item.disarmed.starter', { name: item.startedBy?.displayName ?? '' }));
    else why = wireText(cause instanceof SmurgError && cause.text !== undefined ? cause.text : defaultErrorRef('internal'));
    const now = this.ctx.clock.now();
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.armed = false;
      draft.retry = false;
      draft.disarmed = reason;
      draft.startError = why;
      draft.state = draft.sessions.length > 0 ? 'stopped' : 'not-started';
      draft.since = now;
    });
    this.ctx.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'scheduler.disarm',
      outcome: 'ok',
      target: topicId,
      detail: { topicId, itemId, reason, ...(cause instanceof SmurgError ? { code: cause.code } : {}), ...(item.startedBy === undefined ? {} : { startedBy: item.startedBy.userId }) },
    });
    this.core.publish(topicId);
  }

  // ===================================================================================================================
  // Telling a session to go on
  // ===================================================================================================================

  /** `continue-item` to an item's session (the line that explains it first), and the item runs again. */
  async sendContinue(topicId: string, itemId: string, by: { readonly userId: string; readonly displayName: string }): Promise<boolean> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || item.sessionId === undefined) return false;
    const agents = this.ctx.services.agents;
    const sessionId = item.sessionId;
    agents.append(sessionId, lineEvent(msg('conversation.continueRequested', { name: by.displayName })));
    await agents.send(sessionId, { kind: 'smurg', purpose: 'continue-item', text: continueItemMessage(), by });
    const hasReport = this.reports?.hasReport(topicId, itemId) ?? false;
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.nudged = false;
      delete draft.fix;
    });
    if (item.state === 'stalled' || item.state === 'failed') {
      this.core.setItemState(topicId, itemId, 'running');
      agents.setItemState(sessionId, { reportRegistered: hasReport });
    }
    this.core.publish(topicId);
    return true;
  }

  // ===================================================================================================================
  // What the bus tells the scheduler
  // ===================================================================================================================

  onTurnStarted(sessionId: string): void {
    if (!this.core.started) return;
    const hit = this.core.bySession(sessionId);
    if (hit === null || hit.item === null || hit.item.sessionId !== sessionId) return;
    if (hit.item.state !== 'stalled' && hit.item.state !== 'failed') return;
    this.core.setItemState(hit.topic.id, hit.item.id, 'running');
    this.core.publish(hit.topic.id);
  }

  onSessionUpdated(session: SessionInfo): void {
    if (!this.core.started || session.kind !== 'agent') return;
    if (session.purpose === 'item') {
      // A session changes often (every event moves its `lastSeq`); the plans care about two facts of it.
      const look = `${session.status}|${session.responsible?.userId ?? ''}`;
      if (this.seen.get(session.id) === look) return;
      this.seen.set(session.id, look);
      const hit = this.core.bySession(session.id);
      if (hit !== null && hit.item !== null && hit.item.sessionId === session.id) {
        const { topic, item } = hit;
        if (session.status === 'failed' && (item.state === 'running' || item.state === 'stalled')) this.core.setItemState(topic.id, item.id, 'failed');
        // A failed item runs again when its session is inside a turn. A session that is merely there again (idle after
        // a restart of smurg or of its process, renamed, given to someone else) works on nothing: "Try again" stays.
        else if (item.state === 'failed' && (session.status === 'running' || session.status === 'waiting-answer' || session.status === 'waiting-permission')) this.core.setItemState(topic.id, item.id, 'running');
        // Once a session exists IT holds who is responsible; the plan's record follows it.
        if ((session.responsible?.userId ?? null) !== (item.responsible?.userId ?? null)) {
          this.core.updateItem(topic.id, item.id, (draft) => {
            draft.responsible = session.responsible === null ? null : { ...session.responsible, source: 'chosen' };
            draft.chosen = true;
          });
          this.reports?.refreshReviewers();
        }
      }
      // Every plan shows the slots and who waits for a person.
      this.core.publishAll();
      // A session that became idle may be the one a queued item is waiting for (its process can be parked).
      if (this.core.topics().some((topic) => !topic.archived && topic.items.some((item) => item.armed && item.state === 'queued'))) this.request();
    }
  }

  onSessionExited(session: SessionInfo, reason: SessionEndReason): void {
    if (!this.core.started || session.kind !== 'agent' || session.purpose !== 'item') return;
    this.parking.delete(session.id);
    this.seen.delete(session.id);
    const hit = this.core.bySession(session.id);
    if (hit !== null && hit.item !== null && hit.item.sessionId === session.id) {
      const { topic, item } = hit;
      // Ended on purpose before a report was there: "Try again" gives it a new session in the same worktree.
      if (reason !== 'merged' && (item.state === 'running' || item.state === 'stalled' || item.state === 'failed')) this.core.setItemState(topic.id, item.id, 'stopped');
    }
    this.core.publishAll();
    this.request();
  }

  onProcess(event: { readonly sessionId: string; readonly hasProcess: boolean }): void {
    if (!this.core.started) return;
    if (!event.hasProcess) this.parking.delete(event.sessionId);
    this.core.publishAll();
    this.request();
  }

  /** A person removed an item's worktree: its draft went with it; "Try again" makes a fresh checkout at HEAD. */
  onWorktreeRemoved(worktreeId: string): void {
    if (!this.core.started) return;
    for (const topic of this.core.topics()) {
      const item = topic.items.find((candidate) => candidate.worktreeId === worktreeId);
      if (item === undefined) continue;
      this.core.updateItem(topic.id, item.id, (draft) => {
        delete draft.worktreeId;
        if (draft.merge !== undefined && (draft.merge.status === 'draft' || draft.merge.status === 'conflict')) delete draft.merge;
      });
      this.core.publish(topic.id);
    }
  }

  /**
   * A merge request of a work item changed: `merged` satisfies what depends on it, and may finish the item. A new
   * draft (or a pending request) of the item replaces what the plan showed of its worktree before.
   */
  onMerge(request: MergeRequest): void {
    if (!this.core.started || request.topicId === undefined || request.itemId === undefined) return;
    const topic = this.core.topic(request.topicId);
    const item = topic === null ? null : this.core.item(topic, request.itemId);
    if (topic === null || item === null) return;
    const tracked = item.merge === undefined || item.merge.requestId === request.id || request.status === 'draft' || request.status === 'pending';
    this.core.updateItem(topic.id, item.id, (draft) => {
      if (tracked) draft.merge = { requestId: request.id, status: request.status, ready: request.status === 'draft' && request.reviewed };
      if (request.status === 'merged') draft.merged = true;
    });
    this.core.publish(topic.id);
    if (request.status === 'merged') {
      void this.finishIfDone(topic.id, item.id).catch((err: unknown) => {
        this.ctx.log.error('item not finished', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
      });
      this.request();
    }
  }

  /**
   * Merged and reviewed: the item is finished. Its session ends (`merged`), its worktree goes; conversation and report
   * stay. Removing the worktree deletes whatever it holds, so the item is finished only when the main workspace has
   * all of it: the item's CURRENT request is the merged one (a follow-up after a merge makes a new draft, and an older
   * request that is merged later says nothing about it), and the tree holds nothing no merge carried (a version whose
   * snapshot was refused, edits made after the report). Until then everything stays as it is and `finishPending`
   * asks again. One at a time per item: two callers never end the same session twice.
   */
  finishIfDone(topicId: string, itemId: string): Promise<void> {
    return this.core.serialize(`finish:${topicId}:${itemId}`, () => this.finish(topicId, itemId));
  }

  private async finish(topicId: string, itemId: string): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || topic.archived || !item.merged || this.reports?.isReviewed(topicId, itemId) !== true) return;
    if (item.merge !== undefined && item.merge.status !== 'merged') return;
    const agents = this.ctx.services.agents;
    const worktrees = this.ctx.services.worktrees;
    if (item.worktreeId !== undefined && !isStubService(worktrees) && worktrees.get(item.worktreeId) !== null && this.holdsUnmerged(topicId, item.worktreeId)) return;
    if (item.sessionId !== undefined && !isStubService(agents)) {
      const session = agents.get(item.sessionId);
      if (session !== null && session.status !== 'ended') await agents.end(item.sessionId, { by: SYSTEM_ACTOR, reason: 'merged', keepWorktree: true });
    }
    if (item.worktreeId !== undefined && !isStubService(worktrees)) {
      const worktreeId = item.worktreeId;
      try {
        if (worktrees.get(worktreeId) !== null) await worktrees.releaseItem(worktreeId);
      } catch (err) {
        this.ctx.log.warn('item worktree not released', { worktree: worktreeId, error: err instanceof Error ? err.name : 'unknown' });
      }
      this.core.updateItem(topicId, itemId, (draft) => {
        if (draft.worktreeId === worktreeId) delete draft.worktreeId;
      });
    }
    this.core.publish(topicId);
  }

  /** Whether an item's worktree holds changes that never reached the main workspace. A question that cannot be answered counts as yes. */
  private holdsUnmerged(topicId: string, worktreeId: string): boolean {
    try {
      return this.ctx.services.worktrees.unmerged(topicId).some((worktree) => worktree.id === worktreeId);
    } catch (err) {
      this.ctx.log.warn('item worktree could not be asked about unmerged work; it stays', { worktree: worktreeId, error: err instanceof Error ? err.name : 'unknown' });
      return true;
    }
  }

  /**
   * Asks again for every item that is merged and still has its session or its worktree: what held it back may be gone
   * (the new draft was merged, the tree was looked at and holds nothing more), or the finishing itself failed half-way
   * or never ran (a crash between the merge and the end of the session). Called when smurg starts and on the module's
   * sweep; it costs a look at the records, nothing else.
   */
  async finishPending(): Promise<void> {
    if (!this.core.started || this.ctx.stopping.aborted) return;
    const agents = this.ctx.services.agents;
    for (const topic of this.core.topics()) {
      if (topic.archived) continue;
      for (const item of topic.items) {
        if (!item.merged) continue;
        const session = item.sessionId === undefined || isStubService(agents) ? null : agents.get(item.sessionId);
        if (item.worktreeId === undefined && (session === null || session.status === 'ended')) continue;
        await this.finishIfDone(topic.id, item.id).catch((err: unknown) => {
          this.ctx.log.error('item not finished', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
        });
      }
    }
  }

  // ===================================================================================================================
  // After a restart of the host's smurg
  // ===================================================================================================================

  /**
   * What a hard death of the daemon (kill -9, power) between two of its records left out of step, put right when
   * smurg starts: worktrees.json, the agent sessions' records and topics.json are written one after the other.
   *   - A merge request of an item that the worktree module has and the item has not heard of: a merged one makes
   *     the item merged (what depends on it may start); the item's own request takes the state the request has now;
   *     a draft that is gone gives way to the worktree's newest open request, or to none.
   *   - An item session the runtime has and no item names (the death came between its start and the item's record):
   *     it is ended. The item is still armed and starts a session of its own when it may.
   * An item that is merged and reviewed and still has its session or worktree is finished by `finishPending`.
   */
  async reconcile(): Promise<void> {
    const worktrees = this.ctx.services.worktrees;
    const agents = this.ctx.services.agents;
    if (!isStubService(worktrees)) {
      let requests: MergeRequest[] = [];
      try {
        requests = worktrees.listMerges(SYSTEM_PRINCIPAL);
      } catch (err) {
        this.ctx.log.warn('merge requests not read at the start', { error: err instanceof Error ? err.name : 'unknown' });
      }
      const ofItem = (topicId: string, itemId: string): MergeRequest[] => requests.filter((request) => request.topicId === topicId && request.itemId === itemId).sort((a, b) => b.createdAt - a.createdAt);
      for (const listed of this.core.topics()) {
        if (listed.archived) continue;
        for (const stored of listed.items) {
          const mine = ofItem(listed.id, stored.id);
          const merged = mine.find((request) => request.status === 'merged');
          if (merged !== undefined && !stored.merged) this.onMerge(merged);
          const item = this.core.item(this.core.need(listed.id), stored.id);
          if (item === null || item.merge === undefined) continue;
          const pointer = item.merge;
          const current = mine.find((request) => request.id === pointer.requestId);
          if (current !== undefined) {
            if (current.status !== pointer.status || pointer.ready !== (current.status === 'draft' && current.reviewed)) this.onMerge(current);
            continue;
          }
          // (a full page is not every request: what is not in it may still exist)
          if ((pointer.status !== 'draft' && pointer.status !== 'conflict') || requests.length >= LIST_MAX_ITEMS) continue;
          // The request the item points to went with a newer snapshot (or with its worktree).
          const open = mine.find((request) => request.status === 'draft' || request.status === 'pending');
          if (open !== undefined) this.onMerge(open);
          else {
            this.core.updateItem(listed.id, stored.id, (draft) => {
              delete draft.merge;
            });
            this.core.publish(listed.id);
          }
        }
      }
    }
    if (!isStubService(agents)) {
      for (const session of agents.list()) {
        if (session.purpose !== 'item' || session.status === 'ended' || this.core.bySession(session.id) !== null) continue;
        this.ctx.log.warn('an item session no work item names is ended', { session: session.id });
        try {
          await agents.end(session.id, { by: SYSTEM_ACTOR, reason: 'ended', keepWorktree: true });
        } catch (err) {
          this.ctx.log.warn('item session not ended', { session: session.id, error: err instanceof Error ? err.name : 'unknown' });
        }
      }
    }
  }

  /**
   * Nothing runs by itself after a restart. Sessions that were mid-turn are `stalled` (`restart`), unless the report
   * the agent had checked is there (it is registered right then); every topic that has armed or interrupted items is
   * PAUSED until a member with agent access presses "Continue all".
   */
  async afterRestart(): Promise<void> {
    const agents = this.ctx.services.agents;
    const now = this.ctx.clock.now();
    for (const listed of this.core.topics()) {
      if (listed.archived) continue;
      for (const item of listed.items) {
        if (item.state !== 'running' || item.sessionId === undefined) continue;
        const registered = (await this.reports?.checkAfterRestart(listed.id, item.id).catch(() => false)) ?? false;
        if (registered) continue;
        this.core.setItemState(listed.id, item.id, 'stalled', 'restart');
        if (!isStubService(agents)) {
          try {
            agents.setItemState(item.sessionId, { reportRegistered: false, stalled: 'restart' });
          } catch (err) {
            this.ctx.log.debug('item state not set on the session', { session: item.sessionId, error: err instanceof Error ? err.name : 'unknown' });
          }
        }
      }
      const topic = this.core.topic(listed.id);
      if (topic !== null && pausedItems(topic).length > 0 && !topic.plan.paused) {
        this.core.update(topic.id, (draft) => {
          draft.plan.paused = true;
          draft.plan.pausedAt = now;
        });
      }
    }
    this.restored = true;
  }
}
