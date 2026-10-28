// The merge queue (DESIGN 0.7.0 D8): smurg merges the work items that are in order (auto-merge-verdict.ts, D6), one
// at a time, the oldest report first, on the host's standing consent, through the worktree module (`autoMerge`, D7).
//
// One queue per workspace. `request()` asks for a pass (several requests while one runs become one more pass); a pass
// runs inside `core.serialize('auto-merge', …)`, so the module's stop waits for it, and it ends as soon as the daemon
// stops. A pass:
//   1. looks at every item of every open topic that smurg merges: the holds the verdict computes are stored on the item
//      (`autoMerge`, with `since`; once audited as `worktree.merge.held`), a stored hold whose cause went is removed;
//   2. collects what is to be done now: a merge (only when its re-check is due: a wait or a hold of the main workspace
//      is looked at again when what it waits for moved, at the latest a minute after its last try, never on every
//      sweep), a report to check again (`verify-again`, once per version), conflict markers to resolve;
//   3. does them in the order the reports were registered (then the topic's creation, then the item's number), asking
//      "still in order" again at each step and inside the worktree module's queue, the last time just before
//      `git merge`.
// A merge that is not clean against other work items only: the item's checkout is brought up to date with the main
// workspace and its own agent resolves and verifies again (three times at most, then a person decides); one against a
// person's change is a decision at once (R-SAFE S2). What waits or is held is skipped; everything else goes on, and
// what depends on a merged item starts from the merged state (the scheduler, through the bus).
//
// Nothing here has a timer of its own: the reports' sweep (`escalationSweepMs`) calls `sweep()`, which turns a long
// git-busy wait into a hold for the host and asks for a pass.
import { HOST_HOLDS, MAIN_ROOT, SELF_CLEARING_HOLDS, gitCommitSchema, lineEvent, rootRefKey, type FileRef, type LockInfo, type MergeRequest, type RootRef } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { AutoMergeOutcome, PeopleChange } from '../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { AUTO_MERGE_TRIES, KEPT_HOLDS, withinTextBudget, type AutoMergeVerdict } from './auto-merge-verdict.ts';
import { isDirect, itemKey, type TopicsCore } from './core.ts';
import { resolveConflictMessage, verifyAgainMessage } from './prompts.ts';
import type { StoredAutoMerge, StoredItem, StoredTopic } from './store.ts';

/** A wait or a hold of the main workspace is looked at again at the latest this long after its last try (DESIGN 0.7.0 D8). */
export const AUTO_MERGE_RECHECK_MS = 60_000;
/** git busy in the main workspace this long: a hold for the host (the host's terminal is mid-merge or rebase). */
export const AUTO_MERGE_BUSY_HOLD_MS = 10 * 60_000;

/** When an item that waits (or is held by the main workspace) is looked at again. */
interface Recheck {
  /** The daemon's clock: due from then on. */
  readonly at: number;
  /** Paths of the main workspace whose lock or file change makes it due at once. */
  readonly paths: ReadonlySet<string>;
  /** A change of the folder's git (HEAD, the index, a busy marker) makes it due at once. */
  readonly git: boolean;
  /** It waits behind another item's resolution: any merge or hold makes it due. */
  readonly behind: boolean;
}

interface Candidate {
  readonly topicId: string;
  readonly itemId: string;
  readonly kind: 'merge' | 'verify' | 'resolve';
  readonly at: number;
  readonly created: number;
  readonly number: number;
}

/** A record of the item's `autoMerge` without `since` (kept while the state and the reason stay) and `hostOnly` (from the reason). */
interface RecordInput {
  readonly state: StoredAutoMerge['state'];
  readonly reason: StoredAutoMerge['reason'];
  readonly paths?: readonly string[];
  readonly branch?: { readonly expected: string; readonly current: string };
  readonly requestId?: string;
  readonly people?: readonly PeopleChange[];
}

export class AutoMerger {
  private readonly ctx: DaemonContext;
  private readonly core: TopicsCore;
  private loop: Promise<void> | null = null;
  private again = false;
  /** The module's start has looked at what a restart left (`begin`): until then no pass does anything. */
  private begun = false;
  /** In memory: after a restart every waiting item is due once. */
  private readonly rechecks = new Map<string, Recheck>();
  /** `retry` waits in a row, per item: the second is a hold (`merge-failed`). */
  private readonly retries = new Map<string, number>();
  /** When the queue's own failure was last audited (at most once a minute: a pass runs on every sweep). */
  private failureAuditedAt = Number.NEGATIVE_INFINITY;
  /** The merge the queue is making now, and when it is settled (DESIGN 0.7.0 D11's "Leave it out" waits for it). */
  private inFlight: { readonly key: string; readonly settled: Promise<void> } | null = null;

  constructor(ctx: DaemonContext, core: TopicsCore) {
    this.ctx = ctx;
    this.core = core;
  }

  // ===================================================================================================================
  // Running
  // ===================================================================================================================

