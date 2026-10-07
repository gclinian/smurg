// What an inbox row says (DESIGN §3.8, §5.12 items 1–2; P0-API §3.2): two lines and at most one action, composed
// from the item's structured fields in the viewer's language. Nothing here parses a sentence the daemon wrote: a work
// item is named from `item { number, title }`, a person from the item's references, the rest from the fields the
// item's kind carries (INBOX_KIND_FIELDS). Text people or agents wrote (the question, the command, a suggestion) is
// shown as it is.
//
// A feature may change the row of a kind it knows better (lib/slots.ts `inboxRows`); this module composes all of them.
import type { ColumnTarget, HostState, InboxItem, UserRef } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { itemLabel } from '../../lib/columns/describe.ts';
import { renderWireText } from '../../lib/errors.ts';
import { formatActor, formatAge, formatAnd, formatNumber } from '../../lib/format.ts';
import { kindLabel } from '../../lib/session-status.ts';
import type { InboxRowAction, InboxRowView } from '../../lib/slots.ts';
import { selectSession, sessionTitle, type SessionsState, type SessionsStore } from '../../lib/stores/sessions.ts';
import { reportKey, selectPlan, selectReport, selectTopic, type TopicsState, type TopicsStore } from '../../lib/stores/topics.ts';
import { t } from './strings.ts';

export interface InboxRowContext {
  readonly sessions: SessionsState;
  readonly topics: TopicsState;
  /** The viewer. */
  readonly selfUserId: string | null;
  /** The host's account state (the wording of an `account` row); null while unknown. */
  readonly account: HostState['account'] | null;
  readonly now: number;
  /** What a row's action calls. */
  readonly stores: { readonly topics: Pick<TopicsStore, 'continueItem' | 'retryItem' | 'resume' | 'restartDiscussion'>; readonly sessions: Pick<SessionsStore, 'retry'> };
}

const outcomeRef = { complete: msg('report.outcome.complete'), partial: msg('report.outcome.partial'), blocked: msg('report.outcome.blocked') } as const;
const outcomeEnglish = { complete: 'Complete', partial: 'Partial', blocked: 'Blocked' } as const;

/** "topic › session": where the thing is. */
export function whereOf(item: InboxItem, ctx: Pick<InboxRowContext, 'sessions' | 'topics'>): string {
  const topic = item.topicId === undefined ? undefined : selectTopic(ctx.topics, item.topicId);
  const session = item.sessionId === undefined ? undefined : selectSession(ctx.sessions, item.sessionId);
  const topicName = topic?.name ?? (session?.kind === 'agent' ? session.topicName : undefined);
  const inTopic = session !== undefined ? sessionTitle(session) : item.item !== undefined ? itemLabel(item.item) : undefined;
  if (topicName !== undefined) return inTopic === undefined ? topicName : t('where.topic', { topic: topicName, session: inTopic });
  return inTopic === undefined ? '' : t('where.free', { session: inTopic });
}

/** "you or Mei": the others who may settle it too. */
function othersFact(item: InboxItem): string | null {
  const named = item.alsoFor ?? [];
  const count = named.length + (item.alsoForMore ?? 0);
  if (count === 0) return null;
  return count === 1 && named[0] !== undefined ? t('fact.youOr', { name: named[0].displayName }) : t('fact.youOrOthers', { count });
}

/** "Ian has not answered for 6 min" / "Ian is offline": why a thing that waits for someone else is in MY inbox. */
function waitsForFact(item: InboxItem, ctx: InboxRowContext, kind: 'answer' | 'review'): string | null {
  const who: UserRef | undefined = item.waitsFor;
  if (who === undefined || who.userId === ctx.selfUserId) return null;
  if (item.escalated === true) {
    return t(kind === 'answer' ? 'fact.notAnswered' : 'fact.notReviewed', { name: who.displayName, time: formatAge(item.at, ctx.now) });
  }
  return item.waitsForOffline === true ? t('fact.offline', { name: who.displayName }) : null;
}

