// The test harness itself: a real invite + Noise handshake through the in-memory relay, typed requests, the host
// console, stubs for unfinished features, and a clean stop.
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, isSmurgError } from '@smurg/protocol';
import { createTestDaemon, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe('test harness', () => {
  it('joins the host and a guest through real invites and answers admin requests', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    expect(host.welcome?.member.role).toBe('host');
    expect(host.welcome?.workspace.id).toBe(t.workspaceId);
    const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    expect(amy.welcome?.member).toMatchObject({ userId: 'dev:amy', displayName: 'Amy', role: 'editor', online: true });
    const { members } = await host.conn.request('admin.member.list', {});
    expect(members.map((m) => [m.userId, m.role, m.online]).sort()).toEqual([
      ['dev:amy', 'editor', true],
      ['dev:host', 'host', true],
    ]);
    expect(members.find((m) => m.userId === 'dev:amy')?.devices).toHaveLength(1);
  });

  it('can share a git-initialised temp project (isolated git config) and reports it in the Welcome', async () => {
    t = await createTestDaemon({ project: { files: { 'src/a.ts': 'export {};\n' }, git: true } });
    const amy = await t.connect({ userId: 'dev:amy' });
    expect(amy.welcome?.workspace).toMatchObject({ isGitRepo: true, name: 'project', hostUserId: 'dev:host' });
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(`${t.root}/.git/info/exclude`, 'utf8')).toContain('/.smurg/');
  });

  it('tells a member when their record changes (channel.memberUpdated), e.g. a new name from the relay', async () => {
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy' });
    const updates: string[] = [];
    amy.conn.on('channel.memberUpdated', (payload) => updates.push(payload.member.displayName));
    const laptop = await t.connect({ userId: 'dev:amy', displayName: 'Amy Chen', inviteUrl: t.createInvite('editor') });
    expect(laptop.welcome?.member.displayName).toBe('Amy Chen');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updates).toContain('Amy Chen');
  });

  it('answers requests of unfinished features with internal "not implemented"', async () => {
    // No feature module composed: every service slot keeps its stub (every area is implemented by now, so the default
    // composition has no unfinished feature left to probe).
    t = await createTestDaemon({ modules: [] });
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const error = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: '' }).catch((e: unknown) => e);
    expect(isSmurgError(error) && error.code).toBe('internal');
    expect((error as Error).message).toContain('not implemented');
  });

  it('stops cleanly: clients see channel.closed{stopped} (host offline), relay links closed', async () => {
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy', role: 'viewer' });
    const closed: string[] = [];
    amy.conn.on('channel.closed', (payload) => closed.push(payload.reason));
    await t.daemon.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toEqual(['stopped']);
    expect(amy.conn.getState().kind).toBe('host-offline');
    expect(t.relay.hostOnline('ws')).toBe(false);
    expect(t.daemon.status().stopped).toBe(true);
  });
});
