// session.* and exec.* handlers (ARCHITECTURE §5.5, §5.9, §11 D-15; registry checks in brackets). The router has
// already checked the capability of the caller's CURRENT role: `session.drive` (the host, Agent access) types into any
// terminal and drives any agent session; `session.view` watches. What only the member who opened a terminal may do is
// checked here with req.requireOwner (audited authz.denied); who may end an agent session is the registry's rule
// (routing.ts `mayEndSession`).
//
// Also here: the wire's `session.host` (the account state and the main folder's trust state, to everyone), what a
// change of a root's project settings does to its sessions, and the watchers of a channel that is gone.
import {
  EVENTS_PAGE_MAX_BYTES,
  MAIN_ROOT,
  SmurgError,
  mayBeResponsible,
  takeListPage,
  type AgentSession,
  type CardRef,
  type HostState,
  type PermissionRequest,
  type Question,
  type Suggestion,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { RequestContext, Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import { isStubService } from '../core/stubs.ts';
import type { AgentSessionsImpl } from './agent/agent-sessions.ts';
import type { SessionManagerImpl } from './session-manager.ts';

/** The agent session a request names [agent-session]: a terminal is `not-an-agent`, anything else unknown is `not_found`. */
function agentSession(ctx: DaemonContext, sessions: SessionManagerImpl, sessionId: string): AgentSession {
  const session = ctx.services.agents.get(sessionId);
  if (session !== null) return session;
  if (sessions.get(sessionId) !== null) throw new SmurgError('bad_request', msg('session.notAgent'), { reason: 'not-an-agent' });
  throw new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' });
}

/** [session-open]: not ended, and its topic not archived. */
function requireOpen(ctx: DaemonContext, session: AgentSession): void {
  if (session.status === 'ended') throw new SmurgError('conflict', msg('session.ended.noMessages'), { reason: 'ended' });
  if (session.topicId !== undefined && !isStubService(ctx.services.topics) && ctx.services.topics.get(session.topicId)?.archived === true) {
    throw new SmurgError('conflict', msg('topic.archived'), { reason: 'archived' });
  }
}

/** The card part of a page: what the conversation and suggestion services hold, inside what is left of the page. */
function cardsFor(
  ctx: DaemonContext,
  sessionId: string,
  refs: readonly CardRef[],
  usedBytes: number,
  req: RequestContext,
  options: { readonly includeOpen: boolean; readonly atLeastOne?: boolean },
): { questions: Question[]; permissions: PermissionRequest[]; suggestions: Suggestion[]; moreCards: CardRef[] } {
  const budget = Math.max(0, EVENTS_PAGE_MAX_BYTES - usedBytes);
  const cards = isStubService(ctx.services.conversation)
    ? { questions: [], permissions: [], more: [], bytes: 0 }
    : ctx.services.conversation.cards(sessionId, refs, { includeOpen: options.includeOpen, budgetBytes: budget, forHost: req.role === 'host', ...(options.atLeastOne === true ? { atLeastOne: true } : {}) });
  const first = cards.questions.length + cards.permissions.length === 0;
  const suggestions = isStubService(ctx.services.suggestions)
    ? { suggestions: [], more: [], bytes: 0 }
    : ctx.services.suggestions.cards(sessionId, refs, { includeOpen: options.includeOpen, budgetBytes: Math.max(0, budget - cards.bytes), ...(options.atLeastOne === true && first ? { atLeastOne: true } : {}) });
  return { questions: cards.questions, permissions: cards.permissions, suggestions: suggestions.suggestions, moreCards: [...cards.more, ...suggestions.more] };
}

function hostState(ctx: DaemonContext): HostState {
  return { account: ctx.services.agents.account(), mainProjectSettings: isStubService(ctx.services.projectTrust) ? 'none' : ctx.services.projectTrust.state(MAIN_ROOT) };
}

export function registerSessionHandlers(router: Router, ctx: DaemonContext, sessions: SessionManagerImpl, agents: AgentSessionsImpl): Disposable {
  const stack = new DisposableStack();
  /** Unknown sessions are not_found (the ids are visible to every member anyway); others must be the owner. */
  const requireOwner = (sessionId: string, req: RequestContext): void => {
    const owner = sessions.ownerOf(sessionId);
    if (owner === null) return; // an agent session, or unknown: the service decides
    req.requireOwner(owner, 'session');
  };

  // [session.create]: a terminal, or a free agent session; the caller is `openedBy`.
  stack.add(router.handle('session.create', async (payload, req) => ({ session: await sessions.create(payload, req.conn, req.principal) })));
  // [session.view]: every session (with `topicId`: every agent session of that topic), by THE list rule.
  stack.add(
    router.handle('session.list', (payload) => {
      const page = takeListPage(sessions.list(payload.topicId === undefined ? {} : { topicId: payload.topicId }), payload.after, (session) => session.id);
      return { sessions: page.items, hasMore: page.hasMore };
    }),
  );
  // [session.view]: the account state and the main folder's trust state, for every member.
  stack.add(router.handle('session.host.get', () => hostState(ctx)));
  // [session.drive]: any agent session.
  stack.add(router.handle('session.loginStatus', async (payload, req) => ({ login: await sessions.loginStatus(payload.sessionId, req.principal) })));
  // [session.view] (terminal-session): the viewer goes live only after the .ok went out (no gap, no duplicate).
  stack.add(
    router.handle('session.attach', async (payload, req) => {
      const start = await sessions.attach(payload, req.conn, req.principal);
      req.afterReply(() => start.afterReply());
      return start.result;
    }),
  );
  stack.add(router.on('session.detach', (payload, req) => sessions.detach(payload.sessionId, req.conn.channelId)));
  // (session-end-rule): a terminal: the member who opened it; an agent session: routing.ts `mayEndSession`.
  stack.add(
    router.handle('session.end', async (payload, req) => {
      requireOwner(payload.sessionId, req);
      await sessions.end(payload, req.principal);
      return {};
    }),
  );
  // [session.drive]: a title a person gives.
  stack.add(
    router.handle('session.rename', (payload, req) => {
      const terminal = sessions.renameTerminal(payload.sessionId, payload.title);
      if (terminal !== null) return { session: terminal };
      agentSession(ctx, sessions, payload.sessionId);
      agents.setTitle(payload.sessionId, payload.title, req.principal.actor);
      return { session: agentSession(ctx, sessions, payload.sessionId) };
    }),
  );
  // [session.drive] (terminal-session): any terminal.
  stack.add(router.on('exec.input', (payload, req) => sessions.input(payload, req.conn, req.principal)));
  // (owner) session-owner: the PTY follows its owner's viewport (resize policy `owner`).
  stack.add(
    router.on('exec.resize', (payload, req) => {
      requireOwner(payload.sessionId, req);
      sessions.resize(payload, req.conn, req.principal);
    }),
  );

  // ---- agent sessions: the conversation ----------------------------------------------------------------------------
  // [session.view] (agent-session): one page, the blocks that stream, the cards the page points to and every open one.
  stack.add(
    router.handle('session.watch', async (payload, req) => {
      agentSession(ctx, sessions, payload.sessionId);
      const start = await agents.watch(payload, req.conn);
      req.afterReply(() => start.afterReply());
      const { cardRefs, bytes, afterReply: _afterReply, ...page } = start;
      return { ...page, ...cardsFor(ctx, payload.sessionId, cardRefs, bytes, req, { includeOpen: true }) };
    }),
  );
  stack.add(router.on('session.unwatch', (payload, req) => agents.unwatch(payload.sessionId, req.conn.channelId)));
  stack.add(
    router.handle('session.history', async (payload, req) => {
      agentSession(ctx, sessions, payload.sessionId);
      const page = await agents.history(payload);
      return { events: page.events, hasEarlier: page.hasEarlier, hasMore: page.hasMore, ...cardsFor(ctx, payload.sessionId, page.cardRefs, page.bytes, req, { includeOpen: false }) };
    }),
  );
  stack.add(
    router.handle('session.cards.get', (payload, req) => {
      agentSession(ctx, sessions, payload.sessionId);
      return cardsFor(ctx, payload.sessionId, payload.cards, 0, req, { includeOpen: false, atLeastOne: true });
    }),
  );

  // ---- agent sessions: driving [session.drive] ----------------------------------------------------------------------
  stack.add(
    router.handle('session.interrupt', async (payload, req) => {
      agentSession(ctx, sessions, payload.sessionId);
      await agents.interrupt(payload.sessionId, req.principal.actor);
      return {};
    }),
  );
  // (retry-host-only): after three failed starts only the host.
  stack.add(
    router.handle('session.retry', async (payload, req) => {
      const session = agentSession(ctx, sessions, payload.sessionId);
      // A work item's failed session: "Try again" on the session is the plan's "Try again" (`plan.item.retry`): the
      // same session resumes AND smurg tells the agent to go on. Started again alone, the agent would sit idle with
      // its item shown as running, and nothing would ever ask anyone.
      const plans = ctx.services.plans;
      if (session.purpose === 'item' && session.status === 'failed' && !isStubService(plans)) {
        const hit = plans.itemBySession(session.id);
        const archived = session.topicId !== undefined && !isStubService(ctx.services.topics) && ctx.services.topics.get(session.topicId)?.archived === true;
        if (hit !== null && !archived && hit.item.sessionId === session.id && hit.item.state === 'failed') {
          await plans.retryItem({ topicId: hit.topicId, itemId: hit.item.id }, req.principal);
          return { session: agentSession(ctx, sessions, payload.sessionId) };
        }
      }
      return { session: await agents.retry(payload.sessionId, req.principal) };
    }),
  );
  // (session-open): "Restart this session's agent now", the button of the notice of a session that runs without its
  // folder's project settings. While nobody has confirmed them a restart would change nothing: the member is told what
  // has to happen first instead of watching the agent start again as it was.
  stack.add(
    router.handle('session.restart', async (payload, req) => {
      const session = agentSession(ctx, sessions, payload.sessionId);
      requireOpen(ctx, session);
      if (session.projectSettings === 'ignored' && !isStubService(ctx.services.projectTrust) && ctx.services.projectTrust.state(session.root) === 'ignored') {
        throw new SmurgError('conflict', msg('claudeConfig.confirmNeeded'), { reason: 'confirm-needed' });
      }
      await agents.restartProcess(payload.sessionId, 'asked');
      ctx.audit.record({ actor: req.principal.actor, action: 'session.restart', outcome: 'ok', target: payload.sessionId, detail: { sessionId: payload.sessionId } });
      return { session: agentSession(ctx, sessions, payload.sessionId) };
    }),
  );
  // (responsible-eligible): an active member holding `discuss`, or nobody.
  stack.add(
    router.handle('session.responsible.set', (payload, req) => {
      agentSession(ctx, sessions, payload.sessionId);
      let responsible = null;
      if (payload.userId !== null) {
        const member = ctx.members.active(payload.userId);
        if (member === null) throw new SmurgError('not_found', msg('responsible.unknownMember'), { reason: 'unknown-member' });
        if (!mayBeResponsible(member.role)) throw new SmurgError('bad_request', msg('responsible.notEligible', { name: member.displayName }), { reason: 'not-eligible' });
        responsible = { userId: member.userId, displayName: member.displayName };
      }
      agents.setResponsible(payload.sessionId, responsible, req.principal.actor);
      return { session: agentSession(ctx, sessions, payload.sessionId) };
    }),
  );
  // (mode-not-fixed): not for a discussion session.
  stack.add(
    router.handle('session.mode.set', async (payload, req) => {
      if (agentSession(ctx, sessions, payload.sessionId).modeFixed) throw new SmurgError('conflict', msg('session.mode.fixed'), { reason: 'mode-fixed' });
      await agents.setMode(payload.sessionId, payload.mode, req.principal.actor);
      return { session: agentSession(ctx, sessions, payload.sessionId) };
    }),
  );
  // [session.view]: the session's and its topic's always-allowed kinds; the host's own rules that apply (the list for
  // members with session.drive, the fact for everyone else).
  stack.add(
    router.handle('session.rules.get', (payload, req) => {
      const session = agentSession(ctx, sessions, payload.sessionId);
      const topicRules = session.topicId === undefined || isStubService(ctx.services.topics) ? [] : ctx.services.topics.rules(session.topicId);
      const applied = isStubService(ctx.services.hostRules) ? [] : ctx.services.hostRules.applied();
      const drives = req.role === 'host' || req.role === 'agent';
      return { rules: [...agents.rules(payload.sessionId), ...topicRules], host: applied.length === 0 ? { state: 'none' as const } : { state: 'applied' as const, ...(drives ? { rules: [...applied] } : {}) } };
    }),
  );
  stack.add(
    router.handle('session.rule.remove', async (payload, req) => {
      agentSession(ctx, sessions, payload.sessionId);
      const rules = agents.rules(payload.sessionId);
      if (!rules.some((rule) => rule.id === payload.ruleId)) throw new SmurgError('not_found', msg('rule.notFound'), { reason: 'unknown-rule' });
      await agents.setRules(payload.sessionId, rules.filter((rule) => rule.id !== payload.ruleId), req.principal.actor);
      return { session: agentSession(ctx, sessions, payload.sessionId) };
    }),
  );

  // ---- what the bus means for sessions -------------------------------------------------------------------------------
  // Viewers and watchers are keyed by the logical channel: they survive a resume, and go with the channel for good.
  stack.add(
    ctx.bus.on('channel.discarded', (event) => {
      if (event.purpose !== 'interactive') return;
      sessions.detachChannel(event.channelId);
      agents.dropChannel(event.channelId);
    }),
  );
  // d→c `session.host`: the account state or the main folder's trust state changed, to everyone.
  stack.add(ctx.bus.on('account.changed', () => void ctx.hub.broadcast('session.host', hostState(ctx))));
  stack.add(
    ctx.bus.on('trust.changed', (event) => {
      if (event.root.kind === 'main') ctx.hub.broadcast('session.host', hostState(ctx));
    }),
  );
  // A topic's always-allowed kinds count in `ruleCount` of each of its sessions: when they change, every client is
  // told the sessions again (the topic itself is announced by the topics module).
  stack.add(
    ctx.bus.on('topic.changed', ({ topic, previous }) => {
      const now = topic.rules.map((rule) => rule.id).join(' ');
      const before = (previous?.rules ?? []).map((rule) => rule.id).join(' ');
      if (now !== before) agents.topicRulesChanged(topic.id);
    }),
  );
  // A host setting that shapes the launch changed: the sessions start again with it at their next idle moment.
  stack.add(
    ctx.bus.on('settings.changed', ({ settings, previous }) => {
      if (settings.agentMcp !== previous.agentMcp) void agents.restartAll('host').catch(() => {});
    }),
  );
  return stack;
}