const facts = (...parts: readonly (string | null | undefined)[]): string => parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');

function attention(item: InboxItem, ctx: InboxRowContext, where: string): InboxRowView {
  const name = item.item === undefined ? null : itemLabel(item.item);
  const topicName = item.topicId === undefined ? undefined : selectTopic(ctx.topics, item.topicId)?.name;
  const { topicId, itemId, sessionId } = item;
  const action = (id: string, label: string, run: () => Promise<unknown>): InboxRowAction => ({ id, label, run: async () => void (await run()) });
  switch (item.subject) {
    case 'item-stalled': {
      // Why it stopped is in the item's plan (when the plan is loaded): the row says what the plan's badge and the
      // session's status bar say. Stopped by the agent itself, or not known: "stopped without a report".
      const why = topicId === undefined || itemId === undefined ? undefined : selectPlan(ctx.topics, topicId)?.items.find((entry) => entry.id === itemId)?.stalledBy;
      const key = why === undefined || why === 'agent' ? 'title.attention.itemStalled' : (`title.attention.itemStalled.${why}` as const);
      return {
        title: name === null ? renderWireText(msg('attention.itemStalled'), 'Stopped without a report') : t(key, { item: name }),
        where: topicName ?? where,
        ...(topicId !== undefined && itemId !== undefined ? { action: action('continue', t('action.continue'), () => ctx.stores.topics.continueItem(topicId, itemId)) } : {}),
      };
    }
    case 'item-failed':
      return {
        title: name === null ? renderWireText(msg('attention.itemFailed'), "The agent's process failed") : t('title.attention.itemFailed', { item: name }),
        where: topicName ?? where,
        // A failed session continues where it was (the same conversation); an item without one starts a new attempt.
        ...(sessionId !== undefined
          ? { action: action('try-again', t('action.tryAgain'), () => ctx.stores.sessions.retry(sessionId)) }
          : topicId !== undefined && itemId !== undefined
            ? { action: action('try-again', t('action.tryAgain'), () => ctx.stores.topics.retryItem(topicId, itemId)) }
            : {}),
      };
    case 'item-stopped':
      return {
        title: name === null ? renderWireText(msg('attention.itemStopped'), 'The session was ended') : t('title.attention.itemStopped', { item: name }),
        where: topicName ?? where,
        ...(topicId !== undefined && itemId !== undefined ? { action: action('try-again', t('action.tryAgain'), () => ctx.stores.topics.retryItem(topicId, itemId)) } : {}),
      };
    case 'item-not-started':
      return {
        title: name === null ? renderWireText(msg('attention.itemNotStarted'), 'Did not start') : t('title.attention.itemNotStarted', { item: name }),
        where: topicName ?? where,
      };
    case 'plan-paused':
      return {
        title: item.count === undefined ? renderWireText(msg('attention.planPaused'), 'smurg was restarted: the plan is paused') : t('title.attention.planPaused', { count: item.count }),
        where: topicName ?? item.excerpt,
        ...(topicId !== undefined ? { action: action('continue-all', t('action.continueAll'), () => ctx.stores.topics.resume(topicId)) } : {}),
      };
    case 'discussion-lost': {
      const topic = topicName ?? item.excerpt;
      return {
        title: topic === '' ? renderWireText(msg('attention.discussionLost'), 'The discussion is closed') : t('title.attention.discussionLost', { topic }),
        where: '',
        ...(topicId !== undefined ? { action: action('restart-discussion', t('action.restartDiscussion'), () => ctx.stores.topics.restartDiscussion(topicId)) } : {}),
      };
    }
    case 'account': {
      const state = ctx.account?.state;
      const title =
        state === 'usage-limit'
          ? t('title.attention.account.limit')
          : state === 'logged-out'
            ? t('title.attention.account.loggedOut')
            : renderWireText(msg('attention.account'), "The host's Claude account stops agents");
      return { title, where: item.count === undefined ? '' : t('fact.sessionsWait', { count: item.count }) };
    }
    case 'project-settings':
      return { title: renderWireText(msg('attention.projectSettings'), 'Claude Code project settings wait for the host'), where };
    case 'host-rules':
      return { title: renderWireText(msg('attention.hostRules'), 'Your own Claude Code rules apply here'), where };
    case 'storage':
      return { title: renderWireText(msg('attention.storage'), 'Conversations use more disk space than the limit'), where };
    case undefined:
      return { title: kindLabel('attention'), where };
  }
}

