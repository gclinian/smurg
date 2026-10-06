// ReportService (ARCHITECTURE §5.10 "The result report"; design §4.5). A report is a file the agent writes in its
// worktree, `specs/<slug>/reports/<item id>.md`, so it is part of the item's change and reaches the main workspace
// with the merge. It COUNTS only when the agent's own `check_report` answered ok for exactly that content in this
// session (security S21): nobody can plant one. At the end of every completed turn of an execution session:
//
//   checked ok here, new or changed since the last version  → a new report VERSION: the worktree is snapshotted into a
//                                                              draft merge request, the reviewers' inbox gets it
//   checked ok, unchanged                                    → nothing
//   exists, but this content was not checked ok              → `fix-report`, once per content, at most twice in a row
//   missing                                                  → `nudge-report`, once
//   still nothing registered after those                     → the item is `stalled` (`agent`)
//
// A turn a person stopped, or that ended with an error, stalls at once. This file also keeps follow-ups (the answer is
// the final text of the turn that took the message), review marks, who the reviewers are, and the escalation of a
// report that waits too long.
import {
  CHECKED_HASHES_MAX,
} from './store.ts';
import {
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
import type { FileCheck, McpToolContext, Principal, ReportService, Req, TurnMessage } from '../core/interfaces.ts';
import { newId, type Disposable, toDisposable } from '../core/lifecycle.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { userRefOf, type FileContent, type TopicsCore } from './core.ts';
import { fixFileMessage, nudgeReportMessage } from './prompts.ts';
import { parseReport, type ParsedReport } from './report-format.ts';
import type { Scheduler, SchedulerReports } from './scheduler.ts';
import type { StoredItem, StoredReport, StoredTopic } from './store.ts';
import { wireLarge } from './text.ts';

/** What the model reads when it calls `check_report` from a session that is not a work item's. */
export const NOT_AN_ITEM = "This tool is for the session of a work item. This session is not one.";

interface TurnFinished {
  readonly sessionId: string;
  readonly outcome: TurnOutcome;
  readonly finalText?: string;
  readonly messages: readonly TurnMessage[];
  readonly edited: readonly { readonly file: FileRef; readonly seq: number }[];
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
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DaemonContext, core: TopicsCore, scheduler: Scheduler) {
    this.ctx = ctx;
    this.core = core;
    this.scheduler = scheduler;
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
    // The ok answer is what lets the daemon register exactly this content, for this session.
    const attempt = hit.item.attempt;
    this.core.updateItem(hit.topic.id, hit.item.id, (draft) => {
      const kept = draft.checked.filter((entry) => !(entry.sessionId === mcp.sessionId && entry.hash === content.hash));
      kept.push({ sessionId: mcp.sessionId, attempt, hash: content.hash });
      draft.checked = kept.slice(-CHECKED_HASHES_MAX);
    });
    return { ok: true };
  }

  // ===================================================================================================================
  // The end of a turn of an execution session
  // ===================================================================================================================

  onItemTurn(event: TurnFinished): Promise<void> {
    const hit = this.core.bySession(event.sessionId);
    if (hit === null || hit.item === null) return Promise.resolve();
    const topicId = hit.topic.id;
    const itemId = hit.item.id;
    return this.core.serialize(`report:${topicId}:${itemId}`, () => this.itemTurn(topicId, itemId, event));
  }

  private async itemTurn(topicId: string, itemId: string, event: TurnFinished): Promise<void> {
    let topic = this.core.topic(topicId);
    let item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || topic.archived || item.sessionId !== event.sessionId) return;
    // A turn a person asked for (a message, "Continue", a follow-up) may be nudged and fixed afresh.
    if (event.messages.some((message) => message.kind === 'person' || message.by !== undefined)) {
      this.core.updateItem(topicId, itemId, (draft) => {
        draft.nudged = false;
        delete draft.fix;
      });
    }
    this.answerFollowUps(topicId, itemId, event);
    topic = this.core.need(topicId);
    item = this.core.needItem(topic, itemId);
    const registered = this.core.report(topicId, itemId);

    if (event.outcome !== 'completed') {
      // Stopped by a person, or ended with an error: stalled at once, without a nudge.
      if (registered === null) this.stall(topic, item, event.outcome === 'interrupted' ? 'stopped' : 'error');
      else this.core.publish(topicId);
      return;
    }
    if (item.worktreeId === undefined) return;
    const path = topicReportPath(topic.slug, item.id);
    const file = await this.core.readFile(worktreeRoot(item.worktreeId), path);
    if (file === null) {
      if (registered !== null) return; // a version exists and its file is simply not there any more: nothing new
      if (!item.nudged) await this.nudge(topic, item);
      else this.stall(topic, item, 'agent');
      return;
    }
    const checkedHere = item.checked.some((entry) => entry.sessionId === event.sessionId && entry.hash === file.hash);
    if (checkedHere) {
      const parse = parseReport(file.text, item.id);
      // After `resolve-conflict` the worktree changed whatever the agent did (smurg merged the main workspace into
      // it): the snapshot is taken again, so the resolution is committed with its second parent.
      const resolved = event.messages.some((message) => message.purpose === 'resolve-conflict');
      const unchanged = registered !== null && registered.contentHash === file.hash && registered.sessionId === event.sessionId && event.edited.length === 0 && !resolved;
      if (parse.ok && !unchanged) {
        await this.register(topic, item, event.sessionId, file, parse.report);
        return;
      }
      if (parse.ok) {
        this.core.publish(topicId);
        return;
      }
    }
    if (registered !== null && registered.contentHash === file.hash) return; // the registered version, unchanged
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

  /** The session is idle without a registered report: the item needs someone ("Stopped without a report · Continue"). */
  private stall(topic: StoredTopic, item: StoredItem, by: NonNullable<StoredItem['stalledBy']>): void {
    this.core.setItemState(topic.id, item.id, 'stalled', by);
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

  /** A new report version: the draft merge request, the stored report, a `pointer` event, the reviewers' inbox. */
  private async register(topic: StoredTopic, item: StoredItem, sessionId: string, file: FileContent, parsed: ParsedReport): Promise<void> {
    const agents = this.ctx.services.agents;
    const worktrees = this.ctx.services.worktrees;
    const root: RootRef = worktreeRoot(item.worktreeId as string);
    let changes: ReportInfo['changes'];
    let noChanges: ReportInfo['noChanges'];
    if (!isStubService(worktrees)) {
      try {
        // The snapshot IS the report's diff: a draft merge request the reviewer reads and the host can merge.
        const snapshot = await worktrees.snapshot({ worktreeId: item.worktreeId as string, message: `smurg: work item ${item.number} (${item.id})`, topicSlug: topic.slug });
        if (snapshot.ok) {
          changes = {
            requestId: snapshot.request.id,
            files: snapshot.files,
            additions: snapshot.additions,
            deletions: snapshot.deletions,
            byHand: snapshot.byHand.slice(0, REPORT_BY_HAND_MAX).map((entry) => ({ path: entry.path, by: entry.by.slice(0, 20).map((user) => ({ ...user })) })),
          };
        } else {
          // A refused snapshot still registers the report; people are told in the session why there is no diff.
          noChanges = snapshot.reason;
          const why =
            snapshot.reason === 'host-only-paths'
              ? msg('report.changes.hostOnly')
              : snapshot.reason === 'spec-files'
                ? msg('report.changes.specFiles')
                : msg('report.changes.markers', { files: snapshot.files.slice(0, 5).map((path) => path.slice(0, 200)) });
          agents.append(sessionId, noticeEvent('warning', why));
        }
      } catch (err) {
        this.ctx.log.error('snapshot failed', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    const previous = this.core.report(topic.id, item.id);
    const now = this.ctx.clock.now();
    const version = (previous?.version ?? 0) + 1;
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
      if (changes !== undefined) draft.merge = { requestId: changes.requestId, status: 'draft', ready: false };
    });
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
  }

  /** After a restart: a session that was mid-turn may have left a report it had checked; it is registered right then. */
  async checkAfterRestart(topicId: string, itemId: string): Promise<boolean> {
    return this.core.serialize(`report:${topicId}:${itemId}`, async () => {
      const topic = this.core.topic(topicId);
      const item = topic === null ? null : this.core.item(topic, itemId);
      if (topic === null || item === null || item.sessionId === undefined || item.worktreeId === undefined) return false;
      const sessionId = item.sessionId;
      const file = await this.core.readFile(worktreeRoot(item.worktreeId), topicReportPath(topic.slug, item.id));
      if (file === null || !item.checked.some((entry) => entry.sessionId === sessionId && entry.hash === file.hash)) return false;
      const registered = this.core.report(topicId, itemId);
      if (registered !== null && registered.contentHash === file.hash) return true;
      const parse = parseReport(file.text, item.id);
      if (!parse.ok) return false;
      await this.register(topic, item, sessionId, file, parse.report);
      return true;
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
    // Merged and reviewed: the item is finished and its session has ended (the sentence points to the discussion).
    if (item.merged && report.state === 'reviewed') throw new SmurgError('conflict', msg('report.closed'), { reason: 'closed' });
    const agents = this.ctx.services.agents;
    const session = item.sessionId === undefined || isStubService(agents) ? null : agents.get(item.sessionId);
    if (session === null || session.status === 'ended') throw new SmurgError('conflict', msg('plan.item.noSession'), { reason: 'no-session' });
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
    await this.scheduler.finishIfDone(topic.id, item.id);
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
      const previous = this.core.summaryOf(report);
      this.core.putReport({ ...report, escalatedAt: now });
      this.core.publishReport(report.topicId, report.itemId, previous);
    }
  }

  startSweep(): Disposable {
    this.stopSweep();
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        this.ctx.log.error('report escalation sweep failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }, this.ctx.config.agents.escalationSweepMs);
    this.sweepTimer.unref();
    return toDisposable(() => this.stopSweep());
  }

  stopSweep(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
