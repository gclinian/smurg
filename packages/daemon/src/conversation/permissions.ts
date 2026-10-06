// Permission requests (ARCHITECTURE §5.9; DESIGN §2.5, §2.6, §3.6). An agent's `can_use_tool` request that reached the
// daemon on the session's own pipe becomes a CARD a member with agent access answers, or is answered by the daemon
// itself. A card exists only for a request the runner announced (`agent.request`); the daemon answers only ids it
// holds open; an agent can neither create nor settle a card.
//
// Requests the daemon answers itself, each audited `permission.auto`:
//   - anything but a question from a DISCUSSION session                       → deny
//   - a write to Claude Code's configuration or to a file the trust gate records → deny ("the host edits these")
//   - a request whose suggested rule is exactly a rule of the session's topic  → allow, with that rule for this process
//   - an edit tool in a main-workspace session in `ask-commands`               → allow, after the host-only check and
//                                                                                 the lock (a held file: deny)
//   - content too large to show whole                                          → deny (never clipped)
//
// A person never allows what they cannot see: a command whole, an edit as the diff it would make, any other tool's
// whole input. The first answer wins; a later one gets `settledError`. "Always allow" never takes a rule from a
// client: it uses the rule the card showed, which passed rules.ts when the card was built and passes it again here.
import {
  COMMAND_MAX_BYTES,
  DENY_MESSAGE_MAX_CHARS,
  EVENT_TEXT_MAX_BYTES,
  PERMISSION_INPUT_MAX_BYTES,
  REMEMBERED_RULES_MAX,
  SmurgError,
  URL_MAX_CHARS,
  can,
  checkRememberableRule,
  isEditTool,
  isHostPrivatePath,
  lineEvent,
  lockedError,
  mayAllowForTopic,
  mayDecidePermission,
  offerAlwaysRule,
  permissionWhat,
  rootRefEquals,
  ruleString,
  settledError,
  type AgentSession,
  type AlwaysScope,
  type CardWithdrawnReason,
  type FileRef,
  type OfferedRule,
  type PermissionRequest,
  type RememberedRule,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { AgentLockResult, AgentRequest, AgentSessionFacts, Principal, Req } from '../core/interfaces.ts';
import { newId } from '../core/lifecycle.ts';
import { SYSTEM_ACTOR, SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { DISCUSSION_NO_TOOLS, DUPLICATE_REQUEST, HOST_EDITS_CONFIG, NOT_SHOWABLE, SESSION_GONE, TOO_LARGE_TO_SHOW, deniedByPerson } from './agent-sentences.ts';
import type { CardsStore } from './cards-store.ts';
import { DIFF_MAX_CHARS, changeDiff } from './change-diff.ts';
import {
  isClaudeConfigPath,
  isHostHomePath,
  isHostPathInRoot,
  memberCopy,
  namesClaudeConfig,
  shownInput,
  shownReason,
  shownText,
  shownToolName,
  shownUrl,
  utf8Bytes,
} from './permission-card.ts';
import { actingMember, cleanPersonText, refOf } from './session-facts.ts';

type PermissionAgentRequest = Extract<AgentRequest, { kind: 'permission' }>;
type AgentDecision = Parameters<DaemonContext['services']['agents']['decidePermission']>[2];
/** Which automatic answer a request got (the audit entry `permission.auto`). */
export type AutoAnswer = 'discussion' | 'claude-config' | 'topic-rule' | 'main-edit' | 'main-edit-locked' | 'too-large' | 'not-showable';

type Assessment =
  | { readonly kind: 'card'; readonly card: PermissionRequest }
  | { readonly kind: 'auto'; readonly answer: AutoAnswer; readonly decision: AgentDecision; readonly path?: string; readonly rule?: string };

/** The label of a file a card cannot name (outside every root, or the host's private data). */
const UNNAMED_FILE = 'file';
/**
 * The runner's tool view cuts a target at the wire's limit (at a character boundary: up to three bytes below it), so a
 * target that long may not be the whole command. Such a command is not shown: it is denied.
 */
const COMMAND_SHOWN_MAX_BYTES = COMMAND_MAX_BYTES - 4;

function isHostPathPrivate(file: FileRef): boolean {
  return isHostPrivatePath(file.path);
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

export class Permissions {
  private readonly ctx: DaemonContext;
  private readonly store: CardsStore;
  /** Requests whose card is being built: a withdrawal that arrives meanwhile is remembered here. */
  private readonly pending = new Map<string, { withdrawn: boolean }>();
  /** One decision at a time per card (the first answer wins, also across an await). */
  private readonly deciding = new Map<string, Promise<void>>();

  constructor(ctx: DaemonContext, store: CardsStore) {
    this.ctx = ctx;
    this.store = store;
  }

  // =================================================================================================================
  // From the agent
  // =================================================================================================================

  /** `agent.request` with a permission request: a card, or an automatic answer. Never throws; fails closed (a denial). */
  async raise(sessionId: string, request: PermissionAgentRequest): Promise<void> {
    const agents = this.ctx.services.agents;
    const existing = this.store.get(request.id);
    if (this.pending.has(request.id)) return;
    if (existing !== null) {
      if (existing.kind === 'permission' && existing.request.status === 'open' && existing.request.sessionId === sessionId) return;
      this.refuse(sessionId, request.id, DUPLICATE_REQUEST);
      return;
    }
    const session = agents.get(sessionId);
    const facts = agents.facts(sessionId);
    if (session === null || facts === null) {
      this.refuse(sessionId, request.id, SESSION_GONE);
      return;
    }
    // A discussion session reads the project, writes its two files and asks: nothing else, whatever asked.
    if (session.purpose === 'discussion') {
      this.auto(session, request, { kind: 'auto', answer: 'discussion', decision: { allow: false, message: DISCUSSION_NO_TOOLS } });
      return;
    }
    const entry = { withdrawn: false };
    this.pending.set(request.id, entry);
    try {
      const assessment = await this.assess(session, facts, request);
      if (entry.withdrawn) return;
      if (assessment.kind === 'auto') this.auto(session, request, assessment);
      else this.open(assessment.card);
    } catch (err) {
      this.ctx.log.error('a permission request could not be shown; it is denied', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
      if (!entry.withdrawn) this.auto(session, request, { kind: 'auto', answer: 'not-showable', decision: { allow: false, message: NOT_SHOWABLE } });
    } finally {
      this.pending.delete(request.id);
    }
  }

  /** Claude Code withdrew the request, or the daemon restarted. False: nothing open has this id. */
  withdraw(id: string, reason: CardWithdrawnReason, options: { readonly silent?: boolean } = {}): boolean {
    const pending = this.pending.get(id);
    if (pending !== undefined) {
      pending.withdrawn = true;
      return true;
    }
    const request = this.store.permission(id);
    if (request === null || request.status !== 'open') return false;
    const next: PermissionRequest = { ...request, status: 'withdrawn', withdrawn: { reason, at: this.ctx.clock.now() } };
    if (options.silent === true) this.store.put({ kind: 'permission', request: next });
    else this.commit(next, request);
    return true;
  }

  // =================================================================================================================
  // From people
  // =================================================================================================================

  /** `permission.decide`. Decisions on one card run one after the other, so the first one wins also across an await. */
  decide(input: Req<'permission.decide'>, principal: Principal): Promise<PermissionRequest> {
    const before = this.deciding.get(input.requestId) ?? Promise.resolve();
    const result = before.then(() => this.decideNow(input, principal));
    const tail = result.then(
      () => {},
      () => {},
    );
    this.deciding.set(input.requestId, tail);
    void tail.then(() => {
      if (this.deciding.get(input.requestId) === tail) this.deciding.delete(input.requestId);
    });
    return result;
  }

  private async decideNow(input: Req<'permission.decide'>, principal: Principal): Promise<PermissionRequest> {
    const agents = this.ctx.services.agents;
    const member = actingMember(this.ctx, principal);
    if (!can(member.role, 'session.drive')) throw new AuthorizationError(undefined, { reason: 'capability' });
    let request = this.requireOpen(input.requestId);
    if (!mayDecidePermission(member, { hostOnly: request.hostOnly })) throw new AuthorizationError(msg('permission.hostOnly'), { reason: 'host-only' }, 'host_only');
    const session = agents.get(request.sessionId);
    const facts = agents.facts(request.sessionId);
    if (session === null || facts === null) throw new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' });
    const allow = input.decision !== 'deny';
    const message = !allow && input.message !== undefined ? cleanPersonText(input.message, DENY_MESSAGE_MAX_CHARS).text : undefined;

    // "Always allow this kind": the rule the card showed, checked again; stored BEFORE the agent is answered, so a
    // refusal (a limit, the topic module) leaves the card open.
    let rule: OfferedRule | undefined;
    let scope: AlwaysScope | undefined;
    if (input.decision === 'allow-always') {
      scope = input.scope ?? 'session';
      const offered = request.alwaysRule;
      const check = offered === undefined || request.hostOnly ? null : checkRememberableRule(offered.tool, offered.pattern);
      if (check === null || !check.ok) throw new SmurgError('conflict', msg('permission.noAlways'), { reason: 'no-always' });
      rule = check.rule;
      if (scope === 'topic') await this.rememberForTopic(session, rule, principal, member.role);
      else await this.rememberForSession(session, rule, principal);
      // The card may have been settled or withdrawn while the rule was stored.
      request = this.requireOpen(input.requestId);
    }

    // An edit that waited for a person: the agent lock the gate took may have run out, and a person may type there now.
    if (allow && request.what === 'edit' && request.file !== undefined) {
      const lock = this.relock(session, facts, request.file);
      if (lock !== null && !lock.granted && lock.holder !== null) {
        const holders = lock.holder.kind === 'human' ? lock.holder.holders.map((holder) => holder.displayName) : [lock.holder.agentName];
        throw lockedError(lock.holder, msg('permission.fileBusy', { holders }));
      }
    }

    try {
      agents.decidePermission(session.id, request.id, allow ? { allow: true, ...(rule === undefined ? {} : { sessionRule: rule }) } : { allow: false, message: deniedByPerson(member, message) });
    } catch (err) {
      if (err instanceof SmurgError && err.code === 'conflict') throw settledError({ card: { kind: 'permission', id: request.id }, sessionId: request.sessionId, status: 'withdrawn' }, msg('permission.notOpen'));
      throw err;
    }
    const settled: PermissionRequest = {
      ...request,
      status: allow ? 'allowed' : 'denied',
      decision: { by: refOf(member), at: this.ctx.clock.now(), ...(scope === undefined ? {} : { always: scope }), ...(message === undefined ? {} : { message }) },
    };
    this.commit(settled, request);
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'permission.decide',
      outcome: 'ok',
      target: request.id,
      detail: {
        requestId: request.id,
        sessionId: request.sessionId,
        tool: request.tool,
        what: request.what,
        decision: input.decision,
        hostOnly: request.hostOnly,
        ...(scope === undefined ? {} : { always: scope }),
        ...(rule === undefined ? {} : { rule: ruleString(rule) }),
        ...(request.file === undefined ? {} : { path: request.file.path }),
        ...(request.command === undefined ? {} : { command: request.command }),
        ...(message === undefined ? {} : { message }),
      },
      fullText: ['command', 'message'],
    });
    return this.copyFor(settled, member.role === 'host');
  }

  // =================================================================================================================
  // Kept current by the module
  // =================================================================================================================

  /** The request waited too long, or the one person it waits for is away: it now also reaches the others who may answer. */
  escalate(id: string, at: number): void {
    const request = this.store.permission(id);
    if (request === null || request.status !== 'open' || request.escalatedAt !== undefined) return;
    this.commit({ ...request, escalatedAt: at }, request);
  }

  /** The host's copy as it is, or the copy everyone else gets. */
  copyFor(request: PermissionRequest, forHost: boolean): PermissionRequest {
    return structuredClone(forHost ? request : memberCopy(request));
  }

  // =================================================================================================================
  // A request → a card or an automatic answer
  // =================================================================================================================

  private async assess(session: AgentSession, facts: AgentSessionFacts, request: PermissionAgentRequest): Promise<Assessment> {
    const view = request.view;
    // Where the request points: the file of the tool card (inside a root, not host-private), and whatever absolute
    // paths the tool and Claude Code named.
    const named: { abs: string; ref: FileRef | null }[] = [];
    for (const abs of new Set([request.absPath, request.blockedPath])) {
      if (abs !== undefined) named.push({ abs, ref: await this.fileRefOf(abs) });
    }
    const refs: FileRef[] = [...(view.file === undefined ? [] : [view.file]), ...named.flatMap((entry) => (entry.ref === null ? [] : [entry.ref]))];
    const outside = view.outside === true || named.some((entry) => entry.ref === null);
    const shownPath = refs[0]?.path;
    const trustProtected = (ref: FileRef): boolean => !isStubService(this.ctx.services.projectTrust) && this.ctx.services.projectTrust.protectedPaths(ref.root).has(ref.path);

    // No agent session writes Claude Code's configuration: the host edits those files themselves.
    const writes = isEditTool(request.tool) || view.verb === 'edit' || view.verb === 'create' || view.verb === 'run';
    const configTarget = refs.some((ref) => isClaudeConfigPath(ref.path) || trustProtected(ref));
    const configCommand = view.verb === 'run' && request.reasonType === 'safetyCheck' && named.length === 0 && namesClaudeConfig(view.target ?? '');
    if (writes && (configTarget || configCommand)) {
      return { kind: 'auto', answer: 'claude-config', decision: { allow: false, message: HOST_EDITS_CONFIG }, ...(shownPath === undefined ? {} : { path: shownPath }) };
    }

    // A label for requests smurg recognises as reaching beyond the shared project (not a boundary: D-15).
    const home = this.ctx.config.sessions.hostHome;
    let hostOnly =
      request.reasonType === 'safetyCheck' ||
      outside ||
      refs.some((ref) => isHostPathInRoot(ref) || trustProtected(ref)) ||
      named.some((entry) => isHostHomePath(entry.abs, home, this.ctx.config.stateDir));

    // A rule of the session's topic that this process does not have yet: what a click on "Always allow" would send.
    const suggested = request.suggestedRule;
    if (!hostOnly && suggested !== undefined && session.topicId !== undefined && !isStubService(this.ctx.services.topics)) {
      const check = checkRememberableRule(suggested.tool, suggested.pattern);
      if (check.ok && this.ctx.services.topics.rules(session.topicId).some((known) => known.tool === check.rule.tool && known.pattern === check.rule.pattern)) {
        return { kind: 'auto', answer: 'topic-rule', decision: { allow: true, sessionRule: check.rule }, rule: ruleString(check.rule) };
      }
    }

    // A main-workspace session in `ask-commands` never runs in Claude Code's acceptEdits: its edit tools are allowed
    // here instead, after the host-only check and the lock; every shell write still asks.
    if (!hostOnly && isEditTool(request.tool) && view.file !== undefined && session.root.kind === 'main' && session.permissionMode === 'ask-commands' && rootRefEquals(view.file.root, session.root)) {
      if (await this.agentMayWrite(session, facts, view.file)) {
        const lock = this.relock(session, facts, view.file);
        if (lock !== null && !lock.granted) return { kind: 'auto', answer: 'main-edit-locked', decision: { allow: false, message: lock.reason }, path: view.file.path };
        return { kind: 'auto', answer: 'main-edit', decision: { allow: true }, path: view.file.path };
      }
      hostOnly = true;
    }

    // The card: everything the person who answers has to see, whole.
    const what = permissionWhat(view);
    const tooLarge: Assessment = { kind: 'auto', answer: 'too-large', decision: { allow: false, message: TOO_LARGE_TO_SHOW }, ...(shownPath === undefined ? {} : { path: shownPath }) };
    const content: { command?: string; change?: { text: string }; url?: string; input?: string } = {};
    const wholeInput = (): boolean => {
      const input = shownInput(request.input);
      if (input === null) throw new TypeError('the input of the request is not showable');
      if (utf8Bytes(input) > PERMISSION_INPUT_MAX_BYTES) return false;
      content.input = input;
      return true;
    };
    if (what === 'command' && view.target !== undefined) {
      const command = shownText(view.target);
      if (utf8Bytes(command) > COMMAND_SHOWN_MAX_BYTES) return tooLarge;
      content.command = command;
    } else if ((what === 'edit' || what === 'outside') && request.edit !== undefined) {
      const change = await this.changeText(request.edit, view.file);
      if (utf8Bytes(change) > EVENT_TEXT_MAX_BYTES) return tooLarge;
      content.change = { text: change };
    } else if (what === 'fetch' && shownUrl(view.target, URL_MAX_CHARS) !== undefined) {
      content.url = view.target as string;
    } else if (!wholeInput()) {
      return tooLarge;
    }
    const reason = shownReason(request.reason);
    const path = outside ? named.find((entry) => entry.ref === null)?.abs : undefined;
    const card: PermissionRequest = {
      id: request.id,
      sessionId: session.id,
      askedAt: this.ctx.clock.now(),
      status: 'open',
      tool: shownToolName(request.tool),
      what,
      ...content,
      ...(view.file === undefined ? {} : { file: view.file }),
      ...(outside ? { outside: true as const } : {}),
      ...(path !== undefined && utf8Bytes(path) <= COMMAND_MAX_BYTES && !path.includes('\u0000') ? { path } : {}),
      root: session.root,
      ...(reason === undefined ? {} : { reason }),
      hostOnly,
      ...offerAlwaysRule(suggested, hostOnly),
    };
    return { kind: 'card', card };
  }

  /** The diff an edit would make. The file is read only when the tool card names it (inside a root, not host-private). */
  private async changeText(edit: NonNullable<PermissionAgentRequest['edit']>, file: FileRef | undefined): Promise<string> {
    let current: string | null = null;
    let exists = true;
    // (The runner names no file for a host-private path; checked again here: such a file is never read for a card.)
    if (file !== undefined && !isHostPathPrivate(file)) {
      try {
        const read = await this.ctx.paths.readFile(file, { principal: SYSTEM_PRINCIPAL, audit: false, maxBytes: DIFF_MAX_CHARS });
        current = read.truncated ? null : decodeText(read.bytes);
      } catch (err) {
        if (err instanceof SmurgError && err.code === 'not_found') exists = false;
      }
    }
    return shownText(changeDiff({ label: file?.path ?? UNNAMED_FILE, current, exists, edit }));
  }

  private async fileRefOf(absPath: string): Promise<FileRef | null> {
    try {
      return await this.ctx.paths.toFileRef(absPath);
    } catch {
      return null;
    }
  }

  /** The host-only check of an automatic allow: may THIS session's agent write the file through PathGuard? */
  private async agentMayWrite(session: AgentSession, facts: AgentSessionFacts, file: FileRef): Promise<boolean> {
    const agent = this.ctx.members.agentPrincipal(session.id, facts.ownerUserId, { agentName: this.agentName(session), pathRights: facts.pathRights });
    if (agent === null) return false;
    try {
      await this.ctx.paths.resolve(file, { principal: agent, forWrite: true, audit: false });
      return true;
    } catch {
      return false;
    }
  }

  private agentName(session: AgentSession): string {
    const actor = isStubService(this.ctx.services.sessions) ? null : this.ctx.services.sessions.agentActor(session.id);
    return actor !== null && actor.kind === 'agent' ? actor.displayName : `Claude (${session.openedBy.displayName})`;
  }

  /** Asks for the agent lock again. Null: there is no lock to take (no locks module, or the file is not in the session's root). */
  private relock(session: AgentSession, facts: AgentSessionFacts, file: FileRef): AgentLockResult | null {
    if (isStubService(this.ctx.services.locks) || !rootRefEquals(file.root, session.root)) return null;
    return this.ctx.services.locks.requestAgent({ file, sessionId: session.id, ownerUserId: facts.ownerUserId, agentName: this.agentName(session), sessionRoot: session.root });
  }

  // =================================================================================================================
  // Remembered rules
  // =================================================================================================================

  private async rememberForSession(session: AgentSession, rule: OfferedRule, principal: Principal): Promise<void> {
    const agents = this.ctx.services.agents;
    const rules = agents.rules(session.id);
    if (rules.some((known) => known.tool === rule.tool && known.pattern === rule.pattern)) return;
    if (rules.length >= REMEMBERED_RULES_MAX) throw new SmurgError('conflict', msg('rule.limit', { max: REMEMBERED_RULES_MAX }), { reason: 'rule-limit' });
    const member = actingMember(this.ctx, principal);
    const remembered: RememberedRule = { id: newId('rule'), tool: rule.tool, pattern: rule.pattern, scope: 'session', addedBy: refOf(member), addedAt: this.ctx.clock.now() };
    await agents.setRules(session.id, [...rules, remembered], principal.actor);
    this.line(session.id, msg('conversation.rule.added', { by: member.displayName, rule: ruleString(rule) }));
  }

  private async rememberForTopic(session: AgentSession, rule: OfferedRule, principal: Principal, role: Parameters<typeof mayAllowForTopic>[0]): Promise<void> {
    const topics = this.ctx.services.topics;
    if (session.topicId === undefined || isStubService(topics)) throw new SmurgError('bad_request', msg('permission.topicScope'), { reason: 'topic-scope' });
    if (!mayAllowForTopic(role)) throw new AuthorizationError(msg('permission.topicScope'), { reason: 'topic-scope' });
    if (topics.rules(session.topicId).some((known) => known.tool === rule.tool && known.pattern === rule.pattern)) return;
    await topics.rememberRule(session.topicId, rule, principal);
    const member = actingMember(this.ctx, principal);
    this.line(session.id, msg('conversation.rule.added.topic', { by: member.displayName, rule: ruleString(rule) }));
  }

  // =================================================================================================================
  // Internals
  // =================================================================================================================

  private requireOpen(id: string): PermissionRequest {
    const request = this.store.permission(id);
    if (request === null) throw new SmurgError('not_found', msg('permission.notFound'), { reason: 'unknown-request' });
    if (request.status === 'open') return request;
    throw settledError({ card: { kind: 'permission', id }, sessionId: request.sessionId, status: request.status, ...(request.decision === undefined ? {} : { by: request.decision.by }) }, msg('permission.notOpen'));
  }

  /** A new card: stored, its `card` event in the conversation, the entity to the watchers (the host's copy with `path`). */
  private open(card: PermissionRequest): void {
    this.store.put({ kind: 'permission', request: card });
    try {
      this.ctx.services.agents.append(card.sessionId, { kind: 'card', card: 'permission', id: card.id });
      if (card.what === 'edit' && card.file !== undefined && !isStubService(this.ctx.services.locks)) this.ctx.services.locks.markAwaitingApproval(card.sessionId, card.file);
    } catch (err) {
      this.ctx.log.error('the card event of a permission request was not appended', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    }
    this.announce(card, null);
  }

  /** An automatic answer: the agent is told, the audit log says which answer and why. No card. */
  private auto(session: AgentSession, request: PermissionAgentRequest, assessment: Extract<Assessment, { kind: 'auto' }>): void {
    try {
      this.ctx.services.agents.decidePermission(session.id, request.id, assessment.decision);
    } catch {
      return; // withdrawn meanwhile: nothing was answered
    }
    this.ctx.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'permission.auto',
      outcome: assessment.decision.allow ? 'ok' : 'denied',
      target: session.id,
      detail: {
        sessionId: session.id,
        requestId: request.id,
        tool: shownToolName(request.tool),
        answer: assessment.answer,
        ...(session.topicId === undefined ? {} : { topicId: session.topicId }),
        ...(assessment.path === undefined ? {} : { path: assessment.path }),
        ...(assessment.rule === undefined ? {} : { rule: assessment.rule }),
      },
    });
  }

  private refuse(sessionId: string, requestId: string, message: string): void {
    try {
      this.ctx.services.agents.decidePermission(sessionId, requestId, { allow: false, message });
    } catch {
      // Already withdrawn, or the session is gone: nothing waits for an answer.
    }
  }

  private line(sessionId: string, ref: ReturnType<typeof msg>): void {
    try {
      this.ctx.services.agents.append(sessionId, lineEvent(ref));
    } catch (err) {
      this.ctx.log.error('a system line was not appended', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private commit(next: PermissionRequest, previous: PermissionRequest): void {
    this.store.put({ kind: 'permission', request: next });
    this.announce(next, previous);
  }

  private announce(next: PermissionRequest, previous: PermissionRequest | null): void {
    this.ctx.bus.emit('permission.changed', { request: structuredClone(next), previous: previous === null ? null : structuredClone(previous) });
    try {
      this.ctx.services.agents.toWatchers(next.sessionId, 'permission.updated', { request: memberCopy(next) }, { request: next });
    } catch (err) {
      this.ctx.log.error('a permission update was not sent', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}
