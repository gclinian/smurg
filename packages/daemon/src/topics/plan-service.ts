// PlanService (ARCHITECTURE §5.10): the plan of a topic. PLAN.md defines the work items (ids, order, dependencies);
// who is responsible, what is armed and what runs is daemon state keyed by item id, so people can edit the file
// freely. This file holds the requests around it: "Generate plan" (and the agent's own check of its file through the
// MCP tools `check_plan` / `propose_split`), who is responsible, the Start dialog (`plan.preflight`) and Start with
// its pins, "Show the changes", "Continue all", and the three things a person can do to one item (try again,
// continue, resolve a conflict). The scheduler (scheduler.ts) starts what a Start armed.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAIN_ROOT,
  PLAN_CHANGES_DIFF_MAX_BYTES,
  PREFLIGHT_ALSO_IN_FOLDER_MAX,
  PREFLIGHT_BLOCKERS_MAX,
  PREFLIGHT_EDITING_NOW_MAX,
  SPLIT_REASON_MAX_CHARS,
  SmurgError,
  agentDisplayName,
  agentSafeName,
  can,
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
  type PlanInfo,
  type StartPreflight,
  type TurnOutcome,
  type UserRef,
  type WireText,
  type WorkItem,
} from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { FileCheck, McpToolContext, PlanService, Principal, Req, Res, TurnMessage, WorktreeManager } from '../core/interfaces.ts';
import { SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { checkpointCommit } from './checkpoint.ts';
import { isStarted, userRefOf, type TopicsCore } from './core.ts';
import type { PlanParse } from './plan-format.ts';
import { fixFileMessage, generatePlanMessage, resolveConflictMessage, updatePlanMessage } from './prompts.ts';
import type { Scheduler, SchedulerReports } from './scheduler.ts';
import { checkProposal } from './split.ts';
import type { Pin, StoredItem, StoredTopic } from './store.ts';
import type { TopicServiceImpl } from './topic-service.ts';
import { EMPTY_HASH, wireMultiline } from './text.ts';

type MainState = Awaited<ReturnType<WorktreeManager['mainState']>>;

/** What the model reads when it calls a plan tool from a session that is not a topic's discussion. */
export const NOT_A_DISCUSSION = "This tool is for the discussion session of a topic. This session is not one.";

/** How many entries the spec lists under its "Open questions" heading (the Start dialog says so). */
export function countOpenQuestions(spec: string): number {
  const lines = spec.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^#{1,6}[ \t]+open questions[ \t]*#*[ \t]*$/i.test(line));
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

  /**
   * Resolves when what this module does in the background has come to rest: the reading of a topic's files and the
   * end of a turn that are under way, one whole scheduler pass, and the finishing of merged and reviewed items. The
   * module's tests call it before they assert that something did NOT happen, instead of waiting a fixed time.
   */
  async settle(): Promise<void> {
    await this.core.idle();
    await this.scheduler.runNow();
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
      this.core.versioned = main.isRepo;
      return main;
    } catch (err) {
      this.ctx.log.warn('main workspace state unavailable', { error: err instanceof Error ? err.name : 'unknown' });
      return null;
    }
  }

  /** What stops a Start right now, each as a sentence for people. */
  private blockersOf(topic: StoredTopic, targets: readonly StoredItem[], main: MainState | null): MessageRef[] {
    const blockers: MessageRef[] = [];
    if (!topic.spec.exists) blockers.push(msg('topic.noSpec'));
    if (!topic.plan.exists || !topic.plan.valid || !topic.plan.parsed) blockers.push(msg('plan.start.invalid'));
    // Execution needs git: items run in worktrees, their changes are reviewed and merged.
    if (main === null || !main.isRepo || !main.hasCommit || !main.gitOk) blockers.push(msg('plan.start.noGit'));
    else if (main.busy) blockers.push(msg('plan.start.commit.busy'));
    else {
      const startsNow = targets.filter((item) => this.core.unmergedDependencies(topic, item).length === 0 && item.worktreeId === undefined).length;
      const worktrees = this.ctx.services.worktrees;
      if (startsNow > main.free) blockers.push(msg('plan.start.worktreeLimit', { max: main.free + (isStubService(worktrees) ? 0 : worktrees.list().length) }));
    }
    if (topic.plan.paused) blockers.push(msg('plan.paused'));
    if (targets.length === 0) blockers.push(msg('plan.start.nothing'));
    return blockers.slice(0, PREFLIGHT_BLOCKERS_MAX);
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
    let commit: StartPreflight['commit'] = null;
    if (main !== null && main.isRepo) {
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
      blockers: this.blockersOf(topic, targets, main).map((ref): WireText => wireText(ref)),
    };
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
    const changed = (): SmurgError => new SmurgError('conflict', msg('plan.start.changed'), { reason: 'plan-changed' });
    await this.core.serialize(`start:${input.topicId}`, async () => {
      await this.core.refreshFiles(input.topicId);
      const topic = this.core.needOpen(input.topicId);
      if (!topic.plan.parsed || input.planRevision !== topic.plan.revision || input.specHash !== topic.spec.hash || input.planHash !== topic.plan.hash) throw changed();
      const targets = this.targetsOf(topic, input.itemIds);
      const main = await this.mainState();
      const blocker = this.blockersOf(topic, targets, main)[0];
      if (blocker !== undefined) throw new SmurgError('conflict', blocker, { reason: 'blocked' });

      const checkpoint = await checkpointCommit(this.ctx, topic, principal);
      // What is at HEAD now must be exactly what was confirmed: the files as they are, hashing as the dialog showed.
      const specPath = topicSpecPath(topic.slug);
      const planPath = topicPlanPath(topic.slug);
      const [spec, plan, differs] = await Promise.all([
        this.core.readFile(MAIN_ROOT, specPath),
        this.core.readFile(MAIN_ROOT, planPath),
        this.ctx.services.worktrees.diffMainPaths({ paths: [specPath, planPath], against: { [specPath]: checkpoint.specBlob, [planPath]: checkpoint.planBlob }, maxBytes: 1 }).catch(() => []),
      ]);
      if ((spec?.hash ?? EMPTY_HASH) !== input.specHash || (plan?.hash ?? EMPTY_HASH) !== input.planHash || differs.length > 0) throw changed();

      const now = this.ctx.clock.now();
      const pin: Pin = { by: caller, at: now, planRevision: input.planRevision, specHash: input.specHash, planHash: input.planHash, commit: checkpoint.commit, specBlob: checkpoint.specBlob, planBlob: checkpoint.planBlob };
      const armed = new Set(targets.map((item) => item.id));
      this.core.update(topic.id, (draft) => {
        draft.handEdits = { spec: [], plan: [] };
        draft.plan.lastPin = pin;
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
        }
      });
      this.ctx.audit.record({
        actor: principal.actor,
        action: 'plan.start',
        outcome: 'ok',
        target: topic.id,
        detail: { topicId: topic.id, itemIds: [...armed], planRevision: input.planRevision, specHash: input.specHash, planHash: input.planHash, commit: checkpoint.commit, committed: checkpoint.created },
      });
      this.core.publish(topic.id);
    });
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

  /** "Continue all" after a restart of the host's smurg: clears the pause and tells the interrupted sessions to go on. */
  async resume(input: Req<'plan.resume'>, principal: Principal): Promise<PlanInfo> {
    const by = userRefOf(principal);
    const topic = this.core.needOpen(input.topicId);
    this.needPlan(topic.id);
    const interrupted = topic.items.filter((item) => item.state === 'stalled' && item.stalledBy === 'restart' && item.sessionId !== undefined);
    this.core.update(topic.id, (draft) => {
      draft.plan.paused = false;
      delete draft.plan.pausedAt;
    });
    const continued: string[] = [];
    for (const item of interrupted) {
      try {
        if (await this.scheduler.sendContinue(topic.id, item.id, by)) continued.push(item.id);
      } catch (err) {
        this.ctx.log.warn('item not continued', { topic: topic.id, item: item.id, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.resume', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemIds: continued } });
    this.core.publish(topic.id);
    await this.scheduler.runNow();
    return this.needPlan(topic.id);
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
    const sessionId = this.liveSession(item);
    if (item.state === 'failed' && sessionId !== null) {
      // The same session and conversation resume. While the runtime still calls the session failed, it starts the
      // process again (AgentSessions.retry writes its line and audit entry, and keeps "only the host" after three
      // failed starts). After a restart of the host's smurg the session is merely idle: the message below starts it.
      const agents = this.ctx.services.agents;
      if (agents.get(sessionId)?.status === 'failed') await agents.retry(sessionId, principal);
      await this.scheduler.sendContinue(topic.id, item.id, by);
    } else if (item.state === 'stopped' || (item.state === 'failed' && this.liveSession(item) === null)) {
      // A new session in the same worktree, when a slot is free.
      const now = this.ctx.clock.now();
      this.core.updateItem(topic.id, item.id, (draft) => {
        draft.armed = true;
        draft.retry = true;
        draft.startedBy = by;
        draft.state = 'queued';
        draft.since = now;
        delete draft.stalledBy;
        delete draft.disarmed;
        delete draft.startError;
      });
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
    await this.scheduler.sendContinue(topic.id, item.id, by);
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
    const result = await this.ctx.services.worktrees.updateFromMain(item.worktreeId);
    const agents = this.ctx.services.agents;
    agents.append(sessionId, lineEvent(msg('conversation.resolveRequested', { name: by.displayName })));
    agents.append(sessionId, lineEvent(msg('conversation.conflict.merged', { count: result.conflicted.length })));
    const sent = await agents.send(sessionId, { kind: 'smurg', purpose: 'resolve-conflict', text: resolveConflictMessage({ conflicted: result.conflicted }), by });
    this.core.updateItem(topic.id, item.id, (draft) => {
      draft.nudged = false;
      delete draft.fix;
    });
    this.ctx.audit.record({ actor: principal.actor, action: 'plan.item.resolve', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, sessionId, messageId: sent.messageId, conflicted: result.conflicted.length } });
    this.core.publish(topic.id);
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
