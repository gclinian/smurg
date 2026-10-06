// When a member goes (ARCHITECTURE §3 "When a member goes"): ONE place in the core, driven by the member events, so a
// kick, a leave or a role change from any path ends in the same state. In this order:
//   ConversationService.memberRemoved → TopicService.memberRemoved → SessionManager.teardownUser (+ uploads)
// and one `session.handover` audit entry per session that passed to the host, with what was removed.
// The services here are the in-memory fakes of core/fakes (the same contracts the real modules implement).
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '@smurg/protocol';
import { TEARDOWN_TIMEOUT_MS, teardownMember } from '../src/admin/teardown.ts';
import type { FeatureModule } from '../src/core/context.ts';
import { buildAgentSession, fakesModule, fakesOf, type Fakes } from '../src/core/fakes/index.ts';
import type { FeatureServices } from '../src/core/interfaces.ts';
import { toDisposable } from '../src/core/lifecycle.ts';
import { SYSTEM_PRINCIPAL } from '../src/core/permissions.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

function fakeUploads(order: string[]): FeatureModule {
  return {
    name: 'fake-uploads',
    create: () => ({
      uploads: {
        abortAllForUser: async (userId: string) => {
          order.push(`uploads:${userId}`);
        },
      } as unknown as FeatureServices['uploads'],
    }),
    register: () => toDisposable(() => {}),
  };
}

/** A daemon with fakes whose three teardown methods also write their name into `order`. */
async function start(): Promise<{ daemon: TestDaemon; fakes: Fakes; order: string[] }> {
  const order: string[] = [];
  const daemon = await createTestDaemon({ modules: [fakesModule(), fakeUploads(order)] });
  t = daemon;
  const fakes = fakesOf(daemon.ctx);
  const conversation = fakes.conversation.memberRemoved.bind(fakes.conversation);
  fakes.conversation.memberRemoved = (userId, change, to) => {
    order.push(`conversation:${userId}:${change}${to === undefined ? '' : `:${to}`}`);
    return conversation(userId, change, to);
  };
  const topics = fakes.topics.memberRemoved.bind(fakes.topics);
  fakes.topics.memberRemoved = (userId, change, to) => {
    order.push(`topics:${userId}:${change}${to === undefined ? '' : `:${to}`}`);
    return topics(userId, change, to);
  };
  const sessions = fakes.sessions.teardownUser.bind(fakes.sessions);
  fakes.sessions.teardownUser = async (userId, change, to) => {
    order.push(`sessions:${userId}:${change}${to === undefined ? '' : `:${to}`}`);
    return sessions(userId, change, to);
  };
  return { daemon, fakes, order };
}

async function handovers(daemon: TestDaemon): Promise<AuditEntry[]> {
  await daemon.ctx.audit.flush();
  return (await daemon.ctx.audit.query({ limit: 200 })).filter((entry) => entry.action === 'session.handover').reverse();
}

const RITA = { userId: 'dev:rita', displayName: 'Rita' };

describe('the order', () => {
  it('a kick: conversation, then topics, then the sessions and the uploads; the handler answers after all of them', async () => {
    const { daemon, order } = await start();
    const host = await daemon.connectHost();
    await daemon.connect({ userId: 'dev:rita', role: 'agent' });
    await host.conn.request('admin.member.kick', { userId: 'dev:rita' });
    expect(order.slice(0, 2)).toEqual(['conversation:dev:rita:kicked', 'topics:dev:rita:kicked']);
    expect(order.slice(2).sort()).toEqual(['sessions:dev:rita:kicked', 'uploads:dev:rita']);
  });

  it('a leave runs the same steps; a role change passes the new role and leaves the uploads alone', async () => {
    const { daemon, order } = await start();
    const host = await daemon.connectHost();
    const rita = await daemon.connect({ userId: 'dev:rita', role: 'agent' });
    await host.conn.request('admin.member.setRole', { userId: 'dev:rita', role: 'viewer' });
    expect(order).toEqual(['conversation:dev:rita:role-changed:viewer', 'topics:dev:rita:role-changed:viewer', 'sessions:dev:rita:role-changed:viewer']);
    order.length = 0;
    await waitFor(() => rita.conn.getState().kind === 'online', { what: 'rita online with the new role' });
    await rita.conn.request('channel.leave', {});
    expect(order.slice(0, 2)).toEqual(['conversation:dev:rita:left', 'topics:dev:rita:left']);
    expect(order.slice(2).sort()).toEqual(['sessions:dev:rita:left', 'uploads:dev:rita']);
  });

  it('a kick from another path (the member directory itself) runs it too', async () => {
    const { daemon, order } = await start();
    await daemon.connect({ userId: 'dev:rita', role: 'editor' });
    daemon.ctx.members.kick('dev:rita', SYSTEM_PRINCIPAL);
    await waitFor(() => order.length === 4, { what: 'the four steps' });
    expect(order.slice(0, 2)).toEqual(['conversation:dev:rita:kicked', 'topics:dev:rita:kicked']);
  });

  it('a step that throws or never answers is logged and the others still run', async () => {
    const { daemon, fakes, order } = await start();
    fakes.conversation.memberRemoved = () => {
      order.push('conversation:throws');
      throw new Error('broken');
    };
    const result = await teardownMember(daemon.ctx, 'dev:rita', 'kicked');
    expect(order[0]).toBe('conversation:throws');
    expect(order).toContain('topics:dev:rita:kicked');
    expect(order).toContain('sessions:dev:rita:kicked');
    expect(result.conversation).toBeNull();
    expect(result.topics).toEqual({ rules: [], disarmed: [] });
    // Each step has a budget, so a kick answers within the 3 seconds SPEC R2 gives it.
    expect(TEARDOWN_TIMEOUT_MS).toBeLessThan(3_000);
  });
});

