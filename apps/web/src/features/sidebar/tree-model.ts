// The session list as data (UX §3.2; DESIGN §5.12 items 3–8): topics as groups with their fixed rows, then the
// sessions that belong to no topic. Pure: the component (SessionTree.tsx) draws what this returns.
//
// A topic's rows are fixed from its creation, as steps:
//   Discussion              the topic's discussion session
//   Spec                    "not written yet" until the file exists, "draft" until a plan exists
//   Plan                    "no plan yet", then "n of m reviewed"
//   1 · Cart API …          one row per work item, in plan order, showing its newest attempt; an item without a
//                           session yet shows its state (not started, waiting for another item) and opens the plan.
//                           Before the plan is loaded the rows come from the item sessions themselves.
//   Earlier discussion      a discussion that was replaced (restart of the discussion), ended
// "No topic" holds the agent sessions without a topic and the plain terminals, newest first.
import { isSessionOver, type AgentSession, type PlanInfo, type SessionInfo, type Topic, type UserRef } from '@smurg/protocol';
import { itemLabel } from '../../lib/columns/describe.ts';
import { columnId, type ColumnRef } from '../../lib/columns/target.ts';
import { itemGlyph, mostUrgent, sessionGlyph, waitsForPerson } from '../../lib/session-status.ts';
import { isUnseen, type ColumnsState, type SessionFilter } from '../../lib/stores/columns.ts';
import { sessionTitle, type SessionsState } from '../../lib/stores/sessions.ts';
import { selectTopicList, type TopicsState } from '../../lib/stores/topics.ts';
import type { GlyphStatus } from '../../ui/StatusGlyph.tsx';
import { t } from './strings.ts';

export type RowKind = 'session' | 'terminal' | 'spec' | 'plan' | 'item';

export interface TreeRow {
  /** The tree node's id (stable across renders). */
  readonly id: string;
  readonly kind: RowKind;
  /** What a click opens. */
  readonly target: ColumnRef;
  readonly title: string;
  /** After the title, quiet: "draft", "no plan yet", "0 of 6 reviewed". */
  readonly meta?: string;
  /** The status glyph; null: the row has a plain icon (spec, plan, terminal). */
  readonly glyph: GlyphStatus | null;
  /** `undefined`: the row has no responsible person to show (spec, plan, terminal). `null`: nobody is assigned. */
  readonly responsible?: UserRef | null;
  /** The work item has a result report: its state and what the small report mark opens. */
  readonly report?: { readonly target: ColumnRef; readonly waiting: boolean };
  /** Something a reader cares about happened since this browser showed it. */
  readonly unread: boolean;
  /** The thing is open in a column. */
  readonly open: boolean;
  /** It is what the focused column shows. */
  readonly current: boolean;
  /** An empty step ("not written yet") or an ended session: drawn quieter. */
  readonly quiet: boolean;
  readonly session?: SessionInfo;
}

export interface TreeGroup {
  /** `topic:<id>`, or `free` for the sessions without a topic. */
  readonly id: string;
  readonly topic?: Topic;
  readonly name: string;
  readonly open: boolean;
  /** Rows on which a person must act (shown beside the phase while the group is collapsed). */
  readonly waiting: number;
  /** The most urgent status among the rows (a collapsed topic's one glyph). */
  readonly urgent: GlyphStatus | null;
  readonly rows: readonly TreeRow[];
}

export interface TreeInput {
  readonly topics: TopicsState;
  readonly sessions: SessionsState;
  readonly columns: Pick<ColumnsState, 'columns' | 'focusedId' | 'seen' | 'since' | 'groupOpen' | 'filter'>;
  readonly selfUserId: string | null;
}

export const FREE_GROUP = 'free';
export const topicGroupId = (topicId: string): string => `topic:${topicId}`;

/** A session is "mine" when I am responsible for it, or nobody is and I opened it (I am its decider). */
function isMine(session: SessionInfo, selfUserId: string | null): boolean {
  if (selfUserId === null) return false;
  if (session.kind === 'terminal') return session.openedBy.userId === selfUserId;
  return session.responsible === null ? session.openedBy.userId === selfUserId : session.responsible.userId === selfUserId;
}

function keep(row: TreeRow, filter: SessionFilter, selfUserId: string | null): boolean {
  if (filter === 'all') return true;
  if (row.kind === 'spec' || row.kind === 'plan') return false;
  if (filter === 'waiting') return waitsForPerson(row.glyph);
  if (row.session !== undefined) return isMine(row.session, selfUserId);
  return row.responsible !== undefined && row.responsible !== null && row.responsible.userId === selfUserId;
}

