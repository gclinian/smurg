// The question card by who looks at it (UX §5.1, DESIGN §5.12 item 13): the decider, a voter, an Editor who
// decides, a viewer, the host; escalated; the note; settled and withdrawn. Every request it sends is checked against
// the registry by the FakeConnection.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { settledError, type ConversationEvent, type Question } from '@smurg/protocol';
import { buildEvent, buildQuestion, FAKE_NOW } from '@smurg/protocol/testing';
import { AMY, IAN, LEO, MEI, SID, openConversation, settle, type Scene } from './test-support.tsx';

const CARD: ConversationEvent[] = [buildEvent('card', { seq: 1, card: 'question', id: 'q_1' })];
const vote = (who: { userId: string; displayName: string }, options: number[] | string, part = 0): Question['votes'][number] =>
  typeof options === 'string' ? { ...who, part, other: options, at: FAKE_NOW } : { ...who, part, options, at: FAKE_NOW };

async function openQuestion(question: Partial<Question>, scene: Scene = {}) {
  const view = await openConversation({
    session: { status: 'waiting-answer', waitingSince: FAKE_NOW, ...scene.session },
    events: CARD,
    ...scene,
    reply: { questions: [buildQuestion({ id: 'q_1', sessionId: SID, decider: IAN, eligible: 3, ...question })] },
  });
  const card = document.getElementById('conv-card-q_1') as HTMLElement;
  return { ...view, card };
}

