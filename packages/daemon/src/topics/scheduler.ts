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
//
// 0.7.0 (DESIGN D15, D16): plans go on by themselves. After a restart of the host's smurg the plan is paused only when
// a person paused it (`pausedBy`) or an item that runs directly in the folder was interrupted (its half-done change is
// in the folder, which has no history); every other pause (0.6.0's after a restart) is lifted. The pin and history
// checks of what is armed run at the start; what goes on (interrupted items told to continue, armed ones started) waits
// for `goOn()`, which `smurg host` calls once it has printed it (R-SAFE S16). A turn that ended on a usage limit, on an
// error (twice), in a crash (once) or with a snapshot that failed (once) is continued by smurg, each bounded, audited
// and said in the item's conversation, never for a person's stop and never while the plan is paused. Sessions that
// wait for a person no longer keep unrelated items from starting (core.ts `slotFree`).
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
import { defaultErrorRef, msg, type MessageRef } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { PlansAtStart } from '../core/interfaces.ts';
import { SYSTEM_ACTOR, SYSTEM_PRINCIPAL, isHostPrincipal, principalCan } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { AUTO_CONTINUE_DELAYS_MS, autoContinueOwed, cutAfterMerge, type AutoContinueCause } from './auto-merge-verdict.ts';
import { isDirect, itemKey, type TopicsCore } from './core.ts';
import { DirectFolder } from './direct-folder.ts';
import { continueItemMessage, directExecutionRolePrompt, executionRolePrompt, retryItemMessage, startItemMessage } from './prompts.ts';
import type { StoredItem, StoredTopic } from './store.ts';
import { EMPTY_HASH } from './text.ts';