/** The row of one inbox item. */
export function describeInboxItem(item: InboxItem, ctx: InboxRowContext): InboxRowView {
  const where = whereOf(item, ctx);
  const from = item.from === undefined ? null : formatActor(item.from);
  switch (item.kind) {
    case 'question': {
      const voted =
        item.allVoted === true
          ? item.leading !== undefined
            ? t('fact.submit', { eligible: item.eligible ?? 0, leading: item.leading })
            : t('fact.allVoted', { eligible: item.eligible ?? 0 })
          : facts(t('fact.voted', { voted: item.voted ?? 0, eligible: item.eligible ?? 0 }), item.leading === undefined ? null : t('fact.leading', { leading: item.leading }));
      return { title: item.excerpt === '' ? kindLabel('question') : item.excerpt, where: facts(where, voted, waitsForFact(item, ctx, 'answer'), othersFact(item)) };
    }
    case 'vote':
      return {
        title: t('title.vote', { question: item.excerpt }),
        where: facts(
          where,
          t('fact.voted', { voted: item.voted ?? 0, eligible: item.eligible ?? 0 }),
          item.waitsFor === undefined ? null : t('fact.decides', { name: item.waitsFor.displayName }),
          item.waitsFor !== undefined && item.waitsForOffline === true ? t('fact.offline', { name: item.waitsFor.displayName }) : null,
        ),
      };
    case 'permission':
      return {
        title: item.excerpt === '' ? kindLabel('permission') : item.excerpt,
        ...(item.excerpt === '' ? {} : { mono: true }),
        where: facts(where, waitsForFact(item, ctx, 'answer'), othersFact(item)),
      };
    case 'suggestion': {
      const name = from ?? kindLabel('suggestion');
      const count = item.count ?? 1;
      return { title: count === 1 ? t('title.suggestion', { name, text: item.excerpt }) : t('title.suggestions', { name, count }), where: facts(where, othersFact(item)) };
    }
    case 'report': {
      const topicName = item.topicId === undefined ? undefined : selectTopic(ctx.topics, item.topicId)?.name;
      const outcome = item.outcome === undefined ? null : renderWireText(outcomeRef[item.outcome], outcomeEnglish[item.outcome]);
      const checks = item.checks === undefined ? null : t('fact.checks', { passed: item.checks.passed, notVerified: item.checks.notVerified });
      return {
        title: item.item === undefined ? kindLabel('report') : t('title.report', { item: itemLabel(item.item) }),
        where: facts(topicName, outcome, checks, waitsForFact(item, ctx, 'review'), othersFact(item)),
      };
    }
    case 'merge': {
      const what = item.item === undefined ? t('title.merge.changes') : itemLabel(item.item);
      const title = item.ready === true ? t('title.merge.ready', { what }) : from !== null ? t('title.merge.asks', { name: from, what }) : t('title.merge.pending', { what });
      const waiting = item.unblocks ?? [];
      const unblocks = waiting.length === 0 ? null : t(waiting.length === 1 ? 'fact.unblocks.one' : 'fact.unblocks.many', { items: formatAnd(waiting.map((n) => formatNumber(n))) });
      const topicName = item.topicId === undefined ? undefined : selectTopic(ctx.topics, item.topicId)?.name;
      return { title, where: facts(topicName, item.conflict === true ? t('fact.conflict') : null, unblocks, item.excerpt) };
    }
    case 'mention':
      return { title: t('title.mention', { name: from ?? kindLabel('mention'), text: item.excerpt }), where };
    case 'result':
      return {
        title: t(item.result === 'accepted-edited' ? 'title.result.edited' : 'title.result.rejected', { name: from ?? kindLabel('result'), text: item.excerpt }),
        where,
      };
    case 'attention':
      return attention(item, ctx, where);
  }
}

