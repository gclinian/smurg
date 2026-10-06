// The cards a conversation keeps (ARCHITECTURE §5.9, §7.1): cards.json per session next to its transcript, what a
// restart of the daemon does to open cards, the page rule of `cards()`, and what goes when a topic is deleted.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { encodedSize, type AgentSession, type CardRef } from '@smurg/protocol';
import { CARDS_INDEX_DOCUMENT, cardsFileSchema } from '../../src/conversation/cards-store.ts';
import { createTempRunDir, removeTempRunDir } from '../../src/testing/index.ts';
import { AMY, HOST, MEI, PARTS, bashRequest, cardsFile, collect, openDiscussion, openSession, principalOf, questionRequest, quiet, startStack, waitFor, watch } from './support.ts';

const ONE_PART = [PARTS[0] as (typeof PARTS)[number]];
const stateDirs: string[] = [];

afterEach(async () => {
  for (const dir of stateDirs.splice(0)) await removeTempRunDir(dir);
});

describe('cards.json', { timeout: 60_000 }, () => {
  it('a restart: what was open is withdrawn (restarted), settled cards stay readable, the same question asked again shows the earlier votes', async () => {
    const stateDir = await createTempRunDir();
    stateDirs.push(stateDir);
    const first = await startStack({ stateDir });
    const session = await openSession(first, MEI);
    const lost = await openSession(first, HOST);
    first.fakes.agents.raise(session.id, bashRequest('pr-done', 'pnpm test'));
    await quiet(first);
    await first.mei.conn.request('permission.decide', { requestId: 'pr-done', decision: 'allow' });
    first.fakes.agents.raise(session.id, questionRequest('q1'));
    first.fakes.agents.raise(session.id, bashRequest('pr-open', 'pnpm build'));
    first.fakes.agents.raise(lost.id, questionRequest('q-lost', ONE_PART));
    await first.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [1] });
    await first.amy.conn.request('question.comment', { questionId: 'q1', text: 'Simpler is fine.' });
    await quiet(first);
    const asked = first.service.question('q1');
    await first.t.daemon.stop();

    // On disk: one private file per session, the cards in the order they appeared, valid against the wire schemas.
    const file = cardsFile(first.t.ctx, session.id);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = cardsFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    expect(stored.sessionId).toBe(session.id);
    expect(stored.cards.map((card) => (card.kind === 'question' ? `question:${card.question.id}:${card.question.status}` : `permission:${card.request.id}:${card.request.status}`))).toEqual([
      'permission:pr-done:allowed',
      'question:q1:open',
      'permission:pr-open:open',
    ]);
    const index = JSON.parse(await readFile(`${first.t.ctx.state.dir}/${CARDS_INDEX_DOCUMENT}.json`, 'utf8')) as { sessions: string[] };
    expect(index.sessions.sort()).toEqual([session.id, lost.id].sort());

    // The daemon starts again. The agent runtime still has the first session (idle); the other one is gone for good.
    const idle: AgentSession = { ...session, status: 'idle' };
    const second = await startStack({ stateDir, root: first.t.root, workspaceId: first.t.workspaceId, seed: (fakes) => fakes.agents.adopt(idle) });
    // No request survives a restart: what was open is withdrawn, with its votes and comments still readable.
    expect(second.service.question('q1')).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'restarted' }, votes: [{ userId: AMY, part: 0, options: [1] }], comments: [{ text: 'Simpler is fine.' }] });
    expect(second.service.permission('pr-open', true)).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'restarted' } });
    expect(second.service.permission('pr-done', true)).toMatchObject({ status: 'allowed', decision: { by: { userId: MEI } } });
    expect(second.service.openQuestions()).toEqual([]);
    expect(second.service.openPermissions()).toEqual([]);
    // A late joiner reads them with the conversation.
    const refs: CardRef[] = [{ kind: 'question', id: 'q1' }, { kind: 'permission', id: 'pr-done' }];
    expect(second.service.cards(session.id, refs, { includeOpen: true, budgetBytes: 1_000_000, forHost: false })).toMatchObject({ questions: [{ id: 'q1', status: 'withdrawn' }], permissions: [{ id: 'pr-done' }], more: [] });
    // The session that no longer exists took its cards with it; the index forgot it.
    expect(second.service.question('q-lost')).toBeNull();
    await quiet(second);
    await second.t.ctx.state.flush();
    expect((JSON.parse(await readFile(`${second.t.ctx.state.dir}/${CARDS_INDEX_DOCUMENT}.json`, 'utf8')) as { sessions: string[] }).sessions).toEqual([session.id]);
    // A late decision on a card of before the restart is refused like any settled card; the agent hears nothing.
    await expect(second.mei.conn.request('permission.decide', { requestId: 'pr-open', decision: 'allow' })).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'settled', status: 'withdrawn' } });
    expect(second.fakes.agents.log.of('decidePermission')).toEqual([]);

    // The agent asks the same question again: the new card shows what people had voted ("Asked before: …").
    second.fakes.agents.raise(session.id, questionRequest('q2'));
    expect(second.service.question('q2')).toMatchObject({ status: 'open', votes: [], previous: { askedAt: asked?.askedAt, tally: [[0, 1, 0], [0, 0, 0, 0]] } });
    // Another question has no such history.
    second.fakes.agents.raise(session.id, questionRequest('q3', ONE_PART));
    expect(second.service.question('q3')?.previous).toBeUndefined();
  });

  it('a cards.json that is not valid is kept aside and never guessed at; the session goes on without its earlier cards', async () => {
    const stateDir = await createTempRunDir();
    stateDirs.push(stateDir);
    const first = await startStack({ stateDir });
    const session = await openSession(first, MEI);
    first.fakes.agents.raise(session.id, questionRequest('q1', ONE_PART));
    await quiet(first);
    await first.t.daemon.stop();
    const file = cardsFile(first.t.ctx, session.id);
    await writeFile(file, JSON.stringify({ version: 1, sessionId: session.id, cards: [{ kind: 'question', question: { id: 'q1', status: 'open', votes: 'many' } }] }), { mode: 0o600 });
    const second = await startStack({ stateDir, root: first.t.root, workspaceId: first.t.workspaceId, seed: (fakes) => fakes.agents.adopt({ ...session, status: 'idle' }) });
    expect(second.service.question('q1')).toBeNull();
    expect(JSON.parse(await readFile(`${file}.invalid`, 'utf8'))).toMatchObject({ cards: [{ question: { votes: 'many' } }] });
    second.fakes.agents.raise(session.id, questionRequest('q2', ONE_PART));
    await quiet(second);
    expect(cardsFileSchema.parse(JSON.parse(await readFile(file, 'utf8'))).cards).toHaveLength(1);
  });

  it('cards(): the named cards and the open ones, in what is left of the page; the rest is named in `more`', async () => {
    const s = await startStack();
    const session = await openSession(s, MEI);
    s.fakes.agents.raise(session.id, questionRequest('q1', ONE_PART));
    await s.mei.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }] });
    s.fakes.agents.raise(session.id, questionRequest('q2', ONE_PART));
    s.fakes.agents.raise(session.id, bashRequest('pr1', 'pnpm test'));
    s.fakes.agents.raise(session.id, { ...bashRequest('pr2', 'cat /etc/hosts'), absPath: '/etc/hosts' });
    await quiet(s);
    const q2 = s.service.question('q2');
    const everything = { includeOpen: true, budgetBytes: 1_000_000, forHost: true };
    // Open cards come without being named; a settled one only when a page's `card` event points to it.
    expect(s.service.cards(session.id, [], everything)).toMatchObject({ questions: [{ id: 'q2' }], permissions: [{ id: 'pr1' }, { id: 'pr2', path: '/etc/hosts' }], more: [] });
    const named = s.service.cards(session.id, [{ kind: 'question', id: 'q1' }, { kind: 'suggestion', id: 'sug_x' }, { kind: 'question', id: 'unknown' }], { ...everything, includeOpen: false });
    expect(named).toMatchObject({ questions: [{ id: 'q1', status: 'answered' }], permissions: [], more: [] });
    expect(named.bytes).toBe(encodedSize(named.questions) + encodedSize(named.permissions));
    // Everyone but the host gets a permission request without its absolute path.
    expect(s.service.cards(session.id, [], { ...everything, forHost: false }).permissions.map((request) => request.path)).toEqual([undefined, undefined]);
    // A budget that holds the question and one request: the other is named in `more` and fetched with session.cards.get.
    const budget = encodedSize([q2]) + encodedSize([s.service.permission('pr1', true)]) + 4;
    expect(s.service.cards(session.id, [], { ...everything, budgetBytes: budget })).toMatchObject({ questions: [{ id: 'q2' }], permissions: [{ id: 'pr1' }], more: [{ kind: 'permission', id: 'pr2' }] });
    expect(s.service.cards(session.id, [], { ...everything, budgetBytes: 0 })).toMatchObject({ questions: [], permissions: [], more: [{ kind: 'question', id: 'q2' }, { kind: 'permission', id: 'pr1' }, { kind: 'permission', id: 'pr2' }], bytes: expect.any(Number) });
    expect(s.service.cards(session.id, [], { ...everything, budgetBytes: 0, atLeastOne: true })).toMatchObject({ questions: [{ id: 'q2' }], permissions: [] });
    // Over the wire, through the (fake) runtime's handlers: watch carries the open cards, cards.get the named ones.
    const page = await watch(s.amy, session.id);
    expect(page.questions.map((question) => question.id)).toEqual(['q1', 'q2']);
    expect(page.permissions.map((request) => [request.id, request.path])).toEqual([['pr1', undefined], ['pr2', undefined]]);
    const got = await s.host.conn.request('session.cards.get', { sessionId: session.id, cards: [{ kind: 'permission', id: 'pr2' }] });
    expect(got.permissions).toMatchObject([{ id: 'pr2', path: '/etc/hosts' }]);
    expect(s.service.cards('ses_none', [{ kind: 'question', id: 'q1' }], everything)).toEqual({ questions: [], permissions: [], more: [], bytes: expect.any(Number) });
  });

  it('a session keeps every open card and its newest settled ones', async () => {
    const s = await startStack({ conversation: { cards: { maxSettledPerSession: 2 } } });
    const session = await openSession(s, MEI);
    for (const id of ['a', 'b', 'c', 'd']) {
      s.fakes.agents.raise(session.id, questionRequest(id, ONE_PART));
      if (id !== 'b') await s.mei.conn.request('question.submit', { questionId: id, answers: [{ options: [0] }] });
    }
    s.fakes.agents.raise(session.id, questionRequest('e', ONE_PART));
    await quiet(s);
    // `b` is still open and stays whatever its age; of the settled ones the two newest stay.
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => s.service.question(id)?.status ?? null)).toEqual([null, 'open', 'answered', 'answered', 'open']);
    expect(cardsFileSchema.parse(JSON.parse(await readFile(cardsFile(s.t.ctx, session.id), 'utf8'))).cards).toHaveLength(4);
  });

  it('a deleted topic takes the cards of its sessions with it, before the transcripts go', async () => {
    const s = await startStack();
    const session = await openDiscussion(s, MEI);
    const free = await openSession(s, MEI);
    s.fakes.agents.raise(session.id, questionRequest('q-topic', ONE_PART));
    s.fakes.agents.raise(free.id, questionRequest('q-free', ONE_PART));
    await quiet(s);
    const seen: (string | null)[] = [];
    s.t.ctx.bus.on('topic.removed', () => seen.push(s.service.question('q-topic')?.id ?? null));
    await s.fakes.topics.archive({ topicId: 'tp_checkout', archived: true }, principalOf(s, HOST));
    expect(s.service.question('q-topic')).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'ended' } });
    await s.fakes.topics.delete({ topicId: 'tp_checkout' }, principalOf(s, HOST));
    expect(s.service.question('q-topic')).toBeNull();
    expect(s.service.cards(session.id, [{ kind: 'question', id: 'q-topic' }], { includeOpen: true, budgetBytes: 1_000_000, forHost: true }).questions).toEqual([]);
    expect(s.service.question('q-free')?.status).toBe('open');
    await quiet(s);
    await s.t.ctx.state.flush();
    expect((JSON.parse(await readFile(`${s.t.ctx.state.dir}/${CARDS_INDEX_DOCUMENT}.json`, 'utf8')) as { sessions: string[] }).sessions).toEqual([free.id]);
  });

  it('a request the runner raises twice changes nothing; a reused id of a settled card is refused towards the agent', async () => {
    const s = await startStack();
    const session = await openSession(s, MEI);
    await watch(s.amy, session.id);
    const updates = collect(s.amy, 'question.updated');
    s.fakes.agents.raise(session.id, questionRequest('q1', ONE_PART));
    s.t.ctx.bus.emit('agent.request', { sessionId: session.id, request: questionRequest('q1', ONE_PART) });
    await waitFor(() => updates.length >= 1, { what: 'the card' });
    expect(s.fakes.agents.eventsOf(session.id).filter((event) => event.kind === 'card')).toHaveLength(1);
    await s.mei.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }] });
    s.fakes.agents.raise(session.id, questionRequest('q1', ONE_PART));
    expect(s.service.question('q1')?.status).toBe('answered');
    expect(s.fakes.agents.answerTo(session.id, 'q1')).toMatchObject({ allow: false, message: expect.stringContaining('already answered') });
  });
});
