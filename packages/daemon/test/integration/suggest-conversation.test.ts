// The suggest and conversation modules composed (with the real locks / activity module; the agent runtime, the topics
// and the inbox are the fakes of core/fakes), read the way a member's client reads them: the conversation's events,
// the cards a page carries, the card updates. SPEC R6 in a conversation, and what a member who joins LATER can read.
//
// (It replaces test/suggest/r6.pty.test.ts and test/integration/suggest-sessions.test.ts, which pasted suggestions
// into a PTY: an accepted suggestion is now a message to an agent session.)
import { describe, expect, it } from 'vitest';
import type { ConversationEvent } from '@smurg/protocol';
import { locksModule } from '../../src/locks/module.ts';
import { AMY, HOST, MEI, PARTS, bashRequest, collect, openSession, questionRequest, quiet, refusal, settle, startStack, waitFor, watch } from '../conversation/support.ts';

function kinds(events: readonly ConversationEvent[]): string[] {
  return events.map((event) => (event.kind === 'card' ? `card:${event.card}` : event.kind));
}

describe('suggestions in a conversation (the suggest and conversation modules composed)', { timeout: 60_000 }, () => {
  it('before a member who drives the session confirms, no suggestion text enters the agent session; accepted, it is a message of its author in the conversation', async () => {
    const s = await startStack({ before: [locksModule] });
    const session = await openSession(s, MEI);
    await watch(s.amy, session.id);
    await watch(s.mei, session.id);
    const amyEvents = collect(s.amy, 'session.events');
    const amyCards = collect(s.amy, 'suggest.updated');
    const marker = `MARK-${Math.random().toString(36).slice(2)}`;

    // Amy (an Editor) writes three suggestions; each is a card of the conversation at once, for everyone who watches.
    const first = (await s.amy.conn.request('suggest.create', { sessionId: session.id, text: `Cover the empty cart (${marker})` })).suggestion;
    const second = (await s.amy.conn.request('suggest.create', { sessionId: session.id, text: `ORIGINAL (${marker}): delete the flaky test` })).suggestion;
    const third = (await s.amy.conn.request('suggest.create', { sessionId: session.id, text: `@Mei, rewrite everything (${marker})`, mentions: [MEI] })).suggestion;
    await waitFor(() => amyEvents.flatMap((batch) => batch.events).length === 3, { what: 'three card events' });
    expect(kinds(amyEvents.flatMap((batch) => batch.events))).toEqual(['card:suggestion', 'card:suggestion', 'card:suggestion']);
    const page = await watch(s.mei, session.id);
    expect(page.suggestions.map((item) => [item.id, item.status])).toEqual([[first.id, 'pending'], [second.id, 'pending'], [third.id, 'pending']]);
    // Nothing of it has reached the agent: not a message, not a queued one, not a character.
    expect(s.fakes.agents.sentTo(session.id)).toEqual([]);
    expect(JSON.stringify(s.fakes.agents.eventsOf(session.id))).not.toContain(marker);
    // The author cannot accept her own text, with or without naming it.
    expect(await refusal(s.amy.conn.request('suggest.accept', { suggestionId: first.id }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(s.amy.conn.request('suggest.accept', { suggestionId: first.id, text: first.text }))).toMatchObject({ code: 'forbidden' });
    await settle(10);
    expect(s.fakes.agents.sentTo(session.id)).toEqual([]);

    // Mei accepts the first as it is, the second after changing it, and rejects the third.
    await s.mei.conn.request('suggest.accept', { suggestionId: first.id });
    await s.mei.conn.request('suggest.accept', { suggestionId: second.id, text: 'EDITED: fix the flaky test' });
    await s.host.conn.request('suggest.reject', { suggestionId: third.id, reason: 'too much at once' });
    await waitFor(() => amyCards.filter((update) => update.suggestion.status !== 'pending').length === 3, { what: 'the three decisions for the author' });

    // In the conversation: two messages of AMY (an Editor), each marked as her suggestion Mei accepted; only the
    // edited text of the second; nothing of the third.
    const messages = s.fakes.agents.eventsOf(session.id).flatMap((event) => (event.kind === 'message' ? [event] : []));
    expect(messages).toMatchObject([
      { from: { userId: AMY, displayName: 'Amy', role: 'editor' }, text: `Cover the empty cart (${marker})`, origin: 'composer', suggestion: { id: first.id, acceptedBy: { userId: MEI, displayName: 'Mei' }, modified: false } },
      { from: { userId: AMY, role: 'editor' }, text: 'EDITED: fix the flaky test', suggestion: { id: second.id, acceptedBy: { userId: MEI }, modified: true } },
    ]);
    const everything = JSON.stringify(s.fakes.agents.log.of('send'));
    expect(everything).not.toContain('ORIGINAL');
    expect(everything).not.toContain('rewrite everything');
    // What the author learns: the cards' new states, and a result in her inbox for the edit and for the rejection.
    expect(s.fakes.inbox.results.map((result) => [result.userId, result.suggestionId, result.outcome, result.from])).toEqual([
      [AMY, second.id, 'accepted-edited', { kind: 'user', userId: MEI, displayName: 'Mei' }],
      [AMY, third.id, 'rejected', { kind: 'user', userId: HOST, displayName: 'Host' }],
    ]);
    // Her mention of Mei pointed at the card.
    expect(s.fakes.inbox.mentions).toMatchObject([{ userId: MEI, from: { userId: AMY }, anchor: { cardId: third.id }, target: { kind: 'session', sessionId: session.id } }]);
    // The audit log has every step, with the author, the text and the outcome.
    const { entries } = await s.host.conn.request('admin.audit.query', { limit: 200 });
    const audited = entries.filter((entry) => entry.action.startsWith('suggest.')).reverse();
    expect(audited.map((entry) => [entry.action, entry.actor.kind === 'user' ? entry.actor.userId : entry.actor.kind, entry.detail?.['outcome'] ?? 'created'])).toEqual([
      ['suggest.create', AMY, 'created'],
      ['suggest.create', AMY, 'created'],
      ['suggest.create', AMY, 'created'],
      ['suggest.accept', MEI, 'accepted'],
      ['suggest.accept', MEI, 'accepted-modified'],
      ['suggest.reject', HOST, 'rejected'],
    ]);
    expect(audited[4]?.detail).toMatchObject({ authorUserId: AMY, text: `ORIGINAL (${marker}): delete the flaky test`, finalText: 'EDITED: fix the flaky test' });
  });

  it('a member who joins later reads the whole conversation: the cards with their votes, comments and decisions', async () => {
    const s = await startStack({ before: [locksModule] });
    const session = await openSession(s, MEI);
    // A question with votes and a comment, answered; a permission request, allowed; a suggestion, accepted; one more
    // of each still open.
    s.fakes.agents.raise(session.id, questionRequest('q1'));
    await s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
    await s.amy.conn.request('question.comment', { questionId: 'q1', text: 'The server copy survives a reload.' });
    await s.mei.conn.request('question.submit', { questionId: 'q1', answers: [{ options: [0] }, { options: [1] }] });
    s.fakes.agents.raise(session.id, bashRequest('pr1', 'pnpm test cart', { suggestedRule: { tool: 'Bash', pattern: 'pnpm test *' } }));
    await quiet(s);
    await s.mei.conn.request('permission.decide', { requestId: 'pr1', decision: 'allow-always' });
    const { suggestion } = await s.amy.conn.request('suggest.create', { sessionId: session.id, text: 'Also test the empty cart' });
    await s.mei.conn.request('suggest.accept', { suggestionId: suggestion.id });
    s.fakes.agents.raise(session.id, questionRequest('q2', [PARTS[0] as (typeof PARTS)[number]]));
    s.fakes.agents.raise(session.id, bashRequest('pr2', 'pnpm build'));
    const { suggestion: pending } = await s.amy.conn.request('suggest.create', { sessionId: session.id, text: 'And the full cart' });
    await quiet(s);

    // Noa joins now, as a Viewer, and opens the session.
    const noa = await s.t.connect({ userId: 'dev:noa', displayName: 'Noa', role: 'viewer' });
    const page = await watch(noa, session.id);
    expect(kinds(page.events).filter((kind) => kind !== 'turn.started')).toEqual(['card:question', 'card:permission', 'line', 'card:suggestion', 'message', 'card:question', 'card:permission', 'card:suggestion']);
    expect(page.hasEarlier).toBe(false);
    // Every card the page points to, in its current state, and the open ones.
    expect(page.questions.map((question) => [question.id, question.status])).toEqual([['q1', 'answered'], ['q2', 'open']]);
    expect(page.questions[0]).toMatchObject({ votes: [{ userId: AMY, part: 0, options: [0] }], comments: [{ from: { userId: AMY }, text: 'The server copy survives a reload.' }], answer: { by: { userId: MEI }, parts: [{ options: [0] }, { options: [1] }] } });
    expect(page.permissions.map((request) => [request.id, request.status, request.decision?.always])).toEqual([['pr1', 'allowed', 'session'], ['pr2', 'open', undefined]]);
    expect(page.suggestions.map((item) => [item.id, item.status])).toEqual([[suggestion.id, 'accepted'], [pending.id, 'pending']]);
    expect(page.moreCards).toEqual([]);
    // From now on she gets what everyone gets, live; and she can do none of it.
    const live = collect(noa, 'question.changed');
    await s.amy.conn.request('question.vote', { questionId: 'q2', part: 0, options: [1] });
    await waitFor(() => live.length === 1, { what: 'a live vote for the late joiner' });
    expect(await refusal(noa.conn.request('question.vote', { questionId: 'q2', part: 0, options: [0] }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(noa.conn.request('permission.decide', { requestId: 'pr2', decision: 'allow' }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(noa.conn.request('suggest.create', { sessionId: session.id, text: 'me too' }))).toMatchObject({ code: 'forbidden' });
    // An older page and single cards are read the same way.
    const older = await noa.conn.request('session.history', { sessionId: session.id, beforeSeq: 4, limit: 10 });
    expect(older.questions.map((question) => question.id)).toEqual(['q1']);
    expect(older.permissions.map((request) => request.id)).toEqual(['pr1']);
    const single = await noa.conn.request('session.cards.get', { sessionId: session.id, cards: [{ kind: 'suggestion', id: suggestion.id }, { kind: 'question', id: 'q2' }] });
    expect([single.questions.map((question) => question.id), single.suggestions.map((item) => item.id)]).toEqual([['q2'], [suggestion.id]]);
  });
});
