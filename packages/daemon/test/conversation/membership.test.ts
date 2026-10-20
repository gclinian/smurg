// What goes with a member (ARCHITECTURE §3 "When a member goes"; DESIGN §3.9, §7 S17), through the core's real
// teardown: the kick, the role change and the leave travel over the wire, the conversation module answers
// `memberRemoved`, the (fake) session registry does its per-session part afterwards.
import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '@smurg/protocol';
import { AMY, HOST, MEI, PARTS, bashRequest, collect, openItemSession, openSession, principalOf, questionRequest, quiet, startStack, waitFor, watch, type Stack } from './support.ts';

const ONE_PART = [PARTS[0] as (typeof PARTS)[number]];

async function handovers(s: Stack): Promise<AuditEntry[]> {
  await s.t.ctx.audit.flush();
  return (await s.t.ctx.audit.query({ limit: 200 })).filter((entry) => entry.action === 'session.handover').reverse();
}

/** The catalog ids of a session's system lines. */
function lines(s: Stack, sessionId: string): string[] {
  return s.fakes.agents.eventsOf(sessionId).flatMap((event) => (event.kind === 'line' ? [event.text.id] : []));
}

/** The host agent's list as the stand-in's 2.1.288 answers it, in the wire's shape: Fable may bill usage credits. */
const MODELS = [
  { value: 'sonnet', name: 'Sonnet', description: '', resolved: 'claude-sonnet-5-5', auto: true },
  { value: 'fable', name: 'Fable', description: '', resolved: 'claude-fable-5-1', auto: true, billing: 'usage-credits' as const },
];

/**
 * What Mei (Agent access) put in place: an always-allowed kind in the host's free session, a mode there looser than
 * the workspace's ("Asks before commands", the host's choice here) and a model that may bill usage credits, a vote on
 * its open question, a queued message; in a second session of the host a STRICTER mode and a model that bills
 * nothing extra (DESIGN 0.6.0 D12: those stay); and a work item's session of her own with an open question.
 */
async function meiAtWork(s: Stack): Promise<{ shared: string; own: string; strict: string }> {
  await s.t.ctx.settings.update({ permissionMode: 'ask-commands' }, principalOf(s, HOST));
  s.fakes.agents.hostAgent = { ...s.fakes.agents.hostAgent, models: MODELS, modelsKnown: true };
  const shared = await openSession(s, HOST, { modeChoice: null });
  const strict = await openSession(s, HOST, { modeChoice: null });
  const own = await openItemSession(s, MEI);
  for (const client of [s.host, s.amy]) await watch(client, shared.id);
  s.fakes.agents.raise(shared.id, bashRequest('pr1', 'pnpm test cart', { suggestedRule: { tool: 'Bash', pattern: 'pnpm test *' } }));
  await quiet(s);
  await s.mei.conn.request('permission.decide', { requestId: 'pr1', decision: 'allow-always' });
  await s.mei.conn.request('session.mode.set', { sessionId: shared.id, mode: 'auto' });
  await s.mei.conn.request('session.model.set', { sessionId: shared.id, model: 'fable' });
  await s.mei.conn.request('session.mode.set', { sessionId: strict.id, mode: 'ask-all' });
  await s.mei.conn.request('session.model.set', { sessionId: strict.id, model: 'sonnet' });
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
  expect(s.fakes.agents.facts(shared.id)?.modelChangedBy).toBe(MEI);
  return { shared: shared.id, own: own.id, strict: strict.id };
}

/** What stays of Mei's choices (DESIGN 0.6.0 D12): the stricter mode and the model that bills nothing extra. */
function strictStays(s: Stack, strict: string): void {
  expect(s.fakes.agents.get(strict)).toMatchObject({ permissionMode: 'ask-all', modeChoice: 'ask-all', model: 'sonnet' });
  expect(s.fakes.agents.facts(strict)).toMatchObject({ modeChangedBy: MEI, modelChangedBy: MEI });
  expect(lines(s, strict)).toEqual(['conversation.mode.changed', 'conversation.model.changed']);
}