describe('question card: the decider', () => {
  it('sees the votes live, the leading option prefilled as the answer, and submits it', async () => {
    const view = await openQuestion({ votes: [vote(MEI, [0]), vote(AMY, [0])] }, { session: { responsible: IAN } });
    const { card } = view;
    expect(within(card).getByRole('heading', { level: 3, name: 'Question from Claude' })).toBeTruthy();
    expect(card.textContent).toContain('2 of 3 voted');
    expect(within(card).getByText('Where is the cart kept?')).toBeTruthy();
    const group = within(card).getByRole('radiogroup', { name: 'Your vote' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByText('Leading')).toBeTruthy();
    expect(within(group).getByRole('img', { name: '2 votes: Mei and Amy' })).toBeTruthy();
    expect(card.textContent).toContain('You decide: you are responsible for this session.');
    expect(card.textContent).toContain('Answer to submit On the server');
    expect(card.textContent).toContain('You can submit now; votes are advice.');
    expect(card.textContent).toContain('Comments are for the team. Claude does not read them.');

    // A new vote arrives: the count changes without a reload.
    act(() => view.conn.emit('question.changed', { sessionId: SID, questionId: 'q_1', vote: vote(LEO, [1]), eligible: 3 }));
    expect(card.textContent).toContain('All 3 voted');

    fireEvent.click(within(card).getByRole('button', { name: 'Submit answer' }));
    expect(view.conn.lastRequest('question.submit')?.payload).toEqual({ questionId: 'q_1', answers: [{ options: [0] }] });
  });

  it('a click on an option sets the vote and the answer; "Submit a different answer" reveals the choice, with the others\' own words', async () => {
    const view = await openQuestion({ votes: [vote(MEI, [0]), vote(AMY, 'In both places')] });
    const { card } = view;
    // Nobody is assigned and Ian opened the session.
    expect(card.textContent).toContain('You decide: nobody is assigned to this session, and you opened it.');
    fireEvent.click(within(card).getByRole('radio', { name: /In the browser/ }));
    expect(view.conn.lastRequest('question.vote')?.payload).toEqual({ questionId: 'q_1', part: 0, options: [1] });
    act(() => {
      view.conn.respond('question.vote', {});
      view.conn.emit('question.changed', { sessionId: SID, questionId: 'q_1', vote: vote(IAN, [1]) });
    });
    await settle();
    expect(card.textContent).toContain('Answer to submit In the browser');

    fireEvent.click(within(card).getByRole('button', { name: 'Submit a different answer' }));
    const select = within(card).getByRole('combobox', { name: 'Answer to submit' });
    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Choose an answer',
      'On the server',
      'In the browser',
      'Other, by Amy: In both places',
      'Other: an answer in my own words',
    ]);
    fireEvent.change(select, { target: { value: 'v:dev:amy' } });
    // The decider may edit the text before sending.
    fireEvent.change(within(card).getByRole('textbox', { name: 'The answer to send' }), { target: { value: 'In both places, server first' } });
    fireEvent.change(within(card).getByRole('textbox', { name: 'Note for Claude (optional)' }), { target: { value: 'Keep it small' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Submit answer' }));
    expect(view.conn.lastRequest('question.submit')?.payload).toEqual({
      questionId: 'q_1',
      answers: [{ other: 'In both places, server first', otherBy: 'dev:amy' }],
      note: 'Keep it small',
    });
  });

  it('with a tie nothing is prefilled and Submit waits; with no votes it says so; "Add to the note" copies a comment', async () => {
    const tied = await openQuestion({
      votes: [vote(MEI, [0]), vote(AMY, [1])],
      comments: [{ id: 'c_1', from: MEI, text: 'The server survives a reload, @Ian', at: FAKE_NOW, mentions: [IAN.userId] }],
    });
    expect(tied.card.textContent).toContain('The vote is tied. Choose the answer yourself.');
    expect(tied.card.textContent).toContain('No answer chosen yet');
    expect((within(tied.card).getByRole('button', { name: 'Submit answer' }) as HTMLButtonElement).disabled).toBe(true);
    expect(tied.card.querySelector('.conv-thread .md-mention')?.textContent).toBe('@Ian');
    fireEvent.click(within(tied.card).getByRole('button', { name: 'Add to the note' }));
    expect((within(tied.card).getByRole('textbox', { name: 'Note for Claude (optional)' }) as HTMLTextAreaElement).value).toBe('Mei: The server survives a reload, @Ian');
    tied.unmount();

    const empty = await openQuestion({});
    expect(empty.card.textContent).toContain('Nobody has voted yet. You can still choose and submit.');
    expect(empty.card.textContent).toContain('0 of 3 voted');
  });

  it('reminds those who have not voted, comments with a mention, and tells the daemon that the decider saw the card', async () => {
    const view = await openQuestion({ votes: [vote(MEI, [0])] });
    const { card } = view;
    expect(view.conn.notificationsOf('question.seen').map((notification) => notification.payload)).toEqual([{ questionId: 'q_1' }]);
    fireEvent.click(within(card).getByRole('button', { name: 'Remind those who have not voted' }));
    expect(view.conn.lastRequest('question.remind')?.payload).toEqual({ questionId: 'q_1' });
    act(() => {
      view.conn.respond('question.remind', {});
    });
    await settle();
    expect(within(card).getByText('Reminded.')).toBeTruthy();

    const box = within(card).getByRole('combobox', { name: 'Add a comment' });
    fireEvent.change(box, { target: { value: '@Amy what do you think?' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Comment' }));
    expect(view.conn.lastRequest('question.comment')?.payload).toEqual({ questionId: 'q_1', text: '@Amy what do you think?', mentions: ['dev:amy'] });
  });

  it('several questions are one card: each has its votes and its answer, one Submit for all of them', async () => {
    const view = await openQuestion({
      parts: [
        { header: 'Cart', text: 'Where is the cart kept?', multi: false, options: [{ label: 'On the server', description: '' }, { label: 'In the browser', description: '' }] },
        { header: 'Extras', text: 'Which extras?', multi: true, options: [{ label: 'Coupons', description: '' }, { label: 'Gift wrap', description: '' }] },
      ],
      votes: [vote(MEI, [0], 0), vote(MEI, [0, 1], 1)],
    });
    const { card } = view;
    expect(card.textContent).toContain('Question 1 of 2');
    expect(within(card).getByRole('radiogroup', { name: 'Your vote: Where is the cart kept?' })).toBeTruthy();
    const extras = within(card).getByRole('group', { name: 'Your vote: Which extras?' });
    expect(within(extras).getAllByRole('checkbox')).toHaveLength(3);
    expect(card.textContent).toContain('Choose all that apply.');
    fireEvent.click(within(extras).getByRole('checkbox', { name: /Gift wrap/ }));
    expect(view.conn.lastRequest('question.vote')?.payload).toEqual({ questionId: 'q_1', part: 1, options: [1] });
    fireEvent.click(within(card).getByRole('button', { name: 'Submit answers' }));
    // Both parts led by Mei's votes.
    expect(view.conn.lastRequest('question.submit')?.payload).toEqual({ questionId: 'q_1', answers: [{ options: [0] }, { options: [0, 1] }] });
  });
});

describe('question card: the others', () => {
  it('a voter votes and comments, reads who decides and whether they saw it, and has no Submit', async () => {
    const view = await openQuestion({ votes: [] }, { role: 'agent', session: { responsible: IAN } });
    const { card } = view;
    expect(card.textContent).toContain('Ian decides (responsible for this session). Your vote and comments are visible to everyone.');
    expect(card.textContent).toContain('Ian has not opened this question yet.');
    expect(within(card).queryByRole('button', { name: /Submit/ })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Remind those who have not voted' })).toBeNull();
    expect(view.conn.notificationsOf('question.seen')).toHaveLength(0);

    // An "Other" vote needs only `discuss`: her own words, for people.
    fireEvent.click(within(card).getByRole('radio', { name: 'Other' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Vote for this' }));
    expect(within(card).getByRole('alert').textContent).toBe('An answer of your own needs a text.');
    fireEvent.change(within(card).getByRole('textbox', { name: 'Your own answer' }), { target: { value: 'In both places' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Vote for this' }));
    expect(view.conn.lastRequest('question.vote')?.payload).toEqual({ questionId: 'q_1', part: 0, other: 'In both places' });

    act(() => view.conn.emit('question.changed', { sessionId: SID, questionId: 'q_1', deciderSeenAt: FAKE_NOW }));
    expect(card.textContent).toContain('Ian has seen this question.');
  });

  it('an Editor who decides picks among the options and asks those with agent access for an answer in their own words', async () => {
    const view = await openQuestion({ decider: AMY, votes: [vote(MEI, 'Somewhere else')] }, { role: 'editor', session: { responsible: AMY } });
    const { card } = view;
    expect(card.textContent).toContain('You decide: you are responsible for this session.');
    expect(card.textContent).toContain("You decide among Claude's options. An answer in your own words needs Ian and Mei.");
    expect(within(card).queryByRole('textbox', { name: 'Note for Claude (optional)' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Add to the note' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Submit a different answer' }));
    const select = within(card).getByRole('combobox', { name: 'Answer to submit' });
    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Choose an answer', 'On the server', 'In the browser']);

    fireEvent.click(within(card).getByRole('button', { name: 'Ask them to submit' }));
    expect(view.conn.lastRequest('question.comment')?.payload).toEqual({
      questionId: 'q_1',
      text: '@Ian @Mei please submit the answer to this question: I cannot submit one in my own words.',
      mentions: [IAN.userId, MEI.userId],
    });
  });

  it('a viewer watches: no vote, no comment box, who decides', async () => {
    const { card } = await openQuestion({ votes: [vote(MEI, [0])], comments: [{ id: 'c_1', from: MEI, text: 'Server', at: FAKE_NOW }] }, { role: 'viewer' });
    expect(within(card).queryByRole('radio')).toBeNull();
    expect(within(card).queryByRole('combobox')).toBeNull();
    expect(card.textContent).toContain('You are watching. Viewers do not vote. Ian decides.');
    expect(card.textContent).toContain('1 comment');
  });

  it('the host may submit for the decider; once escalated every member with agent access may, and the others read why', async () => {
    const host = await openQuestion({ decider: MEI, votes: [vote(AMY, [1])] }, { role: 'host', session: { responsible: MEI } });
    expect(host.card.textContent).toContain('Mei decides. As the host you can submit the answer too.');
    fireEvent.click(within(host.card).getByRole('button', { name: 'Submit for Mei' }));
    expect(host.conn.lastRequest('question.submit')?.payload).toEqual({ questionId: 'q_1', answers: [{ options: [1] }] });
    host.unmount();

    const waiting = await openQuestion({ decider: IAN, votes: [vote(AMY, [1])], askedAt: Date.now() - 6 * 60_000 - 5_000, escalatedAt: Date.now() }, { role: 'agent', session: { responsible: IAN } });
    expect(waiting.card.textContent).toContain('Ian decides and has not answered for 6 min. You can submit for them.');
    expect(within(waiting.card).getByRole('button', { name: 'Submit for Ian' })).toBeTruthy();
    waiting.unmount();

    const editor = await openQuestion({ decider: IAN, askedAt: Date.now() - 6 * 60_000 - 5_000, escalatedAt: Date.now() }, { role: 'editor', session: { responsible: IAN } });
    expect(editor.card.textContent).toContain('Ian has not answered for 6 min.');
    expect(within(editor.card).queryByRole('button', { name: /Submit/ })).toBeNull();
  });
});

describe('question card: settled', () => {
  it('folds to the answer, who submitted it and the note; the votes and comments stay readable', async () => {
    const view = await openQuestion({ votes: [vote(MEI, [0])] }, { session: { responsible: IAN } });
    const answered = buildQuestion({
      id: 'q_1',
      sessionId: SID,
      status: 'answered',
      decider: MEI,
      eligible: 3,
      votes: [vote(MEI, [0]), vote(AMY, [1])],
      comments: [{ id: 'c_1', from: AMY, text: 'Simpler in the browser', at: FAKE_NOW }],
      answer: { parts: [{ options: [0] }], note: 'Keep it small', by: IAN, onBehalfOf: MEI, at: FAKE_NOW, tally: [[1, 1, 0]] },
    });
    act(() => view.conn.emit('question.updated', { question: answered }));
    const card = document.getElementById('conv-card-q_1') as HTMLElement;
    expect(card.className).toContain('ui-card--settled');
    expect(card.textContent).toContain('Answered: On the server');
    expect(card.textContent).toContain('2 votes');
    expect(card.textContent).toMatch(/submitted by Ian for Mei, /);
    expect(card.textContent).toContain('Note for Claude: Keep it small');
    expect(within(card).queryByRole('radio')).toBeNull();
    expect(within(card).getByText('Show the votes and comments')).toBeTruthy();
    expect(card.textContent).toContain('Simpler in the browser');
  });

  it('a card withdrawn by a restart keeps its votes and says why; the card that replaces it names the earlier votes', async () => {
    const withdrawn = await openQuestion({ status: 'withdrawn', votes: [vote(MEI, [0])], withdrawn: { reason: 'restarted', at: FAKE_NOW } });
    expect(withdrawn.card.textContent).toContain('Not answered: smurg was restarted. Claude asks again when the session continues.');
    expect(within(withdrawn.card).getByText('Show the votes and comments')).toBeTruthy();
    withdrawn.unmount();

    const stopped = await openQuestion({ status: 'withdrawn', withdrawn: { reason: 'stopped', by: MEI, at: FAKE_NOW } });
    expect(stopped.card.textContent).toContain('Not answered: Mei stopped the agent.');
    stopped.unmount();

    const again = await openQuestion({ previous: { askedAt: FAKE_NOW - 60_000, tally: [[2, 0, 0]] } });
    expect(again.card.textContent).toContain('Asked before: 2 votes for "On the server"');
  });

  it('a submit that came second is told who answered first', async () => {
    const view = await openQuestion({ votes: [vote(MEI, [0])] });
    fireEvent.click(within(view.card).getByRole('button', { name: 'Submit answer' }));
    act(() => {
      view.conn.fail('question.submit', settledError({ card: { kind: 'question', id: 'q_1' }, sessionId: SID, status: 'answered', by: MEI }));
    });
    await settle();
    expect(view.card.textContent).toContain('Mei already submitted an answer.');
  });
});
