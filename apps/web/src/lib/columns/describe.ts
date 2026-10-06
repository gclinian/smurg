// The name of what a column shows, from the stores: the title of its header (the region's name), the topic it belongs
// to, and the picture before the title. Used by the column frame, the separators between columns ("resize 1 · Cart
// API") and code mode's session selector. One wording with the session list (lib/stores/sessions.ts sessionTitle).
import type { SessionInfo, Topic } from '@smurg/protocol';
import { tStores } from '../../strings/stores.ts';
import { sessionGlyph } from '../session-status.ts';
import { selectSession, sessionTitle, type SessionsState } from '../stores/sessions.ts';
import { selectPlan, selectTopic, type TopicsState } from '../stores/topics.ts';
import type { WorktreesState } from '../stores/worktrees.ts';
import type { GlyphStatus } from '../../ui/StatusGlyph.tsx';
import { columnKindOf, type ColumnKind, type ColumnRef } from './target.ts';

export type ColumnPicture =
  /** An agent session: its status glyph. */
  | { readonly kind: 'status'; readonly status: GlyphStatus }
  | { readonly kind: 'terminal' | 'spec' | 'plan' | 'report' | 'changes' | 'unknown' };

export interface ColumnDescription {
  /** The header's title and the region's accessible name: "1 · Cart API", "Plan", "Result report: 3 · Receipt email". */
  readonly title: string;
  /** The topic's name (a session without a topic, a terminal: none). */
  readonly topicName?: string;
  readonly topicId?: string;
  readonly picture: ColumnPicture;
  /** The component kind; null while a session's kind is not known. */
  readonly kind: ColumnKind | null;
  /**
   * The lists are loaded and the thing is not in them: the host no longer keeps the session, the topic was deleted.
   * (False while the lists are still loading: the column waits.)
   */
  readonly gone: boolean;
  /** A topic's discussion: in a narrow column the topic's name is the title, so two discussions can be told apart. */
  readonly discussion: boolean;
  readonly session?: SessionInfo;
  readonly topic?: Topic;
}

export interface DescribeStores {
  readonly sessions: SessionsState;
  readonly topics: TopicsState;
  readonly worktrees?: WorktreesState;
}

/** "3 · Receipt email": a work item's number and title. */
export function itemLabel(item: { readonly number: number; readonly title: string }): string {
  return tStores('item.label', { number: item.number, title: item.title });
}

function itemOf(topics: TopicsState, sessions: SessionsState, topicId: string, itemId: string): { number: number; title: string } | undefined {
  const fromPlan = selectPlan(topics, topicId)?.items.find((item) => item.id === itemId);
  if (fromPlan) return { number: fromPlan.number, title: fromPlan.title };
  for (const session of [...sessions.sessions.values(), ...sessions.others.values()]) {
    if (session.kind === 'agent' && session.topicId === topicId && session.itemId === itemId && session.item) return session.item;
  }
  return undefined;
}

export function describeColumn(target: ColumnRef, stores: DescribeStores): ColumnDescription {
  const { sessions, topics } = stores;
  if (target.kind === 'session') {
    const session = selectSession(sessions, target.sessionId);
    if (!session) {
      return { title: tStores('column.session'), picture: { kind: 'unknown' }, kind: null, gone: sessions.status === 'ready', discussion: false };
    }
    const glyph = sessionGlyph(session);
    const topic = session.kind === 'agent' && session.topicId !== undefined ? selectTopic(topics, session.topicId) : undefined;
    const topicName = topic?.name ?? (session.kind === 'agent' ? session.topicName : undefined);
    return {
      title: sessionTitle(session),
      ...(topicName === undefined ? {} : { topicName }),
      ...(session.kind === 'agent' && session.topicId !== undefined ? { topicId: session.topicId } : {}),
      picture: glyph === null ? { kind: 'terminal' } : { kind: 'status', status: glyph },
      kind: columnKindOf(target, session),
      gone: false,
      discussion: session.kind === 'agent' && session.purpose === 'discussion' && (session.title ?? '').trim() === '',
      session,
      ...(topic === undefined ? {} : { topic }),
    };
  }
  if (target.kind === 'changes') {
    const request = stores.worktrees?.mergeRequests.get(target.requestId);
    const worktree = request === undefined ? undefined : stores.worktrees?.worktrees.get(request.worktreeId);
    const topic = request?.topicId === undefined ? undefined : selectTopic(topics, request.topicId);
    return {
      title: worktree === undefined ? tStores('column.changes') : tStores('column.changesOf', { branch: worktree.branch }),
      ...(topic === undefined ? {} : { topicName: topic.name, topicId: topic.id, topic }),
      picture: { kind: 'changes' },
      kind: 'changes',
      gone: stores.worktrees !== undefined && stores.worktrees.status === 'ready' && request === undefined,
      discussion: false,
    };
  }
  const topic = selectTopic(topics, target.topicId);
  const gone = topic === undefined && topics.status === 'ready';
  const base = { ...(topic === undefined ? {} : { topicName: topic.name, topic }), topicId: target.topicId, gone, discussion: false };
  if (target.kind === 'spec') return { ...base, title: tStores('column.spec'), picture: { kind: 'spec' }, kind: 'spec' };
  if (target.kind === 'plan') return { ...base, title: tStores('column.plan'), picture: { kind: 'plan' }, kind: 'plan' };
  const item = itemOf(topics, sessions, target.topicId, target.itemId);
  return {
    ...base,
    title: item === undefined ? tStores('column.report') : tStores('column.reportOf', { item: itemLabel(item) }),
    picture: { kind: 'report' },
    kind: 'report',
  };
}
