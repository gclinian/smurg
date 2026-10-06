// Test helpers of the conversation feature (imported by *.test.tsx only): a conversation column on a FakeConnection,
// with the session, the people and the first page a test asks for.
import { act } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { AgentSession, ConversationEvent, PresenceMember, ResultInputOf, Role } from '@smurg/protocol';
import { buildAgentSession } from '@smurg/protocol/testing';
import { renderInColumn } from '../../testing/columns.tsx';
import { HOST_USER, makeMember, presenceOf } from '../../testing/fixtures.ts';
import ConversationColumn from './ConversationColumn.tsx';

export const SID = 'sess_a';

export type WatchReply = ResultInputOf<'session.watch'>;

/** Lets pending promises and the effects behind them run. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  });
}

export const IAN = { userId: HOST_USER, displayName: 'Ian' };
export const MEI = { userId: 'dev:mei', displayName: 'Mei' };
export const AMY = { userId: 'dev:amy', displayName: 'Amy' };
export const LEO = { userId: 'dev:leo', displayName: 'Leo' };

/** Ian (host), Mei (agent access), Amy (editor), Leo (viewer): the people of the design's walk-through. */
export const PEOPLE: readonly PresenceMember[] = [
  presenceOf(makeMember({ ...IAN, role: 'host', color: '#111111' })),
  presenceOf(makeMember({ ...MEI, role: 'agent', color: '#222222' })),
  presenceOf(makeMember({ ...AMY, role: 'editor', color: '#333333' })),
  presenceOf(makeMember({ ...LEO, role: 'viewer', color: '#444444' })),
];

const SELF: Readonly<Record<Role, { userId: string; displayName: string }>> = { host: IAN, agent: MEI, editor: AMY, viewer: LEO };

export function watchReply(session: AgentSession, events: readonly ConversationEvent[] = [], overrides: Partial<WatchReply> = {}): WatchReply {
  return {
    session,
    events: [...events],
    firstSeq: events[0]?.seq ?? 0,
    nextSeq: (events.at(-1)?.seq ?? 0) + 1,
    hasEarlier: false,
    hasMore: false,
    streaming: [],
    questions: [],
    permissions: [],
    suggestions: [],
    moreCards: [],
    ...overrides,
  };
}

export interface Scene {
  /** Who looks (default the host, Ian). */
  readonly role?: Role;
  readonly session?: Partial<AgentSession>;
  readonly events?: readonly ConversationEvent[];
  /** The rest of the first page: cards, streaming blocks, `hasEarlier`. */
  readonly reply?: Partial<WatchReply>;
  readonly people?: readonly PresenceMember[];
  readonly focused?: boolean;
  readonly visible?: boolean;
  readonly place?: 'strip' | 'code';
  /** Mounted next to the column (the feature's overlays). */
  readonly beside?: ReactElement;
}

/** Renders the column of session SID as `role` sees it and answers its first page. */
export async function openConversation(scene: Scene = {}) {
  const role = scene.role ?? 'host';
  const session = buildAgentSession({ id: SID, openedBy: IAN, ...scene.session });
  const ui = (
    <>
      <ConversationColumn sessionId={SID} />
      {scene.beside}
    </>
  );
  const view = renderInColumn(ui, {
    target: { kind: 'session', sessionId: SID },
    role,
    ...SELF[role],
    ...(scene.focused === undefined ? {} : { focused: scene.focused }),
    ...(scene.visible === undefined ? {} : { visible: scene.visible }),
    ...(scene.place === undefined ? {} : { place: scene.place }),
  });
  view.conn.handle('session.list', () => ({ sessions: [session], hasMore: false }));
  act(() => view.conn.emit('presence.state', { members: [...(scene.people ?? PEOPLE)], agents: [] }));
  await settle();
  act(() => {
    view.conn.respond('session.watch', watchReply(session, scene.events, scene.reply));
  });
  await settle();
  return { ...view, agentSession: session };
}

/** Changes the session as `session.state` would. */
export function updateSession(view: Awaited<ReturnType<typeof openConversation>>, changes: Partial<AgentSession>): AgentSession {
  const next = { ...view.stores.sessions.getState().sessions.get(SID), ...changes } as AgentSession;
  act(() => view.conn.emit('session.state', { session: next }));
  return next;
}
