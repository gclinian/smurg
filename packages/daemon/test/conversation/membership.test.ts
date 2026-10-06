// What goes with a member (ARCHITECTURE §3 "When a member goes"; DESIGN §3.9, §7 S17), through the core's real
// teardown: the kick, the role change and the leave travel over the wire, the conversation module answers
// `memberRemoved`, the (fake) session registry does its per-session part afterwards.
import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '@smurg/protocol';
import { AMY, HOST, MEI, PARTS, bashRequest, collect, openItemSession, openSession, questionRequest, quiet, startStack, waitFor, watch, type Stack } from './support.ts';

const ONE_PART = [PARTS[0] as (typeof PARTS)[number]];

async function handovers(s: Stack): Promise<AuditEntry[]> {
  await s.t.ctx.audit.flush();
  return (await s.t.ctx.audit.query({ limit: 200 })).filter((entry) => entry.action === 'session.handover').reverse();
}

/** The catalog ids of a session's system lines. */
function lines(s: Stack, sessionId: string): string[] {
  return s.fakes.agents.eventsOf(sessionId).flatMap((event) => (event.kind === 'line' ? [event.text.id] : []));
}

/**
 * What Mei (Agent access) put in place: an always-allowed kind in the host's free session, a loosened mode there, a
 * vote on its open question, a queued message; and a work item's session of her own with an open question.
 */
async function meiAtWork(s: Stack): Promise<{ shared: string; own: string }> {
  const shared = await openSession(s, HOST);
  const own = await openItemSession(s, MEI);
  for (const client of [s.host, s.amy]) await watch(client, shared.id);
  s.fakes.agents.raise(shared.id, bashRequest('pr1', 'pnpm test cart', { suggestedRule: { tool: 'Bash', pattern: 'pnpm test *' } }));
  await quiet(s);
  await s.mei.conn.request('permission.decide', { requestId: 'pr1', decision: 'allow-always' });
  await s.mei.conn.request('session.mode.set', { sessionId: shared.id, mode: 'ask-commands' });
  s.fakes.agents.raise(shared.id, questionRequest('q-shared', ONE_PART));
  s.fakes.agents.raise(own.id, questionRequest('q-own', ONE_PART));
  await s.mei.conn.request('question.vote', { questionId: 'q-shared', part: 0, options: [0] });
  await s.amy.conn.request('question.vote', { questionId: 'q-shared', part: 0, options: [1] });
  // A message of hers that no process has taken yet.
  const waiting = await openSession(s, HOST);
  s.fakes.agents.park(waiting.id);
  await s.mei.conn.request('session.message.send', { sessionId: waiting.id, text: 'do this when you wake up' });
  expect(s.fakes.agents.rules(shared.id)).toHaveLength(1);
  expect(s.fakes.agents.facts(shared.id)?.modeChangedBy).toBe(MEI);
  return { shared: shared.id, own: own.id };
}

