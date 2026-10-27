// PlanService (ARCHITECTURE §5.10): the plan of a topic. PLAN.md defines the work items (ids, order, dependencies);
// who is responsible, what is armed and what runs is daemon state keyed by item id, so people can edit the file
// freely. This file holds the requests around it: "Generate plan" (and the agent's own check of its file through the
// MCP tools `check_plan` / `propose_split`), who is responsible, the Start dialog (`plan.preflight`) and Start with
// its pins, "Show the changes", "Continue all", and the three things a person can do to one item (try again,
// continue, resolve a conflict). The scheduler (scheduler.ts) starts what a Start armed.
//
// 0.7.0 (DESIGN D3): a Start records in each pin how its items reach the main workspace (`merging`: smurg merges an
// item that is in order while the workspace's setting says so too, or the host merges each) and, with the folder's
// own git, the branch it committed on (smurg merges only into it). A member may choose the host's merge for a Start;
// nobody can choose smurg's while the workspace says the host merges; a Start on a detached HEAD is the host's.
//
// 0.7.0 (DESIGN D9, D10, D11): what a person decides about one work item: "Leave it out" (it and what depends on it,
// without editing PLAN.md), "Merge it as it is" (a version that stands although somebody wrote to its agent since, a
// later turn was stopped, or its report was not checked again), the host's "Accept as it is" (an item that ran in the
// folder) and "Ask the agent to take them out" (files only the host may merge).
//
// 0.7.0 (DESIGN D14): the host's undo. What it would do is computed by the worktree module (the merges, the trial,
// what is in the way) and here (what is built on the items, what waits for them, what of it is in a turn; the token
// over what the undo does). The apply claims its items inside the worktree module's queue, so nothing of them merges
// between the undo commit and the record here; then every undone item is not merged and not started, its session
// ended and its worktree released, and what waits for them is left out.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAIN_ROOT,
  PLAN_CHANGES_DIFF_MAX_BYTES,
  UNDO_ITEMS_MAX,
  UNDO_PATHS_MAX,
  RELEASABLE_HOLDS,
  PREFLIGHT_ALSO_IN_FOLDER_MAX,
  PREFLIGHT_BLOCKERS_MAX,
  PREFLIGHT_EDITING_NOW_MAX,
  SPLIT_REASON_MAX_CHARS,
  SmurgError,
  shortBranchSchema,
  agentDisplayName,
  agentSafeName,
  can,
  effectivePermissionMode,
  entryPathSchema,
  hasInvisibleCharacters,
  isHiddenTempName,
  lineEvent,
  mask,
  topicDirPath,
  topicFileKind,
  topicPlanPath,
  topicSpecPath,
  wireText,
  type Actor,
  type FileRef,
  type MergeRequest,
  type PlanInfo,
  type SessionModeChoice,
  type StartPreflight,
  type TurnOutcome,
  type UndoItemRef,
  type UndoPreview,
  type UserRef,
  type WireText,
  type WorkItem,
} from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { FileCheck, McpToolContext, PlanService, PlansAtStart, Principal, Req, Res, StartFolderFacts, TurnMessage, UndoAsk, UndoFacts, UndoItem, UndoItemKey, WorktreeManager } from '../core/interfaces.ts';
import { SYSTEM_ACTOR, SYSTEM_PRINCIPAL, isHostPrincipal } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { checkpointCommit } from './checkpoint.ts';
import { requireModelOffered } from '../sessions/model-offered.ts';
import type { AutoMerger } from './auto-merge.ts';
import { applyTopicAgent, isDirect, isStarted, itemKey, userRefOf, type TopicsCore } from './core.ts';
import type { PlanParse } from './plan-format.ts';
import { fixFileMessage, generatePlanMessage, removePathsMessage, resolveConflictMessage, updatePlanMessage } from './prompts.ts';
import type { Scheduler, SchedulerReports } from './scheduler.ts';
import { checkProposal } from './split.ts';
import type { Pin, StoredItem, StoredTopic } from './store.ts';
import type { TopicServiceImpl } from './topic-service.ts';
import { EMPTY_HASH, sha256Hex, wireMultiline } from './text.ts';

type MainState = Awaited<ReturnType<WorktreeManager['mainState']>>;

/** What the model reads when it calls a plan tool from a session that is not a topic's discussion. */
export const NOT_A_DISCUSSION = "This tool is for the discussion session of a topic. This session is not one.";

const OPEN_QUESTIONS_HEADING = /^#{1,6}[ \t]+open questions/i;

/**
 * Whether a line is the "Open questions" heading: one to six hashes, blanks, the two words in any case, and after
 * them nothing but blanks, closing hashes and blanks. What follows the words is read in one pass (as one expression,
 * three runs that may all be empty tried every split of a run of blanks: the square of its length).
 */
function isOpenQuestionsHeading(line: string): boolean {
  const head = OPEN_QUESTIONS_HEADING.exec(line);
  if (head === null) return false;
  let at = head[0].length;
  while (line[at] === ' ' || line[at] === '\t') at += 1;
  while (line[at] === '#') at += 1;
  while (line[at] === ' ' || line[at] === '\t') at += 1;
  return at === line.length;
}

/** How many entries the spec lists under its "Open questions" heading (the Start dialog says so). */
export function countOpenQuestions(spec: string): number {
  const lines = spec.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex(isOpenQuestionsHeading);
  if (start === -1) return 0;
  let bullets = 0;
  let prose = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}[ \t]/.test(line)) break;
    const text = line.trim();
    if (text.length === 0) continue;
    if (/^(?:[-*+]|\d+[.)])[ \t]+\S/.test(text)) {
      if (!/^(?:[-*+]|\d+[.)])[ \t]+(?:none|nothing|n\/a)\.?$/i.test(text)) bullets += 1;
    } else if (!/^(?:none|nothing|n\/a)\.?$/i.test(text)) prose += 1;
  }
  return bullets > 0 ? bullets : prose > 0 ? 1 : 0;
}

export class PlanServiceImpl implements PlanService {
  private readonly ctx: DaemonContext;
  private readonly core: TopicsCore;
  private readonly topics: TopicServiceImpl;
  private readonly scheduler: Scheduler;
  private reports: SchedulerReports | null = null;
  private merger: AutoMerger | null = null;
  /** What `prepareCheck` read for a discussion session's next `check_plan` (the contract's method is synchronous). */
  private readonly prepared = new Map<string, PlanParse | null>();

  constructor(ctx: DaemonContext, core: TopicsCore, topics: TopicServiceImpl, scheduler: Scheduler) {
    this.ctx = ctx;
    this.core = core;
    this.topics = topics;
    this.scheduler = scheduler;
  }

  attach(reports: SchedulerReports): void {
    this.reports = reports;
  }

  /** The merge queue (DESIGN 0.7.0 D8): a Start and "Continue all" give it work. */
  attachMerger(merger: AutoMerger): void {
    this.merger = merger;
  }

  /**
   * Resolves when what this module does in the background has come to rest: the reading of a topic's files and the
   * end of a turn that are under way, one whole scheduler pass, and the finishing of merged and reviewed items. The
   * module's tests call it before they assert that something did NOT happen, instead of waiting a fixed time.
   */
  async settle(): Promise<void> {
    await this.core.idle();
    await this.scheduler.runNow();
    await this.merger?.runNow();
    await this.scheduler.finishPending();
    await this.core.idle();
  }

  // ===================================================================================================================
  // Reading
  // ===================================================================================================================

  get(topicId: string): PlanInfo | null {
    const topic = this.core.topic(topicId);
    return topic === null ? null : this.core.toPlan(topic);
  }

  itemBySession(sessionId: string): { readonly topicId: string; readonly item: WorkItem } | null {
    const hit = this.core.bySession(sessionId);
    if (hit === null || hit.item === null) return null;
    return { topicId: hit.topic.id, item: this.core.toWorkItem(hit.topic, hit.item) };
  }

  private needPlan(topicId: string): PlanInfo {
    const plan = this.get(topicId);
    if (plan === null) throw new SmurgError('not_found', msg('plan.none'), { reason: 'no-plan' });
    return plan;
  }

  // ===================================================================================================================
  // Generate
  // ===================================================================================================================

  async generate(input: Req<'plan.generate'>, principal: Principal): Promise<void> {
    const by = userRefOf(principal);
    this.core.needOpen(input.topicId);
    await this.core.refreshFiles(input.topicId);
    const topic = this.core.needOpen(input.topicId);
    if (!topic.spec.exists) throw new SmurgError('conflict', msg('topic.noSpec'), { reason: 'no-spec' });
    const sessionId = this.topics.discussionOf(topic);
    // The agent knows the items, the daemon knows the people: it is told who can be responsible right now.
    const people = this.core.peoplePresent();
    const refs = people.flatMap((person) => {
      const ref = this.ctx.members.userRef(person.userId);
      return ref === null ? [] : [ref];
    });
    const update = topic.plan.exists;
    const startedIds = topic.items.filter((item) => item.number > 0 && isStarted(item)).map((item) => item.id);
    const agents = this.ctx.services.agents;
    agents.append(sessionId, lineEvent(update ? msg('conversation.planUpdateRequested', { name: by.displayName }) : msg('conversation.planRequested', { name: by.displayName })));
    const text = update ? updatePlanMessage({ slug: topic.slug, people: refs, startedIds }) : generatePlanMessage({ slug: topic.slug, people: refs });
    const sent = await agents.send(sessionId, { kind: 'smurg', purpose: update ? 'update-plan' : 'generate-plan', text, by });
    this.core.generating.set(topic.id, sent.messageId);
    this.core.update(topic.id, (draft) => {
      draft.plan.people = people;
      delete draft.plan.fix;
    });
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.generate', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, sessionId, messageId: sent.messageId, update, people: people.map((person) => person.userId) } });
    this.core.publish(topic.id);
  }