  /** The start has looked at what a restart left (paused plans, resolving items): passes may run from now on. */
  begin(): void {
    this.begun = true;
    this.request();
  }

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
    // Not in the caller's stack: a request made inside a bus listener (a merge announced inside the merge) must not run
    // the pass inside that listener.
    await Promise.resolve();
    while (this.again) {
      this.again = false;
      if (!this.core.started || this.ctx.stopping.aborted) return;
      try {
        await this.core.serialize('auto-merge', () => this.pass());
      } catch (err) {
        if (this.ctx.stopping.aborted) return;
        this.ctx.log.error('merge queue pass failed', { module: 'topics', error: err instanceof Error ? err.name : 'unknown' });
        const now = this.ctx.clock.now();
        if (now - this.failureAuditedAt >= AUTO_MERGE_RECHECK_MS) {
          this.failureAuditedAt = now;
          this.ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'worktree.merge.auto', outcome: 'error', target: 'auto-merge', detail: { reason: 'queue', error: err instanceof Error ? err.name : 'unknown' } });
        }
      }
    }
  }

  /** The merge of this item that is under way now has its outcome (resolved at once when none is). */
  whenSettled(topicId: string, itemId: string): Promise<void> {
    const flight = this.inFlight;
    return flight !== null && flight.key === itemKey(topicId, itemId) ? flight.settled : Promise.resolve();
  }

  /** D6 again, synchronously, for this same request: what the worktree module asks inside its queue. */
  stillInOrder(topicId: string, itemId: string, requestId: string): boolean {
    if (!this.core.started || this.ctx.stopping.aborted) return false;
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null) return false;
    const verdict = this.core.verdictOf(topic, item);
    return verdict.kind === 'merge' && verdict.requestId === requestId;
  }

  private async pass(): Promise<void> {
    if (!this.begun || !this.core.started || this.ctx.stopping.aborted) return;
    if (isStubService(this.ctx.services.worktrees)) return;
    const now = this.ctx.clock.now();
    const cards = this.core.sessionsWithCards();
    const candidates: Candidate[] = [];
    for (const listed of this.core.topics()) {
      let changed = false;
      for (const item of listed.items) {
        const topic = this.core.topic(listed.id);
        if (topic === null) break;
        const current = this.core.item(topic, item.id);
        if (current === null) continue;
        if (this.reconcile(topic, current, now, cards)) changed = true;
        const after = this.core.item(this.core.need(topic.id), item.id);
        if (after === null || topic.archived || this.core.mergingOf(after) !== 'auto') continue;
        const verdict = this.core.verdictOf(this.core.need(topic.id), after, cards);
        if (verdict.kind !== 'merge' && verdict.kind !== 'verify' && verdict.kind !== 'resolve') continue;
        if (verdict.kind === 'merge' && !this.isDue(itemKey(topic.id, after.id), now)) continue;
        const report = this.core.report(topic.id, after.id);
        candidates.push({ topicId: topic.id, itemId: after.id, kind: verdict.kind, at: report?.writtenAt ?? now, created: topic.createdAt, number: after.number });
      }
      if (changed) this.core.publish(listed.id);
    }
    candidates.sort((a, b) => a.at - b.at || a.created - b.created || a.number - b.number);
    for (const candidate of candidates) {
      if (this.ctx.stopping.aborted || !this.core.started) return;
      // What the earlier merges of this pass changed counts: the verdict is asked again for each.
      const topic = this.core.topic(candidate.topicId);
      const item = topic === null ? null : this.core.item(topic, candidate.itemId);
      if (topic === null || item === null) continue;
      const verdict = this.core.verdictOf(topic, item);
      if (verdict.kind !== candidate.kind) continue;
      if (verdict.kind === 'verify') await this.verifyAgain(topic, item);
      else if (verdict.kind === 'resolve') await this.resolveMarkers(topic.id, item.id, verdict.paths);
      else if (verdict.kind === 'merge') await this.tryMerge(topic.id, item.id, verdict.requestId);
    }
  }

  /**
   * What the item's record says follows the verdict: a hold it computes is stored the first time it is seen, a stored
   * hold whose cause went is removed, an item that is not smurg's to merge any more (merged, left out, the host's,
   * archived) keeps none. Returns whether the record changed.
   */
  private reconcile(topic: StoredTopic, item: StoredItem, now: number, cards: ReadonlySet<string>): boolean {
    const record = item.autoMerge;
    // An item that ran directly in the folder has nothing to merge: its record is the report service's (DESIGN 0.7.0 D10).
    if (isDirect(item)) return false;
    // (an item the host merges keeps only D6 row 2's hold for a message nothing delivers by itself, as its record: the
    // decision of its carers, also after the host turned automatic merging off; 0.7.0 fix5)
    const policy = this.core.mergingOf(item);
    const verdict = topic.archived || (policy !== 'auto' && !(policy === 'host' && this.core.messageUndelivered(item))) ? null : this.core.verdictOf(topic, item, cards);
    if (verdict === null || (policy !== 'auto' && verdict.kind !== 'hold')) {
      if (record === undefined) return false;
      this.drop(topic.id, item.id);
      return true;
    }
    if (this.isOut(topic, item, verdict)) {
      if (record === undefined) return false;
      this.drop(topic.id, item.id);
      return true;
    }
    // Its agent was to resolve or check again, and its session is gone (ended by a person, or for good): nobody is at
    // work on it any more, so a person decides (D8: without a live session the resolution gives up at once).
    if (record?.state === 'resolving' && this.liveSession(item) === null) {
      this.store(topic.id, item.id, { state: 'held', reason: record.reason === 'stale-report' ? 'stale-report' : 'conflict', ...(record.requestId === undefined ? {} : { requestId: record.requestId }), ...(record.paths === undefined ? {} : { paths: record.paths }) }, now);
      return true;
    }
    if (verdict.kind === 'hold') {
      if (record?.state === 'held' && record.reason === verdict.reason) return false;
      this.store(topic.id, item.id, { state: 'held', reason: verdict.reason, ...(verdict.paths === undefined ? {} : { paths: verdict.paths }) }, now);
      return true;
    }
    // A hold the verdict no longer gives is over, unless it is a decision that stays until what clears it happens
    // (row 14), or one of the main workspace that the queue looks at again (it falls through to the merge).
    if (record?.state === 'held' && !(KEPT_HOLDS as readonly string[]).includes(record.reason) && !(SELF_CLEARING_HOLDS as readonly string[]).includes(record.reason)) {
      this.drop(topic.id, item.id);
      return true;
    }
    return false;
  }

  /** The verdict says nothing is to be done for good (rows 1, 2): no record is kept for it. */
  private isOut(topic: StoredTopic, item: StoredItem, verdict: AutoMergeVerdict): boolean {
    if (verdict.kind !== 'none') return false;
    if (item.leftOut !== undefined || (item.state !== 'done' && item.state !== 'reviewed')) return true;
    if (this.core.claimed.has(itemKey(topic.id, item.id))) return false; // (transient: an undo's own record follows)
    const status = item.merge === undefined ? undefined : (this.core.requests.get(item.merge.requestId)?.status ?? item.merge.status);
    if (status === 'merged') return true;
    return item.autoMerge?.state !== 'resolving';
  }

  // ===================================================================================================================
  // One merge
  // ===================================================================================================================

  private async tryMerge(topicId: string, itemId: string, requestId: string): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || item.pin === undefined || item.pin.commit === null) return;
    const hostId = this.ctx.members.hostUserId();
    const host = this.ctx.members.userRef(hostId);
    if (host === null) return;
    const key = itemKey(topicId, itemId);
    // Looked at again from now on: a try that comes back with a wait says when.
    this.rechecks.delete(key);
    const consent = this.ctx.settings.notices().includes('auto-merge') ? 'update-default' : 'host-setting';
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.inFlight = { key, settled };
    let outcome: AutoMergeOutcome;
    try {
      outcome = await this.ctx.services.worktrees.autoMerge({
        requestId,
        host,
        pin: { ...(item.pin.branch === undefined ? {} : { branch: item.pin.branch }), commit: item.pin.commit },
        consent,
        stillInOrder: () => this.stillInOrder(topicId, itemId, requestId),
      });
    } catch (err) {
      if (this.ctx.stopping.aborted) return;
      this.ctx.log.error('an automatic merge could not be tried', { module: 'topics', topic: topicId, item: itemId, error: err instanceof Error ? err.name : 'unknown' });
      this.ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'worktree.merge.auto', outcome: 'error', target: requestId, detail: { requestId, topicId, itemId, reason: 'queue', error: err instanceof Error ? err.name : 'unknown' } });
      outcome = { kind: 'wait', reason: 'retry' };
    } finally {
      this.inFlight = null;
      settle();
    }
    await this.apply(topicId, itemId, requestId, outcome);
  }

  /** What a try's outcome does to the item (DESIGN 0.7.0 D8 "What each outcome does"). */
  private async apply(topicId: string, itemId: string, requestId: string, outcome: AutoMergeOutcome): Promise<void> {
    const key = itemKey(topicId, itemId);
    const now = this.ctx.clock.now();
    if (outcome.kind !== 'wait' || outcome.reason !== 'retry') this.retries.delete(key);
    switch (outcome.kind) {
      case 'merged': {
        // `mergedAs` is the scheduler's (onMerge, through the bus): the one writer, also for a merge a restart found;
        // the merge commit, which the wire's request does not carry, is added to it here.
        const mergeCommit = outcome.mergeCommit;
        if (mergeCommit !== undefined && gitCommitSchema.safeParse(mergeCommit).success) {
          this.core.updateItem(topicId, itemId, (draft) => {
            if (draft.mergedAs?.requestId === outcome.request.id && draft.mergedAs.commit === undefined) draft.mergedAs = { ...draft.mergedAs, commit: mergeCommit };
          });
        }
        this.drop(topicId, itemId);
        this.line(topicId, itemId, msg('conversation.merged.auto'));
        this.wakeBehind();
        break;
      }
      case 'conflict': {
        await this.onConflict(topicId, itemId, outcome.paths, outcome.people);
        break;
      }
      case 'wait': {
        const topic = this.core.topic(topicId);
        const item = topic === null ? null : this.core.item(topic, itemId);
        if (outcome.reason === 'retry') {
          const count = (this.retries.get(key) ?? 0) + 1;
          if (count >= 2) {
            this.retries.delete(key);
            this.store(topicId, itemId, { state: 'held', reason: 'merge-failed', requestId }, now);
            break;
          }
          this.retries.set(key, count);
          this.store(topicId, itemId, { state: 'waiting', reason: 'retry', requestId }, now);
          // the next sweep
          this.rechecks.set(key, { at: now, paths: new Set(), git: false, behind: false });
          break;
        }
        if (outcome.reason === 'git-busy') {
          // Ten minutes of git busy (counted from the wait's start) is the host's hold; once held it stays held while
          // git is busy, and clears when a look finds git done.
          const previous = item?.autoMerge;
          const since = previous?.reason === 'git-busy' ? previous.since : now;
          if (previous?.state === 'held' && previous.reason === 'git-busy') this.store(topicId, itemId, { state: 'held', reason: 'git-busy', requestId }, now);
          else if (now - since >= AUTO_MERGE_BUSY_HOLD_MS) this.store(topicId, itemId, { state: 'held', reason: 'git-busy', requestId }, now);
          else this.store(topicId, itemId, { state: 'waiting', reason: 'git-busy', requestId }, now);
          this.rechecks.set(key, { at: now + AUTO_MERGE_RECHECK_MS, paths: new Set(), git: true, behind: false });
          break;
        }
        // typing: someone edits one of its files (the lock's release makes it due)
        const paths = [...(outcome.paths ?? []), ...(outcome.lock === undefined ? [] : [outcome.lock.file.path])];
        this.store(topicId, itemId, { state: 'waiting', reason: 'typing', requestId, ...(outcome.paths === undefined || outcome.paths.length === 0 ? {} : { paths: outcome.paths }) }, now);
        this.rechecks.set(key, { at: now + AUTO_MERGE_RECHECK_MS, paths: new Set(paths), git: false, behind: false });
        break;
      }
      case 'hold': {
        const branch = outcome.reason === 'branch' && outcome.expected !== undefined && outcome.current !== undefined ? { branch: { expected: outcome.expected, current: outcome.current } } : {};
        this.store(topicId, itemId, { state: 'held', reason: outcome.reason, requestId, ...(outcome.paths === undefined || outcome.paths.length === 0 ? {} : { paths: outcome.paths }), ...branch }, now);
        if ((SELF_CLEARING_HOLDS as readonly string[]).includes(outcome.reason)) {
          const files = outcome.reason === 'local-changes' || outcome.reason === 'in-the-way' ? new Set(outcome.paths ?? []) : new Set<string>();
          this.rechecks.set(key, { at: now + AUTO_MERGE_RECHECK_MS, paths: files, git: true, behind: false });
        } else this.rechecks.delete(key);
        break;
      }
      case 'gone':
        break;
    }
    this.core.publish(topicId);
  }

  /**
   * A trial that was not clean (D8): a person's change on the other side is a decision at once; other work items only:
   * the item's checkout is brought up to date and its own agent resolves, at most AUTO_MERGE_TRIES times, one resolution
   * at a time per set of files.
   */
  private async onConflict(topicId: string, itemId: string, paths: readonly string[], people: readonly PeopleChange[]): Promise<void> {
    const now = this.ctx.clock.now();
    const key = itemKey(topicId, itemId);
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null) return;
    const requestId = item.merge?.requestId;
    const base = { ...(requestId === undefined ? {} : { requestId }), ...(paths.length === 0 ? {} : { paths }) };
    if (people.length > 0) {
      this.rechecks.delete(key);
      this.store(topicId, itemId, { state: 'held', reason: 'conflict', ...base, people: people.map((change) => ({ path: change.path, by: change.by.map((user) => ({ userId: user.userId, displayName: user.displayName })), outside: change.outside })) }, now);
      return;
    }
    if ((item.mergeTries ?? 0) >= AUTO_MERGE_TRIES) {
      this.rechecks.delete(key);
      this.store(topicId, itemId, { state: 'held', reason: 'conflict', ...base }, now);
      return;
    }
    // Another item resolves a conflict in the same files: this one is tried again once that one's next version is in.
    const files = new Set(paths);
    const ahead = this.core.topics().some((other) =>
      !other.archived && other.items.some((candidate) => (other.id !== topicId || candidate.id !== itemId) && candidate.autoMerge?.state === 'resolving' && candidate.autoMerge.reason === 'conflict' && (candidate.autoMerge.paths ?? []).some((path) => files.has(path))),
    );
    if (ahead) {
      this.store(topicId, itemId, { state: 'waiting', reason: 'behind', ...base }, now);
      this.rechecks.set(key, { at: now + AUTO_MERGE_RECHECK_MS, paths: new Set(), git: false, behind: true });
      return;
    }
    await this.updateAndResolve(topicId, itemId, paths);
  }

  /**
   * DESIGN 0.7.0 D8 "Update and resolve", in this order so that a crash at any point is taken up at the next start:
   * 1. the record and the try, persisted; 2. the main workspace merged into the item's checkout (0.6.0's
   * `updateFromMain`, which records the merge parent); 3. the line and `resolve-conflict` without `by`, naming the items
   * merged before this one. Without a live session, or when the checkout cannot be brought up to date: a decision.
   */
  private async updateAndResolve(topicId: string, itemId: string, paths: readonly string[], options: { readonly counted?: boolean } = {}): Promise<void> {
    const now = this.ctx.clock.now();
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null) return;
    const requestId = item.merge?.requestId;
    const base = { ...(requestId === undefined ? {} : { requestId }), ...(paths.length === 0 ? {} : { paths }) };
    const sessionId = this.liveSession(item);
    if (sessionId === null || item.worktreeId === undefined) {
      this.store(topicId, itemId, { state: 'held', reason: 'conflict', ...base }, now);
      return;
    }
    const worktreeId = item.worktreeId;
    if (options.counted !== false) {
      this.core.updateItem(topicId, itemId, (draft) => {
        draft.mergeTries = (draft.mergeTries ?? 0) + 1;
      });
    }
    this.store(topicId, itemId, { state: 'resolving', reason: 'conflict', ...base }, now);
    await this.core.flush();
    let conflicted: readonly string[];
    try {
      // (the main workspace as it is NOW: a person's change of a conflicted file since the trial, or since a stop between
      // the record and this update, is a decision for the carers, never the agent's to resolve; 0.7.0 review)
      const update = await this.ctx.services.worktrees.updateFromMain(worktreeId, { people: true });
      if (update.people !== undefined && update.people.length > 0) {
        const held = update.conflicted.length > 0 ? update.conflicted : paths;
        this.store(topicId, itemId, { state: 'held', reason: 'conflict', ...(requestId === undefined ? {} : { requestId }), ...(held.length === 0 ? {} : { paths: held }), people: update.people.map((change) => ({ path: change.path, by: change.by.map((user) => ({ userId: user.userId, displayName: user.displayName })), outside: change.outside })) }, this.ctx.clock.now());
        this.core.publish(topicId);
        return;
      }
      conflicted = update.conflicted;
    } catch (err) {
      if (this.ctx.stopping.aborted) return;
      this.ctx.log.warn('a checkout could not be brought up to date for its agent to resolve', { module: 'topics', topic: topicId, item: itemId, error: err instanceof Error ? err.name : 'unknown' });
      this.store(topicId, itemId, { state: 'held', reason: 'conflict', ...base }, this.ctx.clock.now());
      this.core.publish(topicId);
      return;
    }
    // (a version registered meanwhile, by a person's message, ends the resolution: its own merge decides)
    if (!this.stillResolving(topicId, itemId, 'conflict')) return;
    await this.sendResolve(topicId, itemId, sessionId, conflicted, { line: msg('conversation.update.auto', { count: conflicted.length }) });
  }

  /**
   * A new version whose snapshot the merge policy or the markers refused (report-service.ts, in the same synchronous
   * step that registers it): files only the host may merge, or the topic's own files, are the host's decision at once,
   * with the files; conflict markers are kept in memory for the next pass, which asks the agent to resolve them.
   */
  refused(topicId: string, itemId: string, reason: 'host-only-paths' | 'spec-files' | 'conflict-markers', files: readonly string[]): void {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || this.core.mergingOf(item) !== 'auto') return;
    this.core.refused.set(itemKey(topicId, itemId), files.slice(0, 20));
    if (reason !== 'conflict-markers') this.store(topicId, itemId, { state: 'held', reason: 'policy', ...(files.length === 0 ? {} : { paths: files }) }, this.ctx.clock.now());
  }

  /** The agent's own conflict markers (D6 row 8): it is asked to resolve them, a try each time. */
  private async resolveMarkers(topicId: string, itemId: string, paths: readonly string[]): Promise<void> {
    const now = this.ctx.clock.now();
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null) return;
    const requestId = item.merge?.requestId;
    const base = { ...(requestId === undefined ? {} : { requestId }), ...(paths.length === 0 ? {} : { paths }) };
    const sessionId = this.liveSession(item);
    if (sessionId === null || paths.length === 0 || (item.mergeTries ?? 0) >= AUTO_MERGE_TRIES) {
      this.store(topicId, itemId, { state: 'held', reason: 'conflict', ...base }, now);
      this.core.publish(topicId);
      return;
    }
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.mergeTries = (draft.mergeTries ?? 0) + 1;
    });
    this.store(topicId, itemId, { state: 'resolving', reason: 'markers', ...base }, now);
    await this.core.flush();
    if (!this.stillResolving(topicId, itemId, 'markers')) return;
    await this.sendResolve(topicId, itemId, sessionId, paths, {});
  }

  /** The item's record still says its agent is to resolve this (nothing ended it while smurg was busy with it). */
  private stillResolving(topicId: string, itemId: string, reason: 'conflict' | 'markers' | 'stale-report'): boolean {
    const topic = this.core.topic(topicId);
    const record = topic === null ? undefined : this.core.item(topic, itemId)?.autoMerge;
    return record?.state === 'resolving' && record.reason === reason;
  }

  private async sendResolve(topicId: string, itemId: string, sessionId: string, conflicted: readonly string[], options: { readonly line?: ReturnType<typeof msg> }): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null) return;
    const agents = this.ctx.services.agents;
    try {
      if (options.line !== undefined) agents.append(sessionId, lineEvent(options.line));
      await agents.send(sessionId, { kind: 'smurg', purpose: 'resolve-conflict', text: resolveConflictMessage({ conflicted, mergedBefore: this.core.mergedBefore(topic, item) }) });
      this.core.updateItem(topicId, itemId, (draft) => {
        draft.nudged = false;
        delete draft.fix;
      });
    } catch (err) {
      if (this.ctx.stopping.aborted) return;
      this.ctx.log.warn('resolve-conflict not sent', { module: 'topics', topic: topicId, item: itemId, error: err instanceof Error ? err.name : 'unknown' });
      const requestId = item.merge?.requestId;
      this.store(topicId, itemId, { state: 'held', reason: 'conflict', ...(requestId === undefined ? {} : { requestId }), ...(conflicted.length === 0 ? {} : { paths: conflicted }) }, this.ctx.clock.now());
    }
    this.core.publish(topicId);
  }

  /**
   * D6 row 13: the version's report was not checked in the turn that made it. Its agent is asked once (`verify-again`),
   * recorded first: the end of that turn decides (report-service.ts).
   */
  private async verifyAgain(topic: StoredTopic, item: StoredItem): Promise<void> {
    const now = this.ctx.clock.now();
    const sessionId = this.liveSession(item);
    const requestId = item.merge?.requestId;
    if (sessionId === null) {
      this.store(topic.id, item.id, { state: 'held', reason: 'stale-report', ...(requestId === undefined ? {} : { requestId }) }, now);
      this.core.publish(topic.id);
      return;
    }
    this.store(topic.id, item.id, { state: 'resolving', reason: 'stale-report', ...(requestId === undefined ? {} : { requestId }) }, now);
    await this.core.flush();
    if (!this.stillResolving(topic.id, item.id, 'stale-report')) return;
    await this.sendVerify(topic.id, item.id, sessionId, { line: msg('conversation.verifyAgain') });
  }

  private async sendVerify(topicId: string, itemId: string, sessionId: string, options: { readonly line: ReturnType<typeof msg> }): Promise<void> {
    const agents = this.ctx.services.agents;
    try {
      agents.append(sessionId, lineEvent(options.line));
      // (a version registered from the check of a turn a restart cut: its agent changed nothing after it, 0.7.0 verify)
      const key = itemKey(topicId, itemId);
      const version = this.core.report(topicId, itemId)?.version;
      const why = version !== undefined && this.core.cutTurnVersions.get(key) === version ? 'restart' : 'changed';
      this.core.cutTurnVersions.delete(key);
      await agents.send(sessionId, { kind: 'smurg', purpose: 'verify-again', text: verifyAgainMessage(why) });
    } catch (err) {
      if (this.ctx.stopping.aborted) return;
      this.ctx.log.warn('verify-again not sent', { module: 'topics', topic: topicId, item: itemId, error: err instanceof Error ? err.name : 'unknown' });
      const item = this.core.topic(topicId) === null ? null : this.core.item(this.core.need(topicId), itemId);
      const requestId = item?.merge?.requestId;
      this.store(topicId, itemId, { state: 'held', reason: 'stale-report', ...(requestId === undefined ? {} : { requestId }) }, this.ctx.clock.now());
    }
    this.core.publish(topicId);
  }

  // ===================================================================================================================
  // The setting (DESIGN 0.7.0 D3)
  // ===================================================================================================================

  /**
   * "Turning it off is for good" (R-SAFE S5, R-ENG E6): while the workspace's setting says the host merges, every item
   * whose pin says smurg's merge gets the host's, merged ones included (a follow-up's later version is the host's too),
   * and every record of the queue goes; one topic update per topic, audited once (`plan.merging.host`). Run when the
   * setting turns to `host` and at every start while it says so (a crash between state.json and topics.json is
   * repaired there). Archived topics too: restored, they must not be armed again by a later "on". `plan.lastPin` is
   * not rewritten (it only proposes the next Start's choice).
   */
  settingSaysHost(cause: 'setting' | 'start'): void {
    if (!this.core.started || this.ctx.settings.get().merging !== 'host') return;
    let topics = 0;
    let items = 0;
    for (const topic of this.core.topics()) {
      const rewritten = topic.items.filter((item) => item.pin?.merging === 'auto');
      // (an item that ran directly in the folder keeps what it is held for: that is no merge of anybody's, D10)
      if (rewritten.length === 0 && !topic.items.some((item) => item.autoMerge !== undefined && !isDirect(item))) continue;
      this.core.update(topic.id, (draft) => {
        for (const item of draft.items) {
          if (item.pin?.merging === 'auto') item.pin = { ...item.pin, merging: 'host' };
          if (!isDirect(item)) delete item.autoMerge;
        }
      });
      for (const item of topic.items) this.forget(topic.id, item.id);
      if (rewritten.length > 0) {
        topics += 1;
        items += rewritten.length;
      }
      this.core.publish(topic.id);
    }
    if (items > 0) this.ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'plan.merging.host', outcome: 'ok', target: 'merging', detail: { topics, items, cause } });
  }

  // ===================================================================================================================
  // After a restart (DESIGN 0.7.0 D8, R-ENG E2)
  // ===================================================================================================================

  /**
   * Items whose agent was bringing their work up to date, or checking their report again, when smurg stopped: taken up
   * where the record says, with no new try. Not in a paused plan (its "Continue all" takes them up).
   */
  async takeUp(topicId?: string): Promise<void> {
    if (!this.core.started || this.ctx.stopping.aborted) return;
    for (const listed of this.core.topics()) {
      if (listed.archived || listed.plan.paused || (topicId !== undefined && listed.id !== topicId)) continue;
      for (const stored of listed.items) {
        if (stored.autoMerge?.state !== 'resolving' || this.core.mergingOf(stored) !== 'auto') continue;
        await this.core
          .serialize('auto-merge', () => this.takeUpItem(listed.id, stored.id))
          .catch((err: unknown) => this.ctx.log.error('a resolving item was not taken up after the start', { module: 'topics', topic: listed.id, item: stored.id, error: err instanceof Error ? err.name : 'unknown' }));
      }
    }
  }

  private async takeUpItem(topicId: string, itemId: string): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    const record = item?.autoMerge;
    if (topic === null || item === null || record?.state !== 'resolving') return;
    const sessionId = this.liveSession(item);
    if (sessionId === null || item.worktreeId === undefined) {
      this.store(topicId, itemId, { state: 'held', reason: record.reason, ...(record.requestId === undefined ? {} : { requestId: record.requestId }), ...(record.paths === undefined ? {} : { paths: record.paths }) }, this.ctx.clock.now());
      this.core.publish(topicId);
      return;
    }
    // (the report the agent checked in the turn the restart cut was registered at the start, scheduler.ts afterRestart:
    // a new version ended the record)
    const after = this.core.item(this.core.need(topicId), itemId);
    if (after?.autoMerge?.state !== 'resolving') return;
    const restarted = msg('conversation.continued.restart');
    if (record.reason === 'stale-report') {
      await this.sendVerify(topicId, itemId, sessionId, { line: restarted });
      return;
    }
    if (this.ctx.services.worktrees.pendingMergeParent(item.worktreeId) !== null || record.reason === 'markers') {
      await this.sendResolve(topicId, itemId, sessionId, record.paths ?? [], { line: restarted });
      return;
    }
    // The stop came between the record and the update of the checkout: both again, not counted as another try.
    await this.updateAndResolve(topicId, itemId, record.paths ?? [], { counted: false });
  }

  // ===================================================================================================================
  // What makes a waiting item due
  // ===================================================================================================================

  private isDue(key: string, now: number): boolean {
    const recheck = this.rechecks.get(key);
    return recheck === undefined || recheck.at <= now;
  }

  private due(fits: (recheck: Recheck) => boolean): void {
    let any = false;
    for (const [key, recheck] of this.rechecks) {
      if (!fits(recheck)) continue;
      this.rechecks.set(key, { ...recheck, at: 0 });
      any = true;
    }
    if (any) this.request();
  }

  /** A lock of the main workspace changed (`lock.changed`): what waited for someone typing in that file is due. */
  onLock(file: FileRef, lock: LockInfo | null): void {
    if (lock !== null || rootRefKey(file.root) !== rootRefKey(MAIN_ROOT)) return;
    this.due((recheck) => recheck.paths.has(file.path));
  }

  /** Files of the main workspace changed (`file.changed`). */
  onFiles(root: RootRef, paths: readonly string[]): void {
    if (rootRefKey(root) !== rootRefKey(MAIN_ROOT) || this.rechecks.size === 0) return;
    const changed = new Set(paths);
    this.due((recheck) => [...recheck.paths].some((path) => changed.has(path)));
  }

  /** The folder's git changed (`workspace.git`). */
  onGit(): void {
    this.due((recheck) => recheck.git);
  }

  private wakeBehind(): void {
    this.due((recheck) => recheck.behind);
  }

  /**
   * A merge request changed (`merge.changed`): the host merged or rejected an item smurg would have merged. A
   * rejection of its current request is a decision for the item's carers (`held: rejected`).
   */
  onMerge(request: MergeRequest): void {
    if (!this.core.started || request.topicId === undefined || request.itemId === undefined) return;
    if (request.status === 'merged' || request.status === 'rejected') this.wakeBehind();
    if (request.status !== 'rejected') return;
    const topic = this.core.topic(request.topicId);
    const item = topic === null ? null : this.core.item(topic, request.itemId);
    if (topic === null || item === null || topic.archived || item.merge?.requestId !== request.id || this.core.mergingOf(item) !== 'auto') return;
    this.store(topic.id, item.id, { state: 'held', reason: 'rejected', requestId: request.id }, this.ctx.clock.now());
    this.core.publish(topic.id);
  }

  /** The reports' sweep: a long git-busy wait becomes the host's hold, and what is due is tried. */
  sweep(): void {
    if (!this.core.started || this.ctx.stopping.aborted) return;
    const now = this.ctx.clock.now();
    for (const topic of this.core.topics()) {
      if (topic.archived) continue;
      let changed = false;
      for (const item of topic.items) {
        const record = item.autoMerge;
        if (record?.state !== 'waiting' || record.reason !== 'git-busy' || now - record.since < AUTO_MERGE_BUSY_HOLD_MS) continue;
        this.store(topic.id, item.id, { state: 'held', reason: 'git-busy', ...(record.requestId === undefined ? {} : { requestId: record.requestId }) }, now);
        changed = true;
      }
      if (changed) this.core.publish(topic.id);
    }
    this.request();
  }

  // ===================================================================================================================
  // The record
  // ===================================================================================================================

  /**
   * Writes the item's `autoMerge` record. `since` changes when the state or the reason does; a change INTO `held` is
   * audited once (`worktree.merge.held`) and said once in the item's conversation.
   */
  store(topicId: string, itemId: string, input: RecordInput, now: number): void {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null) return;
    const previous = item.autoMerge;
    const hostOnly = input.state === 'held' && (HOST_HOLDS as readonly string[]).includes(input.reason);
    const budgeted = withinTextBudget({ ...(input.paths === undefined ? {} : { paths: input.paths }), ...(input.people === undefined ? {} : { people: input.people }) });
    const same = previous !== undefined && previous.state === input.state && previous.reason === input.reason;
    const next: StoredAutoMerge = {
      state: input.state,
      reason: input.reason,
      since: same ? previous.since : now,
      hostOnly,
      ...(budgeted.paths === undefined ? {} : { paths: [...budgeted.paths] }),
      ...(input.branch === undefined || input.reason !== 'branch' ? {} : { branch: { ...input.branch } }),
      ...(same && previous.escalatedAt !== undefined && input.state === 'held' && !hostOnly ? { escalatedAt: previous.escalatedAt } : {}),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(budgeted.people === undefined || input.reason !== 'conflict' ? {} : { people: budgeted.people.map((change) => ({ path: change.path, by: change.by.map((user) => ({ ...user })), outside: change.outside })) }),
    };
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return;
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.autoMerge = next;
    });
    if (next.state === 'held' && !same) this.held(topic, item, next);
  }

  /** The record goes: the item is a candidate again (or not smurg's any more). `mergeTries` stays. */
  drop(topicId: string, itemId: string): void {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    this.rechecks.delete(itemKey(topicId, itemId));
    this.retries.delete(itemKey(topicId, itemId));
    if (item?.autoMerge === undefined) return;
    this.core.updateItem(topicId, itemId, (draft) => {
      delete draft.autoMerge;
    });
  }

  /** Forgets what is kept in memory of an item (a new version, a new Start). */
  forget(topicId: string, itemId: string): void {
    this.rechecks.delete(itemKey(topicId, itemId));
    this.retries.delete(itemKey(topicId, itemId));
  }

  private held(topic: StoredTopic, item: StoredItem, record: StoredAutoMerge): void {
    // What waited behind its resolution is tried again (it is not resolving any more).
    this.wakeBehind();
    this.ctx.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'worktree.merge.held',
      outcome: 'ok',
      target: topic.id,
      detail: {
        topicId: topic.id,
        itemId: item.id,
        ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
        reason: record.reason,
        ...(record.paths === undefined ? {} : { paths: record.paths.slice(0, 20) }),
        ...(record.people === undefined ? {} : { people: record.people.slice(0, 20).map((change) => ({ path: change.path, by: change.by.map((user) => user.userId), outside: change.outside })) }),
        tries: item.mergeTries ?? 0,
      },
    });
    // (an item whose version is merged: what waits is its later change, 0.7.0 verify)
    const later = item.merged && this.core.verdictInputOf(topic, item).request?.status === 'merged';
    this.line(topic.id, item.id, msg(later ? 'conversation.heldLater' : 'conversation.held', { reason: record.reason }));
  }

  /** A line in the item's conversation, when it still has a session. */
  private line(topicId: string, itemId: string, text: ReturnType<typeof msg>): void {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    const sessionId = item === null ? null : this.liveSession(item);
    if (sessionId === null) return;
    try {
      this.ctx.services.agents.append(sessionId, lineEvent(text));
    } catch (err) {
      this.ctx.log.debug('merge line not written', { session: sessionId, error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private liveSession(item: StoredItem): string | null {
    const agents = this.ctx.services.agents;
    if (item.sessionId === undefined || isStubService(agents)) return null;
    const session = agents.get(item.sessionId);
    return session === null || session.status === 'ended' ? null : item.sessionId;
  }
}