describe('what the fakes do with the sessions (the contract of SessionManager.teardownUser)', () => {
  it('a kick ends terminals and free sessions, hands topic sessions to the host STOPPED, and clears the member as responsible', async () => {
    const { daemon, fakes } = await start();
    const host = await daemon.connectHost();
    await daemon.connect({ userId: 'dev:rita', role: 'agent' });
    fakes.agents.adopt(buildAgentSession({ id: 'ses_free', openedBy: RITA }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_item', purpose: 'item', topicId: 'tp_login', itemId: 't2', attempt: 1, openedBy: RITA, status: 'running' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_other', purpose: 'discussion', topicId: 'tp_login', responsible: RITA }));
    fakes.conversation.removal = { rules: ['Bash(pnpm test *)'], modesReset: ['ses_item'], votes: 2, messages: 1 };
    fakes.topics.removal = { rules: ['Edit(src/**)'], disarmed: [{ topicId: 'tp_login', itemId: 't3' }] };

    await host.conn.request('admin.member.kick', { userId: 'dev:rita' });

    expect(fakes.agents.get('ses_free')?.status).toBe('ended');
    expect(fakes.agents.facts('ses_item')?.ownerUserId).toBe(daemon.hostUserId);
    expect(fakes.agents.get('ses_item')?.status).not.toBe('ended');
    expect(fakes.agents.log.of('interrupt').map((args) => args[0])).toEqual(['ses_item']);
    expect(fakes.agents.get('ses_other')?.responsible).toBeNull();

    const entries = await handovers(daemon);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'system' },
      outcome: 'ok',
      target: 'ses_item',
      detail: {
        from: 'dev:rita',
        to: daemon.hostUserId,
        reason: 'kicked',
        sessionId: 'ses_item',
        topicId: 'tp_login',
        stopped: true,
        modeReset: true,
        removed: { rules: ['Bash(pnpm test *)', 'Edit(src/**)'], armedItems: ['tp_login/t3'], queuedMessages: 1, votes: 2, modesReset: ['ses_item'] },
      },
    });
  });

  it('a leave hands topic sessions over RUNNING; a role change that keeps agent access ends nothing', async () => {
    const { daemon, fakes } = await start();
    const host = await daemon.connectHost();
    const rita = await daemon.connect({ userId: 'dev:rita', role: 'agent' });
    await daemon.connect({ userId: 'dev:eddie', role: 'editor' });
    fakes.agents.adopt(buildAgentSession({ id: 'ses_item', purpose: 'item', topicId: 'tp_login', itemId: 't2', attempt: 1, openedBy: RITA, status: 'running' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_voted', purpose: 'discussion', topicId: 'tp_login', responsible: { userId: 'dev:eddie', displayName: 'Eddie' } }));

    // Editor → Viewer loses `discuss`: no session of Eddie's ends (he has none), but he is no longer responsible.
    await host.conn.request('admin.member.setRole', { userId: 'dev:eddie', role: 'viewer' });
    expect(fakes.agents.get('ses_voted')?.responsible).toBeNull();
    const afterDemotion = await handovers(daemon);
    expect(afterDemotion).toHaveLength(1);
    expect(afterDemotion[0]).toMatchObject({ target: 'dev:eddie', detail: { from: 'dev:eddie', reason: 'role-changed', role: 'viewer', cleared: ['ses_voted'] } });

    await rita.conn.request('channel.leave', {});
    expect(fakes.agents.facts('ses_item')?.ownerUserId).toBe(daemon.hostUserId);
    expect(fakes.agents.log.of('interrupt')).toEqual([]);
    const entries = await handovers(daemon);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ target: 'ses_item', detail: { from: 'dev:rita', reason: 'left', stopped: false, modeReset: false } });
  });

  it('nothing handed over and nothing removed: no entry at all', async () => {
    const { daemon } = await start();
    const host = await daemon.connectHost();
    await daemon.connect({ userId: 'dev:vera', role: 'viewer' });
    await host.conn.request('admin.member.kick', { userId: 'dev:vera' });
    expect(await handovers(daemon)).toEqual([]);
  });

  it('nothing handed over but something the member put in place went: one entry about the member', async () => {
    const { daemon, fakes } = await start();
    const host = await daemon.connectHost();
    await daemon.connect({ userId: 'dev:eddie', role: 'editor' });
    fakes.conversation.removal = { rules: [], modesReset: [], votes: 3, messages: 0 };
    await host.conn.request('admin.member.kick', { userId: 'dev:eddie' });
    const entries = await handovers(daemon);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ target: 'dev:eddie', detail: { from: 'dev:eddie', to: daemon.hostUserId, reason: 'kicked', removed: { votes: 3, rules: [], armedItems: [], queuedMessages: 0 } } });
  });
});

describe('without the modules', () => {
  it('service slots that are still stubs are skipped: a kick works in a daemon with no feature module', async () => {
    t = await createTestDaemon({ modules: [] });
    const host = await t.connectHost();
    await t.connect({ userId: 'dev:rita', role: 'agent' });
    await host.conn.request('admin.member.kick', { userId: 'dev:rita' });
    expect(t.ctx.members.get('dev:rita')?.status).not.toBe('active');
    expect(await handovers(t)).toEqual([]);
  });
});
