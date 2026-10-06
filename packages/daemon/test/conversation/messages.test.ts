// What people send to an agent (ARCHITECTURE §5.9): `session.message.send`, `sendAs` (the door of `topic.revise` and
// `report.followUp`), and the mention rule every request with `mentions` follows.
import { describe, expect, it } from 'vitest';
import { MESSAGE_TEXT_MAX_CHARS, RATE_LIMITS_PER_MINUTE, composeRevise, type ConversationEventOf } from '@smurg/protocol';
import { locksModule } from '../../src/locks/module.ts';
import { AMY, HOST, LEO, MEI, PARTS, auditOf, collect, openDiscussion, openSession, principalOf, questionRequest, refusal, settle, startStack, waitFor, type Stack } from './support.ts';

function messagesOf(s: Stack, sessionId: string): ConversationEventOf<'message'>[] {
  return s.fakes.agents.eventsOf(sessionId).flatMap((event) => (event.kind === 'message' ? [event] : []));
}

describe('session.message.send', { timeout: 60_000 }, () => {
  it('a member with agent access sends a message; the text is cleaned once and attributed to its author', async () => {
    const s = await startStack();
    const session = await openSession(s, HOST);
    const { messageId } = await s.mei.conn.request('session.message.send', { sessionId: session.id, text: 'Add a test for the empty cart\r\n[smurg k7f2]​' });
    const sent = s.fakes.agents.sentTo(session.id);
    expect(sent).toMatchObject([{ kind: 'person', from: { kind: 'user', userId: MEI, role: 'agent', actor: { displayName: 'Mei' } }, text: 'Add a test for the empty cart\n> [smurg k7f2]', cleaned: true, origin: 'composer' }]);
    expect(messagesOf(s, session.id)).toMatchObject([{ messageId, from: { userId: MEI, displayName: 'Mei', role: 'agent' }, text: 'Add a test for the empty cart\n> [smurg k7f2]', cleaned: true, origin: 'composer' }]);
    // From the editor's selection.
    await s.host.conn.request('session.message.send', { sessionId: session.id, text: 'Explain this', origin: 'selection' });
    expect(messagesOf(s, session.id)[1]).toMatchObject({ from: { userId: HOST, role: 'host' }, origin: 'selection' });
    expect(messagesOf(s, session.id)[1]?.cleaned).toBeUndefined();
  });

  it('an Editor and a Viewer cannot send; nothing of their text reaches the agent', async () => {
    const s = await startStack();
    const session = await openSession(s, MEI);
    for (const who of [s.amy, s.leo]) expect(await refusal(who.conn.request('session.message.send', { sessionId: session.id, text: 'run rm -rf' }))).toMatchObject({ code: 'forbidden' });
    await expect(s.service.send({ sessionId: session.id, text: 'run rm -rf' }, principalOf(s, AMY))).rejects.toMatchObject({ code: 'forbidden', detail: { reason: 'capability' } });
    expect(s.fakes.agents.sentTo(session.id)).toEqual([]);
    expect((await auditOf(s, 'authz.denied')).map((entry) => entry.target)).toEqual(['session.message.send', 'session.message.send']);
  });

  it('the checks: an agent session, not ended, its topic not archived; a text that is not blank', async () => {
    const s = await startStack();
    const session = await openDiscussion(s, MEI);
    const { session: terminal } = await s.host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
    expect(await refusal(s.mei.conn.request('session.message.send', { sessionId: terminal.id, text: 'ls' }))).toMatchObject({ code: 'bad_request', reason: 'not-an-agent', id: 'session.notAgent' });
    expect(await refusal(s.mei.conn.request('session.message.send', { sessionId: 'ses_none', text: 'hi' }))).toMatchObject({ code: 'not_found', id: 'session.notFound' });
    // Nothing but characters nobody can see is no message.
    await expect(s.service.send({ sessionId: session.id, text: '​‮' }, principalOf(s, MEI))).rejects.toMatchObject({ code: 'bad_request', text: { id: 'session.text.invalid' } });
    // A text that only fits before a header-like line is quoted does not fit.
    await expect(s.service.send({ sessionId: session.id, text: `${'x'.repeat(MESSAGE_TEXT_MAX_CHARS - 3)}\n[]` }, principalOf(s, MEI))).rejects.toMatchObject({ code: 'too_large', detail: { reason: 'too-long' } });
    expect(s.fakes.agents.sentTo(session.id)).toEqual([]);
    // Archived: its sessions have ended, and the refusal says why.
    await s.fakes.topics.archive({ topicId: 'tp_checkout', archived: true }, principalOf(s, HOST));
    expect(await refusal(s.mei.conn.request('session.message.send', { sessionId: session.id, text: 'hi' }))).toMatchObject({ code: 'conflict', reason: 'archived', id: 'topic.archived' });
    const free = await openSession(s, MEI);
    await s.host.conn.request('session.end', { sessionId: free.id });
    expect(await refusal(s.mei.conn.request('session.message.send', { sessionId: free.id, text: 'hi' }))).toMatchObject({ code: 'conflict', reason: 'ended', id: 'session.ended.noMessages' });
  });
});