export function buildSessionTree(input: TreeInput): TreeGroup[] {
  const { topics, sessions, columns, selfUserId } = input;
  const openIds = new Set(columns.columns.map((column) => column.id));
  const marks = columns;

  const place = (target: ColumnRef): Pick<TreeRow, 'open' | 'current'> => {
    const id = columnId(target);
    return { open: openIds.has(id), current: columns.focusedId === id };
  };

  const sessionRow = (session: SessionInfo, title: string = sessionTitle(session), quiet = false): TreeRow => {
    const target: ColumnRef = { kind: 'session', sessionId: session.id };
    return {
      id: `session:${session.id}`,
      kind: session.kind === 'terminal' ? 'terminal' : 'session',
      target,
      title,
      glyph: sessionGlyph(session),
      ...(session.kind === 'agent' ? { responsible: session.responsible } : {}),
      unread: session.kind === 'agent' && isUnseen(marks, 'session', session.id, session.noteworthyAt),
      ...place(target),
      quiet: quiet || isSessionOver(session),
      session,
    };
  };

  const all = [...sessions.sessions.values()];
  const byTopic = new Map<string, AgentSession[]>();
  const free: SessionInfo[] = [];
  for (const session of all) {
    if (session.kind === 'agent' && session.topicId !== undefined) {
      const list = byTopic.get(session.topicId) ?? [];
      list.push(session);
      byTopic.set(session.topicId, list);
    } else {
      free.push(session);
    }
  }

  const groups: TreeGroup[] = [];
  for (const topic of selectTopicList(topics)) {
    const own = (byTopic.get(topic.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    const rows: TreeRow[] = [];

    // ---- Discussion
    const discussions = own.filter((session) => session.purpose === 'discussion');
    const current = discussions.find((session) => session.id === topic.discussionSessionId) ?? (topic.discussionSessionId === undefined ? discussions.at(-1) : undefined);
    if (current) rows.push(sessionRow(current));

    // ---- Spec, Plan
    const spec: ColumnRef = { kind: 'spec', topicId: topic.id };
    rows.push({
      id: `spec:${topic.id}`,
      kind: 'spec',
      target: spec,
      title: t('row.spec'),
      ...(topic.spec.exists ? (topic.plan.exists ? {} : { meta: t('row.spec.draft') }) : { meta: t('row.spec.missing') }),
      glyph: null,
      unread: topic.spec.exists && isUnseen(marks, 'spec', topic.id, topic.spec.changedAt),
      ...place(spec),
      quiet: !topic.spec.exists,
    });
    const planTarget: ColumnRef = { kind: 'plan', topicId: topic.id };
    rows.push({
      id: `plan:${topic.id}`,
      kind: 'plan',
      target: planTarget,
      title: t('row.plan'),
      meta: topic.plan.exists ? t('row.plan.reviewed', { reviewed: topic.plan.reviewed, items: topic.plan.items }) : t('row.plan.missing'),
      glyph: null,
      unread: topic.plan.exists && isUnseen(marks, 'plan', topic.id, topic.plan.changedAt),
      ...place(planTarget),
      quiet: !topic.plan.exists,
    });

    // ---- work items
    const itemSessions = own.filter((session) => session.purpose === 'item');
    const newestOf = (itemId: string): AgentSession | undefined =>
      itemSessions.filter((session) => session.itemId === itemId).sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0) || b.createdAt - a.createdAt)[0];
    const plan: PlanInfo | null | undefined = topics.plans.get(topic.id);
    if (plan) {
      for (const item of plan.items) {
        if (!item.inPlan && item.sessionId === undefined) continue;
        const label = itemLabel(item);
        const session = (item.sessionId === undefined ? undefined : sessions.sessions.get(item.sessionId)) ?? newestOf(item.id);
        const report: TreeRow['report'] | undefined =
          item.report === undefined ? undefined : { target: { kind: 'report', topicId: topic.id, itemId: item.id }, waiting: item.report.state !== 'reviewed' };
        if (session) {
          rows.push({ ...sessionRow(session, (session.title ?? '').trim() === '' ? label : sessionTitle(session)), ...(report ? { report } : {}) });
        } else {
          rows.push({
            id: `item:${topic.id}:${item.id}`,
            kind: 'item',
            target: planTarget,
            title: label,
            glyph: itemGlyph(item),
            responsible: item.responsible === null ? null : { userId: item.responsible.userId, displayName: item.responsible.displayName },
            ...(report ? { report } : {}),
            unread: false,
            // The Plan row says that the plan is open; an item that has not started is only a way to it.
            open: false,
            current: false,
            quiet: true,
          });
        }
      }
    } else {
      const seen = new Set<string>();
      const newest = itemSessions
        .filter((session) => session.itemId !== undefined)
        .sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0) || b.createdAt - a.createdAt)
        .filter((session) => (seen.has(session.itemId as string) ? false : (seen.add(session.itemId as string), true)));
      for (const session of newest.sort((a, b) => (a.item?.number ?? 0) - (b.item?.number ?? 0) || a.createdAt - b.createdAt)) rows.push(sessionRow(session));
    }

    // ---- earlier discussions
    for (const earlier of discussions) if (earlier !== current) rows.push(sessionRow(earlier, (earlier.title ?? '').trim() === '' ? t('row.earlier') : sessionTitle(earlier), true));

    const shown = rows.filter((row) => keep(row, columns.filter, selfUserId));
    if (columns.filter !== 'all' && shown.length === 0) continue;
    const glyphs = rows.flatMap((row) => (row.glyph === null ? [] : [row.glyph]));
    const id = topicGroupId(topic.id);
    groups.push({
      id,
      topic,
      name: topic.name,
      // A complete topic folds by itself; a person's own fold wins.
      open: columns.groupOpen[id] ?? topic.phase !== 'complete',
      waiting: glyphs.filter(waitsForPerson).length,
      urgent: mostUrgent(glyphs),
      rows: shown,
    });
  }

  const freeRows = free.sort((a, b) => b.createdAt - a.createdAt).map((session) => sessionRow(session));
  const shownFree = freeRows.filter((row) => keep(row, columns.filter, selfUserId));
  if (shownFree.length > 0) {
    const glyphs = freeRows.flatMap((row) => (row.glyph === null ? [] : [row.glyph]));
    groups.push({
      id: FREE_GROUP,
      name: t('group.free'),
      open: columns.groupOpen[FREE_GROUP] ?? true,
      waiting: glyphs.filter(waitsForPerson).length,
      urgent: mostUrgent(glyphs),
      rows: shownFree,
    });
  }
  return groups;
}

