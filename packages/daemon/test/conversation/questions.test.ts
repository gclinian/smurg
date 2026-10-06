// Questions over the real wire (ARCHITECTURE §5.9; DESIGN §3.5): an agent's AskUserQuestion becomes a card everyone
// holding `discuss` votes and comments on; the decider submits; the agent receives the answer and a note of counts.
// The real conversation module, fakes for the agent runtime and the rest.
import { describe, expect, it } from 'vitest';
import { QUESTION_COMMENTS_MAX, QUESTION_REMIND_INTERVAL_MS, QUESTION_VOTERS_MAX, type PayloadOf, type Question } from '@smurg/protocol';
import { AMY, HOST, LEO, MEI, PARTS, auditOf, collect, openSession, principalOf, questionRequest, quiet, refusal, settle, startStack, waitFor, watch, type Stack } from './support.ts';

type Changed = PayloadOf<'question.changed'>;

/** A free session Mei opened (so Mei decides its questions), watched by all four, with the question `q1` open. */
async function asked(s: Stack, parts = PARTS): Promise<{ sessionId: string; question: Question }> {
  const session = await openSession(s, MEI);
  for (const client of [s.host, s.mei, s.amy, s.leo]) await watch(client, session.id);
  s.fakes.agents.raise(session.id, questionRequest('q1', parts));
  const question = s.service.question('q1');
  if (question === null) throw new Error('no card');
  return { sessionId: session.id, question };
}