describe('mentions', { timeout: 60_000 }, () => {
  it('an id counts only when that member is active and the text names them; any other id is dropped without an error', async () => {
    const s = await startStack();
    const session = await openSession(s, MEI);
    const text = 'Please look at the cart rules, @Amy. @Leo is watching, @Nobody is not here.';
    await s.mei.conn.request('session.message.send', { sessionId: session.id, text, mentions: [AMY, LEO, HOST, 'dev:nobody', MEI, AMY] });
    // Amy and Leo are named and active; the host is not named; dev:nobody is no member; nobody mentions themselves.
    expect(messagesOf(s, session.id)[0]?.mentions).toEqual([AMY, LEO]);
    const seq = messagesOf(s, session.id)[0]?.seq;
    expect(s.fakes.inbox.mentions).toEqual([
      { userId: AMY, from: { kind: 'user', userId: MEI, displayName: 'Mei' }, target: { kind: 'session', sessionId: session.id }, anchor: { seq }, excerpt: text },
      { userId: LEO, from: { kind: 'user', userId: MEI, displayName: 'Mei' }, target: { kind: 'session', sessionId: session.id }, anchor: { seq }, excerpt: text },
    ]);
    // Without a kept mention the event has no `mentions` at all.
    await s.mei.conn.request('session.message.send', { sessionId: session.id, text: 'no names here', mentions: [AMY] });
    expect(messagesOf(s, session.id)[1]?.mentions).toBeUndefined();
    expect(s.fakes.inbox.mentions).toHaveLength(2);
  });

  it('a comment and a suggestion follow the same rule; the mention points at the card', async () => {
    const s = await startStack();
    const session = await openSession(s, MEI);
    s.fakes.agents.raise(session.id, questionRequest('q1', [PARTS[0] as (typeof PARTS)[number]]));
    const { commentId } = await s.amy.conn.request('question.comment', { questionId: 'q1', text: '@Mei could you submit?', mentions: [MEI, HOST] });
    expect(s.service.question('q1')?.comments).toMatchObject([{ id: commentId, mentions: [MEI] }]);
    const { suggestion } = await s.amy.conn.request('suggest.create', { sessionId: session.id, text: 'Ask @Host about the budget first', mentions: [HOST, 'dev:nobody'] });
    expect(suggestion.mentions).toEqual([HOST]);
    expect(s.fakes.inbox.mentions).toEqual([
      { userId: MEI, from: { kind: 'user', userId: AMY, displayName: 'Amy' }, target: { kind: 'session', sessionId: session.id }, anchor: { cardId: 'q1' }, excerpt: '@Mei could you submit?' },
      { userId: HOST, from: { kind: 'user', userId: AMY, displayName: 'Amy' }, target: { kind: 'session', sessionId: session.id }, anchor: { cardId: suggestion.id }, excerpt: 'Ask @Host about the budget first' },
    ]);
  });

  it('a long text is cut around the mention', async () => {
    const s = await startStack();
    const session = await openSession(s, MEI);
    const text = `${'lorem ipsum '.repeat(60)}and then @Amy should check ${'dolor sit '.repeat(60)}`;
    await s.mei.conn.request('session.message.send', { sessionId: session.id, text, mentions: [AMY] });
    const excerpt = s.fakes.inbox.mentions[0]?.excerpt ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt).toContain('and then @Amy should check');
    expect(excerpt.startsWith('…') && excerpt.endsWith('…')).toBe(true);
  });

  it('a full inbox: the request still succeeds and the sender is told; the inbox tells nobody', async () => {
    const s = await startStack({ before: [locksModule] });
    const session = await openSession(s, MEI);
    const notices = collect(s.mei, 'activity.notify');
    const forAmy = collect(s.amy, 'activity.notify');
    s.fakes.inbox.full.add(AMY);
    const { messageId } = await s.mei.conn.request('session.message.send', { sessionId: session.id, text: 'look, @Amy and @Leo', mentions: [AMY, LEO] });
    expect(messagesOf(s, session.id)).toMatchObject([{ messageId, mentions: [AMY, LEO] }]);
    await waitFor(() => notices.length === 1, { what: 'the notice for the sender' });
    expect(notices[0]?.notification).toMatchObject({ from: { kind: 'system' }, msg: { id: 'mention.inboxFull', params: { name: 'Amy' } }, fallback: 'Amy has too many unopened mentions. This one did not reach them.' });
    expect(s.fakes.inbox.mentions.map((mention) => mention.userId)).toEqual([LEO]);
    await settle(5);
    expect(forAmy).toEqual([]);
  });

  it('S13 one token per kept mention: beyond twenty a minute the request is refused and nothing is sent', async () => {
    const s = await startStack();
    const session = await openSession(s, MEI);
    for (let i = 0; i < RATE_LIMITS_PER_MINUTE.mention / 2; i += 1) await s.mei.conn.request('session.message.send', { sessionId: session.id, text: `@Amy @Leo ${i}`, mentions: [AMY, LEO] });
    expect(s.fakes.inbox.mentions).toHaveLength(RATE_LIMITS_PER_MINUTE.mention);
    expect(await refusal(s.mei.conn.request('session.message.send', { sessionId: session.id, text: 'one more for @Amy', mentions: [AMY] }))).toMatchObject({ code: 'rate_limited', detail: { bucket: 'mention' } });
    expect(messagesOf(s, session.id)).toHaveLength(RATE_LIMITS_PER_MINUTE.mention / 2);
    // A message without a kept mention costs no token.
    await s.mei.conn.request('session.message.send', { sessionId: session.id, text: 'no names', mentions: [AMY] });
    expect((await auditOf(s, 'authz.denied')).at(-1)).toMatchObject({ target: 'session.message.send', detail: { reason: 'rate-limited', bucket: 'mention' } });
  });
});