/** The running sessions of a group, in list order, at most `max`: "watch its running sessions side by side". */
export function runningTargets(group: TreeGroup, max: number): ColumnRef[] {
  return group.rows
    .filter((row) => row.kind === 'session' && row.session !== undefined && !isSessionOver(row.session) && row.session.kind === 'agent' && row.session.purpose === 'item')
    .slice(0, max)
    .map((row) => row.target);
}

/**
 * The archived topics ("Show archived topics"), each folded until a person opens it: its spec and plan and, once
 * looked up (sessions.ofTopic), its sessions, oldest first. Everything in them is quiet: nothing there is waiting.
 */
export function buildArchivedGroups(input: TreeInput): TreeGroup[] {
  const { topics, sessions, columns } = input;
  const openIds = new Set(columns.columns.map((column) => column.id));
  const place = (target: ColumnRef): Pick<TreeRow, 'open' | 'current'> => ({ open: openIds.has(columnId(target)), current: columns.focusedId === columnId(target) });
  return [...(topics.archived?.values() ?? [])]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((topic): TreeGroup => {
      const spec: ColumnRef = { kind: 'spec', topicId: topic.id };
      const plan: ColumnRef = { kind: 'plan', topicId: topic.id };
      const rows: TreeRow[] = [];
      if (topic.spec.exists) rows.push({ id: `spec:${topic.id}`, kind: 'spec', target: spec, title: t('row.spec'), glyph: null, unread: false, ...place(spec), quiet: true });
      if (topic.plan.exists) {
        rows.push({ id: `plan:${topic.id}`, kind: 'plan', target: plan, title: t('row.plan'), meta: t('row.plan.reviewed', { reviewed: topic.plan.reviewed, items: topic.plan.items }), glyph: null, unread: false, ...place(plan), quiet: true });
      }
      const own = [...sessions.others.values()].filter((session) => session.kind === 'agent' && session.topicId === topic.id).sort((a, b) => a.createdAt - b.createdAt);
      for (const session of own) {
        const target: ColumnRef = { kind: 'session', sessionId: session.id };
        rows.push({ id: `session:${session.id}`, kind: 'session', target, title: sessionTitle(session), glyph: sessionGlyph(session), unread: false, ...place(target), quiet: true, session });
      }
      const id = topicGroupId(topic.id);
      return { id, topic, name: topic.name, open: columns.groupOpen[id] ?? false, waiting: 0, urgent: null, rows };
    });
}
