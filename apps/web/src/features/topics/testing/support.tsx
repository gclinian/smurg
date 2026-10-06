// TEST ONLY. A workspace whose FakeConnection answers what the topic screens ask on admission (the topic list, the
// plan, the sessions, the worktrees, the host state), with the people of the mock: Ian (host), Mei (agent access),
// Amy (editor), Vic (viewer).
import { act } from '@testing-library/react';
import type { HostState, MergeRequest, PlanInfo, PresenceMember, Role, SessionInfo, Topic, WorktreeInfo } from '@smurg/protocol';
import { FakeConnection } from '../../../testing/fake-connection.ts';
import { HOST_USER, makeMember, makeWelcome, presenceOf } from '../../../testing/fixtures.ts';

export const IAN = { userId: HOST_USER, displayName: 'Ian' } as const;
export const MEI = { userId: 'dev:mei', displayName: 'Mei' } as const;
export const AMY = { userId: 'dev:amy', displayName: 'Amy' } as const;
export const VIC = { userId: 'dev:vic', displayName: 'Vic' } as const;

export const PEOPLE: readonly PresenceMember[] = [
  presenceOf(makeMember({ ...IAN, role: 'host' })),
  presenceOf(makeMember({ ...MEI, role: 'agent' })),
  presenceOf(makeMember({ ...AMY, role: 'editor' })),
  presenceOf(makeMember({ ...VIC, role: 'viewer' })),
];

const SELF: Readonly<Record<Role, { userId: string; displayName: string }>> = { host: IAN, agent: MEI, editor: AMY, viewer: VIC };

export interface TopicWorld {
  readonly role?: Role;
  readonly topics?: readonly Topic[];
  /** By topic id; a topic without an entry has no plan. */
  readonly plans?: Readonly<Record<string, PlanInfo | null>>;
  readonly sessions?: readonly SessionInfo[];
  readonly worktrees?: readonly WorktreeInfo[];
  readonly requests?: readonly MergeRequest[];
  readonly members?: readonly PresenceMember[];
  readonly host?: HostState;
}

/** A connection that answers the lists; pass it to renderInWorkspace / renderInColumn as `conn` with `admit: false`, then `admitAs`. */
export function topicConnection(world: TopicWorld = {}): FakeConnection {
  const conn = new FakeConnection();
  conn.handle('topic.list', (payload) => ({ topics: payload.archived === true ? [] : [...(world.topics ?? [])], hasMore: false }));
  conn.handle('plan.get', (payload) => ({ plan: world.plans?.[payload.topicId] ?? null }));
  conn.handle('session.list', () => ({ sessions: [...(world.sessions ?? [])], hasMore: false }));
  conn.handle('worktree.list', () => ({ worktrees: [...(world.worktrees ?? [])] }));
  conn.handle('worktree.merge.list', () => ({ requests: [...(world.requests ?? [])] }));
  conn.handle('session.host.get', () => world.host ?? { account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'none' });
  return conn;
}

/** Admits the test's member (by role: Ian, Mei, Amy or Vic) and tells who is in the workspace. */
export function admitAs(conn: FakeConnection, world: TopicWorld = {}): void {
  const role = world.role ?? 'editor';
  act(() => {
    conn.admit(makeWelcome({ role, ...SELF[role] }));
    conn.emit('presence.state', { members: [...(world.members ?? PEOPLE)], agents: [] });
  });
}

/** Lets promises settle (a request answered by a handler, a store update, an effect). */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