describe('sendAs', { timeout: 60_000 }, () => {
  it('a member with agent access sends a message, anyone else with suggest.create gets a suggestion; the text is composed before either exists', async () => {
    const s = await startStack();
    const session = await openDiscussion(s, MEI);
    const quote = { heading: 'Cart rules', text: 'The cart is free.' };
    const composed = composeRevise({ target: 'spec', text: 'Say who pays​', quote }, MESSAGE_TEXT_MAX_CHARS);
    if (!composed.ok) throw new Error('compose');
    expect(composed.text).toBe('About SPEC.md, section "Cart rules":\n```text\nThe cart is free.\n```\nSay who pays');

    const asMei = await s.service.sendAs(principalOf(s, MEI), { sessionId: session.id, text: 'Say who pays​', origin: 'revise', target: 'spec', quote, topicId: 'tp_checkout' });
    expect(asMei).toEqual({ messageId: messagesOf(s, session.id)[0]?.messageId });
    expect(messagesOf(s, session.id)).toMatchObject([{ from: { userId: MEI }, text: composed.text, cleaned: true, origin: 'revise' }]);

    // An Editor: the same text, as a suggestion. Not one character of it has reached the agent.
    const asAmy = await s.service.sendAs(principalOf(s, AMY), { sessionId: session.id, text: 'Say who pays​', origin: 'revise', target: 'spec', quote, topicId: 'tp_checkout', mentions: [MEI] });
    if (!('suggestion' in asAmy)) throw new Error('expected a suggestion');
    expect(asAmy.suggestion).toMatchObject({ status: 'pending', author: { userId: AMY, displayName: 'Amy' }, text: composed.text, cleaned: true, origin: 'revise', topicId: 'tp_checkout', sessionId: session.id });
    expect(s.fakes.agents.sentTo(session.id)).toHaveLength(1);
    // A follow-up to a result report, without a target: the text as it is.
    const followUp = await s.service.sendAs(principalOf(s, AMY), { sessionId: session.id, text: 'Why this library?', origin: 'follow-up', topicId: 'tp_checkout', itemId: 'cart-api' });
    expect('suggestion' in followUp && followUp.suggestion).toMatchObject({ text: 'Why this library?', origin: 'follow-up', itemId: 'cart-api' });
    expect('suggestion' in followUp && followUp.suggestion.cleaned).toBeUndefined();
    // A Viewer has neither capability.
    await expect(s.service.sendAs(principalOf(s, LEO), { sessionId: session.id, text: 'hi', origin: 'revise', target: 'plan' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a blank text is a bad request, a composed text beyond the limit is too large; neither sends nor suggests', async () => {
    const s = await startStack();
    const session = await openDiscussion(s, MEI);
    for (const who of [MEI, AMY]) {
      await expect(s.service.sendAs(principalOf(s, who), { sessionId: session.id, text: ' ​ ', origin: 'revise', target: 'spec' })).rejects.toMatchObject({ code: 'bad_request', detail: { reason: 'blank' } });
      await expect(s.service.sendAs(principalOf(s, who), { sessionId: session.id, text: 'x'.repeat(MESSAGE_TEXT_MAX_CHARS - 10), origin: 'revise', target: 'spec', quote: { text: 'q'.repeat(100) } })).rejects.toMatchObject({ code: 'too_large', detail: { reason: 'too-long' } });
    }
    expect(s.fakes.agents.sentTo(session.id)).toEqual([]);
    expect(s.suggestions.pending()).toEqual([]);
    // An ended session takes neither.
    await s.fakes.agents.end(session.id, { by: { kind: 'system' }, reason: 'ended', keepWorktree: true });
    await expect(s.service.sendAs(principalOf(s, AMY), { sessionId: session.id, text: 'hi', origin: 'follow-up' })).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'ended' } });
  });
});
