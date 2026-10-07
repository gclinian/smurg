// Integration with the REAL lock manager and activity feed (src/locks/, owned by the locks engineer): the hook
// server's calls must mean what the LockManager contract says. The other hook tests use a stand-in so they do not
// depend on that module; this file catches drift between the two.
import { join } from 'node:path';
import { MAIN_ROOT, type MemberNotification } from '@smurg/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTestDaemon, TEST_HOST_USER, type TestDaemon } from '../../src/testing/index.ts';
import { denyReasonOf, hookRequest, lifecycle, mcpRequest, post, pre, registerAgent } from './helpers.ts';

const HOST = { userId: TEST_HOST_USER, name: 'Host' };
const file = (path: string) => ({ root: MAIN_ROOT, path });

let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function setup(): Promise<{ t: TestDaemon; hooks: HookServerImpl }> {
  t = await createTestDaemon({ modules: [locksModule, hooksModule], project: { files: { 'locked.txt': 'x', 'free.txt': 'y' } } });
  return { t, hooks: t.ctx.services.hooks as HookServerImpl };
}

describe('hook server × the real lock manager', () => {
  it('R8: an agent\'s Edit of a file someone is typing in is blocked and names the holder — with the real LockManager; granted, released by PostToolUse and by the next prompt', async () => {
    const { t: d, hooks } = await setup();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    expect(d.ctx.services.locks.touchHuman(file('locked.txt'), { userId: amy.userId, displayName: 'Amy' }).ok).toBe(true);
    const s = registerAgent(hooks, HOST);
    const denied = await hookRequest(hooks.socketPath, s.token, pre(join(d.root, 'locked.txt')));
    expect(denyReasonOf(denied)).toContain('Amy');
    expect(d.ctx.services.locks.get(file('locked.txt'))?.kind).toBe('human');

    expect((await hookRequest(hooks.socketPath, s.token, pre(join(d.root, 'free.txt'))))['hookOutput']).toBeNull();
    expect(d.ctx.services.locks.get(file('free.txt'))).toMatchObject({ kind: 'agent', sessionId: s.sessionId, agentName: 'Claude (Host)' });
    await hookRequest(hooks.socketPath, s.token, post(join(d.root, 'free.txt')));
    expect(d.ctx.services.locks.get(file('free.txt'))).toBeNull();

    await hookRequest(hooks.socketPath, s.token, pre(join(d.root, 'free.txt')));
    await hookRequest(hooks.socketPath, s.token, post(join(d.root, 'free.txt'), 'PermissionRequest'));
    expect(d.ctx.services.locks.get(file('free.txt'))?.kind).toBe('agent');
    await hookRequest(hooks.socketPath, s.token, lifecycle('UserPromptSubmit'));
    expect(d.ctx.services.locks.get(file('free.txt'))).toBeNull();
  });

  it('wait_for_lock returns when the real lock is released; notify_member goes through the real activity feed', async () => {
    const { t: d, hooks } = await setup();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const got: MemberNotification[] = [];
    amy.conn.on('activity.notify', (payload) => got.push(payload.notification));
    d.ctx.services.locks.touchHuman(file('locked.txt'), { userId: amy.userId, displayName: 'Amy' });
    const s = registerAgent(hooks, HOST);
    const waiting = mcpRequest(hooks.socketPath, s.token, 'wait_for_lock', { file_path: 'locked.txt', timeout_seconds: 30 }, 40_000);
    setTimeout(() => d.ctx.services.locks.leaveHuman(file('locked.txt'), amy.userId, 'closed'), 300);
    expect(await waiting).toMatchObject({ ok: true, result: { released: true, lock: null } });
    expect(await mcpRequest(hooks.socketPath, s.token, 'notify_member', { member: 'Amy', message: 'done with free.txt' })).toMatchObject({ ok: true, result: { delivered: true } });
    await expect.poll(() => got.length).toBe(1);
    expect(got[0]).toMatchObject({ from: { kind: 'agent', sessionId: s.sessionId }, text: 'done with free.txt' });
  });

  it("DX-12 notify_member carries an agent's own words to a person: they are masked like every other text of an agent", async () => {
    const { t: d, hooks } = await setup();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'viewer' });
    const got: MemberNotification[] = [];
    amy.conn.on('activity.notify', (payload) => got.push(payload.notification));
    const s = registerAgent(hooks, HOST);
    const message = 'The key in .env is sk-ant-abcdefgh12345678 and the header is Authorization: Bearer abc.def.ghi-123';
    expect(await mcpRequest(hooks.socketPath, s.token, 'notify_member', { member: 'Amy', message })).toMatchObject({ ok: true, result: { delivered: true } });
    await expect.poll(() => got.length).toBe(1);
    expect(got[0]?.text).toBe('The key in .env is [masked] and the header is Authorization: [masked]');
  });
});