/** The work item a merge row is about, when its topic is open: an archived topic's report is read-only, so nothing merges there. */
function itemOfMergeRow(item: InboxItem, topics: TopicsState): { topicId: string; itemId: string } | null {
  const { topicId, itemId } = item;
  return item.kind === 'merge' && topicId !== undefined && itemId !== undefined && topics.topics.has(topicId) ? { topicId, itemId } : null;
}

/**
 * Where a row leads (UX §7). A merge request of a work item leads to the item's result report when that report is
 * about THIS request: the outcome, the checks, "What to watch out for", the host's "Merge…" and "Ask the agent to
 * resolve" are there (DESIGN §5.4), and "Merge…" there opens the request the report names. Any other request keeps
 * the Changes column the item names, where "Merge" merges exactly what the row asks for: a free session's worktree, a
 * work item nobody reported on, and a request somebody made after the report (a hand edit in the item's worktree and
 * "Request merge" give a new request, while the report still names its own draft).
 *
 * The report must be in the store to know (`reportNeededFor`); until it is, the row leads where the item says. The
 * inbox asks about it when the row appears; a click that comes before the answer shows the report's column, and the
 * Changes column takes its place when the answer says so (InboxList.tsx `useOpenInboxItem`).
 */
export function inboxTarget(item: InboxItem, topics: TopicsState): ColumnTarget {
  const about = itemOfMergeRow(item, topics);
  if (about === null || item.target.kind !== 'changes') return item.target;
  const report = selectReport(topics, about.topicId, about.itemId);
  return report?.changes?.requestId === item.target.requestId ? { kind: 'report', ...about } : item.target;
}

/**
 * The report `inboxTarget` needs and the store knows nothing of yet. Null: nothing to read (the report is loaded, or
 * the host said that the item has none).
 */
export function reportNeededFor(item: InboxItem, topics: TopicsState): { topicId: string; itemId: string } | null {
  const about = itemOfMergeRow(item, topics);
  if (about === null || topics.noReport.has(reportKey(about.topicId, about.itemId))) return null;
  return selectReport(topics, about.topicId, about.itemId) === undefined ? about : null;
}

/**
 * The reports the rows of an inbox need, each once: asked about when the rows appear (`knowReport`), so that a click
 * on a merge row opens the right column at once instead of waiting for an answer.
 */
export function reportsToLoad(items: Iterable<InboxItem>, topics: TopicsState): { topicId: string; itemId: string }[] {
  const wanted = new Map<string, { topicId: string; itemId: string }>();
  for (const item of items) {
    const needed = reportNeededFor(item, topics);
    if (needed !== null) wanted.set(reportKey(needed.topicId, needed.itemId), needed);
  }
  return [...wanted.values()];
}

/** The topics whose plans the rows read and the store does not hold yet: why an item stopped. */
export function plansToLoad(items: Iterable<InboxItem>, topics: TopicsState): string[] {
  const wanted = new Set<string>();
  for (const item of items) {
    if (item.kind === 'attention' && item.subject === 'item-stalled' && item.itemId !== undefined && item.topicId !== undefined && selectPlan(topics, item.topicId) === undefined) wanted.add(item.topicId);
  }
  return [...wanted];
}

/** Whether the member may take the item out of the inbox by hand (the daemon refuses anything else). */
export function isDismissable(item: InboxItem): boolean {
  return item.kind === 'mention' || item.kind === 'result';
}