  /**
   * A turn of a topic's discussion ended: its files are read again. A spec the agent changed gets a `pointer` event
   * and `lastAgentChange` (the edit's tool card, and who asked); a plan that the agent wrote in this turn and that
   * does not pass gets `fix-plan`, once per file content and at most twice in a row (then people see the error with
   * "Ask the agent to fix it"). When PEOPLE break the file nothing is sent to the agent.
   */
  async onDiscussionTurn(event: { readonly sessionId: string; readonly outcome: TurnOutcome; readonly messages: readonly TurnMessage[]; readonly edited: readonly { readonly file: FileRef; readonly seq: number }[] }): Promise<void> {
    const hit = this.core.bySession(event.sessionId);
    if (hit === null || hit.item !== null || hit.topic.archived || hit.topic.discussionSessionId !== event.sessionId) return;
    const topicId = hit.topic.id;
    const slug = hit.topic.slug;
    const agents = this.ctx.services.agents;
    const editsOf = (kind: 'spec' | 'plan'): { readonly file: FileRef; readonly seq: number }[] => event.edited.filter((edit) => edit.file.root.kind === 'main' && topicFileKind(edit.file.path, slug) === kind);
    const specEdits = editsOf('spec');
    const planEdits = editsOf('plan');
    // The agent's own edits are the agent's, also when no activity entry said so yet.
    const agent = this.agentActor(event.sessionId, hit.topic);
    if (specEdits.length > 0) this.core.noteWriter(topicId, 'spec', agent);
    if (planEdits.length > 0) this.core.noteWriter(topicId, 'plan', agent);
    const generateMessage = this.core.generating.get(topicId);
    const generateTurn = generateMessage !== undefined && event.messages.some((message) => message.messageId === generateMessage);

    const result = await this.core.refreshFiles(topicId);
    // "Claude is writing the plan…" ends with the turn that took the request, together with what that turn wrote.
    if (generateTurn && this.core.generating.get(topicId) === generateMessage) this.core.generating.delete(topicId);
    const topic = this.core.topic(topicId);
    if (result === null || topic === null) return;
    const now = this.ctx.clock.now();
    if (specEdits.length > 0) {
      const persons = event.messages.filter((message) => message.kind === 'person' && message.from !== undefined);
      const askedBy = persons.at(-1)?.from ?? [...event.messages].reverse().find((message) => message.by !== undefined)?.by;
      const seq = Math.max(...specEdits.map((edit) => edit.seq));
      this.core.update(topicId, (draft) => {
        draft.spec.lastAgentChange = { sessionId: event.sessionId, seq, at: now, ...(askedBy === undefined ? {} : { askedBy }) };
      });
    }
    // A file the agent's edit tool changed in this turn, and whose change nobody else is named for, is the agent's.
    if (specEdits.length > 0 || planEdits.length > 0) {
      this.core.update(topicId, (draft) => {
        if (specEdits.length > 0 && (draft.spec.changedBy === undefined || draft.spec.changedBy.kind === 'system')) draft.spec.changedBy = agent;
        if (planEdits.length > 0 && (draft.plan.changedBy === undefined || draft.plan.changedBy.kind === 'system')) draft.plan.changedBy = agent;
      });
    }
    try {
      if (topic.spec.exists && (specEdits.length > 0 || result.specChanged)) agents.append(event.sessionId, { kind: 'pointer', target: 'spec', topicId });
      if (topic.plan.valid && (planEdits.length > 0 || result.planChanged)) agents.append(event.sessionId, { kind: 'pointer', target: 'plan', topicId });
    } catch (err) {
      this.ctx.log.debug('pointer not written', { session: event.sessionId, error: err instanceof Error ? err.name : 'unknown' });
    }
    if (event.outcome === 'completed' && (generateTurn || planEdits.length > 0) && !topic.plan.valid) await this.maybeFixPlan(topic, event.sessionId, result.plan);
    this.core.publish(topicId);
  }

  private agentActor(sessionId: string, topic: StoredTopic): Actor {
    const sessions = this.ctx.services.sessions;
    const actor = isStubService(sessions) ? null : sessions.agentActor(sessionId);
    if (actor !== null) return actor;
    const agents = this.ctx.services.agents;
    const owner = (isStubService(agents) ? null : agents.facts(sessionId)?.ownerUserId) ?? topic.createdBy.userId;
    return { kind: 'agent', sessionId, ownerUserId: owner, displayName: agentDisplayName(agentSafeName(topic.name, owner)) };
  }