/** What the scheduler needs of the report service (reports are checked once when smurg starts; reviewers follow who is responsible). */
export interface SchedulerReports {
  checkAfterRestart(topicId: string, itemId: string, options?: { readonly cutTurnOnly?: boolean }): Promise<boolean>;
  /** A later turn of an item with a version was cut by the stop of the host's smurg (0.7.0 review): held, its follow-ups unanswered. */
  cutByStop(topicId: string, itemId: string, at: number, stillWaiting: number): void;
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
  /** `afterRestart` has run: until then no pass does anything (nothing may start before the plans are looked at). */
  private restored = false;
  /** `goOn()` has run (DESIGN 0.7.0 D15): until then nothing starts and nothing is continued. */
  private goneOn = false;
  /** What the start found that goes on at `goOn()` (D18: `smurg host` prints it first). */
  private found: PlansAtStart = { continues: [], paused: [] };
  /** An automatic continue being sent (one at a time: the sweep runs every few seconds). */
  private continuing: Promise<void> | null = null;
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
    if (!this.core.started || !this.restored || !this.goneOn || this.ctx.stopping.aborted) return;
    const agents = this.ctx.services.agents;
    const worktrees = this.ctx.services.worktrees;
    if (isStubService(agents) || isStubService(worktrees)) return;
    for (const listed of this.core.topics()) {
      if (listed.archived || !listed.items.some((item) => item.armed)) continue;
      const topicId = listed.id;
      await this.checkArmed(topicId);
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
      //      the folder is free, one at a time; `maxLiveAgents` is not consulted for it). DESIGN 0.7.0 D16: a slot is
      //      free while fewer than `max` item processes WORK; sessions that wait for a person do not count (up to twice
      //      `max` processes in all, core.ts `slotFree`) ----
      const queued = [...(this.core.topic(topicId)?.items ?? [])].filter((item) => item.armed && item.state === 'queued').sort((a, b) => a.number - b.number);
      for (const item of queued) {
        if (this.ctx.stopping.aborted) return;
        if (historyOf(item) === 'direct') {
          if (this.folder.isFree()) await this.startItem(topicId, item.id);
          continue;
        }
        if (!this.core.slotFree()) {
          this.freeSlot();
          break;
        }
        await this.startItem(topicId, item.id);
      }
      this.core.publish(topicId);
    }
  }

  /**
   * The checks of what is armed in one topic, before anything of it starts: the history its Start used, and the pin
   * (the two files as pinned). Not while the plan is paused (they run before anything starts after "Continue all").
   * An item that fails them is disarmed.
   */
  private async checkArmed(topicId: string): Promise<void> {
    const worktrees = this.ctx.services.worktrees;
    const listed = this.core.topic(topicId);
    if (listed === null || listed.archived || isStubService(worktrees)) return;
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
        // (a daemon that stops answers nothing true: what it says is not a reason to disarm, 0.7.0 review)
        if (this.ctx.stopping.aborted) return;
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
      // A daemon that is stopping reads nothing true (headBlobs answers null for everything): an armed item is never
      // disarmed for it, "The spec or the plan changed" would be false and the item would not start after the restart
      // (0.7.0 review). The next start checks it again.
      if (this.ctx.stopping.aborted) return;
      const heads = new Map<string, Record<string, string | null> | null>();
      for (const item of pinned) {
        const pin = item.pin;
        const history = historyOf(item);
        let head: Record<string, string | null> | null = null;
        if (history !== 'direct') {
          if (!heads.has(history)) heads.set(history, await worktrees.headBlobs([specPath, planPath], { history }).catch(() => null));
          if (this.ctx.stopping.aborted) return;
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
    // (an item a person is leaving out right now is not started: DESIGN 0.7.0 D11; nor one an undo claims: D14; nor one
    // whose dependency counts as merged no more since this pass looked, a later turn of an item in the folder that did
    // not finish: D10)
    if (topic === null || item === null || !item.armed || item.leftOut !== undefined || this.core.claimed.has(itemKey(topicId, itemId)) || this.core.unmergedDependencies(topic, item).length > 0) return;
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
      // (a daemon that stops answers its starts with "smurg is stopping": the item stays armed and starts after the
      // restart, 0.7.0 verify; acquireForItem reuses its checkout)
      if (this.ctx.stopping.aborted) return;
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
      if (this.ctx.stopping.aborted) return;
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

  /**
   * `continue-item` to an item's session (the line that explains it first), and the item runs again. `who`: the person
   * who asked (Continue, Continue all, Try again: the line names them, and the count of smurg's automatic continues
   * starts again, DESIGN 0.7.0 D15), or smurg's own continue with the line that says why (no `by` on the message).
   */
  async sendContinue(topicId: string, itemId: string, who: { readonly by: { readonly userId: string; readonly displayName: string } } | { readonly line: MessageRef }): Promise<boolean> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || item.sessionId === undefined) return false;
    const agents = this.ctx.services.agents;
    const sessionId = item.sessionId;
    const by = 'by' in who ? who.by : null;
    agents.append(sessionId, lineEvent(by === null ? (who as { readonly line: MessageRef }).line : msg('conversation.continueRequested', { name: by.displayName })));
    await agents.send(sessionId, { kind: 'smurg', purpose: 'continue-item', text: continueItemMessage(), ...(by === null ? {} : { by: { userId: by.userId, displayName: by.displayName } }) });
    const hasReport = this.reports?.hasReport(topicId, itemId) ?? false;
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.nudged = false;
      delete draft.fix;
      if (by !== null) delete draft.autoContinue;
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
        if (session.status === 'failed' && (item.state === 'running' || item.state === 'stalled')) {
          this.core.setItemState(topic.id, item.id, 'failed');
          // DESIGN 0.7.0 D15: a crash is resumed once by smurg, a minute later.
          this.noteBreak(topic.id, item.id, 'crash');
        }
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
      // A merged item kept for a later turn that did not finish after its merge (`cutAfterMerge`), while its current
      // request is the merged one: nothing can continue that turn any more, so it is forgotten, as "Leave it out" forgets
      // it; the hold ends and the topic settles (0.7.0 fix7: "End session" in its conversation left the hold for good,
      // every answer to it refused). What the turn changed is in its worktree, which the merge queue holds for its
      // carers ("Request merge", core.ts `keptAfterMerge`, 0.7.0 fix8). A newer version still a draft keeps the turn: it
      // waits for "Merge it as it is" (D6 row 6; 0.7.0 fix8: smurg merged it by itself). And a session that ended takes
      // no continue of D15 (0.7.0 fix8: row 4 waited for one for good).
      // The host rejected a later version of a merged item, then its session ended: nothing can make that version
      // right any more, so the reject is the decision, as `onMerge` takes a reject after the end. The item goes back
      // to its merged request, and the rejected change stays in the worktree and holds nothing
      // (TopicsCore.leftOutAfterEnd). (0.7.0 fix9: held 'rejected' for an agent no session can answer, or, with the
      // host merging, nobody's row, and the topic never settled)
      const keptOn = item.merged && item.undone === undefined && item.merge?.status === 'rejected' && item.mergedAs?.requestId !== undefined && item.mergedAs.requestId !== item.merge.requestId ? item.mergedAs.requestId : null;
      const forget = item.merged && (item.merge?.status === 'merged' || keptOn !== null) && cutAfterMerge(item);
      if (keptOn !== null || forget || item.autoContinue !== undefined) {
        this.core.updateItem(topic.id, item.id, (draft) => {
          if (keptOn !== null) draft.merge = { requestId: keptOn, status: 'merged', ready: false };
          if (forget) delete draft.lastTurn;
          delete draft.autoContinue;
        });
      }
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
    // The host rejected the current request of a merged item whose session has ended ("Request merge" of what its
    // worktree held): that reject is the decision, and the item stays on its merged request. The rejected change stays
    // in the worktree and holds nothing (TopicsCore.leftOutAfterEnd). (0.7.0 fix9, the lead's F1: the rejected request
    // became the current one, held 'rejected' for an agent no session can answer, or, with the host merging, nobody's
    // row, and the topic never settled)
    const keptOn =
      request.status === 'rejected' && item.merged && item.undone === undefined && item.merge?.requestId === request.id && item.mergedAs?.requestId !== undefined && item.mergedAs.requestId !== request.id && this.core.sessionEnded(item)
        ? item.mergedAs.requestId
        : null;
    // Who merged it (DESIGN 0.7.0 D8, R-ENG E3): smurg on the host's standing consent, or the host; written here only,
    // so a merge `reconcile` finds after a crash is recorded the same way. (The merge commit is worktrees.json's, which
    // the wire's request does not carry: the merge queue adds it when its own merge says it, auto-merge.ts `apply`.)
    const hostRef = this.ctx.members.userRef(this.ctx.members.hostUserId()) ?? request.requestedBy ?? null;
    const by = request.auto === true ? ('smurg' as const) : hostRef;
    this.core.updateItem(topic.id, item.id, (draft) => {
      if (keptOn !== null) draft.merge = { requestId: keptOn, status: 'merged', ready: false };
      else if (tracked) draft.merge = { requestId: request.id, status: request.status, ready: request.status === 'draft' && request.reviewed };
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
   * the tree holds nothing no merge carried (a version whose snapshot was refused, edits made after the report). Nor
   * while a follow-up of its report waits for its answer or its session holds a message no turn has taken (0.7.0 fix4:
   * the end of the session threw the message away, and Continue was refused for a session that had ended), nor while
   * its session is at work (`sessionAtWork`: a turn, the end of one being looked at; 0.7.0 fix5: a turn that took a
   * person's message was cut by "I've reviewed this", the host's Merge… or the sweep, and its answer never became a
   * version), nor while a later turn did not finish after its merge (`cutAfterMerge`; 0.7.0 fix6: a restart, a hard
   * death, an API error, the process's death or a person's Stop cut it, and the end of the session threw away the
   * continue D15 owed and the carers' Continue), nor while smurg owes its session an automatic continue (`continueOwed`;
   * 0.7.0 fix7: a turn that broke while its version was a draft, then the host's Merge… and a review: the continue never
   * came). Until then everything stays as it is and `finishPending` asks again, on
   * the module's sweep. One at a time per item: two callers never end the same session twice.
   */
  finishIfDone(topicId: string, itemId: string): Promise<void> {
    return this.core.serialize(`finish:${topicId}:${itemId}`, () => this.finish(topicId, itemId));
  }

  private async finish(topicId: string, itemId: string): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    const reviewed = this.reports?.isReviewed(topicId, itemId) === true;
    if (topic === null || item === null || topic.archived || !item.merged || !(reviewed || topic.checked !== undefined)) return;
    // (its answer is still to come: smurg's continue, or its carers' Continue)
    if (cutAfterMerge(item) || this.core.continueOwed(item)) return;
    const agents = this.ctx.services.agents;
    // (what its session still has to deliver or answer: a follow-up of its report, or a message no turn has taken; and
    // what it is doing: a turn, or the end of one being looked at)
    if (item.sessionId !== undefined && !isStubService(agents)) {
      const live = agents.get(item.sessionId);
      if (live !== null && live.status !== 'ended' && ((this.core.report(topicId, itemId)?.pending.length ?? 0) > 0 || (agents.facts(item.sessionId)?.pendingMessages ?? 0) > 0)) return;
      if (this.core.sessionAtWork(topic, item, this.core.sessionsWithCards())?.turnOpen === true) return;
    }
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
      // (looked at again just before it goes, 0.7.0 verify: a person's save that landed since the look above is not
      // deleted; its session has ended, so the worktree stays as its owner's kept worktree, no item's any more)
      try {
        if (worktrees.get(worktreeId) !== null) await worktrees.releaseItem(worktreeId, { keepWork: 'detached' });
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
   *     An item on its merged request whose later request still waits tracks that request again (the host's reject
   *     of it after the end of the item's session was written to topics.json first, 0.7.0 fix10).
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
            else if (pointer.status === 'merged') {
              // (the host's reject of a later request of a merged item whose session has ended keeps the item on its
              // merged request, `onMerge`'s keptOn, before worktrees.json says the request was rejected: a death in
              // between left the item there while that request still waits. The item tracks it again, and the host's
              // answer to it is the decision, as before the death. 0.7.0 fix10: the foot's "Request merge" made a
              // second request, and the first one waited on the complete topic for good)
              const later = mine.find((request) => request.status === 'pending' && request.undone === undefined && request.createdAt > current.createdAt);
              if (later !== undefined) this.onMerge(later);
            }
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
   * The topics module stops (0.7.0 review): an item with a registered version whose session is in a turn now (a
   * person's message, a follow-up, Continue) has that turn cut by the stop, and its end is not looked at. It is marked
   * here, before the records are flushed: after the start it is held (`stopped`, D6 row 6) for its carers, and its
   * version does not merge as if nobody had asked anything. (An item without a version is `running`, and one whose agent
   * resolves is taken up by the merge queue: `afterRestart` and `takeUp` look at those.)
   */
  noteStop(): void {
    if (!this.core.started) return;
    const agents = this.ctx.services.agents;
    if (isStubService(agents)) return;
    const now = this.ctx.clock.now();
    // 0.7.0 verify: also a session that holds a message no turn has taken yet (written to its process, or waiting for a
    // process or for the shared folder: the stop cuts it before its turn opens), and one whose turn ended while smurg was
    // already stopping (its end was not looked at: module.ts). A process that is only being started is no turn.
    const cutNow = (sessionId: string): boolean => TURN_OPEN.has(agents.get(sessionId)?.status ?? '') || (agents.facts(sessionId)?.pendingMessages ?? 0) > 0 || this.core.turnsEndedInStop.has(sessionId);
    for (const topic of this.core.topics()) {
      if (topic.archived) continue;
      const cut = topic.items.filter(
        (item) => (item.state === 'done' || item.state === 'reviewed') && item.sessionId !== undefined && item.leftOut === undefined && item.undone === undefined && item.autoMerge?.state !== 'resolving' && cutNow(item.sessionId),
      );
      if (cut.length === 0) continue;
      const ids = new Set(cut.map((item) => item.id));
      this.core.update(topic.id, (draft) => {
        for (const item of draft.items) if (ids.has(item.id)) item.lastTurn = { outcome: 'interrupted', at: now, restart: true };
      });
    }
  }

  /**
   * After a restart of the host's smurg (DESIGN 0.7.0 D15; until 0.6.0 every plan with armed or interrupted items was
   * paused here). Sessions that were mid-turn are `stalled` (`restart`), unless the report the agent had checked is
   * there (it is registered right then, as not checked in its turn: the merge queue asks the agent once to check it
   * again). An item that runs directly in the folder is not registered: it stays interrupted. An item whose agent was
   * resolving gets the report it checked in the cut turn registered the same way (D8). An item with a version whose
   * later turn the stop cut (marked by `noteStop`, or a session the runtime found mid-turn after a hard death) is held
   * for its carers (0.7.0 review). A cut turn is counted then, so that its checks are never taken for those of the
   * turn that comes next. Then the one rule of every start: a plan is paused when a person paused it (`pausedBy`) or
   * when an item of it that runs directly in the shared folder was interrupted and nobody continued it yet (its
   * half-done change is in the folder, which has no history: the host looks first); any other pause is lifted (0.6.0's
   * after a restart). The history and pin checks of what is armed run now, before anything starts, and what goes on is
   * known (`atStart`): nothing of it is done before `goOn()`.
   */
  async afterRestart(): Promise<void> {
    const agents = this.ctx.services.agents;
    // A turn of an item that runs directly in the folder asks the one-agent hold first (DESIGN 0.6.0 D15).
    if (!isStubService(agents)) agents.setDirectGate(this.folder);
    const now = this.ctx.clock.now();
    for (const listed of this.core.topics()) {
      if (listed.archived) continue;
      for (const stored of listed.items) {
        const item = this.core.item(this.core.need(listed.id), stored.id);
        if (item === null || item.sessionId === undefined) continue;
        const sessionId = item.sessionId;
        const session = isStubService(agents) ? null : agents.get(sessionId);
        if (item.state === 'running') {
          const registered = (await this.reports?.checkAfterRestart(listed.id, item.id).catch(() => false)) ?? false;
          if (!registered) {
            this.core.setItemState(listed.id, item.id, 'stalled', 'restart');
            if (!isStubService(agents)) {
              try {
                agents.setItemState(sessionId, { reportRegistered: false, stalled: 'restart' });
              } catch (err) {
                this.ctx.log.debug('item state not set on the session', { session: sessionId, error: err instanceof Error ? err.name : 'unknown' });
              }
            }
          }
        } else if (item.autoMerge?.state === 'resolving' && item.autoMerge.reason !== 'stale-report' && this.core.mergingOf(item) === 'auto') {
          // The report its agent checked in the turn the restart cut (D8): registered now; the merge queue takes up the rest at `goOn`.
          await this.reports?.checkAfterRestart(listed.id, item.id, { cutTurnOnly: true }).catch(() => false);
        } else if (
          (item.state === 'done' || item.state === 'reviewed') &&
          item.leftOut === undefined &&
          item.undone === undefined &&
          item.autoMerge?.state !== 'resolving' &&
          // (0.7.0 verify: a message no turn took before the stop or the death waits in the session, and nothing delivers
          // it: the version is the carers' to decide, and their Continue delivers it first)
          (item.lastTurn?.restart === true || session?.status === 'stalled' || (session !== null && session.status !== 'ended' && session.status !== 'failed' && (agents.facts(sessionId)?.pendingMessages ?? 0) > 0))
        ) {
          // (a session the runtime found mid-turn after a hard death says `stalled`; its item has a version: say so)
          const midTurn = session?.status === 'stalled';
          if (midTurn) {
            try {
              agents.setItemState(sessionId, { reportRegistered: true });
            } catch (err) {
              this.ctx.log.debug('item state not set on the session', { session: sessionId, error: err instanceof Error ? err.name : 'unknown' });
            }
          }
          // (the turn a session was found in is cut now, when the start finds it; an older mark, the stop's or a break
          // before it, dates the cut only when nothing ran since. 0.7.0 fix8: a hard death in the turn of smurg's
          // continue after the host's merge was dated with the break before that merge, so nothing held the item, the
          // topic said ready and the check ended the session with the answer to the person's message lost)
          this.reports?.cutByStop(listed.id, item.id, midTurn ? now : (item.lastTurn?.at ?? now), isStubService(agents) ? 0 : (agents.facts(sessionId)?.pendingMessages ?? 0));
        }
        this.countCutTurn(listed.id, item.id);
      }
      const topic = this.core.topic(listed.id);
      if (topic === null) continue;
      const keep = topic.plan.pausedBy !== undefined || topic.items.some((item) => isDirect(item) && item.leftOut === undefined && ((item.state === 'stalled' && item.stalledBy === 'restart') || item.lastTurn?.restart === true));
      if (keep && !topic.plan.paused) {
        this.core.update(topic.id, (draft) => {
          draft.plan.paused = true;
          draft.plan.pausedAt = now;
        });
      } else if (!keep && topic.plan.paused) {
        this.core.update(topic.id, (draft) => {
          draft.plan.paused = false;
          delete draft.plan.pausedAt;
        });
      }
    }
    this.restored = true;
    // The checks before anything starts (the pin, the history): what fails them is disarmed now, and is not said to go on.
    for (const topic of this.core.topics()) {
      if (topic.archived || topic.plan.paused || !topic.items.some((item) => item.armed)) continue;
      await this.checkArmed(topic.id).catch((err: unknown) => this.ctx.log.error('armed items not checked at the start', { topic: topic.id, error: err instanceof Error ? err.name : 'unknown' }));
    }
    this.found = this.lookAtStart();
  }

  /**
   * A turn of the item's session whose end never arrived (the stop cut it, or the daemon died) and in which
   * `check_report` answered (`checked[].turn === turns + 1`) is counted now: the next turn that ends is the one after
   * it, and a check of the cut turn is never one "of the turn that made the version" (0.7.0 review).
   */
  private countCutTurn(topicId: string, itemId: string): void {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (item === null || item.sessionId === undefined) return;
    const cut = (item.turns ?? 0) + 1;
    if (!item.checked.some((entry) => entry.sessionId === item.sessionId && entry.turn === cut)) return;
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.turns = cut;
    });
  }

  /** What this start found (DESIGN 0.7.0 D18), as `afterRestart` left it: `smurg host` prints it before `goOn()`. */
  atStart(): PlansAtStart {
    return this.found;
  }

  private lookAtStart(): PlansAtStart {
    const continues: { topicId: string; name: string; items: number }[] = [];
    const paused: { topicId: string; name: string }[] = [];
    for (const topic of this.core.topics()) {
      if (topic.archived) continue;
      if (topic.plan.paused) {
        if (topic.plan.pausedBy !== undefined) paused.push({ topicId: topic.id, name: topic.name });
        continue;
      }
      const items = this.goesOn(topic, 'start');
      if (items > 0) continues.push({ topicId: topic.id, name: topic.name, items });
    }
    return { continues, paused };
  }

  /**
   * How many topics would go on by themselves when the host's smurg starts again (DESIGN 0.7.0 D18), as things are now:
   * open, not paused, with work that goes on by itself; not a topic whose item runs directly in the folder in a turn
   * now (the stop interrupts it, and that topic is paused for the host at the start).
   */
  goOnAtNextStart(): number {
    if (!this.core.started) return 0;
    const agents = this.ctx.services.agents;
    let count = 0;
    for (const topic of this.core.topics()) {
      if (topic.archived || topic.plan.paused) continue;
      const directInTurn = topic.items.some((item) => isDirect(item) && item.sessionId !== undefined && !isStubService(agents) && IN_A_TURN.has(agents.get(item.sessionId)?.status ?? ''));
      if (directInTurn) continue;
      if (this.goesOn(topic, 'stop') > 0) count += 1;
    }
    return count;
  }

  /**
   * The items of a topic that act by themselves at a start (`start`: what this start found; `stop`: what the next start
   * would find): a session continued after the restart (an interrupted item, or one in a turn now), an automatic
   * continue owed, an armed item, an item whose agent was bringing its work up to date, and what the merge queue would
   * do (a merge, a report checked again, conflict markers resolved). Without a way to run agents (no `smurg hook`
   * command, the account logged out) only the merges count.
   */
  private goesOn(topic: StoredTopic, when: 'start' | 'stop'): number {
    const run = this.mayRunAgents();
    const agents = this.ctx.services.agents;
    const cards = this.core.sessionsWithCards();
    let count = 0;
    for (const item of topic.items) {
      if (item.leftOut !== undefined || item.undone !== undefined) continue;
      const live = item.sessionId !== undefined && !isStubService(agents) && (agents.get(item.sessionId)?.status ?? 'ended') !== 'ended';
      const interrupted = live && (when === 'start' ? item.state === 'stalled' && item.stalledBy === 'restart' : item.state === 'running' || (item.state === 'stalled' && item.stalledBy === 'restart'));
      const verdict = this.core.mergingOf(item) === 'auto' ? this.core.verdictOf(topic, item, cards).kind : 'none';
      const acts = run
        ? item.armed || interrupted || (live && autoContinueOwed(item)) || (live && item.autoMerge?.state === 'resolving' && this.core.mergingOf(item) === 'auto') || verdict === 'merge' || verdict === 'verify' || verdict === 'resolve'
        : verdict === 'merge';
      if (acts) count += 1;
    }
    return count;
  }

  /** Whether an agent session can be told to go on at all: an agent process can be started, and the account is not logged out. */
  private mayRunAgents(): boolean {
    const agents = this.ctx.services.agents;
    if (isStubService(agents) || !agents.canLaunch()) return false;
    return agents.account().state !== 'logged-out';
  }

  /**
   * What the start found goes on, from now on (DESIGN 0.7.0 D15): each item a restart interrupted, in a plan that is not
   * paused, gets `continue-item` (without `by`) after the line `conversation.continued.restart`; then the scheduler runs
   * (the armed items). A continue that cannot be sent (no hook command, the session gone) leaves the item
   * `stalled(restart)` with its attention item, and is not counted. Once.
   */
  async goOn(): Promise<void> {
    if (this.goneOn) return;
    this.goneOn = true;
    if (!this.core.started || this.ctx.stopping.aborted) return;
    if (this.mayRunAgents()) {
      const agents = this.ctx.services.agents;
      for (const topic of this.core.topics()) {
        if (topic.archived || topic.plan.paused) continue;
        for (const item of topic.items) {
          if (this.ctx.stopping.aborted) return;
          if (item.state !== 'stalled' || item.stalledBy !== 'restart' || item.sessionId === undefined || isDirect(item)) continue;
          const sessionId = item.sessionId;
          const session = agents.get(sessionId);
          if (session === null || session.status === 'ended') continue;
          try {
            if (!(await this.sendContinue(topic.id, item.id, { line: msg('conversation.continued.restart') }))) continue;
            this.ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'plan.item.autoContinue', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, sessionId, cause: 'restart' } });
          } catch (err) {
            if (this.ctx.stopping.aborted) return;
            this.ctx.log.warn('an interrupted item was not continued after the start', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
          }
        }
      }
    }
    this.request();
  }

  // ===================================================================================================================
  // smurg's own continues (DESIGN 0.7.0 D15): bounded, audited, said in the conversation
  // ===================================================================================================================

  /**
   * A turn of an item broke (or its process failed, or its snapshot could not be taken): what smurg will do about it.
   * The same cause again keeps the count (the bound is per cause); another cause starts at 0; `null` (a logged-out
   * account, a refused model, a person's stop) owes nothing and drops the record.
   */
  noteBreak(topicId: string, itemId: string, cause: AutoContinueCause | null): void {
    const now = this.ctx.clock.now();
    this.core.updateItem(topicId, itemId, (draft) => {
      if (cause === null) {
        delete draft.autoContinue;
        return;
      }
      const count = draft.autoContinue?.cause === cause ? draft.autoContinue.count : 0;
      draft.autoContinue = { cause, count, at: now };
    });
  }

  /** The account works again (`account.changed`): what a usage limit stopped is continued now. */
  onAccount(): void {
    if (this.core.started) this.sweepContinues();
  }

  /**
   * The reports' sweep (a few seconds): every continue that is due is sent, one at a time. Due: owed (the bound not
   * spent, the item still where its turn broke), its plan not paused, its session there and doing nothing (no turn, no
   * message waiting, no card), and its time come: a usage limit when the account is back, a broken turn 1 minute and
   * then 5 minutes after the stall, a crash and a failed snapshot 1 minute after it.
   */
  sweepContinues(): void {
    if (!this.core.started || !this.goneOn || this.ctx.stopping.aborted || this.continuing !== null || !this.mayRunAgents()) return;
    const due = this.dueContinues();
    if (due.length === 0) return;
    this.continuing = (async () => {
      for (const next of due) {
        if (this.ctx.stopping.aborted) return;
        await this.continueByItself(next.topicId, next.itemId).catch((err: unknown) => this.ctx.log.error('an automatic continue failed', { topic: next.topicId, item: next.itemId, error: err instanceof Error ? err.name : 'unknown' }));
      }
    })().finally(() => {
      this.continuing = null;
    });
  }

  private dueContinues(): { readonly topicId: string; readonly itemId: string }[] {
    const out: { topicId: string; itemId: string }[] = [];
    const cards = this.core.sessionsWithCards();
    for (const topic of this.core.topics()) {
      if (topic.archived || topic.plan.paused) continue;
      for (const item of topic.items) if (this.continueDue(topic, item, cards)) out.push({ topicId: topic.id, itemId: item.id });
    }
    return out;
  }

  private continueDue(topic: StoredTopic, item: StoredItem, cards: ReadonlySet<string>): boolean {
    const record = item.autoContinue;
    if (record === undefined || item.leftOut !== undefined || item.sessionId === undefined || !autoContinueOwed(item)) return false;
    const agents = this.ctx.services.agents;
    const session = agents.get(item.sessionId);
    if (session === null || session.status === 'ended') return false;
    const atWork = this.core.sessionAtWork(topic, item, cards);
    if (atWork !== null && (atWork.turnOpen || atWork.openCards > 0)) return false;
    if (record.cause === 'usage-limit') return agents.account().state === 'ok';
    const delays = AUTO_CONTINUE_DELAYS_MS[record.cause];
    const delay = delays[Math.min(record.count, delays.length - 1)] ?? 60_000;
    return this.ctx.clock.now() - record.at >= delay;
  }

  /** One automatic continue: counted and recorded first, then (a crash) the process started again, then `continue-item`. */
  private async continueByItself(topicId: string, itemId: string): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || topic.archived || topic.plan.paused || !this.continueDue(topic, item, this.core.sessionsWithCards())) return;
    const record = item.autoContinue as NonNullable<StoredItem['autoContinue']>;
    const sessionId = item.sessionId as string;
    const count = record.count + 1;
    const now = this.ctx.clock.now();
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.autoContinue = { cause: record.cause, count, at: now };
    });
    const audit = (outcome: 'ok' | 'error', extra: Record<string, string> = {}): void => {
      this.ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'plan.item.autoContinue', outcome, target: topicId, detail: { topicId, itemId, sessionId, cause: record.cause, count, ...extra } });
    };
    const agents = this.ctx.services.agents;
    try {
      // A failed process is started again first, as smurg (AgentSessions.retry names smurg in its line and keeps "only
      // the host" after three failed starts: the system principal has no role).
      if (agents.get(sessionId)?.status === 'failed') await agents.retry(sessionId, SYSTEM_PRINCIPAL);
      const line =
        record.cause === 'usage-limit'
          ? msg('conversation.continued.usageLimit')
          : record.cause === 'error'
            ? msg('conversation.continued.error', { count })
            : record.cause === 'crash'
              ? msg('conversation.continued.crash')
              : msg('conversation.continued.snapshot');
      await this.sendContinue(topicId, itemId, { line });
      audit('ok');
    } catch (err) {
      if (this.ctx.stopping.aborted) return;
      const reason = err instanceof SmurgError ? err.detail?.['reason'] : undefined;
      audit('error', { reason: typeof reason === 'string' ? reason : err instanceof SmurgError ? err.code : 'internal' });
      this.ctx.log.warn('an automatic continue was not sent', { topic: topicId, item: itemId, error: err instanceof Error ? err.name : 'unknown' });
    }
    this.core.publish(topicId);
  }
}

/** Session states that are inside a turn (or about to start one). */
const IN_A_TURN: ReadonlySet<string> = new Set(['starting', 'running', 'waiting-answer', 'waiting-permission']);
/** Session states whose turn is open now (`starting` is a process being launched, maybe with nothing to do). */
const TURN_OPEN: ReadonlySet<string> = new Set(['running', 'waiting-answer', 'waiting-permission']);

/** The history the Start of an item used (its pin): absent means the folder's own repository, as every 0.5.x pin. */
function historyOf(item: StoredItem): 'folder' | 'smurg' | 'direct' {
  return item.pin?.history ?? 'folder';
}

/** An armed item whose Start's history cannot be used now (DESIGN 0.6.0 D15). */
function historyChanged(): SmurgError {
  return new SmurgError('conflict', msg('plan.start.historyChanged'), { reason: 'history-changed' });
}