describe('when a member goes', { timeout: 60_000 }, () => {
  it('S17 a kicked member\'s rule, loosened mode, queued message and vote are gone, and a turn that holds their message stops', async () => {
    const s = await startStack();
    const changes = collect(s.amy, 'question.changed');
    const { shared, own, strict } = await meiAtWork(s);
    // A running turn of another session still holds a message of hers that Claude Code has not started.
    const busy = await openSession(s, HOST);
    s.fakes.agents.undelivered.set(MEI, [busy.id]);
    s.fakes.agents.log.clear();

    await s.host.conn.request('admin.member.kick', { userId: MEI });
    await quiet(s);

    // The always-allowed kind she added is gone, by the system, and the conversation says whose it was. Her mode
    // choice goes too, as it was LOOSER than what the session follows (0.6.0 on purpose, DESIGN D12: the workspace's
    // "Asks before commands"), and her model that may bill usage credits (the host's default again).
    expect(s.fakes.agents.rules(shared)).toEqual([]);
    expect(s.fakes.agents.get(shared)).toMatchObject({ permissionMode: 'ask-commands', modeChoice: null, model: null, ruleCount: 0 });
    expect(s.fakes.agents.facts(shared)?.modeChangedBy).toBeUndefined();
    expect(s.fakes.agents.facts(shared)?.modelChangedBy).toBeUndefined();
    // (Those lines are the agent runtime's own: `setRules`, `setMode` and `setModel` by the system write them.)
    expect(lines(s, shared)).toEqual(['conversation.rule.added', 'conversation.mode.changed', 'conversation.model.changed', 'conversation.rule.removed.member', 'conversation.agent.restarting', 'conversation.mode.reset', 'conversation.model.reset']);
    expect(s.fakes.agents.log.of('setRules')).toEqual([[shared, [], { kind: 'system' }]]);
    expect(s.fakes.agents.log.of('setMode')).toEqual([[shared, null, { kind: 'system' }]]);
    expect(s.fakes.agents.log.of('setModel')).toEqual([[shared, null, { kind: 'system' }]]);
    strictStays(s, strict);
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

  it('DESIGN 0.6.0 D12: a mode choice EQUAL to what the session follows goes back too, so that it cannot outlast a later tightening of the workspace', async () => {
    const s = await startStack();
    // The workspace runs in auto mode (0.6.0's default); Mei picks "Auto" itself for a session of the host's.
    const session = await openSession(s, HOST, { modeChoice: null });
    await s.mei.conn.request('session.mode.set', { sessionId: session.id, mode: 'auto' });
    expect(s.fakes.agents.facts(session.id)?.modeChangedBy).toBe(MEI);
    s.fakes.agents.log.clear();
    await s.host.conn.request('admin.member.kick', { userId: MEI });
    await quiet(s);
    // 0.6.0's review: only a STRICTLY looser choice went back, so this one stayed, and when the host later made the
    // workspace ask before everything, this session alone went on in auto mode on a removed member's choice.
    expect(s.fakes.agents.log.of('setMode')).toEqual([[session.id, null, { kind: 'system' }]]);
    expect(s.fakes.agents.get(session.id)).toMatchObject({ modeChoice: null, permissionMode: 'auto' });
    expect(s.fakes.agents.facts(session.id)?.modeChangedBy).toBeUndefined();
    expect(lines(s, session.id)).toEqual(['conversation.mode.changed', 'conversation.mode.reset']);
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
    const { shared, own, strict } = await meiAtWork(s);
    await s.host.conn.request('admin.member.setRole', { userId: MEI, role: 'editor' });
    await quiet(s);
    expect(s.fakes.agents.rules(shared)).toEqual([]);
    expect(s.fakes.agents.get(shared)).toMatchObject({ permissionMode: 'ask-commands', model: null });
    strictStays(s, strict);
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
    const { shared, own, strict } = await meiAtWork(s);
    s.fakes.agents.undelivered.set(MEI, [shared]);
    s.fakes.agents.log.clear();
    await s.mei.conn.request('channel.leave', {});
    await quiet(s);
    expect(s.fakes.agents.rules(shared)).toEqual([]);
    expect(s.fakes.agents.get(shared)).toMatchObject({ permissionMode: 'ask-commands', model: null });
    strictStays(s, strict);
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