  private async maybeFixPlan(topic: StoredTopic, sessionId: string, parse: PlanParse | null): Promise<void> {
    const hash = topic.plan.exists ? topic.plan.hash : EMPTY_HASH;
    const previous = topic.plan.fix;
    if (previous !== undefined && previous.hash === hash) return; // once per file content
    const count = (previous?.count ?? 0) + 1;
    if (count > this.core.options.maxFixesInRow) return; // then the plan column shows the error to people
    const agents = this.ctx.services.agents;
    const findings = parse === null || parse.ok ? [] : parse.errors.map((error) => ({ sentence: error.model, ...(error.line === undefined ? {} : { line: error.line }) }));
    try {
      agents.append(sessionId, lineEvent(msg('conversation.fix.plan')));
      const sent = await agents.send(sessionId, { kind: 'smurg', purpose: 'fix-plan', text: fixFileMessage({ file: topicPlanPath(topic.slug), tool: 'check_plan', findings, missing: parse === null }) });
      // The agent is writing the plan again: the plan column keeps saying so until this turn ends.
      this.core.generating.set(topic.id, sent.messageId);
      this.core.update(topic.id, (draft) => {
        draft.plan.fix = { hash, count };
      });
    } catch (err) {
      this.ctx.log.warn('fix-plan not sent', { topic: topic.id, error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  // ===================================================================================================================
  // Who is responsible
  // ===================================================================================================================

  async setMode(input: Req<'plan.mode.set'>, principal: Principal): Promise<PlanInfo> {
    const topic = this.core.needOpen(input.topicId);
    this.needPlan(topic.id);
    if (topic.plan.mode !== input.mode) {
      const agents = this.ctx.services.agents;
      this.core.update(topic.id, (draft) => {
        draft.plan.mode = input.mode;
        if (input.mode !== 'everyone') return;
        // "No one assigned: everyone watches": every item's responsible person is nobody.
        for (const item of draft.items) {
          if (item.sessionId !== undefined) continue;
          item.responsible = null;
          item.chosen = false;
        }
        delete draft.plan.split;
      });
      if (input.mode === 'everyone' && !isStubService(agents)) {
        for (const item of topic.items) {
          if (item.sessionId === undefined) continue;
          const session = agents.get(item.sessionId);
          if (session !== null && session.status !== 'ended' && session.responsible !== null) agents.setResponsible(item.sessionId, null, principal.actor);
        }
      }
      if (input.mode === 'assigned') this.core.fillSplit(topic.id, this.core.peoplePresent());
      this.ctx.audit.record({ actor: principal.actor, action: 'plan.mode', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, mode: input.mode } });
      this.reports?.refreshReviewers();
      this.core.publish(topic.id);
    }
    return this.needPlan(topic.id);
  }

  async assign(input: Req<'plan.assign'>, principal: Principal): Promise<PlanInfo> {
    const topic = this.core.needOpen(input.topicId);
    this.needPlan(topic.id);
    const item = this.core.needItem(topic, input.itemId);
    let responsible: UserRef | null = null;
    if (input.userId !== null) {
      const member = this.ctx.members.active(input.userId);
      if (member === null) throw new SmurgError('not_found', msg('responsible.unknownMember'), { reason: 'unknown-member' });
      // Anyone who may discuss can be responsible: it routes things to their inbox and adds no capability.
      if (!can(member.role, 'discuss')) throw new SmurgError('bad_request', msg('responsible.notEligible', { name: member.displayName }), { reason: 'not-eligible' });
      responsible = { userId: member.userId, displayName: member.displayName };
    }
    // Before the item has a session the plan holds the fact; afterwards the session does.
    const agents = this.ctx.services.agents;
    if (item.sessionId !== undefined && !isStubService(agents)) {
      const session = agents.get(item.sessionId);
      if (session !== null && session.status !== 'ended') agents.setResponsible(item.sessionId, responsible, principal.actor);
    }
    this.core.update(topic.id, (draft) => {
      const target = draft.items.find((candidate) => candidate.id === item.id);
      if (target === undefined) return;
      target.responsible = responsible === null ? null : { ...responsible, source: 'chosen' };
      target.chosen = true;
      if (responsible !== null) draft.plan.mode = 'assigned';
    });
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.assign', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, userId: input.userId } });
    this.reports?.refreshReviewers();
    this.core.publish(topic.id);
    return this.needPlan(topic.id);
  }

  /** "Suggest again": smurg's even split over the people with agent access who are present now. */
  async suggest(input: Req<'plan.suggest'>, principal: Principal): Promise<PlanInfo> {
    const topic = this.core.needOpen(input.topicId);
    this.needPlan(topic.id);
    const people = this.core.peoplePresent();
    this.core.update(topic.id, (draft) => {
      draft.plan.mode = 'assigned';
    });
    const filled = this.core.fillSplit(topic.id, people, { redo: 'suggested' });
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.assign', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, suggested: true, items: filled, people: people.map((person) => person.userId) } });
    this.reports?.refreshReviewers();
    this.core.publish(topic.id);
    return this.needPlan(topic.id);
  }

  // ===================================================================================================================
  // The Start dialog and Start
  // ===================================================================================================================

  /** The items a Start is about: the named ones, or every item of the plan that is not started. */
  private targetsOf(topic: StoredTopic, itemIds: readonly string[] | undefined): StoredItem[] {
    const startable = (item: StoredItem): boolean => item.number > 0 && item.state === 'not-started' && !item.armed;
    if (itemIds === undefined) return topic.items.filter(startable).sort((a, b) => a.number - b.number);
    const out: StoredItem[] = [];
    for (const id of new Set(itemIds)) {
      const item = this.core.item(topic, id);
      if (item === null || item.number === 0) throw new SmurgError('not_found', msg('plan.item.unknown'), { reason: 'unknown-item' });
      if (!startable(item)) throw new SmurgError('conflict', msg('plan.item.started'), { reason: 'already-started' });
      out.push(item);
    }
    return out.sort((a, b) => a.number - b.number);
  }

  private async mainState(): Promise<MainState | null> {
    const worktrees = this.ctx.services.worktrees;
    if (isStubService(worktrees)) return null;
    try {
      const main = await worktrees.mainState();
      // (A change the worktree module saw is announced through `workspace.git` already; this keeps the two in step.)
      this.core.setVersioned(main.isRepo);
      return main;
    } catch (err) {
      this.ctx.log.warn('main workspace state unavailable', { error: err instanceof Error ? err.name : 'unknown' });
      return null;
    }
  }

  /**
   * What stops a Start right now, each as a sentence for people. `folderProblem`: what the Start dialog found about
   * smurg's own history (too large, unknown, changed, gone).
   */
  private blockersOf(topic: StoredTopic, targets: readonly StoredItem[], main: MainState | null, folderProblem: MessageRef | null = null): MessageRef[] {
    const blockers: MessageRef[] = [];
    if (!topic.spec.exists) blockers.push(msg('topic.noSpec'));
    if (!topic.plan.exists || !topic.plan.valid || !topic.plan.parsed) blockers.push(msg('plan.start.invalid'));
    // Execution needs a history: items run in worktrees of the folder's own repository or of smurg's own history,
    // their changes are reviewed and merged. One message per reason (the first that holds), saying what the host can do
    // and whether sharing has to be restarted. Without the git program items run directly in the folder (DESIGN 0.6.0
    // D15): that is no blocker (the dialog says what it means and the host confirms it).
    if (main === null) blockers.push(msg('worktree.unavailable.checkFailed'));
    else if (main.history === 'direct') {
      // nothing in the way as far as git goes
    } else if (main.history === 'smurg') {
      if (main.unavailable !== null || folderProblem !== null) blockers.push(main.unavailable ?? (folderProblem as MessageRef));
      else if (main.busy) blockers.push(msg('plan.start.commit.busy'));
      else this.worktreeLimit(blockers, topic, targets, main);
    } else if (main.unavailable !== null || !main.isRepo || !main.hasCommit || !main.gitOk) blockers.push(main.unavailable ?? msg('worktree.unavailable.checkFailed'));
    else if (main.busy) blockers.push(msg('plan.start.commit.busy'));
    else this.worktreeLimit(blockers, topic, targets, main);
    if (topic.plan.paused) blockers.push(msg('plan.paused'));
    if (targets.length === 0) blockers.push(msg('plan.start.nothing'));
    return blockers.slice(0, PREFLIGHT_BLOCKERS_MAX);
  }

  /** The items that start now need a worktree each (an item that has one already does not). */
  private worktreeLimit(blockers: MessageRef[], topic: StoredTopic, targets: readonly StoredItem[], main: MainState): void {
    const startsNow = targets.filter((item) => this.core.unmergedDependencies(topic, item).length === 0 && item.worktreeId === undefined).length;
    const worktrees = this.ctx.services.worktrees;
    if (startsNow > main.free) blockers.push(msg('plan.start.worktreeLimit', { max: main.free + (isStubService(worktrees) ? 0 : worktrees.list().length) }));
  }

  /** Files of the topic's folder other than the two that are committed (the dialog says they are NOT committed). */
  private async alsoInFolder(slug: string): Promise<string[]> {
    const out: string[] = [];
    try {
      const dir = await this.ctx.paths.resolve({ root: MAIN_ROOT, path: topicDirPath(slug) }, { principal: SYSTEM_PRINCIPAL, mustExist: true, audit: false });
      const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
        const entries = await readdir(absolute, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (out.length >= PREFLIGHT_ALSO_IN_FOLDER_MAX) return;
          const path = `${relative}/${entry.name}`;
          if (isHiddenTempName(entry.name) || topicFileKind(path, slug) !== null) continue;
          if (entry.isDirectory()) {
            if (depth < 3) await walk(join(absolute, entry.name), path, depth + 1);
          } else if (entryPathSchema.safeParse(path).success) out.push(path);
        }
      };
      await walk(dir.realPath, topicDirPath(slug), 0);
    } catch {
      // no folder, or not listable: nothing else is named
    }
    return out;
  }

  async preflight(input: Req<'plan.preflight'>, principal: Principal): Promise<StartPreflight> {
    const caller = userRefOf(principal);
    this.core.needOpen(input.topicId);
    await this.core.refreshFiles(input.topicId);
    const topic = this.core.needOpen(input.topicId);
    const specPath = topicSpecPath(topic.slug);
    const planPath = topicPlanPath(topic.slug);
    const targets = this.targetsOf(topic, input.itemIds);
    const main = await this.mainState();
    const [spec, plan] = await Promise.all([this.core.readFile(MAIN_ROOT, specPath), this.core.readFile(MAIN_ROOT, planPath)]);
    const worktrees = this.ctx.services.worktrees;
    // smurg's own history (DESIGN 0.6.0 D14): made when it is not there, the folder listed (the bound, nested
    // repositories) and, after this answer, warmed up.
    const folder = main?.history === 'smurg' && !isStubService(worktrees) ? await worktrees.prepareStart().catch(() => null) : null;
    // What Start would commit: only when worktree mode is available and the repository has a commit (a folder that is
    // no repository yet, a gitfile share or one without a commit has no branch to name; its blocker says why).
    let commit: StartPreflight['commit'] = null;
    if (main !== null && main.history === 'folder' && main.unavailable === null && main.isRepo && main.hasCommit && main.gitOk) {
      const differs = await worktrees.diffMainPaths({ paths: [specPath, planPath], against: 'head', maxBytes: 1 }).catch(() => []);
      commit = { needed: differs.length > 0, branch: main.branch ?? '', as: caller, files: [specPath, planPath], alsoInFolder: await this.alsoInFolder(topic.slug) };
    }
    const online = this.ctx.hub.onlineUserIds();
    const conversation = this.ctx.services.conversation;
    const locks = this.ctx.services.locks;
    const editingNow = new Map<string, UserRef>();
    if (!isStubService(locks)) {
      for (const path of [specPath, planPath]) {
        try {
          for (const human of locks.whoIsEditing({ root: MAIN_ROOT, path }).humans) editingNow.set(human.userId, { userId: human.userId, displayName: human.displayName });
        } catch {
          // lock information is a courtesy of the dialog
        }
      }
    }
    const trust = this.ctx.services.projectTrust;
    const waits = targets.flatMap((item) => {
      const unmerged = this.core.unmergedDependencies(topic, item);
      return unmerged.length === 0 ? [] : [{ itemId: item.id, for: unmerged }];
    });
    const waiting = new Set(waits.map((entry) => entry.itemId));
    const responsibleOf = (item: StoredItem): UserRef | null => {
      const userId = this.core.responsibleOf(topic, item);
      return userId === null ? null : this.ctx.members.userRef(userId);
    };
    return {
      planRevision: topic.plan.revision,
      specHash: topic.spec.hash,
      planHash: topic.plan.hash,
      startsNow: targets.filter((item) => !waiting.has(item.id)).map((item) => item.id),
      waits,
      alreadyStarted: topic.items.filter((item) => item.number > 0 && isStarted(item)).map((item) => item.id),
      responsible: targets.map((item) => {
        const user = responsibleOf(item);
        return { itemId: item.id, user, online: user !== null && online.has(user.userId) };
      }),
      // With nobody assigned the member who starts a session decides its questions.
      youDecide: targets.filter((item) => {
        const user = responsibleOf(item);
        return user === null || user.userId === caller.userId;
      }).length,
      commit,
      handEdits: structuredClone(topic.handEdits),
      invisibleCharacters: [...(spec !== null && hasInvisibleCharacters(spec.text) ? (['spec'] as const) : []), ...(plan !== null && hasInvisibleCharacters(plan.text) ? (['plan'] as const) : [])],
      stale: this.core.toTopic(topic).plan.stale,
      openQuestion: topic.discussionSessionId !== undefined && !isStubService(conversation) && conversation.openQuestions().some((question) => question.sessionId === topic.discussionSessionId),
      specOpenQuestions: spec === null ? 0 : countOpenQuestions(spec.text),
      editingNow: [...editingNow.values()].slice(0, PREFLIGHT_EDITING_NOW_MAX),
      projectSettings: isStubService(trust) ? 'none' : trust.state(MAIN_ROOT),
      rules: topic.rules.map((rule) => ({ ...rule })),
      sharedDirs: [...this.ctx.settings.get().sharedDirs],
      blockers: this.blockersOf(topic, targets, main, folder?.problem ?? null).map((ref): WireText => wireText(ref)),
      ...this.startFacts(topic, principal, main, folder),
    };
  }

  /**
   * What protocol 5 adds to the Start dialog (DESIGN 0.6.0 D5, D3, D14, D15): how the items started now run (the folder's
   * own git, smurg's own history with its nested repositories and whether a cloud service syncs the folder, or directly
   * in the folder with why, and `hostOnly` for anyone but the host), and the topic's agent settings with the mode its
   * items would run with.
   */
  private startFacts(topic: StoredTopic, principal: Principal, main: MainState | null, folder: StartFolderFacts | null): Pick<StartPreflight, 'history' | 'direct' | 'agent' | 'nestedRepos' | 'cloudSynced' | 'merging'> {
    const history = main?.history ?? 'folder';
    // Why git cannot be used: the `worktree.unavailable.git*` sentence (MainState names it with history `direct`).
    const reason = history === 'direct' ? wireText(main?.unavailable ?? msg('worktree.unavailable.gitCannotRun')) : null;
    const choice = topic.agent?.permissionMode ?? null;
    return {
      history,
      direct: reason === null ? null : { reason, hostOnly: !isHostPrincipal(principal) },
      agent: {
        model: topic.agent?.model ?? null,
        permissionMode: choice,
        effective: effectivePermissionMode({ purpose: 'item', session: null, topic: choice, workspace: this.ctx.settings.get().permissionMode }),
      },
      nestedRepos: history === 'smurg' ? [...(folder?.nestedRepos ?? [])] : [],
      cloudSynced: history === 'smurg' && folder?.cloudSynced === true,
      merging: this.mergingFacts(topic, history, main),
    };
  }

  /**
   * How the items a Start starts now would reach the main workspace (protocol 6, DESIGN 0.7.0 D3): null without git
   * (nothing to merge); else the workspace's setting, whether the folder's own git is on no branch (a detached HEAD:
   * only the host merges), and what the dialog proposes: the host when the workspace says so, the HEAD is detached, or
   * the topic's last Start chose it.
   */
  private mergingFacts(topic: StoredTopic, history: StartPreflight['history'], main: MainState | null): StartPreflight['merging'] {
    if (history === 'direct') return null;
    const workspace = this.ctx.settings.get().merging;
    const detached = history === 'folder' && main !== null && main.isRepo && main.gitOk && main.hasCommit && main.branch === null;
    const proposed = workspace === 'host' || detached || topic.plan.lastPin?.merging === 'host' ? 'host' : 'auto';
    return { workspace, proposed, detached };
  }

  /**
   * Start PINS what was confirmed (security S3): the request carries the plan revision and the two file hashes the
   * dialog showed; when the files differ by now it is refused and the dialog reloads. Inside the request the daemon
   * makes the checkpoint commit, stores the pin for the items it arms and clears the hand edits. Then the scheduler
   * starts those that can start.
   */
  async start(input: Req<'plan.start'>, principal: Principal): Promise<PlanInfo> {
    const caller = userRefOf(principal);
    this.core.needOpen(input.topicId);
    // [model-offered] with the other checks: a model the Start sets for the topic is one of the host agent's list.
    requireModelOffered(this.ctx, input.agent?.model);
    const changed = (): SmurgError => new SmurgError('conflict', msg('plan.start.changed'), { reason: 'plan-changed' });
    let modeBefore: SessionModeChoice | null = null;
    await this.core.serialize(`start:${input.topicId}`, async () => {
      await this.core.refreshFiles(input.topicId);
      const topic = this.core.needOpen(input.topicId);
      if (!topic.plan.parsed || input.planRevision !== topic.plan.revision || input.specHash !== topic.spec.hash || input.planHash !== topic.plan.hash) throw changed();
      const targets = this.targetsOf(topic, input.itemIds);
      const main = await this.mainState();
      // Without the git program the items change the shared folder directly (DESIGN 0.6.0 D15): only the host starts
      // them, and only after confirming it in the dialog; a dialog that showed another history is stale.
      const direct = main?.history === 'direct';
      if (direct && !isHostPrincipal(principal)) throw new SmurgError('forbidden', msg('plan.start.directHostOnly'), { reason: 'direct-host-only' });
      if (direct && input.direct !== true) throw new SmurgError('conflict', msg('plan.start.directUnconfirmed'), { reason: 'direct-unconfirmed' });
      if (!direct && input.direct === true) throw new SmurgError('conflict', msg('plan.start.historyChanged'), { reason: 'history-changed' });
      const blocker = this.blockersOf(topic, targets, main)[0];
      if (blocker !== undefined) throw new SmurgError('conflict', blocker, { reason: 'blocked' });

      // No checkpoint in direct mode: the items run in the folder itself, and the pin is of its two files only.
      const specPath = topicSpecPath(topic.slug);
      const planPath = topicPlanPath(topic.slug);
      const checkpoint = direct ? null : await checkpointCommit(this.ctx, topic, principal);
      // What is at HEAD now must be exactly what was confirmed: the files as they are, hashing as the dialog showed.
      const [spec, plan, differs] = await Promise.all([
        this.core.readFile(MAIN_ROOT, specPath),
        this.core.readFile(MAIN_ROOT, planPath),
        checkpoint === null ? [] : this.ctx.services.worktrees.diffMainPaths({ paths: [specPath, planPath], against: { [specPath]: checkpoint.specBlob, [planPath]: checkpoint.planBlob }, maxBytes: 1 }).catch(() => []),
      ]);
      if ((spec?.hash ?? EMPTY_HASH) !== input.specHash || (plan?.hash ?? EMPTY_HASH) !== input.planHash || differs.length > 0) throw changed();

      const now = this.ctx.clock.now();
      const pinned = { by: caller, at: now, planRevision: input.planRevision, specHash: input.specHash, planHash: input.planHash };
      // How its items are merged (DESIGN 0.7.0 D3): smurg's merge only while the workspace says so, the Start did not
      // ask for the host's, and (the folder's own git) the checkpoint is on a branch, which the pin records: smurg
      // merges only into it. A detached HEAD (the checkpoint's branch reads `HEAD`) has no branch to guard: the host's.
      const branch = checkpoint !== null && checkpoint.history === 'folder' && main?.branch !== null && checkpoint.branch !== 'HEAD' && shortBranchSchema.safeParse(checkpoint.branch).success ? checkpoint.branch : null;
      const merging: 'auto' | 'host' | null =
        checkpoint === null ? null : this.ctx.settings.get().merging === 'auto' && input.merging !== 'host' && (checkpoint.history === 'smurg' || branch !== null) ? 'auto' : 'host';
      const pin: Pin =
        checkpoint === null
          ? { ...pinned, commit: null, specBlob: null, planBlob: null, history: 'direct' }
          : {
              ...pinned,
              commit: checkpoint.commit,
              specBlob: checkpoint.specBlob,
              planBlob: checkpoint.planBlob,
              ...(checkpoint.history === 'smurg' ? { history: 'smurg' as const } : {}),
              ...(merging === null ? {} : { merging }),
              ...(branch === null ? {} : { branch }),
            };
      const armed = new Set(targets.map((item) => item.id));
      modeBefore = topic.agent?.permissionMode ?? null;
      // The topic's agent settings the dialog showed change in the SAME update that arms the items, after the
      // checkpoint commit succeeded: a Start refused anywhere leaves them as they were (DESIGN 0.6.0 D3).
      this.core.update(topic.id, (draft) => {
        if (input.agent !== undefined) {
          draft.agent = applyTopicAgent(draft.agent, input.agent, caller);
          if (Object.keys(draft.agent).length === 0) delete draft.agent;
        }
        draft.handEdits = { spec: [], plan: [] };
        draft.plan.lastPin = pin;
        // The plan has new work: its result is not checked any more (DESIGN 0.7.0 D13).
        delete draft.checked;
        for (const item of draft.items) {
          if (!armed.has(item.id)) continue;
          item.armed = true;
          item.retry = false;
          item.startedBy = caller;
          item.pin = pin;
          item.state = this.core.unmergedDependencies(draft, item).length === 0 ? 'queued' : 'waiting';
          item.since = now;
          delete item.disarmed;
          delete item.startError;
          // A Start again begins the merge queue's account of the item afresh (DESIGN 0.7.0 D8), and takes it back in (D11).
          delete item.autoMerge;
          delete item.mergeTries;
          delete item.lastTurn;
          delete item.leftOut;
          // An undone item starts again from the main workspace as it is now (DESIGN 0.7.0 D14: a fresh worktree).
          delete item.undone;
        }
      });
      for (const itemId of armed) {
        this.core.refused.delete(itemKey(topic.id, itemId));
        this.merger?.forget(topic.id, itemId);
      }
      this.ctx.audit.record({
        actor: principal.actor,
        action: 'plan.start',
        outcome: 'ok',
        target: topic.id,
        detail: {
          topicId: topic.id,
          itemIds: [...armed],
          planRevision: input.planRevision,
          specHash: input.specHash,
          planHash: input.planHash,
          commit: checkpoint?.commit ?? null,
          committed: checkpoint?.created ?? false,
          history: pin.history ?? 'folder',
          ...(pin.merging === undefined ? {} : { merging: pin.merging }),
          ...(pin.branch === undefined ? {} : { branch: pin.branch }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
        },
      });
      this.core.publish(topic.id);
    });
    const agents = this.ctx.services.agents;
    if (input.agent?.permissionMode !== undefined && !isStubService(agents)) await agents.topicAgentChanged(input.topicId, modeBefore, principal.actor);
    await this.scheduler.runNow();
    return this.needPlan(input.topicId);
  }

  async changes(input: Req<'plan.changes'>, _principal: Principal): Promise<Res<'plan.changes'>> {
    const topic = this.core.needOpen(input.topicId);
    const worktrees = this.ctx.services.worktrees;
    if (isStubService(worktrees)) return { files: [] };
    const specPath = topicSpecPath(topic.slug);
    const planPath = topicPlanPath(topic.slug);
    // The two files as they are now against what the last Start pinned, or against HEAD before the first Start.
    const pin = topic.plan.lastPin;
    const against = pin === undefined ? ('head' as const) : { [specPath]: pin.specBlob, [planPath]: pin.planBlob };
    const diffs = await worktrees.diffMainPaths({ paths: [specPath, planPath], against, maxBytes: PLAN_CHANGES_DIFF_MAX_BYTES });
    return {
      files: diffs.flatMap((entry) => {
        const target = topicFileKind(entry.path, topic.slug);
        return target === null ? [] : [{ target, diff: entry.diff, truncated: entry.truncated }];
      }),
    };
  }

  /**
   * "Continue all": clears the pause (a person's, or smurg's after a restart left an item that runs directly in the
   * folder interrupted) and tells the interrupted sessions to go on.
   */
  async resume(input: Req<'plan.resume'>, principal: Principal): Promise<PlanInfo> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    this.needPlan(topic.id);
    const interrupted = topic.items.filter((item) => item.state === 'stalled' && item.stalledBy === 'restart' && item.sessionId !== undefined);
    this.core.update(topic.id, (draft) => {
      draft.plan.paused = false;
      delete draft.plan.pausedAt;
      delete draft.plan.pausedBy;
    });
    const continued: string[] = [];
    for (const item of interrupted) {
      try {
        if (await this.scheduler.sendContinue(topic.id, item.id, { by })) continued.push(item.id);
      } catch (err) {
        this.ctx.log.warn('item not continued', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.resume', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemIds: continued } });
    this.core.publish(topic.id);
    // Items whose agent was bringing their work up to date when smurg stopped go on too (DESIGN 0.7.0 D8).
    await this.merger?.takeUp(topic.id);
    this.merger?.request();
    await this.scheduler.runNow();
    return this.needPlan(topic.id);
  }

  /**
   * "Pause" (DESIGN 0.7.0 D15): the brake that survives a restart. Nothing of the plan starts, merges or continues by
   * itself until someone presses "Continue all"; turns that run finish, and so does a merge already inside `git merge`
   * (whoever wants the turns to stop stops the sessions). The plan names who paused it. A plan a person paused already
   * is answered as it is; one smurg paused (an interrupted item in the folder) becomes this person's pause.
   */
  async pause(input: Req<'plan.pause'>, principal: Principal): Promise<PlanInfo> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    this.needPlan(topic.id);
    if (topic.plan.paused && topic.plan.pausedBy !== undefined) return this.needPlan(topic.id);
    const was = topic.plan.paused;
    this.core.update(topic.id, (draft) => {
      draft.plan.paused = true;
      draft.plan.pausedAt = this.ctx.clock.now();
      draft.plan.pausedBy = { userId: by.userId, displayName: by.displayName };
    });
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.pause', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, ...(was ? { wasPaused: true } : {}) } });
    this.core.publish(topic.id);
    // The merge queue looks again: what was in order waits now (D6 row 3).
    this.merger?.request();
    return this.needPlan(topic.id);
  }

  /** What this start found that goes on by itself, and the topics a person paused (DESIGN 0.7.0 D15, D18). */
  atStart(): PlansAtStart {
    return this.core.started ? this.scheduler.atStart() : { continues: [], paused: [] };
  }

  /** How many topics would go on by themselves at the next start (DESIGN 0.7.0 D18). */
  goOnAtNextStart(): number {
    return this.scheduler.goOnAtNextStart();
  }

  // ===================================================================================================================
  // One item
  // ===================================================================================================================

  private liveSession(item: StoredItem): string | null {
    const agents = this.ctx.services.agents;
    if (item.sessionId === undefined || isStubService(agents)) return null;
    const session = agents.get(item.sessionId);
    return session === null || session.status === 'ended' ? null : item.sessionId;
  }

  async retryItem(input: Req<'plan.item.retry'>, principal: Principal): Promise<PlanInfo> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    const item = this.core.needItem(topic, input.itemId);
    // An item that runs directly in the folder is started again by the host alone (DESIGN 0.6.0 D15).
    if (item.pin?.history === 'direct' && !isHostPrincipal(principal)) throw new SmurgError('forbidden', msg('plan.start.directHostOnly'), { reason: 'direct-host-only' });
    const sessionId = this.liveSession(item);
    if (item.state === 'failed' && sessionId !== null) {
      // The same session and conversation resume. While the runtime still calls the session failed, it starts the
      // process again (AgentSessions.retry writes its line and audit entry, and keeps "only the host" after three
      // failed starts). After a restart of the host's smurg the session is merely idle: the message below starts it.
      const agents = this.ctx.services.agents;
      if (agents.get(sessionId)?.status === 'failed') await agents.retry(sessionId, principal);
      await this.scheduler.sendContinue(topic.id, item.id, { by });
    } else if (item.state === 'stopped' || (item.state === 'failed' && this.liveSession(item) === null)) {
      // A new session in the same worktree, when a slot is free.
      const now = this.ctx.clock.now();
      this.core.update(topic.id, (draft) => {
        const target = draft.items.find((candidate) => candidate.id === item.id);
        if (target === undefined) return;
        target.armed = true;
        target.retry = true;
        target.startedBy = by;
        target.state = 'queued';
        target.since = now;
        delete target.stalledBy;
        delete target.disarmed;
        delete target.startError;
        // "Try again" begins the merge queue's account of the item afresh (DESIGN 0.7.0 D8), takes a left-out item back
        // in (D11), and the topic has new work: its result is not checked any more (D13).
        delete target.autoMerge;
        delete target.mergeTries;
        delete target.lastTurn;
        delete target.leftOut;
        // (and the count of smurg's automatic continues starts again, DESIGN 0.7.0 D15)
        delete target.autoContinue;
        delete draft.checked;
      });
      this.merger?.forget(topic.id, item.id);
    } else throw new SmurgError('conflict', msg('plan.item.notRetryable'), { reason: 'not-retryable' });
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.item.retry', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, was: item.state, attempt: item.attempt } });
    this.core.publish(topic.id);
    await this.scheduler.runNow();
    return this.needPlan(topic.id);
  }

  async continueItem(input: Req<'plan.item.continue'>, principal: Principal): Promise<void> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    const item = this.core.needItem(topic, input.itemId);
    if (this.liveSession(item) === null) throw new SmurgError('conflict', msg('plan.item.noSession'), { reason: 'no-session' });
    await this.scheduler.sendContinue(topic.id, item.id, { by });
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.item.continue', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, sessionId: item.sessionId } });
  }

  /**
   * After a merge conflict: smurg merges the main workspace into the item's worktree (nobody's agent runs git) and
   * asks the agent to resolve the conflict markers.
   */
  async resolveItem(input: Req<'plan.item.resolve'>, principal: Principal): Promise<void> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    const item = this.core.needItem(topic, input.itemId);
    if (item.merge?.status !== 'conflict') throw new SmurgError('conflict', msg('plan.item.noConflict'), { reason: 'no-conflict' });
    const sessionId = this.liveSession(item);
    if (sessionId === null || item.worktreeId === undefined) throw new SmurgError('conflict', msg('plan.item.noSession'), { reason: 'no-session' });
    // A person's resolve is not counted as one of smurg's tries (DESIGN 0.7.0 D8). When the other side of the conflict
    // is a person's change (the item is held for it), the message says which files hold it and that it stays (D17).
    const record = item.autoMerge;
    const peopleChanged = record?.state === 'held' && record.reason === 'conflict' ? (record.people ?? []).map((change) => change.path) : [];
    const result = await this.ctx.services.worktrees.updateFromMain(item.worktreeId);
    const agents = this.ctx.services.agents;
    agents.append(sessionId, lineEvent(msg('conversation.resolveRequested', { name: by.displayName })));
    agents.append(sessionId, lineEvent(msg('conversation.conflict.merged', { count: result.conflicted.length })));
    const sent = await agents.send(sessionId, { kind: 'smurg', purpose: 'resolve-conflict', text: resolveConflictMessage({ conflicted: result.conflicted, mergedBefore: this.core.mergedBefore(topic, item), peopleChanged }), by });
    this.core.updateItem(topic.id, item.id, (draft) => {
      draft.nudged = false;
      delete draft.fix;
    });
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.item.resolve', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, sessionId, messageId: sent.messageId, conflicted: result.conflicted.length } });
    this.core.publish(topic.id);
  }

  // ===================================================================================================================
  // What a person decides about one item (DESIGN 0.7.0 D9, D10, D11)
  // ===================================================================================================================

  /** An item of the plan (not one that left PLAN.md): `plan.item.unknown` otherwise. */
  private needPlanItem(topic: StoredTopic, itemId: string): StoredItem {
    const item = this.core.needItem(topic, itemId);
    if (item.number === 0) throw new SmurgError('not_found', msg('plan.item.unknown'), { reason: 'unknown-item' });
    return item;
  }

  /** The item and every item of the topic that depends on it, directly or through others, that is not merged and not left out already. */
  private withDependents(topic: StoredTopic, itemId: string): string[] {
    const out = [itemId];
    for (let index = 0; index < out.length; index += 1) {
      const id = out[index] as string;
      for (const other of topic.items) {
        if (out.includes(other.id) || !other.dependsOn.includes(id)) continue;
        out.push(other.id);
      }
    }
    return out.filter((id) => {
      const item = this.core.item(topic, id);
      return item !== null && !item.merged && item.leftOut === undefined;
    });
  }

  /**
   * "Leave it out" (DESIGN 0.7.0 D11): the item and every item that depends on it and is not merged are left out in ONE
   * topic update, without touching PLAN.md (an edit of the file would disarm every armed item of the topic). The claim
   * comes first: from that moment D6 row 1 refuses their merge, also inside the worktree module's queue. A merge of one
   * of them that is already past its last check (R-SAFE S3) is waited for; then what is true decides: the asked item
   * merged → `plan.item.leaveOut.merged` and nothing is left out; a dependent that merged is not left out. Then each
   * is not armed any more, its record of the merge queue goes, its live session ends after its line (the worktree and
   * its draft stay), and its state says `stopped` (it had a session) or `not-started`.
   */
  async leaveOut(input: Req<'plan.item.leaveOut'>, principal: Principal): Promise<PlanInfo> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    this.needPlan(topic.id);
    const asked = this.needPlanItem(topic, input.itemId);
    if (asked.merged) throw new SmurgError('conflict', msg('plan.item.leaveOut.merged'), { reason: 'merged' });
    if (asked.leftOut !== undefined) return this.needPlan(topic.id);
    const at = this.ctx.clock.now();
    const claimed = this.withDependents(topic, asked.id);
    const claim = new Set(claimed);
    this.core.update(topic.id, (draft) => {
      for (const item of draft.items) if (claim.has(item.id)) item.leftOut = { by, at };
    });
    for (const id of claimed) await this.merger?.whenSettled(topic.id, id);
    const ours = (item: StoredItem): boolean => claim.has(item.id) && item.leftOut?.at === at && item.leftOut.by.userId === by.userId;
    const settled = this.core.need(topic.id);
    if (this.core.needItem(settled, asked.id).merged) {
      this.core.update(topic.id, (draft) => {
        for (const item of draft.items) if (ours(item)) delete item.leftOut;
      });
      this.core.publish(topic.id);
      throw new SmurgError('conflict', msg('plan.item.leaveOut.merged'), { reason: 'merged' });
    }
    const leaving = new Set(settled.items.filter((item) => ours(item) && !item.merged).map((item) => item.id));
    const sessions: string[] = [];
    this.core.update(topic.id, (draft) => {
      for (const item of draft.items) {
        if (!ours(item)) continue;
        // (merged meanwhile: it is in the main workspace, so it is not left out)
        if (!leaving.has(item.id)) {
          delete item.leftOut;
          continue;
        }
        const live = this.liveSession(item);
        if (live !== null) sessions.push(live);
        item.armed = false;
        item.retry = false;
        delete item.autoMerge;
        delete item.stalledBy;
        item.state = item.sessions.length > 0 ? 'stopped' : 'not-started';
        item.since = at;
      }
    });
    for (const id of leaving) {
      this.core.refused.delete(itemKey(topic.id, id));
      this.merger?.forget(topic.id, id);
    }
    const agents = this.ctx.services.agents;
    for (const sessionId of sessions) {
      try {
        agents.append(sessionId, lineEvent(msg('conversation.ended.leftOut', { name: by.displayName })));
        await agents.end(sessionId, { by: principal.actor, reason: 'ended', keepWorktree: true });
      } catch (err) {
        this.ctx.log.warn('the session of a left-out item was not ended', { module: 'topics', topic: topic.id, session: sessionId, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'plan.item.leaveOut',
      outcome: 'ok',
      target: topic.id,
      detail: { topicId: topic.id, itemId: asked.id, others: [...leaving].filter((id) => id !== asked.id), sessions: sessions.length },
    });
    this.core.publish(topic.id);
    this.merger?.request();
    this.scheduler.request();
    return this.needPlan(topic.id);
  }

  /**
   * "Accept as it is" (DESIGN 0.7.0 D10; `worktree.merge.decide`, the host): an item that ran directly in the folder,
   * held because its report is not complete and verified (or was not checked again), counts as merged: who accepted it
   * is its `mergedAs`, the hold goes, and what depends on it may start.
   */
  async accept(input: Req<'plan.item.accept'>, principal: Principal): Promise<PlanInfo> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    const item = this.needPlanItem(topic, input.itemId);
    const hold = item.autoMerge;
    if (!isDirect(item) || item.merged || hold?.state !== 'held') throw new SmurgError('conflict', msg('plan.item.accept.notHeld'), { reason: 'not-held' });
    const report = this.core.report(topic.id, item.id);
    if (report === null || report.version !== input.version) throw new SmurgError('conflict', msg('report.changed'), { reason: 'report-changed' });
    const at = this.ctx.clock.now();
    this.core.updateItem(topic.id, item.id, (draft) => {
      draft.merged = true;
      draft.mergedAs = { at, by: { userId: by.userId, displayName: by.displayName } };
      delete draft.autoMerge;
    });
    this.merger?.forget(topic.id, item.id);
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.item.accept', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, version: report.version, outcome: report.outcome, reason: hold.reason } });
    this.core.publish(topic.id);
    await this.scheduler.runNow();
    return this.needPlan(topic.id);
  }

  /**
   * "Merge it as it is" (DESIGN 0.7.0 D9, R-SAFE S7, S4; `session.drive`: a person who may stop the agent decides that
   * its work stands): for an item that smurg merges by itself and that is held because somebody wrote to its agent
   * since this version, a later turn was stopped, or its report was not checked again (RELEASABLE_HOLDS). What made it
   * so goes (`changesAsked`, `lastTurn`), the version counts as checked in its turn, and the merge queue merges it when
   * it is otherwise in order.
   */
  async release(input: Req<'plan.item.release'>, principal: Principal): Promise<PlanInfo> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    const item = this.needPlanItem(topic, input.itemId);
    const verdict = this.core.mergingOf(item) === 'auto' ? this.core.verdictOf(topic, item) : null;
    // (a merged item held because a later turn left half of a change in its checkout has no version to merge "as it
    // is": its carers continue it, and the change becomes a version of its own; 0.7.0 review)
    if (verdict?.kind !== 'hold' || !(RELEASABLE_HOLDS as readonly string[]).includes(verdict.reason) || item.merged) throw new SmurgError('conflict', msg('plan.item.release.notHeld'), { reason: 'not-held' });
    const report = this.core.report(topic.id, item.id);
    if (report === null || report.version !== input.version) throw new SmurgError('conflict', msg('report.changed'), { reason: 'report-changed' });
    this.core.updateItem(topic.id, item.id, (draft) => {
      delete draft.changesAsked;
      delete draft.lastTurn;
    });
    if (report.checkedInTurn !== true) this.core.putReport({ ...report, checkedInTurn: true });
    this.merger?.drop(topic.id, item.id);
    const sessionId = this.liveSession(item);
    if (sessionId !== null) {
      try {
        this.ctx.services.agents.append(sessionId, lineEvent(msg('conversation.released', { name: by.displayName })));
      } catch (err) {
        this.ctx.log.debug('release line not written', { session: sessionId, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.item.release', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, version: report.version, reason: verdict.reason } });
    this.core.publish(topic.id);
    this.merger?.request();
    return this.needPlan(topic.id);
  }

  /**
   * "Ask the agent to take them out" (DESIGN 0.7.0 D9; `worktree.merge.decide`, the host): the item smurg merges by
   * itself is held because it changes files only the host may merge; its agent is asked (`remove-paths`) to undo its
   * changes to exactly those files. The hold stays until its next version.
   */
  async removePaths(input: Req<'plan.item.removePaths'>, principal: Principal): Promise<void> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    const item = this.needPlanItem(topic, input.itemId);
    const verdict = this.core.mergingOf(item) === 'auto' ? this.core.verdictOf(topic, item) : null;
    const paths = verdict?.kind === 'hold' && verdict.reason === 'policy' ? (verdict.paths ?? []) : [];
    if (paths.length === 0) throw new SmurgError('conflict', msg('plan.item.removePaths.notHeld'), { reason: 'not-held' });
    const sessionId = this.liveSession(item);
    if (sessionId === null) throw new SmurgError('conflict', msg('plan.item.noSession'), { reason: 'no-session' });
    const agents = this.ctx.services.agents;
    agents.append(sessionId, lineEvent(msg('conversation.removePathsRequested', { name: by.displayName })));
    const sent = await agents.send(sessionId, { kind: 'smurg', purpose: 'remove-paths', text: removePathsMessage({ paths }), by });
    this.core.updateItem(topic.id, item.id, (draft) => {
      draft.nudged = false;
      delete draft.fix;
    });
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.item.removePaths', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, sessionId, messageId: sent.messageId, paths: paths.slice(0, 20) } });
    this.core.publish(topic.id);
  }

  // ===================================================================================================================
  // The host's undo (DESIGN 0.7.0 D14)
  // ===================================================================================================================

  /** Undo is the host's (`worktree.merge.decide`; the router checks it, and so does this). */
  private undoHost(principal: Principal): UserRef {
    if (!isHostPrincipal(principal)) throw new AuthorizationError(undefined, { reason: 'capability' });
    return userRefOf(principal);
  }

  /**
   * The items an undo of `itemIds` (null: the whole topic) is asked for: merged and not undone. Those that ran directly
   * in the folder have no history smurg could take them back from (`direct`). Refused for an item that is not merged.
   */
  private undoAsked(topic: StoredTopic, itemIds: readonly string[] | null): { readonly asked: readonly StoredItem[]; readonly direct: readonly StoredItem[] } {
    const merged = (item: StoredItem): boolean => item.merged && item.undone === undefined;
    const notMerged = (): SmurgError => new SmurgError('conflict', msg('undo.notMerged'), { reason: 'not-merged' });
    const chosen = itemIds === null ? topic.items.filter(merged) : [...new Set(itemIds)].map((id) => this.core.needItem(topic, id));
    if (chosen.length === 0 || chosen.some((item) => !merged(item))) throw notMerged();
    const direct = chosen.filter((item) => isDirect(item));
    return { asked: direct.length > 0 ? [] : chosen, direct };
  }

  /** Every merged work item of every topic that smurg could take back (not undone, not run directly in the folder). */
  private undoItems(): UndoItem[] {
    const out: UndoItem[] = [];
    for (const topic of this.core.topics()) {
      for (const item of topic.items) {
        if (!item.merged || item.undone !== undefined || isDirect(item)) continue;
        const mergedAs = item.mergedAs;
        out.push({
          topicId: topic.id,
          topicSlug: topic.slug,
          itemId: item.id,
          history: item.pin?.history === 'smurg' ? 'smurg' : 'folder',
          ...(item.pin?.branch === undefined ? {} : { branch: item.pin.branch }),
          ...(mergedAs === undefined ? {} : { mergedAs: { ...(mergedAs.requestId === undefined ? {} : { requestId: mergedAs.requestId }), ...(mergedAs.commit === undefined ? {} : { commit: mergedAs.commit }) } }),
        });
      }
    }
    return out;
  }

  /** The items of the topic that depend on these, directly or through others, whatever their state (these not included). */
  private dependentsOf(topic: StoredTopic, ids: ReadonlySet<string>): string[] {
    const out = [...ids];
    for (let index = 0; index < out.length; index += 1) {
      const id = out[index] as string;
      for (const other of topic.items) if (!out.includes(other.id) && other.dependsOn.includes(id)) out.push(other.id);
    }
    return out.filter((id) => !ids.has(id));
  }

  /** These items and every merged item of their plans built on them, transitively (DESIGN 0.7.0 D14 step 2(a), `built-on`). */
  private withBuiltOn(keys: readonly UndoItemKey[]): UndoItemKey[] {
    const out = new Map(keys.map((key) => [itemKey(key.topicId, key.itemId), key]));
    const byTopic = new Map<string, Set<string>>();
    for (const key of keys) byTopic.set(key.topicId, (byTopic.get(key.topicId) ?? new Set()).add(key.itemId));
    for (const [topicId, ids] of byTopic) {
      const topic = this.core.topic(topicId);
      if (topic === null) continue;
      for (const id of this.dependentsOf(topic, ids)) {
        const item = this.core.item(topic, id);
        if (item !== null && item.merged && item.undone === undefined && !isDirect(item)) out.set(itemKey(topicId, id), { topicId, itemId: id });
      }
    }
    return [...out.values()];
  }

  private undoAsk(asked: readonly StoredItem[], topic: StoredTopic, host: UserRef): UndoAsk {
    return { host, asked: asked.map((item) => ({ topicId: topic.id, itemId: item.id })), items: this.undoItems(), withBuiltOn: (keys) => this.withBuiltOn(keys) };
  }

  /** How a work item is named in an undo's preview: with its topic (an item of another topic goes with it by name). */
  private undoRef(key: UndoItemKey): UndoItemRef {
    const topic = this.core.topic(key.topicId);
    const item = topic === null ? null : this.core.item(topic, key.itemId);
    return { topicId: key.topicId, topicName: topic?.name ?? key.topicId, itemId: key.itemId, number: item?.number ?? 0, title: item?.title ?? key.itemId };
  }

  /**
   * The preview from what the worktree module found and what the plans say (DESIGN 0.7.0 D14 step 2(d), step 5): the
   * items not merged that wait for an undone one or stand on it are left out (whatever their state: a done dependent
   * started from the merged state), and one in a turn is in the way instead (`running`), as is an undone item other
   * than the asked ones whose agent is in a turn. The token is over what the undo DOES: the merges it reverts, the
   * requests and items it takes back, the items it leaves out, whether its trial is clean.
   */
  private describeUndo(facts: UndoFacts): { readonly preview: UndoPreview; readonly undone: readonly UndoItemKey[]; readonly leftOut: readonly UndoItemKey[] } {
    const undoneKeys = new Set(facts.items.map((item) => itemKey(item.topicId, item.itemId)));
    const cards = this.core.sessionsWithCards();
    const inATurn = (key: UndoItemKey): boolean => {
      const topic = this.core.topic(key.topicId);
      const item = topic === null ? null : this.core.item(topic, key.itemId);
      return topic !== null && item !== null && this.core.sessionAtWork(topic, item, cards)?.turnOpen === true;
    };
    const leftOut: UndoItemKey[] = [];
    const running: UndoItemKey[] = facts.items.filter((item) => item.why !== 'asked' && inATurn(item)).map((item) => ({ topicId: item.topicId, itemId: item.itemId }));
    const byTopic = new Map<string, Set<string>>();
    for (const item of facts.items) byTopic.set(item.topicId, (byTopic.get(item.topicId) ?? new Set()).add(item.itemId));
    for (const [topicId, ids] of byTopic) {
      const topic = this.core.topic(topicId);
      if (topic === null) continue;
      for (const id of this.dependentsOf(topic, ids)) {
        const item = this.core.item(topic, id);
        if (item === null || undoneKeys.has(itemKey(topicId, id)) || item.merged || item.undone !== undefined || item.leftOut !== undefined) continue;
        if (inATurn({ topicId, itemId: id })) running.push({ topicId, itemId: id });
        else leftOut.push({ topicId, itemId: id });
      }
    }
    const sortKeys = (keys: readonly UndoItemKey[]): string[] => keys.map((key) => itemKey(key.topicId, key.itemId)).sort();
    const requestIds = [...new Set(facts.merges.flatMap((merge) => (merge.requestId === undefined ? [] : [merge.requestId])))].sort();
    const token = sha256Hex(JSON.stringify({ merges: facts.merges.map((merge) => merge.commit), requests: requestIds, undone: sortKeys(facts.items), leftOut: sortKeys(leftOut), clean: facts.clean }));
    const tooMany = facts.items.length > UNDO_ITEMS_MAX || leftOut.length > UNDO_ITEMS_MAX || running.length > UNDO_ITEMS_MAX;
    // An undone item's checkout goes with the undo (a new Start needs a fresh one): one that holds work no merge carried
    // (a person's saved edit, a later turn's change) is not deleted unasked (0.7.0 review, the finish rule of D12).
    const keepsWork = facts.items.filter((key) => this.checkoutHoldsWork(key)).slice(0, 5).map((key) => {
      const ref = this.undoRef(key);
      return `${ref.number} · ${ref.title}`.slice(0, 200);
    });
    const unavailable =
      facts.unavailable !== null
        ? wireText(facts.unavailable)
        : tooMany
          ? wireText(msg('undo.unavailable.tooMany', { max: UNDO_ITEMS_MAX }))
          : keepsWork.length > 0
            ? wireText(msg('undo.unavailable.unmerged', { items: keepsWork }))
            : null;
    const blockers: UndoPreview['blockers'] = {
      running: running.slice(0, UNDO_ITEMS_MAX).map((key) => this.undoRef(key)),
      changedSince: facts.changedSince.slice(0, UNDO_PATHS_MAX).map((change) => ({ path: change.path, by: change.by.slice(0, 5).map((user) => ({ userId: user.userId, displayName: user.displayName })), outside: change.outside })),
      typing: facts.typing.slice(0, UNDO_PATHS_MAX).map((entry) => ({ path: entry.path, names: entry.names.slice(0, 5).map((user) => ({ userId: user.userId, displayName: user.displayName })) })),
      uncommitted: facts.uncommitted.slice(0, UNDO_PATHS_MAX),
      staged: facts.staged,
      busy: facts.busy,
      branch: facts.branch === null ? null : { expected: facts.branch.expected, current: facts.branch.current },
      unavailable,
    };
    const ok =
      facts.clean &&
      facts.items.length > 0 &&
      unavailable === null &&
      blockers.running.length === 0 &&
      blockers.changedSince.length === 0 &&
      blockers.typing.length === 0 &&
      blockers.uncommitted.length === 0 &&
      !blockers.staged &&
      !blockers.busy &&
      blockers.branch === null;
    const undone = facts.items.map((item) => ({ topicId: item.topicId, itemId: item.itemId }));
    return {
      preview: {
        token,
        history: facts.history,
        undone: facts.items.slice(0, UNDO_ITEMS_MAX).map((item) => ({ ...this.undoRef(item), why: item.why })),
        leftOut: leftOut.slice(0, UNDO_ITEMS_MAX).map((key) => this.undoRef(key)),
        blockers,
        ok,
      },
      undone,
      leftOut,
    };
  }

  /** Whether the item's checkout holds work that no merge carried (a question that cannot be answered counts as yes). */
  private checkoutHoldsWork(key: UndoItemKey): boolean {
    const topic = this.core.topic(key.topicId);
    const item = topic === null ? null : this.core.item(topic, key.itemId);
    const worktrees = this.ctx.services.worktrees;
    if (item === null || item.worktreeId === undefined || isStubService(worktrees) || worktrees.get(item.worktreeId) === null) return false;
    try {
      return worktrees.unmerged(key.topicId).some((worktree) => worktree.id === item.worktreeId);
    } catch {
      return true;
    }
  }

  /** The preview of items that ran directly in the shared folder: there is no history to take them back from. */
  private directUndo(topic: StoredTopic, direct: readonly StoredItem[]): UndoPreview {
    const undone = direct.slice(0, UNDO_ITEMS_MAX).map((item) => ({ ...this.undoRef({ topicId: topic.id, itemId: item.id }), why: 'asked' as const }));
    return {
      token: sha256Hex(JSON.stringify({ direct: undone.map((item) => item.itemId) })),
      history: 'folder',
      undone,
      leftOut: [],
      blockers: { running: [], changedSince: [], typing: [], uncommitted: [], staged: false, busy: false, branch: null, unavailable: wireText(msg('undo.unavailable.direct')) },
      ok: false,
    };
  }

  /** The undo commit's subject (fixed English, one shared history). */
  private undoSubject(topic: StoredTopic, asked: readonly StoredItem[], whole: boolean): string {
    if (whole) return `smurg: undo topic ${topic.slug}`;
    const named = asked.map((item) => `${item.number} (${item.id})`).join(', ');
    return `smurg: undo work item${asked.length === 1 ? '' : 's'} ${named} of ${topic.slug}`;
  }

  async undoPreview(input: Req<'topic.undo.preview'>, principal: Principal): Promise<Res<'topic.undo.preview'>> {
    const host = this.undoHost(principal);
    const topic = this.core.needOpen(input.topicId);
    const { asked, direct } = this.undoAsked(topic, input.itemIds);
    if (direct.length > 0) return { preview: this.directUndo(topic, direct) };
    const facts = await this.ctx.services.worktrees.undoPreview(this.undoAsk(asked, topic, host));
    return { preview: this.describeUndo(facts).preview };
  }

  /**
   * DESIGN 0.7.0 D14 "Topics": the worktree module's apply, with this module's yes inside its queue (the token, nothing
   * in the way) and the claim from that moment (D6 row 2: no merge of an undone or left-out item starts meanwhile);
   * then every undone item is not merged and not started (its session ended after its line, its worktree released: a
   * new Start makes a fresh one from the main workspace as it is), what waits for them is left out as "Leave it out"
   * does (by the host), and the claim goes. The topic stays complete when it was checked; else its phase follows D13.
   */
  async undo(input: Req<'topic.undo'>, principal: Principal): Promise<PlanInfo> {
    const host = this.undoHost(principal);
    const topic = this.core.needOpen(input.topicId);
    const { asked, direct } = this.undoAsked(topic, input.itemIds);
    if (direct.length > 0) throw new SmurgError('conflict', msg('undo.unavailable.direct'), { reason: 'direct' });
    const decided: { described?: ReturnType<PlanServiceImpl['describeUndo']> } = {};
    const claim = new Set<string>();
    const release = (): void => {
      for (const key of claim) this.core.claimed.delete(key);
    };
    let done: Awaited<ReturnType<WorktreeManager['undo']>>;
    try {
      done = await this.ctx.services.worktrees.undo({
        ...this.undoAsk(asked, topic, host),
        subject: this.undoSubject(topic, asked, input.itemIds === null),
        confirm: (facts) => {
          const described = this.describeUndo(facts);
          if (described.preview.token !== input.token) throw new SmurgError('conflict', msg('undo.changed'), { reason: 'changed' });
          if (!described.preview.ok) throw new SmurgError('conflict', msg('undo.notOk'), { reason: 'not-ok' });
          for (const key of [...described.undone, ...described.leftOut]) {
            const k = itemKey(key.topicId, key.itemId);
            claim.add(k);
            this.core.claimed.add(k);
          }
          decided.described = described;
        },
      });
    } catch (err) {
      release();
      if (err instanceof SmurgError && (err.detail?.['reason'] === 'changed' || err.detail?.['reason'] === 'not-ok')) {
        this.ctx.audit.record({ actor: principal.actor, action: 'worktree.merge.undo', outcome: 'denied', target: topic.id, detail: { topicId: topic.id, itemIds: asked.map((item) => item.id), reason: err.detail['reason'] } });
      }
      throw err;
    }
    const described = decided.described;
    try {
      if (described !== undefined) await this.takeBack(described.undone, described.leftOut, { by: host, at: this.ctx.clock.now(), commit: done.commit, actor: principal.actor });
    } finally {
      release();
    }
    const askedKeys = new Set(asked.map((item) => itemKey(topic.id, item.id)));
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'worktree.merge.undo',
      outcome: 'ok',
      target: topic.id,
      detail: {
        topicId: topic.id,
        requestIds: [...new Set(done.facts.merges.flatMap((merge) => (merge.requestId === undefined ? [] : [merge.requestId])))],
        itemIds: asked.map((item) => item.id),
        goesWith: done.facts.items.filter((item) => !askedKeys.has(itemKey(item.topicId, item.itemId))).map((item) => ({ topicId: item.topicId, itemId: item.itemId, why: item.why })),
        leftOut: (described?.leftOut ?? []).map((key) => ({ topicId: key.topicId, itemId: key.itemId })),
        commit: done.commit,
        files: done.files,
        history: done.facts.history,
      },
    });
    const activity = this.ctx.services.activity;
    if (!isStubService(activity)) {
      try {
        activity.record({ actor: principal.actor, kind: 'merge', text: msg('activity.undo', { items: done.facts.items.map((item) => item.itemId).slice(0, UNDO_ITEMS_MAX) }) });
      } catch (err) {
        this.ctx.log.error('undo activity failed', { module: 'topics', error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    this.merger?.request();
    this.scheduler.request();
    return this.needPlan(topic.id);
  }

  /**
   * The topics' half of an undo (DESIGN 0.7.0 D14): every undone item is not merged and not started (its record of the
   * merge queue goes, its live session ends after `conversation.ended.undone`, its worktree is released); every
   * left-out one as "Leave it out" leaves it (its session ended, its worktree kept).
   */
  private async takeBack(undone: readonly UndoItemKey[], leftOut: readonly UndoItemKey[], input: { readonly by: UserRef; readonly at: number; readonly commit: string; readonly actor: Actor }): Promise<void> {
    const undoneKeys = new Set(undone.map((key) => itemKey(key.topicId, key.itemId)));
    const leftKeys = new Set(leftOut.map((key) => itemKey(key.topicId, key.itemId)));
    const topicIds = new Set([...undone, ...leftOut].map((key) => key.topicId));
    const sessions: { readonly sessionId: string; readonly line: ReturnType<typeof msg> }[] = [];
    const release: string[] = [];
    for (const topicId of topicIds) {
      if (this.core.topic(topicId) === null) continue;
      this.core.update(topicId, (draft) => {
        for (const item of draft.items) {
          const key = itemKey(topicId, item.id);
          if (undoneKeys.has(key)) {
            if (item.undone !== undefined) continue;
            const live = this.liveSession(item);
            if (live !== null) sessions.push({ sessionId: live, line: msg('conversation.ended.undone', { name: input.by.displayName }) });
            if (item.worktreeId !== undefined) release.push(item.worktreeId);
            item.undone = { by: { userId: input.by.userId, displayName: input.by.displayName }, at: input.at, commit: input.commit };
            item.merged = false;
            item.armed = false;
            item.retry = false;
            item.state = 'not-started';
            item.since = input.at;
            delete item.mergedAs;
            delete item.autoMerge;
            delete item.merge;
            delete item.changesAsked;
            delete item.lastTurn;
            delete item.mergeTries;
            delete item.leftOut;
            delete item.stalledBy;
          } else if (leftKeys.has(key)) {
            if (item.leftOut !== undefined || item.merged) continue;
            const live = this.liveSession(item);
            if (live !== null) sessions.push({ sessionId: live, line: msg('conversation.ended.leftOut', { name: input.by.displayName }) });
            item.leftOut = { by: { userId: input.by.userId, displayName: input.by.displayName }, at: input.at };
            item.armed = false;
            item.retry = false;
            delete item.autoMerge;
            delete item.stalledBy;
            item.state = item.sessions.length > 0 ? 'stopped' : 'not-started';
            item.since = input.at;
          }
        }
      });
    }
    for (const key of [...undone, ...leftOut]) {
      this.core.refused.delete(itemKey(key.topicId, key.itemId));
      this.merger?.forget(key.topicId, key.itemId);
    }
    const agents = this.ctx.services.agents;
    for (const { sessionId, line } of sessions) {
      try {
        agents.append(sessionId, lineEvent(line));
        await agents.end(sessionId, { by: input.actor, reason: 'ended', keepWorktree: true });
      } catch (err) {
        this.ctx.log.warn('the session of an undone or left-out item was not ended', { module: 'topics', session: sessionId, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    // Re-merging reverted commits does nothing ("Already up to date"): a new Start needs a fresh worktree from the main workspace.
    const worktrees = this.ctx.services.worktrees;
    for (const worktreeId of release) {
      try {
        if (worktrees.get(worktreeId) !== null) await worktrees.releaseItem(worktreeId);
      } catch (err) {
        this.ctx.log.warn('the worktree of an undone item was not released', { module: 'topics', worktree: worktreeId, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    for (const topicId of topicIds) this.core.publish(topicId);
  }

  /**
   * A merge request of a work item was undone that this module did not take back itself (DESIGN 0.7.0 D14 step 7: the
   * worktree module recorded an undo a crash had cut short): its item, and what waits for it, follow now.
   */
  onUndone(request: MergeRequest): void {
    if (!this.core.started || request.undone === undefined || request.topicId === undefined || request.itemId === undefined) return;
    const topicId = request.topicId;
    const itemId = request.itemId;
    const undone = request.undone;
    void this.core
      .serialize(`undo:${topicId}`, () => this.followUndone(topicId, itemId, request.id, undone))
      .catch((err: unknown) => this.ctx.log.error('an undone item was not taken back', { module: 'topics', topic: topicId, item: itemId, error: err instanceof Error ? err.name : 'unknown' }));
  }

  /** At the start: requests the worktree module has as undone whose items still say they are merged (a crash between the two records). */
  async reconcileUndone(): Promise<void> {
    const worktrees = this.ctx.services.worktrees;
    if (isStubService(worktrees) || !this.core.started) return;
    let requests: MergeRequest[] = [];
    try {
      requests = worktrees.listMerges(SYSTEM_PRINCIPAL);
    } catch {
      return;
    }
    for (const request of requests) {
      if (request.undone === undefined || request.topicId === undefined || request.itemId === undefined) continue;
      await this.followUndone(request.topicId, request.itemId, request.id, request.undone).catch((err: unknown) =>
        this.ctx.log.error('an undone item was not taken back at the start', { module: 'topics', topic: request.topicId, item: request.itemId, error: err instanceof Error ? err.name : 'unknown' }),
      );
    }
  }

  private async followUndone(topicId: string, itemId: string, requestId: string, undone: NonNullable<MergeRequest['undone']>): Promise<void> {
    const topic = this.core.topic(topicId);
    const item = topic === null ? null : this.core.item(topic, itemId);
    if (topic === null || item === null || item.undone !== undefined || this.core.claimed.has(itemKey(topicId, itemId))) return;
    if (item.mergedAs?.requestId !== requestId && item.merge?.requestId !== requestId) return;
    const leftOut = this.dependentsOf(topic, new Set([itemId]))
      .map((id) => this.core.item(topic, id))
      .filter((other): other is StoredItem => other !== null && !other.merged && other.undone === undefined && other.leftOut === undefined)
      .map((other) => ({ topicId, itemId: other.id }));
    await this.takeBack([{ topicId, itemId }], leftOut, { by: undone.by, at: undone.at, commit: undone.commit, actor: SYSTEM_ACTOR });
    this.merger?.request();
    this.scheduler.request();
  }

  // ===================================================================================================================
  // The agent's own tools (the session is in `ctx`, never in an argument)
  // ===================================================================================================================

  private discussionTopic(mcp: McpToolContext): StoredTopic | null {
    if (mcp.purpose !== 'discussion' || mcp.topic === undefined || !this.core.started) return null;
    const topic = this.core.topic(mcp.topic.id);
    return topic === null || topic.archived || topic.discussionSessionId !== mcp.sessionId ? null : topic;
  }

  /**
   * Reads PLAN.md for the `check_plan` / `propose_split` that follows (reading goes through PathGuard and is
   * asynchronous; the contract's two methods are synchronous) and applies it to the plan at once, so the answer and
   * the plan column never disagree.
   */
  async prepareCheck(mcp: McpToolContext): Promise<void> {
    const topic = this.discussionTopic(mcp);
    if (topic === null) return;
    const result = await this.core.refreshFiles(topic.id);
    if (result !== null) this.prepared.set(mcp.sessionId, result.plan);
  }

  checkPlan(mcp: McpToolContext): { readonly ok: true; readonly items: number; readonly warnings: readonly string[] } | Extract<FileCheck, { ok: false }> {
    const topic = this.discussionTopic(mcp);
    if (topic === null) return { ok: false, errors: [{ message: NOT_A_DISCUSSION }] };
    const parse = this.prepared.get(mcp.sessionId);
    this.prepared.delete(mcp.sessionId);
    const file = JSON.stringify(topicPlanPath(topic.slug));
    if (parse === undefined) return { ok: false, errors: [{ message: `${file} could not be read right now. Call check_plan again.` }] };
    if (parse === null) return { ok: false, errors: [{ message: `${file} does not exist. Write it first, then call check_plan.` }] };
    if (!parse.ok) return { ok: false, errors: parse.errors.map((error) => ({ message: error.model, ...(error.line === undefined ? {} : { line: error.line }) })) };
    return { ok: true, items: parse.items.length, warnings: parse.warnings.map((warning) => warning.model) };
  }

  /**
   * `propose_split`: the agent's proposal, checked against the people it was told about. A pair is kept when its id is
   * an item of the current plan that is not started and not chosen by a person, and its person matches exactly one of
   * them; smurg fills what is left with an even split.
   */
  recordSplit(mcp: McpToolContext, input: { readonly items: readonly { readonly id: string; readonly person: string }[]; readonly reason: string }): { readonly ok: true; readonly assigned: number; readonly unknownPeople: number } {
    const topic = this.discussionTopic(mcp);
    if (topic === null) throw new SmurgError('conflict', undefined, { reason: 'not-a-discussion' });
    if (!topic.plan.valid || !topic.plan.parsed) throw new SmurgError('conflict', undefined, { reason: 'no-plan' });
    const people = topic.plan.people.length > 0 ? topic.plan.people : this.core.peoplePresent();
    const eligible = new Set(topic.items.filter((item) => item.number > 0 && !isStarted(item) && !item.chosen).map((item) => item.id));
    const checked = checkProposal(eligible, people, input.items);
    const reason = wireMultiline(mask(input.reason), SPLIT_REASON_MAX_CHARS).trim();
    // With "everyone watches" nobody is responsible: the proposal is counted and not applied.
    const applies = topic.plan.mode === 'assigned';
    this.core.update(topic.id, (draft) => {
      if (!applies) return;
      for (const item of draft.items) {
        const userId = checked.kept.get(item.id);
        const ref = userId === undefined ? null : this.ctx.members.userRef(userId);
        if (ref !== null) item.responsible = { ...ref, source: 'agent' };
      }
      draft.plan.split = { source: checked.kept.size > 0 ? 'agent' : 'smurg', ...(reason.length === 0 ? {} : { reason }) };
    });
    // The rest is split again around what the agent proposed.
    if (applies) this.core.fillSplit(topic.id, people, { redo: 'smurg' });
    this.reports?.refreshReviewers();
    this.core.publish(topic.id);
    return { ok: true, assigned: applies ? checked.kept.size : 0, unknownPeople: checked.unknownPeople };
  }
}
