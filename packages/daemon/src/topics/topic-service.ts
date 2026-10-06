// TopicService (ARCHITECTURE §5.10): the topics of a workspace. A topic is a folder `specs/<slug>/` in the MAIN
// workspace with its discussion session; its phase is derived from facts (does SPEC.md exist, does PLAN.md parse, was
// an item started, is every item reviewed), never set by a request. What this file adds to the shared state
// (core.ts): creating and renaming, archiving and deleting, the restart of a lost discussion, "Ask the agent to
// revise", "Write the spec now", the kinds of commands always allowed in every session of the topic, hand edits of
// the two files, and what goes with a member who is removed.
import { mkdir, rmdir } from 'node:fs/promises';
import {
  HAND_EDITS_MAX,
  MAIN_ROOT,
  MESSAGE_TEXT_MAX_CHARS,
  REMEMBERED_RULES_MAX,
  SmurgError,
  TOPICS_MAX,
  TOPIC_SLUG_PATTERN,
  agentTextWithin,
  can,
  checkRememberableRule,
  defaultPermissionMode,
  lineEvent,
  noticeEvent,
  ruleString,
  slugFromName,
  takeListPage,
  topicDirPath,
  topicSpecPath,
  topicPlanPath,
  unmergedError,
  userRefSchema,
  wireText,
  type Actor,
  type AgentSession,
  type FileRef,
  type HandEdit,
  type LockInfo,
  type Question,
  type RememberedRule,
  type Role,
  type SessionInfo,
  type Suggestion,
  type Topic,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { AttentionFact, MemberChange, OutboundMessage, Principal, Req, Res, TopicRemoval, TopicService, UserId } from '../core/interfaces.ts';
import { newId } from '../core/lifecycle.ts';
import { SYSTEM_ACTOR, SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { userRefOf, type TopicsCore } from './core.ts';
import { discussionRolePrompt, restartDiscussionMessage, writeSpecMessage, type EarlierDecision } from './prompts.ts';
import type { StoredTopic } from './store.ts';
import { EMPTY_HASH } from './text.ts';

/** Activity kinds that are a write of the file they name (a hand edit of SPEC.md / PLAN.md unless the discussion agent made it). */
const WRITE_KINDS: ReadonlySet<string> = new Set(['agent.edit', 'human.edit', 'file.create', 'file.delete', 'file.rename', 'file.upload', 'external.change']);

function decisionsOf(questions: readonly Question[]): EarlierDecision[] {
  const out: EarlierDecision[] = [];
  for (const question of questions) {
    if (question.answer === undefined) continue;
    question.parts.forEach((part, index) => {
      const answer = question.answer?.parts[index];
      if (answer === undefined) return;
      const chosen = (answer.options ?? []).flatMap((option) => (part.options[option] === undefined ? [] : [part.options[option].label]));
      out.push({ question: part.text, chosen, ...(answer.other === undefined ? {} : { other: answer.other }) });
    });
  }
  return out;
}

export class TopicServiceImpl implements TopicService {
  private readonly ctx: DaemonContext;
  private readonly core: TopicsCore;
  /** Discussion sessions this service is ending itself (a restart, an archive): their end is not a lost discussion. */
  private readonly ending = new Set<string>();
  /** Files of a discussion the agent is waiting for: the notice `conversation.locked.spec` is written once per wait. */
  private readonly lockNoticed = new Set<string>();

  constructor(ctx: DaemonContext, core: TopicsCore) {
    this.ctx = ctx;
    this.core = core;
  }

  // ===================================================================================================================
  // Create, list, rename
  // ===================================================================================================================

  async create(input: Req<'topic.create'>, principal: Principal): Promise<{ readonly topic: Topic; readonly session: AgentSession }> {
    const createdBy = userRefOf(principal);
    const topics = this.core.topics();
    if (topics.length >= TOPICS_MAX) throw new SmurgError('conflict', msg('topic.limit', { max: TOPICS_MAX }), { reason: 'topic-limit' });
    if (input.slug !== undefined && !TOPIC_SLUG_PATTERN.test(input.slug)) throw new SmurgError('bad_request', msg('topic.badSlug'), { reason: 'bad-slug' });
    const taken = topics.map((topic) => topic.slug);
    const slug = input.slug ?? slugFromName(input.name, taken);
    if (taken.includes(slug)) throw new SmurgError('conflict', msg('topic.slugTaken'), { reason: 'slug-taken' });
    let firstMessage: OutboundMessage | undefined;
    if (input.firstMessage !== undefined) {
      const text = agentTextWithin(input.firstMessage, MESSAGE_TEXT_MAX_CHARS);
      if (!text.ok) throw new SmurgError(text.reason === 'too-long' ? 'too_large' : 'bad_request', msg('session.text.invalid'), { reason: text.reason });
      firstMessage = { kind: 'person', from: principal, text: text.text, cleaned: text.cleaned, origin: 'composer' };
    }
    // The folder is the topic's: it must not exist yet (also under another spelling on a case-insensitive disk).
    const dir = await this.ctx.paths.resolve({ root: MAIN_ROOT, path: topicDirPath(slug) }, { principal: SYSTEM_PRINCIPAL, forWrite: true, audit: false });
    if (dir.exists) throw new SmurgError('conflict', msg('topic.folderExists', { path: topicDirPath(slug) }), { reason: 'folder-exists' });
    await mkdir(dir.realPath, { recursive: true });

    const id = newId('tp');
    const now = this.ctx.clock.now();
    const stored: StoredTopic = {
      id,
      name: input.name,
      slug,
      archived: false,
      createdBy,
      createdAt: now,
      discussion: 'live',
      discussionSessions: [],
      spec: { exists: false, hash: EMPTY_HASH },
      handEdits: { spec: [], plan: [] },
      rules: [],
      plan: { exists: false, hash: EMPTY_HASH, valid: false, parsed: false, fingerprint: '', revision: 0, mode: 'assigned', paused: false, warnings: [], people: [] },
      items: [],
    };
    // The topic exists (and is announced) BEFORE its discussion session, so a listener of `session.created` finds it.
    this.core.addTopic(stored);
    this.core.publish(id);
    let session: AgentSession;
    try {
      session = await this.startDiscussion(stored, principal, 'conversation.started.discussion', firstMessage);
    } catch (err) {
      // No discussion, no topic: the name and the folder are free again.
      this.ctx.bus.emit('topic.removed', { topicId: id, sessionIds: [] });
      this.core.removeTopic(id);
      this.ctx.hub.broadcast('topic.removed', { topicId: id });
      await rmdir(dir.realPath).catch(() => {});
      throw err;
    }
    this.core.update(id, (topic) => {
      topic.discussionSessionId = session.id;
      topic.discussionSessions.push(session.id);
    });
    this.ctx.audit.record({ actor: principal.actor, action: 'topic.create', outcome: 'ok', target: id, detail: { topicId: id, slug, name: input.name, sessionId: session.id } });
    this.core.publish(id);
    return { topic: this.core.toTopic(this.core.need(id)), session };
  }

  list(input: Req<'topic.list'>): Res<'topic.list'> {
    const archived = input.archived ?? false;
    const page = takeListPage(
      this.core.topics().filter((topic) => topic.archived === archived),
      input.after,
      (topic) => topic.id,
    );
    return { topics: page.items.map((topic) => this.core.toTopic(topic)), hasMore: page.hasMore };
  }

  get(topicId: string): Topic | null {
    const topic = this.core.topic(topicId);
    return topic === null ? null : this.core.toTopic(topic);
  }

  bySession(sessionId: string): Topic | null {
    const own = this.core.bySession(sessionId);
    if (own !== null) return this.core.toTopic(own.topic);
    const agents = this.ctx.services.agents;
    const topicId = isStubService(agents) ? undefined : agents.facts(sessionId)?.topicId;
    return topicId === undefined ? null : this.get(topicId);
  }

  async rename(input: Req<'topic.rename'>, principal: Principal): Promise<Topic> {
    const topic = this.core.needOpen(input.topicId);
    if (topic.name === input.name) return this.core.toTopic(topic);
    this.core.update(topic.id, (draft) => {
      draft.name = input.name;
    });
    const agents = this.ctx.services.agents;
    if (!isStubService(agents)) for (const session of agents.list({ topicId: topic.id })) agents.setLabels(session.id, { topicName: input.name });
    this.ctx.audit.record({ actor: principal.actor, action: 'topic.rename', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, slug: topic.slug, name: input.name } });
    this.core.publish(topic.id);
    return this.core.toTopic(this.core.need(topic.id));
  }

  // ===================================================================================================================
  // Archive, delete
  // ===================================================================================================================

  async archive(input: Req<'topic.archive'>, principal: Principal): Promise<Topic> {
    const topic = this.core.need(input.topicId);
    if (topic.archived === input.archived) return this.core.toTopic(topic);
    const audit = (extra: Record<string, unknown>): void => {
      this.ctx.audit.record({ actor: principal.actor, action: 'topic.archive', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, slug: topic.slug, name: topic.name, archived: input.archived, ...extra } });
    };
    if (!input.archived) {
      // Restored: its sessions ended with the archive, so the discussion must be restarted before anything goes on.
      const now = this.ctx.clock.now();
      this.core.update(topic.id, (draft) => {
        draft.archived = false;
        draft.discussion = 'lost';
        draft.lostAt = now;
      });
      audit({});
      this.core.publish(topic.id);
      void this.core.refreshFiles(topic.id);
      return this.core.toTopic(this.core.need(topic.id));
    }
    // Worktrees with changes that were never merged need a decision before anything changes.
    const worktrees = this.ctx.services.worktrees;
    const unmerged = isStubService(worktrees) ? [] : worktrees.unmerged(topic.id);
    if (unmerged.length > 0 && input.deleteUnmerged === undefined) {
      throw unmergedError(
        unmerged.flatMap((worktree) => (worktree.itemId === undefined ? [] : [{ itemId: worktree.itemId, worktreeId: worktree.id, branch: worktree.branch }])),
        msg('topic.archive.unmerged', { count: unmerged.length }),
      );
    }
    const now = this.ctx.clock.now();
    this.core.generating.delete(topic.id);
    this.core.update(topic.id, (draft) => {
      draft.archived = true;
      draft.plan.paused = false;
      delete draft.plan.pausedAt;
      for (const item of draft.items) {
        if (!item.armed) continue;
        // Nothing starts by itself in an archived topic.
        item.armed = false;
        item.retry = false;
        item.state = item.sessions.length > 0 ? 'stopped' : 'not-started';
        item.since = now;
      }
    });
    const agents = this.ctx.services.agents;
    const ended: string[] = [];
    if (!isStubService(agents)) {
      for (const session of agents.list({ topicId: topic.id })) {
        if (session.status === 'ended') continue;
        this.ending.add(session.id);
        try {
          await agents.end(session.id, { by: principal.actor, reason: 'archived', keepWorktree: true });
          ended.push(session.id);
        } finally {
          this.ending.delete(session.id);
        }
      }
    }
    // Item worktrees leave with the archive, except those the member chose to keep.
    const keep = new Set(input.deleteUnmerged === false ? unmerged.map((worktree) => worktree.id) : []);
    const released: string[] = [];
    if (!isStubService(worktrees)) {
      for (const worktree of worktrees.list()) {
        if (worktree.topicId !== topic.id || worktree.itemId === undefined || keep.has(worktree.id)) continue;
        try {
          await worktrees.releaseItem(worktree.id);
          released.push(worktree.id);
        } catch (err) {
          this.ctx.log.warn('item worktree not released', { worktree: worktree.id, error: err instanceof Error ? err.name : 'unknown' });
        }
      }
    }
    this.core.update(topic.id, (draft) => {
      for (const item of draft.items) if (item.worktreeId !== undefined && released.includes(item.worktreeId)) delete item.worktreeId;
    });
    audit({ sessions: ended.length, worktreesRemoved: released.length, worktreesKept: keep.size });
    this.core.publish(topic.id);
    this.core.requestSchedule();
    return this.core.toTopic(this.core.need(topic.id));
  }

  async delete(input: Req<'topic.delete'>, principal: Principal): Promise<void> {
    const topic = this.core.need(input.topicId);
    if (!topic.archived) throw new SmurgError('conflict', msg('topic.delete.notArchived'), { reason: 'not-archived' });
    const worktrees = this.ctx.services.worktrees;
    if (!isStubService(worktrees) && worktrees.listMerges(SYSTEM_PRINCIPAL).some((request) => request.topicId === topic.id && request.status === 'pending')) {
      throw new SmurgError('conflict', msg('topic.delete.openMerge'), { reason: 'open-merge' });
    }
    const agents = this.ctx.services.agents;
    const sessionIds = [
      ...new Set([...(isStubService(agents) ? [] : agents.list({ topicId: topic.id }).map((session) => session.id)), ...topic.discussionSessions, ...topic.items.flatMap((item) => item.sessions)]),
    ];
    // FIRST the event (listeners can still map the sessions), THEN the transcripts, THEN the topic's own records.
    this.ctx.bus.emit('topic.removed', { topicId: topic.id, sessionIds });
    if (!isStubService(agents)) await agents.forget(sessionIds);
    this.core.removeTopic(topic.id);
    this.ctx.hub.broadcast('topic.removed', { topicId: topic.id });
    this.ctx.audit.record({ actor: principal.actor, action: 'topic.delete', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, slug: topic.slug, name: topic.name, sessions: sessionIds.length } });
    this.core.publishAttention();
  }

  // ===================================================================================================================
  // The discussion
  // ===================================================================================================================

  private startDiscussion(topic: StoredTopic, principal: Principal, opening: 'conversation.started.discussion' | 'conversation.discussion.restarted', firstMessage: OutboundMessage | undefined): Promise<AgentSession> {
    // A discussion session exists only in the main root: a worktree's copy of the spec is another document.
    return this.ctx.services.agents.start({
      purpose: 'discussion',
      topic: { id: topic.id, slug: topic.slug, name: topic.name },
      openedBy: principal,
      responsible: null,
      workspace: { mode: 'main' },
      mode: defaultPermissionMode('discussion', MAIN_ROOT),
      rolePrompt: ({ smurgTag }) => discussionRolePrompt({ slug: topic.slug, smurgTag }),
      opening: msg(opening, { name: userRefOf(principal).displayName }),
      ...(firstMessage === undefined ? {} : { firstMessage }),
    });
  }

  /** The session a message for the topic's agent goes to; refused while the discussion is lost (the sentence offers the restart). */
  discussionOf(topic: StoredTopic): string {
    if (topic.discussion === 'lost' || topic.discussionSessionId === undefined) throw new SmurgError('conflict', msg('topic.noDiscussion'), { reason: 'no-discussion' });
    return topic.discussionSessionId;
  }

  async restartDiscussion(input: Req<'topic.discussion.restart'>, principal: Principal): Promise<{ readonly topic: Topic; readonly session: AgentSession }> {
    const topic = this.core.needOpen(input.topicId);
    const by = userRefOf(principal);
    const agents = this.ctx.services.agents;
    const old = topic.discussionSessionId;
    const conversation = this.ctx.services.conversation;
    // What the team decided earlier travels as a quotation, never as smurg's own words.
    const decisions = old === undefined || isStubService(conversation) ? [] : decisionsOf(conversation.answeredQuestions(old));
    if (old !== undefined) {
      const session = agents.get(old);
      if (session !== null && session.status !== 'ended') {
        agents.append(old, lineEvent(msg('conversation.discussion.replaced')));
        this.ending.add(old);
        try {
          await agents.end(old, { by: SYSTEM_ACTOR, reason: 'replaced', keepWorktree: true });
        } finally {
          this.ending.delete(old);
        }
      }
    }
    let session: AgentSession;
    try {
      session = await this.startDiscussion(topic, principal, 'conversation.discussion.restarted', { kind: 'smurg', purpose: 'restart-discussion', text: restartDiscussionMessage({ slug: topic.slug, decisions }), by });
    } catch (err) {
      this.markLost(topic.id);
      throw err;
    }
    this.core.generating.delete(topic.id);
    this.core.update(topic.id, (draft) => {
      draft.discussionSessionId = session.id;
      draft.discussionSessions = [...draft.discussionSessions, session.id].slice(-64);
      draft.discussion = 'live';
      delete draft.lostAt;
    });
    this.ctx.audit.record({ actor: principal.actor, action: 'topic.discussion.restart', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, slug: topic.slug, name: topic.name, sessionId: session.id, ...(old === undefined ? {} : { replaced: old }) } });
    this.core.publish(topic.id);
    return { topic: this.core.toTopic(this.core.need(topic.id)), session };
  }

  private markLost(topicId: string): void {
    const now = this.ctx.clock.now();
    this.core.generating.delete(topicId);
    this.core.update(topicId, (draft) => {
      if (draft.discussion === 'lost') return;
      draft.discussion = 'lost';
      draft.lostAt = now;
    });
    this.core.publish(topicId);
  }

  async revise(input: Req<'topic.revise'>, principal: Principal): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }> {
    const topic = this.core.needOpen(input.topicId);
    const sessionId = this.discussionOf(topic);
    // The conversation module composes the text (the quoted section, the cleaning), checks the mentions, and makes it
    // a message or, for a member without agent access, a suggestion.
    return this.ctx.services.conversation.sendAs(principal, {
      sessionId,
      text: input.text,
      origin: 'revise',
      target: input.target,
      topicId: topic.id,
      ...(input.quote === undefined ? {} : { quote: input.quote }),
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
    });
  }

  async requestSpec(input: Req<'topic.spec.request'>, principal: Principal): Promise<void> {
    const topic = this.core.needOpen(input.topicId);
    const sessionId = this.discussionOf(topic);
    const by = userRefOf(principal);
    const agents = this.ctx.services.agents;
    agents.append(sessionId, lineEvent(msg('conversation.specRequested', { name: by.displayName })));
    const sent = await agents.send(sessionId, { kind: 'smurg', purpose: 'write-spec', text: writeSpecMessage(), by });
    this.ctx.audit.record({ actor: principal.actor, action: 'topic.spec.request', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, slug: topic.slug, name: topic.name, sessionId, messageId: sent.messageId } });
  }

  // ===================================================================================================================
  // Always-allowed kinds of commands, for every session of the topic
  // ===================================================================================================================

  async addRule(input: Req<'topic.rule.add'>, principal: Principal): Promise<Topic> {
    await this.rememberRule(input.topicId, { tool: input.tool, pattern: input.pattern }, principal);
    return this.core.toTopic(this.core.need(input.topicId));
  }

  async rememberRule(topicId: string, rule: { readonly tool: 'Bash' | 'WebFetch'; readonly pattern: string }, by: Principal): Promise<RememberedRule> {
    const topic = this.core.needOpen(topicId);
    // Only the two checked forms are ever remembered, whoever asks (the check is repeated here on purpose).
    const check = checkRememberableRule(rule.tool, rule.pattern);
    if (!check.ok) throw new SmurgError('bad_request', msg('rule.notAllowed'), { reason: check.reason });
    const existing = topic.rules.find((candidate) => candidate.tool === check.rule.tool && candidate.pattern === check.rule.pattern);
    if (existing !== undefined) return { ...existing };
    if (topic.rules.length >= REMEMBERED_RULES_MAX) throw new SmurgError('conflict', msg('rule.limit', { max: REMEMBERED_RULES_MAX }), { reason: 'rule-limit' });
    const remembered: RememberedRule = { id: newId('rl'), tool: check.rule.tool, pattern: check.rule.pattern, scope: 'topic', addedBy: userRefOf(by), addedAt: this.ctx.clock.now() };
    this.core.update(topic.id, (draft) => {
      draft.rules.push(remembered);
    });
    this.ctx.audit.record({ actor: by.actor, action: 'topic.rule.add', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, ruleId: remembered.id, rule: ruleString(remembered) } });
    this.core.publish(topic.id);
    return { ...remembered };
  }

  async removeRule(input: Req<'topic.rule.remove'>, principal: Principal): Promise<Topic> {
    const topic = this.core.needOpen(input.topicId);
    const rule = topic.rules.find((candidate) => candidate.id === input.ruleId);
    if (rule === undefined) throw new SmurgError('not_found', msg('rule.notFound'), { reason: 'unknown-rule' });
    this.dropRules(topic.id, [rule], principal.actor);
    this.core.publish(topic.id);
    return this.core.toTopic(this.core.need(topic.id));
  }

  /** Removes rules, audits each, and lets the topic's sessions start again without them at their next idle moment. */
  private dropRules(topicId: string, rules: readonly RememberedRule[], by: Actor): void {
    if (rules.length === 0) return;
    const gone = new Set(rules.map((rule) => rule.id));
    this.core.update(topicId, (draft) => {
      draft.rules = draft.rules.filter((rule) => !gone.has(rule.id));
    });
    for (const rule of rules) {
      this.ctx.audit.record({ actor: by, action: 'topic.rule.remove', outcome: 'ok', target: topicId, detail: { topicId, ruleId: rule.id, rule: ruleString(rule), addedBy: rule.addedBy.userId } });
    }
    const agents = this.ctx.services.agents;
    if (isStubService(agents)) return;
    for (const session of agents.list({ topicId })) {
      if (session.status === 'ended') continue;
      void agents.restartProcess(session.id, 'rules').catch((err: unknown) => {
        this.ctx.log.warn('session not restarted after a rule went', { session: session.id, error: err instanceof Error ? err.name : 'unknown' });
      });
    }
  }

  rules(topicId: string): readonly RememberedRule[] {
    return (this.core.topic(topicId)?.rules ?? []).map((rule) => ({ ...rule }));
  }

  // ===================================================================================================================
  // When a member goes
  // ===================================================================================================================

  memberRemoved(userId: UserId, change: MemberChange, to?: Role): TopicRemoval {
    if (!this.core.started) return { rules: [], disarmed: [] };
    const keeps = (capability: 'session.drive' | 'session.create' | 'discuss'): boolean => change === 'role-changed' && to !== undefined && can(to, capability);
    const removedRules: string[] = [];
    const disarmed: { topicId: string; itemId: string }[] = [];
    const now = this.ctx.clock.now();
    for (const topic of this.core.topics()) {
      let changed = false;
      // What they put in place goes with them: the kinds of commands they always allowed in this topic …
      if (!keeps('session.drive')) {
        const theirs = topic.rules.filter((rule) => rule.addedBy.userId === userId);
        if (theirs.length > 0) {
          removedRules.push(...theirs.map((rule) => ruleString(rule)));
          this.dropRules(topic.id, theirs, SYSTEM_ACTOR);
          changed = true;
        }
      }
      // … and the work items they armed that have not started.
      if (!keeps('session.create')) {
        for (const item of topic.items) {
          if (!item.armed || item.startedBy?.userId !== userId) continue;
          this.core.updateItem(topic.id, item.id, (draft) => {
            draft.armed = false;
            draft.retry = false;
            draft.disarmed = 'starter-removed';
            draft.startError = wireText(msg('plan.item.disarmed.starter', { name: item.startedBy?.displayName ?? '' }));
            draft.state = draft.sessions.length > 0 ? 'stopped' : 'not-started';
            draft.since = now;
          });
          this.ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'scheduler.disarm', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, itemId: item.id, reason: 'starter-removed', startedBy: userId } });
          disarmed.push({ topicId: topic.id, itemId: item.id });
          changed = true;
        }
      }
      // Plan records that name them: an item without a session, and the people the agent may propose.
      if (!keeps('discuss') && (topic.items.some((item) => item.sessionId === undefined && item.responsible?.userId === userId) || topic.plan.people.some((person) => person.userId === userId))) {
        this.core.update(topic.id, (draft) => {
          for (const item of draft.items) {
            if (item.sessionId !== undefined || item.responsible?.userId !== userId) continue;
            item.responsible = null;
            item.chosen = false;
          }
          draft.plan.people = draft.plan.people.filter((person) => person.userId !== userId);
        });
        changed = true;
      }
      if (changed) this.core.publish(topic.id);
    }
    return { rules: removedRules, disarmed };
  }

  attention(): AttentionFact[] {
    return this.core.attention();
  }

  // ===================================================================================================================
  // What the bus tells this service
  // ===================================================================================================================

  /**
   * Every change of a topic's two files that was not the discussion agent's is a hand edit (since the last confirmed
   * Start): typing in the editor, `file.write`, an upload, a rename or move into place or away, a delete, and a change
   * no member made through smurg (`'outside'`: an outside program, another agent session).
   */
  onActivity(entry: { readonly actor: Actor; readonly kind: string; readonly file?: FileRef; readonly at: number; readonly renamedFrom?: string }): void {
    if (!this.core.started || entry.file === undefined || !WRITE_KINDS.has(entry.kind)) return;
    const hits = [this.core.topicFileOf(entry.file), entry.renamedFrom === undefined ? null : this.core.topicFileOf({ root: entry.file.root, path: entry.renamedFrom })];
    for (const hit of hits) {
      if (hit === null || hit.topic.archived) continue;
      const { topic, kind } = hit;
      this.core.noteWriter(topic.id, kind, entry.actor);
      const byDiscussion = entry.actor.kind === 'agent' && topic.discussionSessions.includes(entry.actor.sessionId);
      if (!byDiscussion) {
        // A person is named (as the member directory knows them); an outside program or another agent session is `outside`.
        const named = entry.actor.kind === 'user' ? userRefSchema.safeParse(this.ctx.members.userRef(entry.actor.userId) ?? { userId: entry.actor.userId, displayName: entry.actor.displayName }) : null;
        const edit: HandEdit = { by: named !== null && named.success ? named.data : 'outside', at: entry.at };
        this.core.update(topic.id, (draft) => {
          const list = draft.handEdits[kind];
          const same = (other: HandEdit): boolean => (typeof other.by === 'string' || typeof edit.by === 'string' ? other.by === edit.by : other.by.userId === edit.by.userId);
          // One entry per person, with the time of their newest edit; the oldest entry goes when the list is full.
          const kept = list.filter((other) => !same(other));
          kept.push(edit);
          draft.handEdits[kind] = kept.slice(-HAND_EDITS_MAX);
        });
        this.core.publish(topic.id);
      }
      this.scheduleRefresh(topic.id);
    }
  }

  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Reads a topic's files again after the debounce (changes on disk coalesce into one read). */
  scheduleRefresh(topicId: string): void {
    if (this.refreshTimers.has(topicId)) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(topicId);
      void this.core.refreshFiles(topicId).catch((err: unknown) => {
        this.ctx.log.error('topic files not read', { topic: topicId, error: err instanceof Error ? err.name : 'unknown' });
      });
    }, this.core.options.fileDebounceMs);
    timer.unref();
    this.refreshTimers.set(topicId, timer);
  }

  stop(): void {
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
  }

  /** A file of the main workspace changed on disk (the watcher), or a document was saved. */
  onFileChanged(file: FileRef): void {
    if (!this.core.started) return;
    const hit = this.core.topicFileOf(file);
    if (hit !== null && !hit.topic.archived) this.scheduleRefresh(hit.topic.id);
  }

  /**
   * The discussion agent wanted to edit the spec or the plan while someone is typing in it: people see why it waits
   * (and can let it go first). One notice per wait; the next granted edit of that file ends the wait.
   */
  onToolPre(event: { readonly sessionId: string; readonly file: FileRef | null; readonly outcome: 'granted' | 'denied'; readonly holder?: LockInfo }): void {
    if (!this.core.started || event.file === null) return;
    const hit = this.core.topicFileOf(event.file);
    if (hit === null || hit.topic.discussionSessionId !== event.sessionId) return;
    const key = `${event.sessionId}:${hit.kind}`;
    if (event.outcome === 'granted') {
      this.lockNoticed.delete(key);
      return;
    }
    if (this.lockNoticed.has(key) || event.holder === undefined || event.holder.kind !== 'human') return;
    this.lockNoticed.add(key);
    const path = hit.kind === 'spec' ? topicSpecPath(hit.topic.slug) : topicPlanPath(hit.topic.slug);
    // (Clipped so the reference always fits the wire.)
    const holders = event.holder.holders.slice(0, 5).map((holder) => holder.displayName.slice(0, 80));
    try {
      this.ctx.services.agents.append(event.sessionId, noticeEvent('info', msg('conversation.locked.spec', { path, holders })));
    } catch (err) {
      this.ctx.log.debug('lock notice not written', { session: event.sessionId, error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  /**
   * A topic's discussion is LOST when its session ended (the host terminated it) or failed to start three times in a
   * row; an ordinary crash is not this case (a failed session resumes with the next message). The spec and plan
   * toolbars then offer "Restart discussion", and the host and the topic's creator get an attention item.
   */
  onSession(session: SessionInfo, ended: boolean): void {
    if (!this.core.started || session.kind !== 'agent' || session.purpose !== 'discussion' || session.topicId === undefined) return;
    const topic = this.core.topic(session.topicId);
    if (topic === null || topic.discussionSessionId !== session.id || this.ending.has(session.id)) return;
    if (ended || (session.status === 'failed' && session.retryHostOnly === true)) {
      this.markLost(topic.id);
      return;
    }
    // The host got a session going again that had failed for good: the discussion is back.
    if (topic.discussion === 'lost' && session.status !== 'failed' && session.status !== 'ended') {
      this.core.update(topic.id, (draft) => {
        draft.discussion = 'live';
        delete draft.lostAt;
      });
      this.core.publish(topic.id);
    }
  }
}