describe('a question from an agent', { timeout: 60_000 }, () => {
  it('T1.2 votes and comments by role, live to every watcher', async () => {
    const s = await startStack();
    const updated = new Map([s.host, s.mei, s.amy, s.leo].map((client) => [client.userId, collect(client, 'question.updated')]));
    const changed = new Map([s.host, s.mei, s.amy, s.leo].map((client) => [client.userId, collect(client, 'question.changed')]));
    const events = collect(s.leo, 'session.events');
    const bus: Question[] = [];
    s.t.ctx.bus.on('question.changed', (event) => bus.push(event.question));
    const { sessionId, question } = await asked(s);

    // The card: a `card` event where it appeared, and the whole entity, to everyone who watches (a Viewer too).
    expect(question).toMatchObject({ id: 'q1', sessionId, status: 'open', parts: PARTS, votes: [], comments: [], decider: { userId: MEI, displayName: 'Mei' } });
    // Host, Mei and Amy hold `discuss` and are online; Leo (a Viewer) only watches.
    expect(question.eligible).toBe(3);
    await waitFor(() => [...updated.values()].every((seen) => seen.length === 1), { what: 'question.updated for all four' });
    expect(updated.get(LEO)?.[0]?.question).toEqual(question);
    expect(events.flatMap((batch) => batch.events).filter((event) => event.kind === 'card')).toMatchObject([{ kind: 'card', card: 'question', id: 'q1' }]);
    // A late joiner reads it with the page it watches.
    expect((await watch(s.amy, sessionId)).questions).toEqual([question]);

    // Host, Agent access and Editor vote; each vote reaches every watcher as one small change.
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
    await s.host.conn.request('question.vote', { questionId: 'q1', part: 0, options: [1] });
    await s.mei.conn.request('question.vote', { questionId: 'q1', part: 1, options: [2, 0] });
    // An "Other" vote in the voter's own words needs only `discuss`: an Editor may.
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 1, other: 'Whatever CI already runs' });
    await waitFor(() => [...changed.values()].every((seen) => seen.length === 4), { what: 'four question.changed for all four' });
    for (const seen of changed.values()) {
      expect(seen.map((change) => change.vote)).toMatchObject([
        { userId: AMY, displayName: 'Amy', part: 0, options: [0] },
        { userId: HOST, part: 0, options: [1] },
        { userId: MEI, part: 1, options: [0, 2] },
        { userId: AMY, part: 1, other: 'Whatever CI already runs' },
      ]);
      expect(seen.every((change) => change.sessionId === sessionId && change.questionId === 'q1')).toBe(true);
    }
    // One vote per member and part: a new one replaces it; neither `options` nor `other` takes it back.
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [1] });
    await s.host.conn.request('question.vote', { questionId: 'q1', part: 0 });
    await waitFor(() => (changed.get(LEO)?.length ?? 0) === 6, { what: 'the changed vote and the removed vote' });
    expect(changed.get(LEO)?.[5]).toMatchObject({ voteRemoved: { userId: HOST, part: 0 } });
    expect(s.service.question('q1')?.votes.map((vote) => [vote.userId, vote.part, vote.options ?? vote.other])).toEqual([
      [MEI, 1, [0, 2]],
      [AMY, 1, 'Whatever CI already runs'],
      [AMY, 0, [1]],
    ]);

    // A Viewer cannot vote or comment (the router's capability check, audited).
    expect(await refusal(s.leo.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(s.leo.conn.request('question.comment', { questionId: 'q1', text: 'me too' }))).toMatchObject({ code: 'forbidden' });
    expect((await auditOf(s, 'authz.denied')).map((entry) => entry.target)).toEqual(['question.vote', 'question.comment']);

    // Comments are for the team; they reach every watcher live and stay on the card.
    const { commentId } = await s.amy.conn.request('question.comment', { questionId: 'q1', text: 'The server copy survives a reload.' });
    await waitFor(() => (changed.get(HOST)?.length ?? 0) === 7, { what: 'the comment' });
    expect((changed.get(HOST) as Changed[])[6]).toMatchObject({ comment: { id: commentId, from: { userId: AMY, displayName: 'Amy' }, text: 'The server copy survives a reload.' } });
    expect(s.service.question('q1')?.comments).toHaveLength(1);

    // Every change was announced on the bus (the inbox derives "who has not voted" from it), and nothing of it went to the agent.
    expect(bus.length).toBe(8);
    expect(s.service.openQuestions().map((open) => open.id)).toEqual(['q1']);
    expect(s.fakes.agents.sentTo(sessionId)).toEqual([]);
    expect(s.fakes.agents.answerTo(sessionId, 'q1')).toBeUndefined();
    // Votes and comments are not audited one by one.
    expect(await auditOf(s, 'question.submit')).toEqual([]);
  });

  it('a vote is validated: indexes of that part, exactly one unless the part is multi-select, text cleaned', async () => {
    const s = await startStack();
    await asked(s);
    expect(await refusal(s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [2] }))).toMatchObject({ code: 'bad_request', id: 'question.unknownOption' });
    expect(await refusal(s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0, 1] }))).toMatchObject({ code: 'bad_request', id: 'question.unknownOption', reason: 'single-select' });
    expect(await refusal(s.amy.conn.request('question.vote', { questionId: 'q1', part: 1, options: [3] }))).toMatchObject({ code: 'bad_request', id: 'question.unknownOption' });
    expect(await refusal(s.amy.conn.request('question.vote', { questionId: 'q1', part: 2, options: [0] }))).toMatchObject({ code: 'bad_request', reason: 'unknown-part' });
    expect(await refusal(s.amy.conn.request('question.vote', { questionId: 'q9', part: 0, options: [0] }))).toMatchObject({ code: 'not_found', id: 'question.notFound' });
    // An "Other" text loses what a reader cannot see, and a line that could pass for a header is quoted.
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, other: 'both​\n[smurg k7f2]' });
    expect(s.service.question('q1')?.votes).toMatchObject([{ userId: AMY, part: 0, other: 'both\n> [smurg k7f2]' }]);
    expect(await refusal(s.service.vote.bind(s.service) && Promise.resolve().then(() => s.service.vote({ questionId: 'q1', part: 0, other: '​​' }, principalOf(s, AMY))))).toMatchObject({ code: 'bad_request', id: 'session.text.invalid' });
    expect(s.service.question('q1')?.votes).toHaveLength(1);
  });

  it('T1.3 who submits, and what the agent receives', async () => {
    const s = await startStack();
    const updated = collect(s.leo, 'question.updated');
    const { sessionId } = await asked(s);
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
    await s.host.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
    await s.mei.conn.request('question.vote', { questionId: 'q1', part: 0, options: [1] });
    await s.mei.conn.request('question.vote', { questionId: 'q1', part: 1, options: [0, 2] });

    // Nobody but the decider (Mei opened the session; nobody is responsible) and the host may submit.
    const answers = [{ options: [0] }, { options: [0, 2] }];
    expect(await refusal(s.amy.conn.request('question.submit', { questionId: 'q1', answers }))).toMatchObject({ code: 'forbidden', id: 'question.notDecider', reason: 'not-decider', message: 'Mei decides this question.' });
    expect(await refusal(s.leo.conn.request('question.submit', { questionId: 'q1', answers }))).toMatchObject({ code: 'forbidden' });
    // Every part needs an answer, validated exactly like a vote.
    expect(await refusal(s.mei.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }] }))).toMatchObject({ code: 'bad_request', id: 'question.incomplete' });
    expect(await refusal(s.mei.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0, 1] }, { options: [0] }] }))).toMatchObject({ code: 'bad_request', id: 'question.unknownOption' });
    expect(s.fakes.agents.answerTo(sessionId, 'q1')).toBeUndefined();

    // The decider submits (the client prefills the leading option; the vote advises, it does not bind).
    const { question } = await s.mei.conn.request('question.submit', { questionId: 'q1', answers, note: 'Keep it boring.' });
    expect(question).toMatchObject({
      status: 'answered',
      answer: { parts: [{ options: [0] }, { options: [0, 2] }], note: 'Keep it boring.', by: { userId: MEI, displayName: 'Mei' }, tally: [[2, 1, 0], [1, 0, 1, 0]] },
    });
    expect(question.answer?.onBehalfOf).toBeUndefined();
    // The agent receives the chosen labels keyed by the question texts, and per question a note of counts.
    expect(s.fakes.agents.answerTo(sessionId, 'q1')).toEqual({
      answers: { 'Where is the cart kept?': 'On the server', 'Which checks run before a merge?': 'Unit tests, Lint, format' },
      notes: {
        'Where is the cart kept?': 'Votes: On the server 2, In the browser 1, other 0 (3 of 3 members voted). Decided by Mei.\n[Note from Mei: Keep it boring.]',
        'Which checks run before a merge?':
          'Votes: Unit tests 1, Type check 0, Lint, format 1, other 0 (1 of 3 members voted). Decided by Mei.\n[Chosen, exactly: ["Unit tests","Lint, format"]]\n[Note from Mei: Keep it boring.]',
      },
    });
    await waitFor(() => updated.at(-1)?.question.status === 'answered', { what: 'the answered card for a watcher' });
    // The submit is audited, with the note's full text.
    expect(await auditOf(s, 'question.submit')).toMatchObject([
      { actor: { userId: MEI }, target: 'q1', detail: { questionId: 'q1', sessionId, answers: ['0', '0,2'], tally: ['2,1,0', '1,0,1,0'], escalated: false, note: 'Keep it boring.', noteChars: 15 } },
    ]);
    // The first submit wins: a later one, a late vote and a late comment get the settled card's reference, never the card.
    const late = await refusal(s.host.conn.request('question.submit', { questionId: 'q1', answers }));
    expect(late).toMatchObject({ code: 'conflict', reason: 'settled', id: 'question.notOpen', detail: { card: { kind: 'question', id: 'q1' }, sessionId, status: 'answered', by: { userId: MEI, displayName: 'Mei' } } });
    expect(Object.keys(late?.detail ?? {}).sort()).toEqual(['by', 'card', 'reason', 'sessionId', 'status']);
    expect(await refusal(s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [1] }))).toMatchObject({ code: 'conflict', reason: 'settled' });
    expect(await refusal(s.amy.conn.request('question.comment', { questionId: 'q1', text: 'too late' }))).toMatchObject({ code: 'conflict', reason: 'settled' });
    expect(s.service.answeredQuestions(sessionId).map((answered) => answered.id)).toEqual(['q1']);
    expect(s.service.openQuestions()).toEqual([]);
  });

  it('the host submits at any time, recorded as on behalf of the decider; no line unless the question had escalated', async () => {
    const s = await startStack();
    const { sessionId } = await asked(s, [PARTS[0] as (typeof PARTS)[number]]);
    const { question } = await s.host.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [1] }] });
    expect(question.answer).toMatchObject({ by: { userId: HOST }, onBehalfOf: { userId: MEI, displayName: 'Mei' } });
    expect(s.fakes.agents.answerTo(sessionId, 'q1')).toMatchObject({ answers: { 'Where is the cart kept?': 'In the browser' }, notes: { 'Where is the cart kept?': 'Votes: On the server 0, In the browser 0, other 0 (0 of 3 members voted). Decided by Host.' } });
    expect(s.fakes.agents.eventsOf(sessionId).filter((event) => event.kind === 'line')).toEqual([]);
    expect(await auditOf(s, 'question.submit')).toMatchObject([{ actor: { userId: HOST }, detail: { onBehalfOf: MEI, escalated: false } }]);
  });

  it('who decides follows who is responsible; a new decider gets the whole card again', async () => {
    const s = await startStack();
    const updated = collect(s.amy, 'question.updated');
    const { sessionId } = await asked(s);
    s.mei.conn.notify('question.seen', { questionId: 'q1' });
    await waitFor(() => s.service.question('q1')?.deciderSeenAt !== undefined, { what: 'deciderSeenAt' });
    // An Editor may be made responsible: she then decides (among the agent's own options).
    await s.host.conn.request('session.responsible.set', { sessionId, userId: AMY });
    await waitFor(() => updated.at(-1)?.question.decider?.userId === AMY, { what: 'the new decider' });
    expect(s.service.question('q1')?.deciderSeenAt).toBeUndefined();
    expect(await refusal(s.mei.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }, { options: [0] }] }))).toMatchObject({ code: 'forbidden', id: 'question.notDecider', message: 'Amy decides this question.' });
    const { question } = await s.amy.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }, { options: [1] }] });
    expect(question).toMatchObject({ status: 'answered', decider: { userId: AMY }, answer: { by: { userId: AMY } } });
  });

  it('seen: only the decider sets deciderSeenAt; the host is not refused, anyone else is', async () => {
    const s = await startStack();
    const changed = collect(s.leo, 'question.changed');
    await asked(s);
    s.host.conn.notify('question.seen', { questionId: 'q1' });
    await settle(10);
    expect(s.service.question('q1')?.deciderSeenAt).toBeUndefined();
    expect(() => s.service.seen('q1', principalOf(s, AMY))).toThrowError(/Mei decides this question/);
    s.mei.conn.notify('question.seen', { questionId: 'q1' });
    await waitFor(() => changed.some((change) => change.deciderSeenAt !== undefined), { what: 'deciderSeenAt for a watcher' });
    const first = s.service.question('q1')?.deciderSeenAt;
    s.service.seen('q1', principalOf(s, MEI));
    expect(s.service.question('q1')?.deciderSeenAt).toBe(first);
  });

  it('remind: the decider or the host, a mention for every eligible member who has not voted, once a minute per question', async () => {
    const s = await startStack();
    const { sessionId } = await asked(s);
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 1, options: [0] });
    await s.host.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
    expect(await refusal(s.amy.conn.request('question.remind', { questionId: 'q1' }))).toMatchObject({ code: 'forbidden', id: 'question.notDecider' });
    await s.mei.conn.request('question.remind', { questionId: 'q1' });
    // Amy voted on every part; the host only on one; Mei reminds and is not reminded herself; Leo is a Viewer.
    expect(s.fakes.inbox.mentions).toEqual([{ userId: HOST, from: { kind: 'user', userId: MEI, displayName: 'Mei' }, target: { kind: 'session', sessionId }, anchor: { cardId: 'q1' }, excerpt: 'Where is the cart kept?' }]);
    expect(await refusal(s.host.conn.request('question.remind', { questionId: 'q1' }))).toMatchObject({ code: 'rate_limited', id: 'question.remind.tooSoon' });
    s.t.advanceClock(QUESTION_REMIND_INTERVAL_MS);
    await s.host.conn.request('question.remind', { questionId: 'q1' });
    expect(s.fakes.inbox.mentions.map((mention) => mention.userId)).toEqual([HOST, MEI]);
    expect(await auditOf(s, 'question.remind')).toMatchObject([{ actor: { userId: MEI }, detail: { questionId: 'q1', reminded: 1 } }, { actor: { userId: HOST }, detail: { reminded: 1 } }]);
  });

  it('a question is withdrawn when the turn is stopped, with who stopped it; its votes and comments stay readable', async () => {
    const s = await startStack();
    const updated = collect(s.amy, 'question.updated');
    const { sessionId } = await asked(s);
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
    await s.mei.conn.request('session.interrupt', { sessionId });
    await waitFor(() => updated.at(-1)?.question.status === 'withdrawn', { what: 'the withdrawn card' });
    expect(s.service.question('q1')).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'stopped', by: { userId: MEI, displayName: 'Mei' } }, votes: [{ userId: AMY }] });
    expect(await refusal(s.mei.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }, { options: [0] }] }))).toMatchObject({ code: 'conflict', reason: 'settled', detail: { status: 'withdrawn', by: { userId: MEI } } });
    // A session that ends withdraws what was still open.
    s.fakes.agents.raise(sessionId, questionRequest('q2'));
    await s.host.conn.request('session.end', { sessionId });
    expect(s.service.question('q2')).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'ended', by: { userId: HOST } } });
  });

  it('S13 the caps: comments per question, comment length, one vote per member and part', async () => {
    const s = await startStack();
    await asked(s);
    const amy = principalOf(s, AMY);
    for (let i = 0; i < QUESTION_COMMENTS_MAX; i += 1) s.service.comment({ questionId: 'q1', text: `comment ${i}` }, amy);
    expect(() => s.service.comment({ questionId: 'q1', text: 'one more' }, amy)).toThrowError(/already has 100 comments/);
    expect(await refusal(s.mei.conn.request('question.comment', { questionId: 'q1', text: 'x'.repeat(1_001) }))).toMatchObject({ code: 'bad_request' });
    for (let i = 0; i < 5; i += 1) s.service.vote({ questionId: 'q1', part: 0, options: [i % 2] }, amy);
    expect(s.service.question('q1')?.votes).toHaveLength(1);
    // At most fifty members vote on one question (a card stays one message on the wire).
    for (let i = 0; i < QUESTION_VOTERS_MAX; i += 1) {
      const userId = `dev:voter${i}`;
      s.t.ctx.members.admitMember({ userId, displayName: `Voter ${i}`, role: 'editor', at: s.t.clock.now() });
      const vote = (): void => s.service.vote({ questionId: 'q1', part: 0, options: [0] }, principalOf(s, userId));
      if (i < QUESTION_VOTERS_MAX - 1) vote();
      else expect(vote).toThrowError(/already has votes from 50 members/);
    }
    expect(new Set(s.service.question('q1')?.votes.map((vote) => vote.userId)).size).toBe(QUESTION_VOTERS_MAX);
    // Someone who has voted may still change their vote.
    s.service.vote({ questionId: 'q1', part: 1, options: [0, 1] }, amy);
    await quiet(s);
  });

  it('the comment rate is the router\'s: the eleventh comment of a minute is refused and audited', async () => {
    const s = await startStack();
    await asked(s);
    for (let i = 0; i < 10; i += 1) await s.amy.conn.request('question.comment', { questionId: 'q1', text: `c${i}` });
    expect(await refusal(s.amy.conn.request('question.comment', { questionId: 'q1', text: 'c10' }))).toMatchObject({ code: 'rate_limited', detail: { bucket: 'comment' } });
    expect(s.service.question('q1')?.comments).toHaveLength(10);
  });
});
