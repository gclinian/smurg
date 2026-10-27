// ReportService (ARCHITECTURE §7.8 "The result report"; design §4.5). A report is a file the agent writes in its
// worktree, `specs/<slug>/reports/<item id>.md`, so it is part of the item's change and reaches the main workspace
// with the merge. It COUNTS only when the agent's own `check_report` answered ok for exactly that content in this
// session (security S21): nobody can plant one. At the end of every completed turn of an execution session:
//
//   checked ok here, new or changed since the last version  → a new report VERSION: the worktree is snapshotted into a
//                                                              draft merge request, the reviewers' inbox gets it
//                                                              (a snapshot that cannot be taken registers NOTHING: the
//                                                              session says so, and the next completed turn tries again)
//   checked ok, unchanged                                    → nothing
//   exists, but this content was not checked ok              → `fix-report`, once per content, at most twice in a row
//   missing                                                  → `nudge-report`, once
//   still nothing registered after those                     → the item is `stalled` (`agent`)
//
// A turn a person stopped, or that ended with an error, stalls at once. This file also keeps follow-ups (the answer is
// the final text of the turn that took the message), review marks, who the reviewers are, and the escalation of a
// report that waits too long.
//
// An item that ran directly in the shared folder (no git, DESIGN 0.6.0 D15) writes its report where every item does,
// but in the shared folder itself: it counts by the same rule, is registered without a snapshot (`no-history`: there
// is no diff), and its first run then gives the shared folder back (direct-folder.ts). Its changes are in the folder
// already; it COUNTS as merged (what depends on it may start) only when its report is complete and verified and was
// checked in the turn that produced it (0.7.0, DESIGN D10: else its agent is asked once to check it again, and then it
// is held for its carers, as a report that is not complete and verified is at once; the host may accept it as it is).
//
// 0.7.0 (DESIGN D6, D8, D12): what the merge queue reads of a turn is recorded here, as it happens: the turns of an
// item's sessions are counted when a turn's end arrives (`turns`), `check_report` stamps the turn it answered in, a
// version is "checked in the turn that made it" (`checkedInTurn`) or a later turn that changed nothing confirms it, a
// later turn that did not finish is `lastTurn`, a turn that carried a person's message and made no new version is
// `changesAsked`. A version is snapshotted again whenever its item is bringing its work up to date. A new version ends
// any hold of the merge queue and wakes it; a report of an item that smurg merges by itself is no review for anybody
// (its review is a mark) and never escalates.
import {
  CHECKED_HASHES_MAX,
} from './store.ts';
import {
  MAIN_ROOT,
  MESSAGE_TEXT_MAX_CHARS,
  REPORT_BY_HAND_MAX,
  REPORT_FOLLOW_UPS_MAX,
  REPORT_FOLLOW_UP_TEXT_MAX_BYTES,
  SmurgError,
  agentTextWithin,
  lineEvent,
  mayReview,
  noticeEvent,
  topicReportPath,
  wireText,
  worktreeRoot,
  type FileRef,
  type ReportInfo,
  type ReportSummary,
  type RootRef,
  type Suggestion,
  type TurnOutcome,
  type UserRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import { autoContinueOwed, directVerdict, type DirectVerdict } from './auto-merge-verdict.ts';
import type { FileCheck, McpToolContext, Principal, ReportService, Req, SnapshotResult, TurnMessage } from '../core/interfaces.ts';
import { newId, type Disposable, toDisposable } from '../core/lifecycle.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import type { AutoMerger } from './auto-merge.ts';
import { isDirect, itemKey, userRefOf, type FileContent, type TopicsCore } from './core.ts';
import { DirectFolder } from './direct-folder.ts';
import { fixFileMessage, nudgeReportMessage, verifyAgainMessage } from './prompts.ts';
import { parseReport, type ParsedReport } from './report-format.ts';
import type { Scheduler, SchedulerReports } from './scheduler.ts';
import type { StoredItem, StoredReport, StoredTopic } from './store.ts';
import { wireLarge } from './text.ts';

/** What the model reads when it calls `check_report` from a session that is not a work item's. */
export const NOT_AN_ITEM = "This tool is for the session of a work item. This session is not one.";

interface TurnFinished {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly outcome: TurnOutcome;
  readonly finalText?: string;
  readonly messages: readonly TurnMessage[];
  readonly edited: readonly { readonly file: FileRef; readonly seq: number }[];
  readonly ran?: readonly { readonly seq: number }[];
  readonly modelRefused?: true;
}

function clipFollowUp(text: string): { text: string; truncated?: true } {
  const cut = wireLarge(text, REPORT_FOLLOW_UP_TEXT_MAX_BYTES);
  return { text: cut.text, ...(cut.truncated ? { truncated: true as const } : {}) };
}

export class ReportServiceImpl implements ReportService, SchedulerReports {
  private readonly ctx: DaemonContext;
  private readonly core: TopicsCore;
  private readonly scheduler: Scheduler;
  /** What `prepareCheck` read for an item session's next `check_report` (the contract's method is synchronous). */
  private readonly prepared = new Map<string, FileContent | null>();
  /**
   * The session's newest event when `check_report` last answered ok for a content (session and hash): an edit of the
   * turn with a later tool card was made after that check (0.7.0 review: a version is checked in its turn only when
   * nothing changed after its check). Kept in memory: a turn a restart cut is never one that completed.
   */
  private readonly checkSeqs = new Map<string, number>();
  /** Turns of item sessions that started and whose end is not handled yet (`agent.turn.started`, R-ENG: no gap). */
  private readonly openTurns = new Map<string, { readonly key: string; readonly sessionId: string }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private merger: AutoMerger | null = null;

  constructor(ctx: DaemonContext, core: TopicsCore, scheduler: Scheduler) {
    this.ctx = ctx;
    this.core = core;
    this.scheduler = scheduler;
  }

  /** The merge queue a new version wakes (DESIGN 0.7.0 D8). */
  attachMerger(merger: AutoMerger): void {
    this.merger = merger;
  }

  // ===================================================================================================================
  // Reading
  // ===================================================================================================================

  get(topicId: string, itemId: string): ReportInfo | null {
    if (!this.core.started) return null;
    const stored = this.core.report(topicId, itemId);
    return stored === null ? null : this.core.toReportInfo(stored);
  }

  toReview(): { readonly topicId: string; readonly itemId: string; readonly report: ReportSummary }[] {
    if (!this.core.started) return [];
    const open = new Set(
      this.core
        .topics()
        .filter((topic) => !topic.archived)
        .map((topic) => topic.id),
    );
    return this.core
      .reports()
      .filter((report) => open.has(report.topicId) && (report.state === 'to-review' || report.state === 'changed-after-review'))
      .map((report) => ({ topicId: report.topicId, itemId: report.itemId, report: this.core.summaryOf(report) }));
  }

  isReviewed(topicId: string, itemId: string): boolean {
    return this.core.report(topicId, itemId)?.state === 'reviewed';
  }

  hasReport(topicId: string, itemId: string): boolean {
    return this.core.report(topicId, itemId) !== null;
  }

  // ===================================================================================================================
  // The agent's own check (MCP `check_report`)
  // ===================================================================================================================

  private itemOf(mcp: McpToolContext): { readonly topic: StoredTopic; readonly item: StoredItem } | null {
    if (mcp.purpose !== 'item' || mcp.topic === undefined || mcp.itemId === undefined || !this.core.started) return null;
    const topic = this.core.topic(mcp.topic.id);
    const item = topic === null ? null : this.core.item(topic, mcp.itemId);
    return topic === null || item === null || topic.archived || item.sessionId !== mcp.sessionId ? null : { topic, item };
  }

  /** Reads the report file of the caller's root for the `check_report` that follows (see PlanServiceImpl.prepareCheck). */
  async prepareCheck(mcp: McpToolContext): Promise<void> {
    const hit = this.itemOf(mcp);
    if (hit === null) return;
    this.prepared.set(mcp.sessionId, await this.core.readFile(mcp.root, topicReportPath(hit.topic.slug, hit.item.id)));
  }

  checkReport(mcp: McpToolContext): FileCheck {
    const hit = this.itemOf(mcp);
    if (hit === null) return { ok: false, errors: [{ message: NOT_AN_ITEM }] };
    const content = this.prepared.get(mcp.sessionId);
    this.prepared.delete(mcp.sessionId);
    const file = JSON.stringify(topicReportPath(hit.topic.slug, hit.item.id));
    if (content === undefined) return { ok: false, errors: [{ message: `${file} could not be read right now. Call check_report again.` }] };
    if (content === null) return { ok: false, errors: [{ message: `${file} does not exist. Write it first, then call check_report.` }] };
    const parse = parseReport(content.text, hit.item.id);
    if (!parse.ok) return { ok: false, errors: parse.errors.map((error) => ({ line: error.line, message: error.model })) };
    // The ok answer is what lets the daemon register exactly this content, for this session. 0.7.0 (DESIGN D6): with
    // the turn it answered in (the turn in progress), so "checked in the turn that made it" survives a restart.
    const attempt = hit.item.attempt;
    const turn = (hit.item.turns ?? 0) + 1;
    this.core.updateItem(hit.topic.id, hit.item.id, (draft) => {
      const kept = draft.checked.filter((entry) => !(entry.sessionId === mcp.sessionId && entry.hash === content.hash));
      kept.push({ sessionId: mcp.sessionId, attempt, hash: content.hash, turn });
      draft.checked = kept.slice(-CHECKED_HASHES_MAX);
    });
    const agents = this.ctx.services.agents;
    const seq = isStubService(agents) ? undefined : agents.get(mcp.sessionId)?.lastSeq;
    if (seq !== undefined) this.checkSeqs.set(checkKey(mcp.sessionId, content.hash), seq);
    return { ok: true };
  }

  // ===================================================================================================================
  // The end of a turn of an execution session
  // ===================================================================================================================

  /**
   * A turn of an item session began (`agent.turn.started`): from now until its end is handled the item counts as at
   * work (core.ts `sessionAtWork`). The runtime publishes the session's new status before it announces the turn's end,
   * so without this the plan read the item as idle with its old facts for a moment: "Ready to check" twice, a hold that
   * came back (0.7.0 review).
   */
  onTurnStarted(event: { readonly sessionId: string; readonly turnId: string }): void {
    if (!this.core.started) return;
    const hit = this.core.bySession(event.sessionId);
    if (hit === null || hit.item === null) return;
    const id = turnKey(event.sessionId, event.turnId);
    if (this.openTurns.has(id)) return;
    const key = itemKey(hit.topic.id, hit.item.id);
    this.openTurns.set(id, { key, sessionId: event.sessionId });
    this.core.turnsInHand.set(key, (this.core.turnsInHand.get(key) ?? 0) + 1);
  }

  /** An item session ended: a turn of it whose end never came is in hand no more. */
  onSessionExited(sessionId: string): void {
    for (const [id, open] of [...this.openTurns]) {
      if (open.sessionId !== sessionId) continue;
      this.openTurns.delete(id);
      this.releaseTurn(open.key);
    }
  }

  private releaseTurn(key: string): void {
    const left = (this.core.turnsInHand.get(key) ?? 1) - 1;
    if (left <= 0) this.core.turnsInHand.delete(key);
    else this.core.turnsInHand.set(key, left);
  }

  onItemTurn(event: TurnFinished): Promise<void> {
    const hit = this.core.bySession(event.sessionId);
    if (hit === null || hit.item === null) return Promise.resolve();
    const topicId = hit.topic.id;
    const itemId = hit.item.id;
    // DESIGN 0.7.0 D6: the turn is counted when its end arrives, synchronously, before its handling is queued; and
    // until that handling is done nothing of the item merges (the turn may have changed what is in order).
    let turn = hit.item.turns ?? 0;
    if (hit.item.sessionId === event.sessionId) {
      turn += 1;
      this.core.updateItem(topicId, itemId, (draft) => {
        draft.turns = (draft.turns ?? 0) + 1;
      });
    }
    const key = itemKey(topicId, itemId);
    // (in hand since its start, when that was heard; else from now)
    const started = event.turnId === undefined ? undefined : this.openTurns.get(turnKey(event.sessionId, event.turnId));
    if (started !== undefined && event.turnId !== undefined) this.openTurns.delete(turnKey(event.sessionId, event.turnId));
    const counted = started?.key ?? key;
    if (started === undefined) this.core.turnsInHand.set(key, (this.core.turnsInHand.get(key) ?? 0) + 1);
    return this.core.serialize(`report:${topicId}:${itemId}`, () => this.itemTurn(topicId, itemId, event, turn)).finally(() => {
      this.releaseTurn(counted);
      if (this.core.started && this.core.topic(topicId) !== null) this.core.publish(topicId);
      this.merger?.request();
    });
  }

  private async itemTurn(topicId: string, itemId: string, event: TurnFinished, turn: number): Promise<void> {
    const before = this.core.report(topicId, itemId)?.version ?? 0;
    await this.turnBody(topicId, itemId, event, turn);
    this.afterTurn(topicId, itemId, event, turn, before);
  }

  /**
   * DESIGN 0.7.0 D6, D8: what a completed turn that made no new version says. It carried a person's message: somebody
   * wrote to the agent since this version (`changesAsked`). It checked the current version's content and changed
   * nothing: that version is checked in a turn of its own (`checkedInTurn`). And a turn that `verify-again` started
   * and that did neither is a decision (`held: stale-report`).
   */
  private afterTurn(topicId: string, itemId: string, event: TurnFinished, turn: number, before: number): void {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    const registered = this.core.report(topicId, itemId);
    if (topic === null || item === null || topic.archived || item.sessionId !== event.sessionId || registered === null) return;
    if (registered.version !== before) return;
    // DESIGN 0.7.0 D10: the turn `verify-again` started for an item that ran in the folder did not finish: a decision.
    if (event.outcome !== 'completed') {
      if (isDirect(item) && item.autoMerge?.state === 'resolving' && item.autoMerge.reason === 'stale-report') this.merger?.store(topicId, itemId, { state: 'held', reason: 'stale-report' }, this.ctx.clock.now());
      return;
    }
    const person = event.messages.find((message) => message.kind === 'person' && message.from !== undefined);
    if (person?.from !== undefined) {
      const by = person.from;
      this.core.updateItem(topicId, itemId, (draft) => {
        draft.changesAsked = { by: { ...by }, at: this.ctx.clock.now() };
      });
    }
    const confirmed =
      event.edited.length === 0 && registered.sessionId === event.sessionId && item.checked.some((entry) => entry.sessionId === event.sessionId && entry.hash === registered.contentHash && entry.turn === turn);
    if (confirmed && registered.checkedInTurn !== true) {
      const previous = this.core.summaryOf(registered);
      this.core.putReport({ ...registered, checkedInTurn: true });
      this.core.publishReport(topicId, itemId, previous);
    }
    const record = this.core.item(this.core.need(topicId), itemId)?.autoMerge;
    if (isDirect(item)) {
      // An item that ran in the folder, whose version waited for a check of its report (D10): checked now, it counts as
      // merged and what depends on it may start; asked to and not checked, it is a decision.
      if (record?.reason === 'stale-report' && (record.state === 'resolving' || record.state === 'held')) {
        if (confirmed) this.directMerged(topicId, itemId);
        else if (record.state === 'resolving') this.merger?.store(topicId, itemId, { state: 'held', reason: 'stale-report' }, this.ctx.clock.now());
      }
    } else if (record?.state === 'resolving' && record.reason === 'stale-report') {
      if (confirmed) this.merger?.drop(topicId, itemId);
      else this.merger?.store(topicId, itemId, { state: 'held', reason: 'stale-report', ...(record.requestId === undefined ? {} : { requestId: record.requestId }) }, this.ctx.clock.now());
    }
    this.core.publish(topicId);
  }

  /** DESIGN 0.7.0 D10: an item that ran in the folder counts as merged now; what depends on it may start. */
  private directMerged(topicId: string, itemId: string): void {
    this.merger?.drop(topicId, itemId);
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.merged = true;
    });
    this.scheduler.request();
  }

  /**
   * DESIGN 0.7.0 D10, D6 row 13: the version of an item that ran in the folder was not checked in the turn that made
   * it: its agent is asked once to check it again (recorded first; the end of that turn decides, `afterTurn`).
   */
  private async directVerify(topicId: string, itemId: string, sessionId: string): Promise<void> {
    const agents = this.ctx.services.agents;
    this.merger?.store(topicId, itemId, { state: 'resolving', reason: 'stale-report' }, this.ctx.clock.now());
    try {
      agents.append(sessionId, lineEvent(msg('conversation.verifyAgain')));
      await agents.send(sessionId, { kind: 'smurg', purpose: 'verify-again', text: verifyAgainMessage() });
    } catch (err) {
      if (this.ctx.stopping.aborted) return;
      this.ctx.log.warn('verify-again not sent', { module: 'topics', topic: topicId, item: itemId, error: err instanceof Error ? err.name : 'unknown' });
      this.merger?.store(topicId, itemId, { state: 'held', reason: 'stale-report' }, this.ctx.clock.now());
    }
    this.core.publish(topicId);
  }

  private async turnBody(topicId: string, itemId: string, event: TurnFinished, turn: number): Promise<void> {
    let topic = this.core.topic(topicId);
    let item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || topic.archived || item.sessionId !== event.sessionId) return;
    // A turn a person asked for (a message, "Continue", a follow-up) may be nudged and fixed afresh, and smurg's
    // automatic continues count from 0 again (DESIGN 0.7.0 D15).
    if (event.messages.some((message) => message.kind === 'person' || message.by !== undefined)) {
      this.core.updateItem(topicId, itemId, (draft) => {
        draft.nudged = false;
        delete draft.fix;
        delete draft.autoContinue;
      });
    }
    this.answerFollowUps(topicId, itemId, event);
    topic = this.core.need(topicId);
    item = this.core.needItem(topic, itemId);
    const registered = this.core.report(topicId, itemId);

    if (event.outcome !== 'completed') {
      // Stopped by a person, or ended with an error: stalled at once, without a nudge. Not so when the turn ended
      // because the session's PROCESS is gone (the runtime ends the turn with `error` and then says `failed`): that
      // item is `failed` ("Try again" resumes the same session), whichever of the two this module hears first.
      const agents = this.ctx.services.agents;
      const processFailed = item.state === 'failed' || (!isStubService(agents) && agents.get(event.sessionId)?.status === 'failed');
      // DESIGN 0.7.0 D15: what smurg continues by itself. A person's stop never; a process that is gone once (a crash);
      // a usage limit when the account is back; any other error twice; a logged-out account or a model the API refused
      // never (a person must act first).
      const account = isStubService(agents) ? 'ok' : agents.account().state;
      const cause =
        event.outcome !== 'error' ? null : processFailed ? 'crash' : account === 'usage-limit' ? 'usage-limit' : account === 'logged-out' || event.modelRefused === true ? null : 'error';
      this.scheduler.noteBreak(topicId, itemId, cause);
      if (registered === null && !processFailed) this.stall(topic, item, event.outcome === 'interrupted' ? 'stopped' : 'error');
      else {
        // DESIGN 0.7.0 D6 row 6: a later turn after a version did not finish (R-SAFE S7): that version is not merged.
        if (registered !== null) {
          const at = this.ctx.clock.now();
          this.core.updateItem(topicId, itemId, (draft) => {
            draft.lastTurn = { outcome: event.outcome === 'interrupted' ? 'interrupted' : 'error', at };
            // What it edited is in the checkout and in no version: the next completed turn takes the snapshot again
            // whatever the report file says (0.7.0 review: else the change stayed unmerged and the topic never got to
            // "ready").
            if (event.edited.length > 0 && !isDirect(draft)) draft.snapshotOwed = true;
          });
          // DESIGN 0.7.0 D10 (0.7.0 review): an item that ran in the folder has the unfinished turn's change in the
          // folder already: it no longer counts as merged, so what depends on it does not start on half of a change.
          if (isDirect(item)) this.directUnfinished(topicId, itemId, at);
        }
        this.core.publish(topicId);
      }
      return;
    }
    // A completed turn: no later turn is unfinished any more. An item that ran in the folder has its version decided
    // again (DESIGN 0.7.0 D10: the unfinished turn made it count as not merged); an item with a checkout whose
    // unfinished turn edited files takes its snapshot again (`snapshotOwed`).
    const afterUnfinished = item.lastTurn !== undefined && isDirect(item);
    if (item.lastTurn !== undefined) {
      this.core.updateItem(topicId, itemId, (draft) => {
        delete draft.lastTurn;
      });
      topic = this.core.need(topicId);
      item = this.core.needItem(topic, itemId);
    }
    const root = reportRootOf(item);
    if (root === null) return;
    const path = topicReportPath(topic.slug, item.id);
    const file = await this.core.readFile(root, path);
    if (file === null) {
      if (registered !== null) return; // a version exists and its file is simply not there any more: nothing new
      if (!item.nudged) await this.nudge(topic, item);
      else this.stall(topic, item, 'agent');
      return;
    }
    const checkedHere = item.checked.some((entry) => entry.sessionId === event.sessionId && entry.hash === file.hash);
    // The checkout holds what no version has (0.7.0 verify): files a command changed (no edit tool, so not in
    // `edited`), a person's save; or, owed a snapshot, still holds what that was owed for (a tree git says holds nothing
    // beyond its newest request owes nothing: a talk-only turn the stop cut). Looked at (git) only where nothing else
    // says the version changed; a tree that cannot be looked at is ahead when a snapshot is owed.
    const worktrees = this.ctx.services.worktrees;
    const owed = item.snapshotOwed === true;
    let ahead: boolean | null = null;
    const treeAhead = async (): Promise<boolean> => {
      if (ahead !== null) return ahead;
      if (registered === null || isDirect(item) || item.worktreeId === undefined || isStubService(worktrees)) ahead = owed;
      else ahead = (await worktrees.holdsUnsnapshotted(item.worktreeId)) ?? owed;
      return ahead;
    };
    if (checkedHere) {
      const parse = parseReport(file.text, item.id);
      // After `resolve-conflict` the worktree changed whatever the agent did (smurg merged the main workspace into
      // it): the snapshot is taken again, so the resolution is committed with its second parent. 0.7.0 (DESIGN D8):
      // also whenever the item is bringing its work up to date, or its worktree holds a merge parent no snapshot has
      // committed yet.
      const resolved = event.messages.some((message) => message.purpose === 'resolve-conflict') || this.resolving(item);
      const unchanged =
        registered !== null && registered.contentHash === file.hash && registered.sessionId === event.sessionId && event.edited.length === 0 && !resolved && !afterUnfinished && !(await treeAhead());
      // (owed a snapshot, and git says the checkout holds nothing beyond its newest request: nothing is owed any more)
      if (unchanged && owed) {
        this.core.updateItem(topicId, itemId, (draft) => {
          delete draft.snapshotOwed;
        });
      }
      if (parse.ok && !unchanged) {
        // checked in THIS turn (DESIGN 0.7.0 D6 row 13), and nothing of the item edited after that check (0.7.0
        // review: a change made after the check is one no check ran against): what smurg's merge of this version needs
        const inTurn = item.checked.some((entry) => entry.sessionId === event.sessionId && entry.hash === file.hash && entry.turn === turn) && !this.editedAfterCheck(event, file.hash, path);
        await this.register(topic, item, event.sessionId, file, parse.report, inTurn);
        return;
      }
      if (parse.ok) {
        this.core.publish(topicId);
        return;
      }
    }
    // The registered version, unchanged (a checkout that holds more than it has: its report is checked again first).
    if (registered !== null && registered.contentHash === file.hash && !(await treeAhead())) return;
    // The file exists, but this content was not checked ok in this session.
    const parse = parseReport(file.text, item.id);
    const asked = item.fix;
    const count = (asked?.count ?? 0) + 1;
    if ((asked === undefined || asked.hash !== file.hash) && count <= this.core.options.maxFixesInRow) {
      await this.fix(topic, item, file.hash, count, parse.ok ? [] : parse.errors.map((error) => ({ line: error.line, sentence: error.model })));
      return;
    }
    // Still nothing registered after those.
    if (registered === null) {
      this.stall(topic, item, 'agent');
      return;
    }
    if (!parse.ok && registered.state !== 'invalid') {
      const first = parse.errors[0];
      const previous = this.core.summaryOf(registered);
      this.core.putReport({ ...registered, state: 'invalid', ...(first === undefined ? {} : { error: { ...wireText(first.text), line: first.line } }) });
      this.core.publishReport(topicId, itemId, previous);
    }
  }

  private async nudge(topic: StoredTopic, item: StoredItem): Promise<void> {
    const sessionId = item.sessionId as string;
    const agents = this.ctx.services.agents;
    this.core.updateItem(topic.id, item.id, (draft) => {
      draft.nudged = true;
    });
    try {
      agents.append(sessionId, lineEvent(msg('conversation.nudge.report')));
      await agents.send(sessionId, { kind: 'smurg', purpose: 'nudge-report', text: nudgeReportMessage() });
    } catch (err) {
      this.ctx.log.warn('nudge-report not sent', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
      this.stall(topic, item, 'agent');
    }
  }

  private async fix(topic: StoredTopic, item: StoredItem, hash: string, count: number, findings: readonly { readonly line?: number; readonly sentence: string }[]): Promise<void> {
    const sessionId = item.sessionId as string;
    const agents = this.ctx.services.agents;
    this.core.updateItem(topic.id, item.id, (draft) => {
      draft.fix = { hash, count };
    });
    try {
      agents.append(sessionId, lineEvent(msg('conversation.fix.report')));
      await agents.send(sessionId, { kind: 'smurg', purpose: 'fix-report', text: fixFileMessage({ file: topicReportPath(topic.slug, item.id), tool: 'check_report', findings }) });
    } catch (err) {
      this.ctx.log.warn('fix-report not sent', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
      this.stall(topic, item, 'agent');
    }
  }

  /**
   * Whether the turn edited a file other than the report, or ran a command, after `check_report` last answered ok for
   * this content (its tool card came later). Unknown (no check heard in this daemon's run): yes.
   */
  private editedAfterCheck(event: TurnFinished, hash: string, reportPath: string): boolean {
    const seq = this.checkSeqs.get(checkKey(event.sessionId, hash));
    if (seq === undefined) return true;
    // (a command that ran after the check may have changed what was checked, as an edit does: 0.7.0 verify)
    return event.edited.some((entry) => entry.seq > seq && entry.file.path !== reportPath) || (event.ran ?? []).some((entry) => entry.seq > seq);
  }

  /**
   * An item that ran directly in the shared folder, a later turn of which did not finish (DESIGN 0.7.0 D10; 0.7.0
   * review): it does not count as merged any more and is held (`stopped`) for its carers. "Continue" (a completed turn
   * registers its version again and decides anew), the host's "Accept as it is" or "Leave it out" settle it. While
   * smurg will continue it by itself (D15) nobody is asked yet.
   */
  private directUnfinished(topicId: string, itemId: string, at: number): void {
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.merged = false;
      delete draft.mergedAs;
    });
    const after = this.core.item(this.core.need(topicId), itemId);
    if (after !== null && !autoContinueOwed(after)) this.merger?.store(topicId, itemId, { state: 'held', reason: 'stopped' }, at);
  }

  /**
   * The item is bringing its work up to date (DESIGN 0.7.0 D8): its record says it resolves a conflict or markers, or
   * its worktree holds a merge parent that no snapshot committed yet. Its next version is snapshotted whatever the
   * report file did.
   */
  private resolving(item: StoredItem): boolean {
    const record = item.autoMerge;
    if (record?.state === 'resolving' && (record.reason === 'conflict' || record.reason === 'markers')) return true;
    const worktrees = this.ctx.services.worktrees;
    return item.worktreeId !== undefined && !isStubService(worktrees) && worktrees.pendingMergeParent(item.worktreeId) !== null;
  }

  /** The session is idle without a registered report: the item needs someone ("Stopped without a report · Continue"). */
  private stall(topic: StoredTopic, item: StoredItem, by: NonNullable<StoredItem['stalledBy']>): void {
    // (DESIGN 0.7.0 D8: an item that was bringing its work up to date stops doing so with the stall)
    if (item.autoMerge?.state === 'resolving') this.merger?.drop(topic.id, item.id);
    this.core.setItemState(topic.id, item.id, 'stalled', by);
    // A direct item that needs someone gives the shared folder back ("Continue" takes it again, as a later turn).
    if (item.direct === true) this.scheduler.folder.firstRunOver(DirectFolder.key(topic.id, item.id));
    const agents = this.ctx.services.agents;
    if (item.sessionId !== undefined && !isStubService(agents)) {
      try {
        agents.setItemState(item.sessionId, { reportRegistered: false, stalled: by });
      } catch (err) {
        this.ctx.log.debug('item state not set on the session', { session: item.sessionId, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    this.core.publish(topic.id);
  }

  /**
   * The item's worktree as a draft merge request. A file that changed while the tree was read: that one request is
   * simply repeated. So is one whose staging failed (0.7.0 verify, the lead's decision 2: `git add --all` stops when a
   * file it listed is renamed away before it reads it, as a person's save in the checkout does).
   */
  private async snapshot(topic: StoredTopic, item: StoredItem): Promise<SnapshotResult> {
    const worktrees = this.ctx.services.worktrees;
    const input = { worktreeId: item.worktreeId as string, message: `smurg: work item ${item.number} (${item.id})`, topicSlug: topic.slug };
    try {
      return await worktrees.snapshot(input);
    } catch (err) {
      if (!(err instanceof SmurgError) || !changedUnderIt(err) || this.ctx.stopping.aborted) throw err;
      return worktrees.snapshot(input);
    }
  }

  /**
   * The snapshot could not be taken (a file kept changing, a repository inside the worktree, too many files, git ran
   * out of time). A report without its changes would read "changed no files" and offer nothing to merge, so NO
   * version is registered: the session says why, an item without any report needs someone ("Continue"), and the next
   * completed turn takes the snapshot again whatever the report file says by then. Not when smurg itself is stopping
   * (that is what ended git): the start looks at the item again.
   */
  private snapshotFailed(topic: StoredTopic, item: StoredItem, sessionId: string, contentHash: string, err: unknown): void {
    this.ctx.log.error('snapshot failed', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
    if (this.ctx.stopping.aborted) return;
    this.core.updateItem(topic.id, item.id, (draft) => {
      draft.snapshotOwed = true;
    });
    // DESIGN 0.7.0 D15: smurg continues it once, a minute later (the next completed turn takes the snapshot again).
    this.scheduler.noteBreak(topic.id, item.id, 'snapshot');
    try {
      this.ctx.services.agents.append(sessionId, noticeEvent('warning', msg('report.changes.failed')));
    } catch (failure) {
      this.ctx.log.debug('snapshot notice not written', { session: sessionId, error: failure instanceof Error ? failure.name : 'unknown' });
    }
    const reason = err instanceof SmurgError ? err.detail?.['reason'] : undefined;
    this.ctx.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'report.register',
      outcome: 'error',
      target: topic.id,
      detail: { topicId: topic.id, itemId: item.id, contentHash, sessionId, ...(err instanceof SmurgError ? { code: err.code } : {}), ...(typeof reason === 'string' ? { reason } : {}) },
    });
    if (this.core.report(topic.id, item.id) === null) this.stall(topic, item, 'error');
    else this.core.publish(topic.id);
  }

  /**
   * A new report version: the draft merge request, the stored report, a `pointer` event, the reviewers' inbox.
   * `false`: the worktree could not be snapshotted, and nothing was registered.
   */
  private async register(topic: StoredTopic, item: StoredItem, sessionId: string, file: FileContent, parsed: ParsedReport, checkedInTurn = false): Promise<boolean> {
    const agents = this.ctx.services.agents;
    const worktrees = this.ctx.services.worktrees;
    const direct = item.direct === true;
    const root: RootRef = direct ? MAIN_ROOT : worktreeRoot(item.worktreeId as string);
    let changes: ReportInfo['changes'];
    let noChanges: ReportInfo['noChanges'];
    let refusedFiles: readonly string[] = [];
    // In the folder itself there is no history: no snapshot, no diff (the report and the guides say so).
    if (direct) noChanges = 'no-history';
    else if (!isStubService(worktrees)) {
      // The snapshot IS the report's diff: a draft merge request the reviewer reads and the host can merge.
      let snapshot: SnapshotResult;
      try {
        snapshot = await this.snapshot(topic, item);
      } catch (err) {
        this.snapshotFailed(topic, item, sessionId, file.hash, err);
        return false;
      }
      if (snapshot.ok) {
        changes = {
          requestId: snapshot.request.id,
          files: snapshot.files,
          additions: snapshot.additions,
          deletions: snapshot.deletions,
          byHand: snapshot.byHand.slice(0, REPORT_BY_HAND_MAX).map((entry) => ({ path: entry.path, by: entry.by.slice(0, 20).map((user) => ({ ...user })) })),
          // (DESIGN 0.7.0 D4: a hand edit the list does not show holds an item smurg would merge, D6 row 9)
          ...(snapshot.byHand.length > REPORT_BY_HAND_MAX || snapshot.byHand.some((entry) => entry.by.length > 20) ? { byHandTruncated: true as const } : {}),
        };
      } else {
        // A refused snapshot still registers the report; people are told in the session why there is no diff.
        noChanges = snapshot.reason;
        refusedFiles = snapshot.files;
        const why =
          snapshot.reason === 'host-only-paths'
            ? msg('report.changes.hostOnly')
            : snapshot.reason === 'spec-files'
              ? msg('report.changes.specFiles')
              : msg('report.changes.markers', { files: snapshot.files.slice(0, 5).map((path) => path.slice(0, 200)) });
        agents.append(sessionId, noticeEvent('warning', why));
      }
    }
    const previous = this.core.report(topic.id, item.id);
    const now = this.ctx.clock.now();
    const version = (previous?.version ?? 0) + 1;
    // In the folder itself (DESIGN 0.7.0 D10): whether this version lets what depends on the item start.
    const decided: DirectVerdict | null = direct ? directVerdict({ outcome: parsed.outcome, checks: parsed.checks, checkedInTurn }) : null;
    const stored: StoredReport = {
      version,
      writtenAt: now,
      outcome: parsed.outcome,
      // A report that changes after its review asks for the review again.
      state: previous?.review === undefined ? 'to-review' : 'changed-after-review',
      reviewers: this.core.reviewersOf(topic, item),
      ...(previous?.review === undefined ? {} : { review: previous.review }),
      checks: parsed.checks,
      topicId: topic.id,
      itemId: item.id,
      file: { root, path: topicReportPath(topic.slug, item.id) },
      sections: {
        done: parsed.sections.done,
        why: parsed.sections.why,
        verified: parsed.sections.verified.map((check) => ({ ...check })),
        watchOut: parsed.sections.watchOut,
        ...(parsed.sections.followUps === undefined ? {} : { followUps: parsed.sections.followUps }),
      },
      ...(changes === undefined ? {} : { changes }),
      ...(noChanges === undefined ? {} : { noChanges }),
      questions: previous?.questions ?? [],
      contentHash: file.hash,
      sessionId,
      waitingSince: now,
      ...(checkedInTurn ? { checkedInTurn: true as const } : {}),
      pending: previous?.pending ?? [],
    };
    this.core.putReport(stored);
    this.core.updateItem(topic.id, item.id, (draft) => {
      // The item becomes `done`, or keeps `reviewed` (with the report asking again).
      const next = previous?.review === undefined ? 'done' : 'reviewed';
      if (draft.state !== next) draft.since = now;
      draft.state = next;
      draft.nudged = false;
      delete draft.stalledBy;
      delete draft.fix;
      delete draft.changesAsked;
      delete draft.snapshotOwed;
      // A new version ends whatever the merge queue held or waited for (DESIGN 0.7.0 D8), and any unfinished later turn;
      // the count of smurg's automatic continues starts again (D15).
      delete draft.autoMerge;
      delete draft.lastTurn;
      delete draft.autoContinue;
      if (changes !== undefined) draft.merge = { requestId: changes.requestId, status: 'draft', ready: false };
      // Its changes are in the folder already: what depends on it may start (once the folder is free), when its report
      // is complete and verified and was checked in this turn (D10). Each version decides again.
      // (`mergedAs` of a direct item is the host's "Accept as it is" of an earlier version: this one decides anew)
      if (decided !== null) {
        draft.merged = decided.kind === 'merged';
        delete draft.mergedAs;
      }
    });
    // A version registered after the topic's result was checked: the topic has new work again (DESIGN 0.7.0 D13).
    if (topic.checked !== undefined) {
      this.core.update(topic.id, (draft) => {
        delete draft.checked;
      });
    }
    const key = itemKey(topic.id, item.id);
    this.core.refused.delete(key);
    this.merger?.forget(topic.id, item.id);
    if (noChanges === 'host-only-paths' || noChanges === 'spec-files' || noChanges === 'conflict-markers') this.merger?.refused(topic.id, item.id, noChanges, refusedFiles);
    // (stored after the version: the hold's `since` is the version's, and its line follows the report's pointer below)
    if (decided?.kind === 'hold') this.merger?.store(topic.id, item.id, { state: 'held', reason: decided.reason }, now);
    try {
      agents.append(sessionId, { kind: 'pointer', target: 'report', topicId: topic.id, itemId: item.id, version });
      agents.setItemState(sessionId, { reportRegistered: true });
    } catch (err) {
      this.ctx.log.debug('report pointer not written', { session: sessionId, error: err instanceof Error ? err.name : 'unknown' });
    }
    this.ctx.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'report.register',
      outcome: 'ok',
      target: topic.id,
      detail: { topicId: topic.id, itemId: item.id, version, contentHash: file.hash, sessionId, outcome: parsed.outcome, ...(changes === undefined ? {} : { requestId: changes.requestId }), ...(noChanges === undefined ? {} : { noChanges }) },
    });
    this.core.publishReport(topic.id, item.id, previous === null ? null : this.core.summaryOf(previous));
    if (direct) {
      // The first run is over with its report: the folder goes once its turn is, and what depends on it may start.
      this.scheduler.folder.firstRunOver(DirectFolder.key(topic.id, item.id));
      this.scheduler.request();
      if (decided?.kind === 'verify') await this.directVerify(topic.id, item.id, sessionId);
    }
    // The merge queue looks at the new version (DESIGN 0.7.0 D8).
    this.merger?.request();
    return true;
  }

  /**
   * After a restart: a session that was mid-turn may have left a report it had checked; it is registered right then,
   * never as checked in the turn that made it (0.7.0 review): the turn the stop cut did not finish, and what it did
   * after its check is in the version too, so the merge queue asks the agent once to check it again (D6 row 13) and only
   * a turn that completes decides. `cutTurnOnly` (an item that was bringing its work up to date, D8): only a check of
   * that cut turn (`turns + 1`: its end never arrived) counts, and the snapshot is taken again whatever the report file
   * did. An item that runs directly in the folder is not registered here: its half-done change is in the folder, it
   * stays interrupted and its topic paused for the host (0.6.0 D15).
   */
  async checkAfterRestart(topicId: string, itemId: string, options: { readonly cutTurnOnly?: boolean } = {}): Promise<boolean> {
    return this.core.serialize(`report:${topicId}:${itemId}`, async () => {
      const topic = this.core.topic(topicId);
      const item = topic === null ? null : this.core.item(topic, itemId);
      const root = item === null ? null : reportRootOf(item);
      if (topic === null || item === null || item.sessionId === undefined || root === null || isDirect(item)) return false;
      const sessionId = item.sessionId;
      const file = await this.core.readFile(root, topicReportPath(topic.slug, item.id));
      const cutTurn = (item.turns ?? 0) + 1;
      const entry = file === null ? undefined : item.checked.find((candidate) => candidate.sessionId === sessionId && candidate.hash === file.hash && (options.cutTurnOnly !== true || candidate.turn === cutTurn));
      if (file === null || entry === undefined) return false;
      const forced = options.cutTurnOnly === true || this.resolving(item);
      const registered = this.core.report(topicId, itemId);
      if (registered !== null && registered.contentHash === file.hash && item.snapshotOwed !== true && !forced) return true;
      const parse = parseReport(file.text, item.id);
      if (!parse.ok) return false;
      // (a snapshot that fails here has left the item stalled or with its earlier version: nothing more to do at the start)
      const before = registered?.version ?? 0;
      await this.register(topic, item, sessionId, file, parse.report, false);
      const after = this.core.report(topicId, itemId)?.version ?? 0;
      // (its agent is told why it checks again: the restart, not an edit after its check; 0.7.0 verify)
      if (after > before) this.core.cutTurnVersions.set(itemKey(topicId, itemId), after);
      return after > before || (registered !== null && !forced);
    });
  }

  // ===================================================================================================================
  // Follow-ups
  // ===================================================================================================================

  async followUp(input: Req<'report.followUp'>, principal: Principal): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    const item = this.core.needItem(topic, input.itemId);
    const report = this.core.report(topic.id, item.id);
    if (report === null) throw new SmurgError('not_found', msg('report.none'), { reason: 'no-report' });
    const agents = this.ctx.services.agents;
    const session = item.sessionId === undefined || isStubService(agents) ? null : agents.get(item.sessionId);
    if (session === null || session.status === 'ended') {
      // Merged and reviewed: the item is finished and its session has ended (the sentence points to the discussion).
      // While the session is still there the item is not finished (a newer draft waits for the host), and it answers.
      if (item.merged && report.state === 'reviewed') throw new SmurgError('conflict', msg('report.closed'), { reason: 'closed' });
      throw new SmurgError('conflict', msg('plan.item.noSession'), { reason: 'no-session' });
    }
    // A message of that member when they have agent access; else a suggestion. A parked, idle or failed session resumes.
    const result = await this.ctx.services.conversation.sendAs(principal, {
      sessionId: session.id,
      text: input.text,
      origin: 'follow-up',
      topicId: topic.id,
      itemId: item.id,
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
    });
    const now = this.ctx.clock.now();
    const current = this.core.report(topic.id, item.id);
    if (current === null) return result;
    const questionId = newId('fq');
    if ('messageId' in result) {
      const cleaned = agentTextWithin(input.text, MESSAGE_TEXT_MAX_CHARS);
      const question = { id: questionId, from: by, ...clipFollowUp(cleaned.ok ? cleaned.text : input.text), at: now };
      this.core.putReport({ ...current, questions: [...current.questions, question].slice(-REPORT_FOLLOW_UPS_MAX), pending: [...current.pending, { questionId, messageId: result.messageId }].slice(-100) });
      // "Changes asked by Ian", until the next report version.
      this.core.updateItem(topic.id, item.id, (draft) => {
        draft.changesAsked = { by, at: now };
        draft.nudged = false;
        delete draft.fix;
      });
    } else {
      // Not a message yet: it joins the report's questions when someone accepted it and a turn took it.
      this.core.putReport({ ...current, pending: [...current.pending, { questionId, suggestionId: result.suggestion.id, question: { from: by, ...clipFollowUp(result.suggestion.text), at: now } }].slice(-100) });
    }
    this.core.publishReport(topic.id, item.id, this.core.summaryOf(current));
    return result;
  }

  /** A follow-up that was a suggestion: accepted, it marks the item "changes asked"; rejected or withdrawn, it is forgotten. */
  onSuggestion(suggestion: Suggestion): void {
    if (!this.core.started || suggestion.origin !== 'follow-up' || suggestion.topicId === undefined || suggestion.itemId === undefined || suggestion.status === 'pending') return;
    const report = this.core.report(suggestion.topicId, suggestion.itemId);
    if (report === null || !report.pending.some((entry) => entry.suggestionId === suggestion.id)) return;
    if (suggestion.status === 'accepted' || suggestion.status === 'accepted-modified') {
      const at = suggestion.resolvedAt ?? this.ctx.clock.now();
      this.core.updateItem(suggestion.topicId, suggestion.itemId, (draft) => {
        draft.changesAsked = { by: suggestion.author, at };
      });
      if (suggestion.finalText !== undefined) {
        const finalText = suggestion.finalText;
        this.core.putReport({ ...report, pending: report.pending.map((entry) => (entry.suggestionId === suggestion.id && entry.question !== undefined ? { ...entry, question: { ...entry.question, ...clipFollowUp(finalText) } } : entry)) });
      }
      this.core.publish(suggestion.topicId);
      return;
    }
    this.core.putReport({ ...report, pending: report.pending.filter((entry) => entry.suggestionId !== suggestion.id) });
  }

  /**
   * After a restart, an item with a version whose later turn the stop cut (scheduler.ts `noteStop`, or a session the
   * runtime found mid-turn after a hard death): that turn did not finish (`lastTurn`, `restart`), so the version is held
   * for its carers (D6 row 6: Continue, "Merge it as it is", Leave it out); an item that ran in the folder no longer
   * counts as merged (its topic stays paused for the host, D15). Its cut follow-ups get no answer.
   */
  cutByStop(topicId: string, itemId: string, at: number, stillWaiting: number): void {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || this.core.report(topicId, itemId) === null) return;
    // (what the cut turn edited is not known: for an item smurg merges, the next completed turn takes the snapshot again,
    // so that nothing it left stays in the checkout unmerged; the host who merges each item reads the checkout's diff)
    const retake = this.core.mergingOf(item) === 'auto';
    this.core.updateItem(topicId, itemId, (draft) => {
      draft.lastTurn = { outcome: 'interrupted', at, restart: true };
      if (retake) draft.snapshotOwed = true;
    });
    if (isDirect(item)) this.directUnfinished(topicId, itemId, at);
    this.cutFollowUps(topicId, itemId, stillWaiting);
  }

  /**
   * After a restart that cut a turn of the item (0.7.0 review): the follow-ups whose message that turn had taken get no
   * answer any more (its end never came): they join the report's questions without one, so that nothing waits for them
   * for ever (D6 row 5). The newest `stillWaiting` messages are still in the session's queue and are kept.
   */
  cutFollowUps(topicId: string, itemId: string, stillWaiting: number): void {
    const report = this.core.report(topicId, itemId);
    if (report === null) return;
    const messages = report.pending.filter((entry) => entry.messageId !== undefined);
    const cut = new Set(messages.slice(0, Math.max(0, messages.length - stillWaiting)));
    if (cut.size === 0) return;
    const questions = [...report.questions];
    for (const entry of cut) if (entry.question !== undefined && !questions.some((question) => question.id === entry.questionId)) questions.push({ id: entry.questionId, ...entry.question });
    this.core.putReport({ ...report, questions: questions.slice(-REPORT_FOLLOW_UPS_MAX), pending: report.pending.filter((entry) => !cut.has(entry)) });
    this.core.publishReport(topicId, itemId, this.core.summaryOf(report));
  }

  /** The turn that took a follow-up's message ended: its final text is the follow-up's answer. */
  private answerFollowUps(topicId: string, itemId: string, event: TurnFinished): void {
    const report = this.core.report(topicId, itemId);
    if (report === null || report.pending.length === 0) return;
    const now = this.ctx.clock.now();
    let questions = [...report.questions];
    let pending = [...report.pending];
    let changed = false;
    for (const message of event.messages) {
      if (message.kind !== 'person') continue;
      const entry = pending.find((candidate) => candidate.messageId === message.messageId || (message.suggestionId !== undefined && candidate.suggestionId === message.suggestionId));
      if (entry === undefined) continue;
      pending = pending.filter((candidate) => candidate !== entry);
      changed = true;
      if (entry.question !== undefined && !questions.some((question) => question.id === entry.questionId)) questions.push({ id: entry.questionId, ...entry.question });
      if (event.finalText === undefined) continue;
      const answer = { ...clipFollowUp(event.finalText), at: now };
      questions = questions.map((question) => (question.id === entry.questionId ? { ...question, answer } : question));
    }
    if (!changed) return;
    this.core.putReport({ ...report, questions: questions.slice(-REPORT_FOLLOW_UPS_MAX), pending });
    this.core.publishReport(topicId, itemId, this.core.summaryOf(report));
  }

  // ===================================================================================================================
  // Review
  // ===================================================================================================================

  async review(input: Req<'report.review'>, principal: Principal): Promise<ReportSummary> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    const item = this.core.needItem(topic, input.itemId);
    const report = this.core.report(topic.id, item.id);
    if (report === null) throw new SmurgError('not_found', msg('report.none'), { reason: 'no-report' });
    // A reviewer only; once the report has waited too long also a member with agent access ("Review instead of Mei").
    const isReviewer = report.reviewers.some((reviewer) => reviewer.userId === by.userId);
    if (principal.role === null || !mayReview({ userId: by.userId, role: principal.role }, { reviewers: report.reviewers.map((reviewer) => reviewer.userId), escalated: report.escalatedAt !== undefined })) {
      throw new AuthorizationError(msg('report.notReviewer', { name: report.reviewers[0]?.displayName ?? '' }), { reason: 'not-reviewer' });
    }
    if (input.version !== report.version) throw new SmurgError('conflict', msg('report.changed'), { reason: 'report-changed' });
    if (report.state === 'invalid') throw new SmurgError('conflict', report.error?.text ?? msg('report.error.format', { line: 1 }), { reason: 'invalid' });
    // Unfinished work is marked reviewed only on purpose.
    if (report.outcome !== 'complete' && input.acknowledgeUnfinished !== true) throw new SmurgError('conflict', msg('report.unfinished'), { reason: 'unfinished' });
    const now = this.ctx.clock.now();
    const insteadOf: UserRef | undefined = isReviewer ? undefined : report.reviewers[0];
    const previous = this.core.summaryOf(report);
    const { escalatedAt: _escalated, ...rest } = report;
    this.core.putReport({ ...rest, state: 'reviewed', review: { by, at: now, version: report.version, ...(insteadOf === undefined ? {} : { insteadOf }) } });
    this.core.setItemState(topic.id, item.id, 'reviewed');
    // Reviewing is not merging, but it must not strand the work: the reviewed draft is in the host's inbox by itself.
    const worktrees = this.ctx.services.worktrees;
    if (report.changes !== undefined && !isStubService(worktrees)) {
      try {
        worktrees.setReviewed(report.changes.requestId, true);
      } catch (err) {
        this.ctx.log.warn('draft not marked reviewed', { request: report.changes.requestId, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    this.ctx.audit.record({ actor: principal.actor, action: 'report.review', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, version: report.version, ...(insteadOf === undefined ? {} : { insteadOf: insteadOf.userId }), ...(report.outcome === 'complete' ? {} : { acknowledgedUnfinished: true }) } });
    this.core.publishReport(topic.id, item.id, previous);
    // The review stands whatever the finishing does (the module's sweep asks again for an item that could not be finished).
    await this.scheduler.finishIfDone(topic.id, item.id).catch((err: unknown) => {
      this.ctx.log.error('item not finished', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
    });
    const after = this.core.report(topic.id, item.id);
    return this.core.summaryOf(after ?? report);
  }

  // ===================================================================================================================
  // Reviewers and escalation
  // ===================================================================================================================

  /** Who may review follows who is responsible and who is a member: kept current, announced when it changed. */
  refreshReviewers(): void {
    if (!this.core.started) return;
    for (const report of this.core.reports()) {
      const topic = this.core.topic(report.topicId);
      const item = topic === null ? null : this.core.item(topic, report.itemId);
      if (topic === null || item === null || topic.archived) continue;
      const reviewers = this.core.reviewersOf(topic, item);
      if (JSON.stringify(reviewers) === JSON.stringify(report.reviewers)) continue;
      const previous = this.core.summaryOf(report);
      this.core.putReport({ ...report, reviewers });
      this.core.publishReport(topic.id, item.id, previous);
    }
  }

  /**
   * A report that has waited for its review six times as long as a question may wait (30 minutes by default) is ALSO
   * for the host and every member with agent access. Stored times compared with the clock, looked at again on a real
   * timer (`escalationSweepMs`): never one timer per report.
   */
  sweep(): void {
    if (!this.core.started) return;
    const now = this.ctx.clock.now();
    const after = this.ctx.settings.get().escalateAfterMs * this.ctx.config.agents.reportEscalationFactor;
    for (const report of this.core.reports()) {
      if ((report.state !== 'to-review' && report.state !== 'changed-after-review') || report.escalatedAt !== undefined || now - report.waitingSince < after) continue;
      const topic = this.core.topic(report.topicId);
      if (topic === null || topic.archived) continue;
      // A report of an item smurg merges by itself waits for nobody (DESIGN 0.7.0 D12): its review is a mark.
      const item = this.core.item(topic, report.itemId);
      if (item !== null && this.core.mergingOf(item) === 'auto') continue;
      const previous = this.core.summaryOf(report);
      this.core.putReport({ ...report, escalatedAt: now });
      this.core.publishReport(report.topicId, report.itemId, previous);
    }
    // A decision on a work item escalates too (DESIGN 0.7.0 D9), and a topic whose phase moved quietly is announced;
    // an item that stopped reaches more people once it has waited (attention.ts: the facts are compared with the clock).
    this.core.trackPresence();
    this.core.escalateHolds();
    this.core.escalateSuggestions();
    this.core.publishChangedPhases();
    this.core.publishAttention();
  }

  startSweep(): Disposable {
    this.stopSweep();
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        this.ctx.log.error('report escalation sweep failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
      // The merge queue: long waits become holds, and what is due is tried (DESIGN 0.7.0 D8).
      try {
        this.merger?.sweep();
      } catch (err) {
        this.ctx.log.error('merge queue sweep failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
      // An item that is merged and reviewed but could not be finished yet (its worktree held something unmerged).
      void this.scheduler.finishPending().catch((err: unknown) => this.ctx.log.error('finishing items failed', { error: err instanceof Error ? err.name : 'unknown' }));
      // smurg's own continues whose time has come (DESIGN 0.7.0 D15).
      try {
        this.scheduler.sweepContinues();
      } catch (err) {
        this.ctx.log.error('automatic continues not looked at', { error: err instanceof Error ? err.name : 'unknown' });
      }
      // The shared folder's `.git`, looked at again (file calls only while nothing changed): a repository the host made
      // while sharing counts without a restart, and the topics' `versioned` follows (0.5.2).
      const worktrees = this.ctx.services.worktrees;
      if (!isStubService(worktrees)) void worktrees.refreshGitState({ timer: true });
    }, this.ctx.config.agents.escalationSweepMs);
    this.sweepTimer.unref();
    return toDisposable(() => this.stopSweep());
  }

  stopSweep(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

/** A snapshot that failed because the checkout changed under it: a file changed while it was read, or staging stopped. */
function changedUnderIt(err: SmurgError): boolean {
  const reason = err.detail?.['reason'];
  return reason === 'worktree-changed' || (reason === 'git-failed' && err.detail?.['step'] === 'stage');
}

const checkKey = (sessionId: string, hash: string): string => `${sessionId}\u0000${hash}`;
const turnKey = (sessionId: string, turnId: string): string => `${sessionId}\u0000${turnId}`;

/** Where an item's report is read: its worktree, or the shared folder itself for an item that runs there (DESIGN 0.6.0 D15). */
function reportRootOf(item: StoredItem): RootRef | null {
  if (item.direct === true) return MAIN_ROOT;
  return item.worktreeId === undefined ? null : worktreeRoot(item.worktreeId);
}
