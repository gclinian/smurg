// What waits too long reaches the others who may settle it (ARCHITECTURE §3 "Who decides"; DESIGN §3.9). Stored times
// are compared with the daemon's clock on a real sweep: the tests move the clock and wait for the sweep.
import { describe, expect, it } from 'vitest';
import { ESCALATE_AFTER_MS_DEFAULT, permissionRecipients, questionRecipients } from '@smurg/protocol';
import { HOST, MEI, PARTS, auditOf, bashRequest, collect, openSession, questionRequest, quiet, refusal, settle, startStack, waitFor, watch } from './support.ts';

const NOA = 'dev:noa';
const ONE_PART = [PARTS[0] as (typeof PARTS)[number]];

describe('escalation', { timeout: 60_000 }, () => {
  it('T6.3 a thing that waits too long reaches the others', async () => {
    const s = await startStack();
    const noa = await s.t.connect({ userId: NOA, displayName: 'Noa', role: 'agent' });
    // Mei opened the session and is responsible for it: its questions and permission requests wait for her.
    const session = await openSession(s, MEI, { responsible: { userId: MEI, displayName: 'Mei' } });
    for (const client of [s.host, s.amy, noa]) await watch(client, session.id);
    const questions = collect(s.amy, 'question.updated');
    const permissions = collect(s.amy, 'permission.updated');
    s.fakes.agents.raise(session.id, questionRequest('q1', ONE_PART));
    s.fakes.agents.raise(session.id, bashRequest('pr1', 'pnpm test'));
    await quiet(s);
    const members = (): { userId: string; role: 'host' | 'agent' | 'editor' | 'viewer' }[] => s.t.ctx.members.routing();
    const routing = { responsible: MEI, fallbackDecider: MEI };
    const whoHasTheQuestion = (): string[] => questionRecipients({ escalated: s.service.question('q1')?.escalatedAt !== undefined }, routing, members()).sort();
    const whoHasTheRequest = (): string[] => permissionRecipients({ hostOnly: false, escalated: s.service.permission('pr1', true)?.escalatedAt !== undefined }, routing, members()).sort();
    expect(whoHasTheQuestion()).toEqual([MEI]);
    expect(whoHasTheRequest()).toEqual([MEI]);
    // Before the waiting time another member with agent access cannot submit for her; nothing has escalated.
    expect(await refusal(noa.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }] }))).toMatchObject({ code: 'forbidden', id: 'question.notDecider' });
    s.t.advanceClock(ESCALATE_AFTER_MS_DEFAULT - 30_000);
    await settle(20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.service.question('q1')?.escalatedAt).toBeUndefined();
    expect(s.service.permission('pr1', true)?.escalatedAt).toBeUndefined();

    // After it: both carry `escalatedAt`, every watcher gets the whole card again, the inbox routing widens.
    const bus: string[] = [];
    s.t.ctx.bus.on('question.changed', (event) => bus.push(`question:${event.question.escalatedAt !== undefined}`));
    s.t.ctx.bus.on('permission.changed', (event) => bus.push(`permission:${event.request.escalatedAt !== undefined}`));
    s.t.advanceClock(30_000);
    await waitFor(() => s.service.question('q1')?.escalatedAt !== undefined && s.service.permission('pr1', true)?.escalatedAt !== undefined, { what: 'both to escalate' });
    await waitFor(() => questions.at(-1)?.question.escalatedAt !== undefined && permissions.at(-1)?.request.escalatedAt !== undefined, { what: 'the escalated cards for a watcher' });
    expect(bus.sort()).toEqual(['permission:true', 'question:true']);
    expect(whoHasTheQuestion()).toEqual([HOST, MEI, NOA].sort());
    expect(whoHasTheRequest()).toEqual([HOST, MEI, NOA].sort());
    // It escalates once.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(questions.filter((update) => update.question.escalatedAt !== undefined)).toHaveLength(1);

    // An Editor still cannot; a member with agent access submits for Mei, recorded as that, and the conversation says so.
    expect(await refusal(s.amy.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }] }))).toMatchObject({ code: 'forbidden', id: 'question.notDecider' });
    const { question } = await noa.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [1] }] });
    expect(question.answer).toMatchObject({ by: { userId: NOA, displayName: 'Noa' }, onBehalfOf: { userId: MEI, displayName: 'Mei' } });
    expect(s.fakes.agents.eventsOf(session.id).flatMap((event) => (event.kind === 'line' ? [event.text] : []))).toEqual([{ id: 'conversation.submittedFor', params: { by: 'Noa', name: 'Mei' } }]);
    expect(await auditOf(s, 'question.submit')).toMatchObject([{ actor: { userId: NOA }, detail: { onBehalfOf: MEI, escalated: true } }]);
    // Noa did not become responsible by it.
    expect(s.fakes.agents.get(session.id)?.responsible).toEqual({ userId: MEI, displayName: 'Mei' });
  });

  it('the person a thing waits for is offline for a minute: it escalates at once', async () => {
    const s = await startStack({ agents: { escalateOfflineMs: 60_000 } });
    const session = await openSession(s, MEI, { responsible: { userId: MEI, displayName: 'Mei' } });
    s.fakes.agents.raise(session.id, questionRequest('q1', ONE_PART));
    s.fakes.agents.raise(session.id, bashRequest('pr1', 'pnpm test'));
    await quiet(s);
    // Online: half a minute changes nothing.
    s.t.advanceClock(30_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.service.question('q1')?.escalatedAt).toBeUndefined();
    // Mei closes her browser.
    s.mei.close();
    await waitFor(() => !s.t.ctx.hub.isOnline(MEI), { what: 'Mei to be offline' });
    // (One round of the sweep now, so "offline since" is this moment whatever the machine's load.)
    s.service.sweep();
    s.t.advanceClock(59_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.service.question('q1')?.escalatedAt).toBeUndefined();
    expect(s.service.permission('pr1', true)?.escalatedAt).toBeUndefined();
    s.t.advanceClock(1_500);
    await waitFor(() => s.service.question('q1')?.escalatedAt !== undefined && s.service.permission('pr1', true)?.escalatedAt !== undefined, { what: 'both to escalate' });
    // The count of who may vote follows who is online.
    expect(s.service.question('q1')?.eligible).toBe(2);
  });

  it('the waiting time is the host\'s setting; a request that waits for everyone who may answer has no single person to be away', async () => {
    const s = await startStack({ agents: { escalateOfflineMs: 1_000 } });
    // Nobody is responsible: the request is in the inbox of the host and every member with agent access from the start.
    const session = await openSession(s, MEI);
    s.fakes.agents.raise(session.id, bashRequest('pr1', 'pnpm test'));
    s.fakes.agents.raise(session.id, bashRequest('host-only', 'cat /etc/hosts', { reasonType: 'safetyCheck' }));
    await quiet(s);
    s.mei.close();
    await waitFor(() => !s.t.ctx.hub.isOnline(MEI), { what: 'Mei to be offline' });
    s.service.sweep();
    s.t.advanceClock(5_000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(s.service.permission('pr1', true)?.escalatedAt).toBeUndefined();
    expect(s.service.permission('host-only', true)?.escalatedAt).toBeUndefined();
    // The host shortens the waiting time to a minute: what has waited that long escalates right away.
    s.t.advanceClock(60_000);
    await s.host.conn.request('admin.settings.set', { escalateAfterMs: 60_000 });
    await waitFor(() => s.service.permission('pr1', true)?.escalatedAt !== undefined, { what: 'the request to escalate' });
    expect(s.service.permission('host-only', true)?.escalatedAt).toBeDefined();
  });

  it('a settled card never escalates', async () => {
    const s = await startStack();
    const session = await openSession(s, MEI);
    s.fakes.agents.raise(session.id, questionRequest('q1', ONE_PART));
    s.fakes.agents.raise(session.id, bashRequest('pr1', 'pnpm test'));
    await quiet(s);
    await s.mei.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }] });
    await s.mei.conn.request('permission.decide', { requestId: 'pr1', decision: 'deny' });
    s.t.advanceClock(ESCALATE_AFTER_MS_DEFAULT * 3);
    s.service.sweep();
    expect(s.service.question('q1')?.escalatedAt).toBeUndefined();
    expect(s.service.permission('pr1', true)?.escalatedAt).toBeUndefined();
  });
});
