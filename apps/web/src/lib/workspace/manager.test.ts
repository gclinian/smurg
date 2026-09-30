import { describe, expect, it } from 'vitest';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { WORKSPACE_ID, makeInvite, makeWelcome } from '../../testing/fixtures.ts';
import type { OpenOptions } from '../connection/types.ts';
import { createWorkspaceManager } from './manager.ts';

function setup() {
  const created: { workspaceId: string; options: OpenOptions; conn: FakeConnection }[] = [];
  const timers: (() => void)[] = [];
  const manager = createWorkspaceManager({
    connect: (workspaceId, options) => {
      const conn = new FakeConnection();
      created.push({ workspaceId, options, conn });
      return conn;
    },
    releaseGraceMs: 1_000,
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: (handle) => {
      timers[(handle as number) - 1] = () => {};
    },
  });
  return { manager, created, runTimers: () => timers.splice(0).forEach((timer) => timer()) };
}

function invite() {
  const { fingerprint, secret } = makeInvite();
  return { fingerprint, secret };
}

describe('workspace manager: ONE connection per workspace', () => {
  it('shares the session between pages and starts the connection once', () => {
    const { manager, created } = setup();
    const join = manager.acquire(WORKSPACE_ID, { invite: invite() });
    const page = manager.acquire(WORKSPACE_ID);
    expect(page.session).toBe(join.session);
    expect(created).toHaveLength(1);
    expect(created[0]!.conn.started).toBe(true);
    expect(manager.peek(WORKSPACE_ID)).toBe(join.session);
  });

  it('keeps the session through a hand-over and closes it a grace period after the last page left', () => {
    const { manager, created, runTimers } = setup();
    const join = manager.acquire(WORKSPACE_ID, { invite: invite() });
    join.release();
    const page = manager.acquire(WORKSPACE_ID); // before the grace period ran out
    runTimers();
    expect(page.session.disposed).toBe(false);
    page.release();
    page.release(); // idempotent
    runTimers();
    expect(page.session.disposed).toBe(true);
    expect(created[0]!.conn.getState()).toMatchObject({ kind: 'closed', reason: 'local' });
    expect(manager.peek(WORKSPACE_ID)).toBeNull();
  });

  it('keeps an ended session (its screen explains why) unless a new invite comes', () => {
    const { manager, created } = setup();
    const first = manager.acquire(WORKSPACE_ID);
    created[0]!.conn.keyMismatch();
    expect(manager.acquire(WORKSPACE_ID).session).toBe(first.session);
    const withInvite = manager.acquire(WORKSPACE_ID, { invite: invite() });
    expect(withInvite.session).not.toBe(first.session);
    expect(first.session.disposed).toBe(true);
    expect(created).toHaveLength(2);
  });

  it('leave(): channel.leave, then the session is gone', async () => {
    const { manager, created } = setup();
    const handle = manager.acquire(WORKSPACE_ID);
    const conn = created[0]!.conn;
    conn.admit(makeWelcome());
    conn.handle('channel.leave', () => ({}));
    await manager.leave(WORKSPACE_ID);
    expect(conn.requestsOf('channel.leave')).toHaveLength(1);
    expect(handle.session.disposed).toBe(true);
    expect(manager.peek(WORKSPACE_ID)).toBeNull();
    // A later visit opens a fresh connection.
    manager.acquire(WORKSPACE_ID);
    expect(created).toHaveLength(2);
  });

  it('separate workspaces get separate connections', () => {
    const { manager, created } = setup();
    manager.acquire(WORKSPACE_ID);
    manager.acquire('ws_another_workspace_001');
    expect(created.map((c) => c.workspaceId)).toEqual([WORKSPACE_ID, 'ws_another_workspace_001']);
    manager.closeAll();
    expect(created.every((c) => c.conn.getState().kind === 'closed')).toBe(true);
  });
});