describe('when a member goes', { timeout: 60_000 }, () => {
  it('S17 a kicked member\'s rule, loosened mode, queued message and vote are gone, and a turn that holds their message stops', async () => {
    const s = await startStack();
    const changes = collect(s.amy, 'question.changed');
    const { shared, own } = await meiAtWork(s);
    // A running turn of another session still holds a message of hers that Claude Code has not started.
    const busy = await openSession(s, HOST);
    s.fakes.agents.undelivered.set(MEI, [busy.id]);
    s.fakes.agents.log.clear();

    await s.host.conn.request('admin.member.kick', { userId: MEI });
    await quiet(s);

    // The always-allowed kind she added is gone, by the system, and the conversation says whose it was.
    expect(s.fakes.agents.rules(shared)).toEqual([]);
    expect(s.fakes.agents.get(shared)).toMatchObject({ permissionMode: 'ask-all', ruleCount: 0 });
    expect(s.fakes.agents.facts(shared)?.modeChangedBy).toBeUndefined();
    // (Those two lines are the agent runtime's own: `setRules` and `setMode` by the system write them.)
    expect(lines(s, shared)).toEqual(['conversation.rule.added', 'conversation.mode.changed', 'conversation.rule.removed.member', 'conversation.agent.restarting', 'conversation.mode.reset']);
    expect(s.fakes.agents.log.of('setRules')).toEqual([[shared, [], { kind: 'system' }]]);
    expect(s.fakes.agents.log.of('setMode')).toEqual([[shared, 'ask-all', { kind: 'system' }]]);
    // Her vote left the open question; the watchers saw it go; Amy's stays.
    expect(s.service.question('q-shared')?.votes.map((vote) => vote.userId)).toEqual([AMY]);
    await waitFor(() => changes.some((change) => change.voteRemoved?.userId === MEI), { what: 'voteRemoved for a watcher' });
    // Her queued message was dropped, and the turn that held an undelivered one was stopped (by the system: no line).
    expect(s.fakes.agents.log.of('cancelQueued')).toEqual([[MEI]]);
    expect(s.fakes.agents.log.of('interrupt')).toEqual(expect.arrayContaining([[busy.id, { kind: 'system' }]]));
    // Her own topic session passed to the host, stopped: its open question was withdrawn with the turn.
    expect(s.service.question('q-own')).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'stopped' } });
    expect(s.fakes.agents.facts(own)).toMatchObject({ ownerUserId: HOST, pathRights: 'member', fallbackDecider: null });
    // The core's audit entry lists all of it.
    expect(await handovers(s)).toMatchObject([
      { actor: { kind: 'system' }, target: own, detail: { from: MEI, to: HOST, reason: 'kicked', stopped: true, removed: { rules: ['Bash(pnpm test *)'], queuedMessages: 1, votes: 1, modesReset: [shared] } } },
    ]);
  });

  it('S17 a rejoined member is not the decider again', async () => {
    const s = await startStack();
    // A free session of the HOST that Mei is responsible for: its questions are hers to decide.
    const session = await openSession(s, HOST, { responsible: { userId: MEI, displayName: 'Mei' } });
    await watch(s.amy, session.id);
    const updates = collect(s.amy, 'question.updated');
    s.fakes.agents.raise(session.id, questionRequest('q1', ONE_PART));
    expect(s.service.question('q1')?.decider).toEqual({ userId: MEI, displayName: 'Mei' });

    await s.host.conn.request('admin.member.kick', { userId: MEI });
    await waitFor(() => s.service.question('q1')?.decider?.userId === HOST, { what: 'the host to decide' });
    await waitFor(() => updates.at(-1)?.question.decider?.userId === HOST, { what: 'the new decider for a watcher' });
    expect(s.fakes.agents.get(session.id)?.responsible).toBeNull();
    expect(lines(s, session.id)).toEqual(['conversation.responsible.fallback']);

    // She joins again with a new invite and her old role: nothing she decided before comes back to her.
    const again = await s.t.connect({ userId: MEI, displayName: 'Mei', role: 'agent' });
    s.service.sweep();
    expect(s.service.question('q1')?.decider).toEqual({ userId: HOST, displayName: 'Host' });
    expect(s.fakes.agents.facts(session.id)?.fallbackDecider).toBe(HOST);
    // She is a member with agent access like any other again: she votes, and may not submit before it escalates.
    await again.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
    await expect(again.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }] })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('losing agent access takes the rule, the mode and the queued message; the vote stays while the member still holds discuss', async () => {
    const s = await startStack();
    const { shared, own } = await meiAtWork(s);
    await s.host.conn.request('admin.member.setRole', { userId: MEI, role: 'editor' });
    await quiet(s);
    expect(s.fakes.agents.rules(shared)).toEqual([]);
    expect(s.fakes.agents.get(shared)?.permissionMode).toBe('ask-all');
    expect(s.service.question('q-shared')?.votes.map((vote) => vote.userId).sort()).toEqual([AMY, MEI].sort());
    // An Editor may still be the one who decides: her own item's question stays hers (the session passed to the host, running).
    expect(s.service.question('q-own')).toMatchObject({ status: 'open', decider: { userId: MEI } });
    expect(s.fakes.agents.facts(own)?.ownerUserId).toBe(HOST);
    expect(s.fakes.agents.log.of('interrupt')).toEqual([]);
    expect((await handovers(s))[0]).toMatchObject({ detail: { reason: 'role-changed', role: 'editor', stopped: false, removed: { rules: ['Bash(pnpm test *)'], votes: 0, queuedMessages: 1, modesReset: [shared] } } });

    // Now a Viewer: the vote goes too, and she no longer decides anything.
    await s.host.conn.request('admin.member.setRole', { userId: MEI, role: 'viewer' });
    await quiet(s);
    expect(s.service.question('q-shared')?.votes.map((vote) => vote.userId)).toEqual([AMY]);
    await waitFor(() => s.service.question('q-own')?.decider?.userId === HOST, { what: 'the host to decide her item\'s question' });
  });

  it('leaving takes what a kick takes, without stopping anything', async () => {
    const s = await startStack();
    const { shared, own } = await meiAtWork(s);
    s.fakes.agents.undelivered.set(MEI, [shared]);
    s.fakes.agents.log.clear();
    await s.mei.conn.request('channel.leave', {});
    await quiet(s);
    expect(s.fakes.agents.rules(shared)).toEqual([]);
    expect(s.fakes.agents.get(shared)?.permissionMode).toBe('ask-all');
    expect(s.service.question('q-shared')?.votes.map((vote) => vote.userId)).toEqual([AMY]);
    expect(s.fakes.agents.log.of('interrupt')).toEqual([]);
    expect(s.service.question('q-own')?.status).toBe('open');
    expect(s.fakes.agents.facts(own)?.ownerUserId).toBe(HOST);
    await waitFor(() => s.service.question('q-own')?.decider?.userId === HOST, { what: 'the host to decide after she left' });
  });

  it('a promotion removes nothing', async () => {
    const s = await startStack();
    const session = await openSession(s, HOST);
    s.fakes.agents.raise(session.id, questionRequest('q1', ONE_PART));
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
    await s.host.conn.request('admin.member.setRole', { userId: AMY, role: 'agent' });
    await quiet(s);
    expect(s.service.question('q1')?.votes).toHaveLength(1);
    expect(s.service.memberRemoved(AMY, 'role-changed', 'agent')).toEqual({ rules: [], modesReset: [], votes: 0, messages: 0 });
  });
});
