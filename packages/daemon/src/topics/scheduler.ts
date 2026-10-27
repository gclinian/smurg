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
//
// 0.7.0 (DESIGN D8, D12): `onMerge` is the one writer of who merged an item (`mergedAs`: smurg, or the host), also for
// a merge a restart found; an item is finished when it is merged and reviewed OR its topic's result was checked, so an
// item smurg merged keeps its session and its clean worktree until then (a follow-up from its report still reaches the
// agent that did the work, and a change it makes merges like the first one). An item's agent is told at its start
// whether smurg may merge its work by itself.
//
// 0.6.0 (DESIGN D14, D15): an item starts only in the history its Start used (its pin's `history`): a worktree of the
// folder's own `.git`, a worktree of smurg's own history, or, only when that Start said so (`direct`), directly in the
// shared folder. When that history cannot be used now (git missing or unusable, the folder's `.git` gone or changed,
// smurg's history refused), the item is disarmed with `plan.start.historyChanged`: for EVERY armed item, retried ones
// included, before and outside the hash part of the pin check. Direct items run one at a time (direct-folder.ts holds
// the folder); `maxLiveAgents` is not theirs.
import {
  LIST_MAX_ITEMS,
  MAIN_ROOT,
  SmurgError,
  lineEvent,
  topicPlanPath,
  topicSpecPath,
  wireText,
  worktreeRoot,
  type MergeRequest,
  type SessionEndReason,
  type SessionInfo,
  type UserRef,
  type WireText,
} from '@smurg/protocol';
import { defaultErrorRef, msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { SYSTEM_ACTOR, SYSTEM_PRINCIPAL, isHostPrincipal, principalCan } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { pausedItems } from './attention.ts';
import { itemKey, type TopicsCore } from './core.ts';
import { DirectFolder } from './direct-folder.ts';
import { continueItemMessage, directExecutionRolePrompt, executionRolePrompt, retryItemMessage, startItemMessage } from './prompts.ts';
import type { StoredItem, StoredTopic } from './store.ts';
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
  /** The one-agent hold of the shared folder for items that run directly in it (DESIGN 0.6.0 D15). */
  readonly folder: DirectFolder;

  constructor(ctx: DaemonContext, core: TopicsCore) {
    this.ctx = ctx;
    this.core = core;
    this.folder = new DirectFolder({
      released: (sessionId) => {
        const agents = this.ctx.services.agents;
        if (!isStubService(agents)) agents.releaseHeld(sessionId);
      },
      // A queued item may start now (one that waited for the folder, or what depends on the one that just finished).
      free: () => this.request(),
      log: ctx.log,
    });
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
      // ---- THE HISTORY (DESIGN 0.6.0 D15): for EVERY armed item, retried ones included, the history its Start used
      //      must still be usable (not while the plan is paused: the check runs before anything starts after "Continue all") ----
      if (!listed.plan.paused) {
        const states = new Map<string, Awaited<ReturnType<typeof worktrees.historyState>>>();
        for (const item of listed.items.filter((candidate) => candidate.armed)) {
          const history = historyOf(item);
          let state = states.get(history);
          if (state === undefined) {
            state = await worktrees.historyState(history).catch(() => 'unknown' as const);
            states.set(history, state);
          }
          if (state === 'changed') this.disarm(topicId, item.id, 'start-failed', historyChanged());
        }
      }
      // ---- PIN CHECK (not for a retried item: its worktree already holds the copy it was started from; not while
      //      the plan is paused: nothing can start then, and the check runs before anything does after "Continue all").
      //      The two files hash as pinned in the working tree, and at HEAD of the history the Start used (an item that
      //      runs directly in the folder has no history: the working tree alone) ----
      const checked = this.core.topic(topicId) ?? listed;
      const pinned = checked.plan.paused ? [] : checked.items.filter((item) => item.armed && !item.retry);
      if (pinned.length > 0) {
        const specPath = topicSpecPath(listed.slug);
        const planPath = topicPlanPath(listed.slug);
        const [spec, plan] = await Promise.all([this.core.readFile(MAIN_ROOT, specPath), this.core.readFile(MAIN_ROOT, planPath)]);
        const heads = new Map<string, Record<string, string | null> | null>();
        for (const item of pinned) {
          const pin = item.pin;
          const history = historyOf(item);
          let head: Record<string, string | null> | null = null;
          if (history !== 'direct') {
            if (!heads.has(history)) heads.set(history, await worktrees.headBlobs([specPath, planPath], { history }).catch(() => null));
            head = heads.get(history) ?? null;
          }
          const asPinned =
            pin !== undefined &&
            item.number > 0 &&
            (spec?.hash ?? EMPTY_HASH) === pin.specHash &&
            (plan?.hash ?? EMPTY_HASH) === pin.planHash &&
            (history === 'direct' || (head !== null && (head[specPath] ?? null) === pin.specBlob && (head[planPath] ?? null) === pin.planBlob));
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
      // ---- queued → running, in plan order, while a slot is free (an item that runs directly in the folder: while
      //      the folder is free, one at a time; `maxLiveAgents` is not consulted for it) ----
      const queued = [...(this.core.topic(topicId)?.items ?? [])].filter((item) => item.armed && item.state === 'queued').sort((a, b) => a.number - b.number);
      for (const item of queued) {
        if (this.ctx.stopping.aborted) return;
        if (historyOf(item) === 'direct') {
          if (this.folder.isFree()) await this.startItem(topicId, item.id);
          continue;
        }
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
    // (an item a person is leaving out right now is not started: DESIGN 0.7.0 D11; nor one an undo claims: D14)
    if (topic === null || item === null || !item.armed || item.leftOut !== undefined || this.core.claimed.has(itemKey(topicId, itemId))) return;
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
    // 0. the history its Start used, if it can still be used (DESIGN 0.6.0 D15): a first start, a retry, "Continue all"
    const history = historyOf(item);
    const state = await worktrees.historyState(history).catch(() => 'unknown' as const);
    if (state === 'changed') {
      this.disarm(topicId, itemId, 'start-failed', historyChanged());
      return;
    }
    if (history === 'direct') {
      await this.startDirect(topicId, itemId, starter, responsible);
      return;
    }
    try {
      // 1. the item's own worktree at the main workspace's HEAD (a retry reuses it; an existing report file is removed),
      // of the history its Start used
      const handle = await worktrees.acquireForItem({ topic: { id: topic.id, slug: topic.slug }, itemId, owner: starter, history });
      const worktreeId = handle.worktree.id;
      // 2. its session: it follows its topic's mode, else the workspace's (DESIGN 0.6.0 D3); its model is the topic's
      // when it starts (a retry: the model of the item's previous session), else the host's default (D7)
      const model = this.modelOf(topic, item, retry);
      const session = await agents.start({
        purpose: 'item',
        topic: { id: topic.id, slug: topic.slug, name: topic.name },
        item: { id: item.id, number: item.number, title: item.title, attempt },
        openedBy: starter,
        responsible,
        workspace: { mode: 'worktree', worktreeId },
        modeChoice: null,
        model: model.model,
        ...(model.by === undefined ? {} : { modelChangedBy: model.by }),
        // (DESIGN 0.7.0 D17: the item's policy when its session starts; a later change of the setting does not rewrite it)
        rolePrompt: ({ smurgTag, branch }) => executionRolePrompt({ slug: topic.slug, itemId: item.id, smurgTag, branch: branch ?? handle.worktree.branch, merging: this.core.mergingOf(item) === 'auto' ? 'auto' : 'host' }),
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
          // The model its session runs on (null: the host's default), as every audit entry that sets one names it.
          model: model.model,
          ...(item.pin === undefined ? {} : { planRevision: item.pin.planRevision, specHash: item.pin.specHash, planHash: item.pin.planHash, commit: item.pin.commit }),
        },
      });
    } catch (err) {
      this.disarm(topicId, itemId, 'start-failed', err);
    }
  }

  /**
   * An item whose Start said it runs directly in the shared folder (DESIGN 0.6.0 D15): no worktree, its session in the
   * main workspace (the gate applies as to any of it: G7 keeps the spec and plan away, G8 locks, G11 in auto), the
   * direct role prompt, and the folder held from its first turn. Only the host starts it (Start and Retry are the
   * host's): a starter who is not the host now disarms it.
   */
  private async startDirect(topicId: string, itemId: string, starter: NonNullable<ReturnType<DaemonContext['members']['principalOf']>>, responsible: UserRef | null): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || !item.armed) return;
    if (!isHostPrincipal(starter)) {
      this.disarm(topicId, itemId, 'start-failed', new SmurgError('forbidden', msg('plan.start.directHostOnly'), { reason: 'direct-host-only' }));
      return;
    }
    if (!this.folder.isFree()) return; // it waits its turn (queued)
    const agents = this.ctx.services.agents;
    const retry = item.retry;
    const attempt = item.attempt + 1;
    const key = DirectFolder.key(topicId, itemId);
    this.folder.takeForStart(key);
    try {
      const model = this.modelOf(topic, item, retry);
      const session = await agents.start({
        purpose: 'item',
        topic: { id: topic.id, slug: topic.slug, name: topic.name },
        item: { id: item.id, number: item.number, title: item.title, attempt },
        openedBy: starter,
        responsible,
        workspace: { mode: 'main' },
        modeChoice: null,
        model: model.model,
        ...(model.by === undefined ? {} : { modelChangedBy: model.by }),
        rolePrompt: ({ smurgTag }) => directExecutionRolePrompt({ slug: topic.slug, itemId: item.id, smurgTag }),
        opening: retry ? msg('conversation.retry', { name: item.startedBy?.displayName ?? '', attempt }) : msg('conversation.started.itemDirect', { number: item.number }),
        firstMessage: retry
          ? { kind: 'smurg', purpose: 'retry-item', text: retryItemMessage(), ...(item.startedBy === undefined ? {} : { by: item.startedBy }) }
          : { kind: 'smurg', purpose: 'start-item', text: startItemMessage({ slug: topic.slug, itemId: item.id, number: item.number, responsible }) },
      });
      const now = this.ctx.clock.now();
      this.core.updateItem(topicId, itemId, (draft) => {
        draft.sessionId = session.id;
        draft.sessions = [...draft.sessions, session.id].slice(-64);
        delete draft.worktreeId;
        draft.direct = true;
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
          history: 'direct',
          attempt,
          startedBy: item.startedBy?.userId,
          model: model.model,
          ...(item.pin === undefined ? {} : { planRevision: item.pin.planRevision, specHash: item.pin.specHash, planHash: item.pin.planHash }),
        },
      });
    } catch (err) {
      this.folder.ended(key);
      this.disarm(topicId, itemId, 'start-failed', err);
    }
  }

  /**
   * The model an item's session starts with (DESIGN 0.6.0 D7) and who chose it: a retry keeps the model of the item's
   * previous session (what the person who tried again saw it run on); otherwise the topic's model, else the host's
   * default (null).
   */
  private modelOf(topic: StoredTopic, item: StoredItem, retry: boolean): { readonly model: string | null; readonly by?: UserRef } {
    const agents = this.ctx.services.agents;
    if (retry && item.sessionId !== undefined) {
      const previous = agents.get(item.sessionId);
      if (previous !== null) {
        const chooser = previous.model === null ? null : (agents.facts(item.sessionId)?.modelChangedBy ?? null);
        const by = chooser === null ? null : this.ctx.members.userRef(chooser);
        return { model: previous.model, ...(by === null ? {} : { by }) };
      }
    }
    const model = topic.agent?.model ?? null;
    const by = model === null ? undefined : topic.agent?.modelChangedBy;
    return { model, ...(by === undefined ? {} : { by: { ...by } }) };
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
        // A direct item whose process failed holds the shared folder no more ("Try again" takes it again).
        if (session.status === 'failed' && item.direct === true) this.folder.ended(DirectFolder.key(topic.id, item.id));
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
      if (item.direct === true) this.folder.ended(DirectFolder.key(topic.id, item.id));
      // Ended on purpose before a report was there: "Try again" gives it a new session in the same worktree.
      if (reason !== 'merged' && reason !== 'reviewed' && (item.state === 'running' || item.state === 'stalled' || item.state === 'failed')) this.core.setItemState(topic.id, item.id, 'stopped');
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
    this.core.noteRequest(request);
    // The host took its merge back (DESIGN 0.7.0 D14): it satisfies nothing any more; the undo's own half follows.
    if (request.undone !== undefined) return;
    const topic = this.core.topic(request.topicId);
    const item = topic === null ? null : this.core.item(topic, request.itemId);
    if (topic === null || item === null) return;
    const tracked = item.merge === undefined || item.merge.requestId === request.id || request.status === 'draft' || request.status === 'pending';
    // Who merged it (DESIGN 0.7.0 D8, R-ENG E3): smurg on the host's standing consent, or the host; written here only,
    // so a merge `reconcile` finds after a crash is recorded the same way. (The merge commit is worktrees.json's, which
    // the wire's request does not carry: the merge queue adds it when its own merge says it, auto-merge.ts `apply`.)
    const hostRef = this.ctx.members.userRef(this.ctx.members.hostUserId()) ?? request.requestedBy ?? null;
    const by = request.auto === true ? ('smurg' as const) : hostRef;
    this.core.updateItem(topic.id, item.id, (draft) => {
      if (tracked) draft.merge = { requestId: request.id, status: request.status, ready: request.status === 'draft' && request.reviewed };
      if (request.status === 'merged') {
        draft.merged = true;
        if (by !== null && (draft.mergedAs === undefined || draft.mergedAs.requestId !== request.id)) {
          draft.mergedAs = { requestId: request.id, at: request.decidedAt ?? this.ctx.clock.now(), by: by === 'smurg' ? by : { userId: by.userId, displayName: by.displayName } };
        }
      }
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
   * Merged and reviewed, or merged and its topic's result checked (DESIGN 0.7.0 D12): the item is finished. Its session
   * ends (`merged`), its worktree goes; conversation and report stay. Removing the worktree deletes whatever it holds,
   * so the item is finished only when the main workspace has all of it: the item's CURRENT request is the merged one (a
   * follow-up after a merge makes a new draft, and an older request that is merged later says nothing about it), and
   * the tree holds nothing no merge carried (a version whose snapshot was refused, edits made after the report). Until
   * then everything stays as it is and `finishPending` asks again. One at a time per item: two callers never end the
   * same session twice.
   */
  finishIfDone(topicId: string, itemId: string): Promise<void> {
    return this.core.serialize(`finish:${topicId}:${itemId}`, () => this.finish(topicId, itemId));
  }

  private async finish(topicId: string, itemId: string): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    const reviewed = this.reports?.isReviewed(topicId, itemId) === true;
    if (topic === null || item === null || topic.archived || !item.merged || !(reviewed || topic.checked !== undefined)) return;
    const agents = this.ctx.services.agents;
    if (item.direct === true) {
      // It ran in the folder itself: nothing waits for a merge. Reviewed (or its topic checked), it is complete and its
      // session ends.
      if (item.sessionId !== undefined && !isStubService(agents)) {
        const session = agents.get(item.sessionId);
        if (session !== null && session.status !== 'ended') {
          agents.append(item.sessionId, lineEvent(msg(reviewed ? 'conversation.ended.reviewed' : 'conversation.ended.checked')));
          await agents.end(item.sessionId, { by: SYSTEM_ACTOR, reason: 'reviewed', keepWorktree: true });
        }
      }
      this.core.publish(topicId);
      return;
    }
    if (item.merge !== undefined && item.merge.status !== 'merged') return;
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
   *     a draft that is gone gives way to the worktree's newest open request, or to none; so does a request that
   *     still WAITED for the host and is gone (worktrees.json was set aside: nobody can decide it any more, and the
   *     item must not go on saying that it waits). A request that was decided is history: the item keeps saying so.
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
      // What the merge queue knows of each request (who asked for it) starts from what the worktree module has.
      for (const request of requests) this.core.noteRequest(request);
      const ofItem = (topicId: string, itemId: string): MergeRequest[] => requests.filter((request) => request.topicId === topicId && request.itemId === itemId).sort((a, b) => b.createdAt - a.createdAt);
      for (const listed of this.core.topics()) {
        if (listed.archived) continue;
        for (const stored of listed.items) {
          const mine = ofItem(listed.id, stored.id);
          // (a merge the host undid satisfies nothing: DESIGN 0.7.0 D14)
          const merged = mine.find((request) => request.status === 'merged' && request.undone === undefined);
          if (merged !== undefined && !stored.merged) this.onMerge(merged);
          const item = this.core.item(this.core.need(listed.id), stored.id);
          if (item === null || item.merge === undefined) continue;
          const pointer = item.merge;
          const current = mine.find((request) => request.id === pointer.requestId);
          if (current !== undefined) {
            if (current.undone !== undefined) continue;
            if (current.status !== pointer.status || pointer.ready !== (current.status === 'draft' && current.reviewed)) this.onMerge(current);
            continue;
          }
          // (a full page is not every request: what is not in it may still exist)
          if ((pointer.status !== 'draft' && pointer.status !== 'conflict' && pointer.status !== 'pending') || requests.length >= LIST_MAX_ITEMS) continue;
          // The request the item points to went with a newer snapshot (or with its worktree, or with worktrees.json).
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
    // A turn of an item that runs directly in the folder asks the one-agent hold first (DESIGN 0.6.0 D15).
    if (!isStubService(agents)) agents.setDirectGate(this.folder);
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

/** The history the Start of an item used (its pin): absent means the folder's own repository, as every 0.5.x pin. */
function historyOf(item: StoredItem): 'folder' | 'smurg' | 'direct' {
  return item.pin?.history ?? 'folder';
}

/** An armed item whose Start's history cannot be used now (DESIGN 0.6.0 D15). */
function historyChanged(): SmurgError {
  return new SmurgError('conflict', msg('plan.start.historyChanged'), { reason: 'history-changed' });
}
