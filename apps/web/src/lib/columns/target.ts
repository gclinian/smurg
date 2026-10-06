// What a column of the sessions view shows (DESIGN §5.4): the wire's `ColumnTarget` without the console (a console
// section is a route, not a column). One thing is open at most once, so a column is identified by its target.
//
//   columnId({ kind: 'session', sessionId: 's1' })                  → 'session:s1'
//   columnId({ kind: 'report', topicId: 't1', itemId: 'cart-api' }) → 'report:t1:cart-api'
//
// A session column is a conversation (an agent session) or a terminal: which one is decided when it is rendered,
// from the session's kind (`columnKindOf`).
import { columnTargetSchema, type ColumnTarget, type SessionInfo } from '@smurg/protocol';

/** A thing a column can show. */
export type ColumnRef = Exclude<ColumnTarget, { kind: 'console' }>;

/** The component kinds a feature registers (lib/slots.ts): one per row of the table in DESIGN §5.4. */
export const COLUMN_KINDS = ['conversation', 'terminal', 'spec', 'plan', 'report', 'changes'] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];

/** The props of each kind's component. */
export interface ColumnBodyProps {
  /** An agent session: the conversation (features/conversation). */
  readonly conversation: { readonly sessionId: string };
  /** A terminal session (features/agents). */
  readonly terminal: { readonly sessionId: string };
  readonly spec: { readonly topicId: string };
  readonly plan: { readonly topicId: string };
  readonly report: { readonly topicId: string; readonly itemId: string };
  /** A merge request without a report (a free session's worktree). */
  readonly changes: { readonly requestId: string };
}

/** Where an inbox item or a link leads inside a column: a card, or an event of the conversation. */
export interface ColumnAnchor {
  readonly cardId?: string;
  readonly seq?: number;
}

export function isColumnRef(target: ColumnTarget): target is ColumnRef {
  return target.kind !== 'console';
}

export function columnId(target: ColumnRef): string {
  switch (target.kind) {
    case 'session':
      return `session:${target.sessionId}`;
    case 'spec':
      return `spec:${target.topicId}`;
    case 'plan':
      return `plan:${target.topicId}`;
    case 'report':
      return `report:${target.topicId}:${target.itemId}`;
    case 'changes':
      return `changes:${target.requestId}`;
  }
}

export function sameColumn(a: ColumnRef, b: ColumnRef): boolean {
  return columnId(a) === columnId(b);
}

/** A target read back from storage: a valid one, or null (corrupt, a console section, another version's shape). */
export function parseColumnRef(value: unknown): ColumnRef | null {
  const parsed = columnTargetSchema.safeParse(value);
  return parsed.success && isColumnRef(parsed.data) ? parsed.data : null;
}

/**
 * The component kind of a target. A session column needs the session: `null` while the session list has not told
 * what it is (still loading, or the host no longer keeps it).
 */
export function columnKindOf(target: ColumnRef, session: Pick<SessionInfo, 'kind'> | undefined): ColumnKind | null {
  if (target.kind !== 'session') return target.kind;
  if (session === undefined) return null;
  return session.kind === 'agent' ? 'conversation' : 'terminal';
}

/** The props a kind's component gets for `target`. */
export function columnBodyProps<K extends ColumnKind>(kind: K, target: ColumnRef): ColumnBodyProps[K] {
  const props: ColumnBodyProps[ColumnKind] =
    target.kind === 'session'
      ? { sessionId: target.sessionId }
      : target.kind === 'report'
        ? { topicId: target.topicId, itemId: target.itemId }
        : target.kind === 'changes'
          ? { requestId: target.requestId }
          : { topicId: target.topicId };
  void kind;
  return props as ColumnBodyProps[K];
}

/** The topic a target belongs to, when the target itself says so (a session's topic is on the session). */
export function topicIdOfTarget(target: ColumnRef): string | undefined {
  return target.kind === 'spec' || target.kind === 'plan' || target.kind === 'report' ? target.topicId : undefined;
}
