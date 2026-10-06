// TEST ONLY. The MECHANICAL handlers of the faked service slots, for `fakesModule({ handlers: true })`: each request of
// protocol 4 is handed to its service (`ctx.services.<slot>`) and the bus events the real modules forward to clients
// are forwarded. With them a test daemon answers the whole wire, so a test of ONE real module can let a member watch
// a session, list topics or read the inbox over a real connection without writing the other packages' handlers.
//
// What is NOT here: the rules of the real handlers (who may submit or decide, mentions, rates beyond the Router's,
// audit entries). Requests are delegated as they come; the Router has checked the capability.
import {
  EVENTS_PAGE_MAX_BYTES,
  MAIN_ROOT,
  SmurgError,
  takeListPage,
  type AgentSession,
  type CardRef,
  type HostState,
  type PermissionRequest,
  type Question,
  type Suggestion,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../context.ts';
import type { FeatureServiceName, RequestContext, Router } from '../interfaces.ts';
import { DisposableStack, type Disposable } from '../lifecycle.ts';
import { isStubService } from '../stubs.ts';
import type { FakeSessionManager } from './sessions.ts';

/** The agent session a request names: a terminal is `not-an-agent`, anything else unknown is `not_found`. */
function agentSession(ctx: DaemonContext, sessionId: string): AgentSession {
  const session = ctx.services.agents.get(sessionId);
  if (session !== null) return session;
  if (!isStubService(ctx.services.sessions) && ctx.services.sessions.get(sessionId) !== null) throw new SmurgError('bad_request', msg('session.notAgent'), { reason: 'not-an-agent' });
  throw new SmurgError('not_found', msg('session.notFound'));
}

/** The card part of a page: what the conversation and suggestion services hold, inside what is left of the page. */
function cardsFor(ctx: DaemonContext, sessionId: string, refs: readonly CardRef[], usedBytes: number, req: RequestContext, options: { includeOpen: boolean; atLeastOne?: boolean }): {
  questions: Question[];
  permissions: PermissionRequest[];
  suggestions: Suggestion[];
  moreCards: CardRef[];
} {
  const budget = Math.max(0, EVENTS_PAGE_MAX_BYTES - usedBytes);
  const forHost = req.role === 'host';
  const cards = isStubService(ctx.services.conversation)
    ? { questions: [], permissions: [], more: [], bytes: 0 }
    : ctx.services.conversation.cards(sessionId, refs, { includeOpen: options.includeOpen, budgetBytes: budget, forHost, ...(options.atLeastOne === true ? { atLeastOne: true } : {}) });
  const first = cards.questions.length + cards.permissions.length === 0;
  const suggestions = isStubService(ctx.services.suggestions)
    ? { suggestions: [], more: [], bytes: 0 }
    : ctx.services.suggestions.cards(sessionId, refs, { includeOpen: options.includeOpen, budgetBytes: Math.max(0, budget - cards.bytes), ...(options.atLeastOne === true && first ? { atLeastOne: true } : {}) });
  return { questions: cards.questions, permissions: cards.permissions, suggestions: suggestions.suggestions, moreCards: [...cards.more, ...suggestions.more] };
}

function hostState(ctx: DaemonContext): HostState {
  return {
    account: ctx.services.agents.account(),
    mainProjectSettings: isStubService(ctx.services.projectTrust) ? 'none' : ctx.services.projectTrust.state(MAIN_ROOT),
  };
}

/** Registers the delegating handlers of every slot in `faked` (`sessions`: the fake registry, for a terminal's rename). */
export function registerFakeHandlers(router: Router, ctx: DaemonContext, faked: ReadonlySet<FeatureServiceName>, sessions: FakeSessionManager): Disposable {
  const stack = new DisposableStack();
  const s = ctx.services;

  if (faked.has('sessions')) {
    stack.add(router.handle('session.create', async (payload, req) => ({ session: await s.sessions.create(payload, req.conn, req.principal) })));
    stack.add(
      router.handle('session.list', (payload) => {
        const page = takeListPage(s.sessions.list(payload.topicId === undefined ? {} : { topicId: payload.topicId }), payload.after, (session) => session.id);
        return { sessions: page.items, hasMore: page.hasMore };
      }),
    );
    stack.add(
      router.handle('session.end', async (payload, req) => {
        await s.sessions.end(payload, req.principal);
        return {};
      }),
    );
    stack.add(
      router.handle('session.attach', async (payload, req) => {
        const start = await s.sessions.attach(payload, req.conn, req.principal);
        req.afterReply(() => start.afterReply());
        return start.result;
      }),
    );
    stack.add(router.on('session.detach', (payload, req) => s.sessions.detach(payload.sessionId, req.conn.channelId)));
    stack.add(router.on('exec.input', (payload, req) => s.sessions.input(payload, req.conn, req.principal)));
    stack.add(router.on('exec.resize', (payload, req) => s.sessions.resize(payload, req.conn, req.principal)));
    stack.add(router.handle('session.loginStatus', async (payload, req) => ({ login: await s.sessions.loginStatus(payload.sessionId, req.principal) })));
    stack.add(
      router.handle('session.rename', (payload, req) => {
        const session = s.sessions.get(payload.sessionId);
        if (session === null) throw new SmurgError('not_found', msg('session.notFound'));
        if (session.kind === 'agent') s.agents.setTitle(payload.sessionId, payload.title, req.principal.actor);
        else sessions.renameTerminal(payload.sessionId, payload.title);
        return { session: s.sessions.get(payload.sessionId) ?? session };
      }),
    );
    // d→c `session.state`: every change of a SessionInfo, to everyone.
    for (const name of ['session.created', 'session.updated', 'session.exited'] as const) {
      stack.add(ctx.bus.on(name, (event) => void ctx.hub.broadcast('session.state', { session: event.session })));
    }
  }

  if (faked.has('agents')) {
    stack.add(
      router.handle('session.watch', async (payload, req) => {
        agentSession(ctx, payload.sessionId);
        const start = await s.agents.watch(payload, req.conn);
        req.afterReply(() => start.afterReply());
        const { cardRefs, bytes, afterReply: _afterReply, ...page } = start;
        return { ...page, ...cardsFor(ctx, payload.sessionId, cardRefs, bytes, req, { includeOpen: true }) };
      }),
    );
    stack.add(router.on('session.unwatch', (payload, req) => s.agents.unwatch(payload.sessionId, req.conn.channelId)));
    stack.add(
      router.handle('session.history', async (payload, req) => {
        agentSession(ctx, payload.sessionId);
        const page = await s.agents.history(payload);
        return { events: page.events, hasEarlier: page.hasEarlier, hasMore: page.hasMore, ...cardsFor(ctx, payload.sessionId, page.cardRefs, page.bytes, req, { includeOpen: false }) };
      }),
    );
    stack.add(
      router.handle('session.cards.get', (payload, req) => {
        agentSession(ctx, payload.sessionId);
        return cardsFor(ctx, payload.sessionId, payload.cards, 0, req, { includeOpen: false, atLeastOne: true });
      }),
    );
    stack.add(
      router.handle('session.interrupt', async (payload, req) => {
        agentSession(ctx, payload.sessionId);
        await s.agents.interrupt(payload.sessionId, req.principal.actor);
        return {};
      }),
    );
    stack.add(
      router.handle('session.retry', async (payload, req) => {
        agentSession(ctx, payload.sessionId);
        return { session: await s.agents.retry(payload.sessionId, req.principal) };
      }),
    );
    stack.add(
      router.handle('session.restart', async (payload) => {
        agentSession(ctx, payload.sessionId);
        await s.agents.restartProcess(payload.sessionId, 'asked');
        return { session: agentSession(ctx, payload.sessionId) };
      }),
    );
    stack.add(
      router.handle('session.responsible.set', (payload, req) => {
        agentSession(ctx, payload.sessionId);
        const responsible = payload.userId === null ? null : ctx.members.userRef(payload.userId);
        if (payload.userId !== null && responsible === null) throw new SmurgError('not_found', msg('responsible.unknownMember'));
        s.agents.setResponsible(payload.sessionId, responsible, req.principal.actor);
        return { session: agentSession(ctx, payload.sessionId) };
      }),
    );
    stack.add(
      router.handle('session.mode.set', async (payload, req) => {
        if (agentSession(ctx, payload.sessionId).modeFixed) throw new SmurgError('conflict', msg('session.mode.fixed'), { reason: 'mode-fixed' });
        await s.agents.setMode(payload.sessionId, payload.mode, req.principal.actor);
        return { session: agentSession(ctx, payload.sessionId) };
      }),
    );
    stack.add(
      router.handle('session.rules.get', (payload, req) => {
        const session = agentSession(ctx, payload.sessionId);
        const topicRules = session.topicId === undefined || isStubService(s.topics) ? [] : s.topics.rules(session.topicId);
        const applied = isStubService(s.hostRules) ? [] : s.hostRules.applied();
        const drives = req.role === 'host' || req.role === 'agent';
        return { rules: [...s.agents.rules(payload.sessionId), ...topicRules], host: applied.length === 0 ? { state: 'none' as const } : { state: 'applied' as const, ...(drives ? { rules: [...applied] } : {}) } };
      }),
    );
    stack.add(
      router.handle('session.rule.remove', async (payload, req) => {
        agentSession(ctx, payload.sessionId);
        const rules = s.agents.rules(payload.sessionId);
        if (!rules.some((rule) => rule.id === payload.ruleId)) throw new SmurgError('not_found', msg('rule.notFound'));
        await s.agents.setRules(payload.sessionId, rules.filter((rule) => rule.id !== payload.ruleId), req.principal.actor);
        return { session: agentSession(ctx, payload.sessionId) };
      }),
    );
    stack.add(router.handle('session.host.get', () => hostState(ctx)));
    // d→c `session.host`: the account state or the main folder's trust state changed, to everyone.
    stack.add(ctx.bus.on('account.changed', () => void ctx.hub.broadcast('session.host', hostState(ctx))));
    stack.add(
      ctx.bus.on('trust.changed', (event) => {
        if (event.root.kind === 'main') ctx.hub.broadcast('session.host', hostState(ctx));
      }),
    );
  }

  if (faked.has('conversation')) {
    stack.add(router.handle('session.message.send', (payload, req) => s.conversation.send(payload, req.principal)));
    stack.add(
      router.handle('question.vote', (payload, req) => {
        s.conversation.vote(payload, req.principal);
        return {};
      }),
    );
    stack.add(router.handle('question.comment', (payload, req) => s.conversation.comment(payload, req.principal)));
    stack.add(router.handle('question.submit', async (payload, req) => ({ question: await s.conversation.submit(payload, req.principal) })));
    stack.add(
      router.handle('question.remind', (payload, req) => {
        s.conversation.remind(payload, req.principal);
        return {};
      }),
    );
    stack.add(router.on('question.seen', (payload, req) => s.conversation.seen(payload.questionId, req.principal)));
    stack.add(router.handle('permission.decide', async (payload, req) => ({ request: await s.conversation.decide(payload, req.principal) })));
  }

  if (faked.has('suggestions')) {
    stack.add(router.handle('suggest.create', async (payload, req) => ({ suggestion: await s.suggestions.create(payload, req.principal) })));
    stack.add(router.handle('suggest.edit', async (payload, req) => ({ suggestion: await s.suggestions.edit(payload, req.principal) })));
    stack.add(router.handle('suggest.withdraw', async (payload, req) => ({ suggestion: await s.suggestions.withdraw(payload, req.principal) })));
    stack.add(router.handle('suggest.accept', async (payload, req) => ({ suggestion: await s.suggestions.accept(payload, req.principal) })));
    stack.add(router.handle('suggest.reject', async (payload, req) => ({ suggestion: await s.suggestions.reject(payload, req.principal) })));
    stack.add(router.handle('suggest.list', (payload, req) => s.suggestions.list(payload, req.principal)));
  }

  if (faked.has('topics')) {
    stack.add(router.handle('topic.create', (payload, req) => s.topics.create(payload, req.principal)));
    stack.add(router.handle('topic.list', (payload) => s.topics.list(payload)));
    stack.add(router.handle('topic.rename', async (payload, req) => ({ topic: await s.topics.rename(payload, req.principal) })));
    stack.add(router.handle('topic.archive', async (payload, req) => ({ topic: await s.topics.archive(payload, req.principal) })));
    stack.add(
      router.handle('topic.delete', async (payload, req) => {
        await s.topics.delete(payload, req.principal);
        return {};
      }),
    );
    stack.add(router.handle('topic.discussion.restart', (payload, req) => s.topics.restartDiscussion(payload, req.principal)));
    stack.add(router.handle('topic.revise', (payload, req) => s.topics.revise(payload, req.principal)));
    stack.add(
      router.handle('topic.spec.request', async (payload, req) => {
        await s.topics.requestSpec(payload, req.principal);
        return {};
      }),
    );
    stack.add(router.handle('topic.rule.add', async (payload, req) => ({ topic: await s.topics.addRule(payload, req.principal) })));
    stack.add(router.handle('topic.rule.remove', async (payload, req) => ({ topic: await s.topics.removeRule(payload, req.principal) })));
    // d→c `topic.updated` / `topic.removed`, to everyone.
    stack.add(ctx.bus.on('topic.changed', (event) => void ctx.hub.broadcast('topic.updated', { topic: event.topic })));
    stack.add(ctx.bus.on('topic.removed', (event) => void ctx.hub.broadcast('topic.removed', { topicId: event.topicId })));
  }

  if (faked.has('plans')) {
    stack.add(
      router.handle('plan.generate', async (payload, req) => {
        await s.plans.generate(payload, req.principal);
        return {};
      }),
    );
    stack.add(router.handle('plan.get', (payload) => ({ plan: s.plans.get(payload.topicId) })));
    stack.add(router.handle('plan.mode.set', async (payload, req) => ({ plan: await s.plans.setMode(payload, req.principal) })));
    stack.add(router.handle('plan.assign', async (payload, req) => ({ plan: await s.plans.assign(payload, req.principal) })));
    stack.add(router.handle('plan.suggest', async (payload, req) => ({ plan: await s.plans.suggest(payload, req.principal) })));
    stack.add(router.handle('plan.preflight', async (payload, req) => ({ preflight: await s.plans.preflight(payload, req.principal) })));
    stack.add(router.handle('plan.start', async (payload, req) => ({ plan: await s.plans.start(payload, req.principal) })));
    stack.add(router.handle('plan.changes', (payload, req) => s.plans.changes(payload, req.principal)));
    stack.add(router.handle('plan.resume', async (payload, req) => ({ plan: await s.plans.resume(payload, req.principal) })));
    stack.add(router.handle('plan.item.retry', async (payload, req) => ({ plan: await s.plans.retryItem(payload, req.principal) })));
    stack.add(
      router.handle('plan.item.continue', async (payload, req) => {
        await s.plans.continueItem(payload, req.principal);
        return {};
      }),
    );
    stack.add(
      router.handle('plan.item.resolve', async (payload, req) => {
        await s.plans.resolveItem(payload, req.principal);
        return {};
      }),
    );
    stack.add(ctx.bus.on('plan.changed', (event) => void ctx.hub.broadcast('plan.updated', { plan: event.plan })));
  }

  if (faked.has('reports')) {
    stack.add(
      router.handle('report.get', (payload) => {
        const report = s.reports.get(payload.topicId, payload.itemId);
        if (report === null) throw new SmurgError('not_found', msg('report.none'));
        return { report };
      }),
    );
    stack.add(router.handle('report.followUp', (payload, req) => s.reports.followUp(payload, req.principal)));
    stack.add(router.handle('report.review', async (payload, req) => ({ report: await s.reports.review(payload, req.principal) })));
    stack.add(ctx.bus.on('report.changed', (event) => void ctx.hub.broadcast('report.updated', { topicId: event.topicId, itemId: event.itemId, report: event.report })));
  }

  if (faked.has('inbox')) {
    stack.add(router.handle('inbox.list', (payload, req) => s.inbox.list(req.principal, payload)));
    stack.add(router.on('inbox.seen', (payload, req) => s.inbox.seen(req.principal, payload.keys)));
    stack.add(
      router.handle('inbox.dismiss', (payload, req) => {
        s.inbox.dismiss(req.principal, payload.key);
        return {};
      }),
    );
  }

  return stack;
}
