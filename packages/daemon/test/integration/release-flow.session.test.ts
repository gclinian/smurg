// The release composition, the whole story of ONE free agent session (DESIGN §3.5, §3.6, §3.8–§3.10, §7 S1 / S2 / S5 /
// S6 / S7): the real agent runtime, the real conversation, suggestion and inbox modules together, with the stand-in
// `claude` (release-flow.support.ts). Ian is the host, Mei has agent access and opens the session, Amy is an Editor,
// Leo a Viewer. Every step is asserted from what the four RECEIVE.
//
// What only this composition proves (REQUESTS-P12 "never run together yet"): the runner's `agent.request` → the cards
// of the conversation module → `answerQuestion` / `decidePermission` back into the stand-in's pipe; `toWatchers`;
// `setRules` + the session rule in the running process; an accepted suggestion as the author's message; the inbox
// derived from all of it; and that nothing an Editor wrote reaches an agent before a member with agent access let it.
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type ConversationEvent } from '@smurg/protocol';
import type { FakeClaudeScenario } from '../../src/testing/index.ts';
import { AMY, IAN, LEO, MEI, audited, eventOf, everythingAgentsReceived, inboxItem, inboxWithout, kinds, permissionAt, questionAt, refusal, sessionReady, startFlow, statusIs, told, turnsFinished, waitFor, type Flow } from './release-flow.support.ts';

// Texts only Amy writes: none of them may ever be in anything an agent received, unless a member with agent access let it.
const AMY_SUGGESTION = 'Please also run the linter (amy-suggestion-7f31).';
const AMY_REJECTED = 'Delete the old tests (amy-rejected-52c9).';
const AMY_COMMENT = '@Leo the browser would be simpler (amy-comment-a0d4).';
const AMY_OTHER = 'In a signed cookie (amy-other-e8b6).';
const AMY_OTHER_PROPOSED = 'Only on Fridays (amy-proposed-19c3).';

const CART = { question: 'Where is the cart kept?', header: 'Cart', multiSelect: false, options: [{ label: 'On the server', description: 'Survives a reload.' }, { label: 'In the browser', description: 'Simpler.' }] };
const CHECKS = { question: 'Which checks run before a merge?', header: 'Checks', multiSelect: true, options: [{ label: 'Unit tests', description: 'Fast.' }, { label: 'Type check', description: 'Strict.' }, { label: 'Lint, format', description: 'One label with a comma.' }] };
const COLOUR = { question: 'Which colour has the button?', header: 'Button', multiSelect: false, options: [{ label: 'Green', description: 'As the logo.' }, { label: 'Blue', description: 'As the links.' }] };
const RELEASE = { question: 'When do we release?', header: 'Release', multiSelect: false, options: [{ label: 'Every week', description: 'A steady rhythm.' }, { label: 'When it is ready', description: 'No date.' }] };

const SCENARIO: FakeClaudeScenario = {
  turns: [
    {
      match: 'run the tests',
      steps: [
        { text: 'I will look at the project first.' },
        { tool: 'Read', input: { file_path: 'README.md' } },
        // Asked: allowed once.
        { tool: 'Bash', input: { command: 'pnpm test' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '3 tests passed' },
        // Asked: "always allow this kind" for this session.
        { tool: 'Bash', input: { command: 'pnpm test --coverage' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: 'coverage 91 %' },
        // Not asked any more: the running process has the rule.
        { tool: 'Bash', input: { command: 'pnpm test unit' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '2 tests passed' },
        // A kind that can never be always allowed (it fetches code and runs it).
        { tool: 'Bash', input: { command: 'npx cowsay done' }, suggest: { toolName: 'Bash', ruleContent: 'npx cowsay *' } },
        { text: 'The tests pass.' },
      ],
    },
    { match: 'ask the team', steps: [{ tool: 'AskUserQuestion', input: { questions: [CART, CHECKS] } }, { text: 'Thank you, I will build it that way.' }] },
    { match: 'ask about the release', steps: [{ tool: 'AskUserQuestion', input: { questions: [RELEASE] } }, { text: 'Noted.' }] },
    { match: 'ask about the colour', steps: [{ tool: 'AskUserQuestion', input: { questions: [COLOUR] } }, { text: 'Blue it is.' }] },
    { match: 'once more', steps: [{ tool: 'Bash', input: { command: 'pnpm test --watch=false' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '3 tests passed' }, { text: 'Still green.' }] },
    { match: 'deploy', steps: [{ tool: 'Bash', input: { command: './deploy.sh staging' }, result: 'deployed' }, { text: 'Deployed to staging.' }] },
    { match: 'clean up', steps: [{ tool: 'Bash', input: { command: 'rm -rf build' } }, { text: 'never said' }] },
    { steps: [{ text: 'ok' }] },
  ],
};

const open = <T extends { status: string }>(list: readonly T[]): T[] => list.filter((entry) => entry.status === 'open');
/** The answers the agent of a session got to its questions (the `control_response` lines on its pipe). */
async function answersGiven(flow: Flow, sessionId: string): Promise<{ answers?: Record<string, string>; annotations?: Record<string, { notes?: string }> }[]> {
  return (await flow.claude.echoed())
    .filter((entry) => entry.kind === 'stdin' && entry.session === sessionId)
    .map((entry) => entry.value as { type?: string; response?: { response?: { behavior?: string; updatedInput?: { answers?: Record<string, string>; annotations?: Record<string, { notes?: string }> } } } })
    .filter((line) => line.type === 'control_response' && line.response?.response?.updatedInput?.answers !== undefined)
    .map((line) => line.response?.response?.updatedInput ?? {});
}

describe('the release composition: one free agent session, four people', { timeout: 240_000 }, () => {
  it('message, tool lines, permission cards, a question with votes, suggestions, escalation: each step as the members receive it, and nothing of an Editor reaches the agent unaccepted', async () => {
    const flow = await startFlow({ files: { 'README.md': '# Bookshop\n' } });
    await flow.claude.setScenario(SCENARIO);
    const { ian, mei, amy, leo } = flow;
    const everyone = [ian, mei, amy, leo];

    // ================================================================================================================
    // Mei opens a free session; everyone watches it
    // ================================================================================================================
    const { session } = await mei.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, title: 'Tests' });
    const sessionId = session.id;
    expect(session).toMatchObject({ kind: 'agent', purpose: 'free', openedBy: { userId: MEI, displayName: 'Mei' }, responsible: null, permissionMode: 'ask-all' });
    // A Viewer and an Editor cannot open one.
    expect(await refusal(leo.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' } }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(amy.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' } }))).toMatchObject({ code: 'forbidden' });
    await sessionReady(ian, sessionId);
    for (const member of everyone) await member.watch(sessionId);

    // ================================================================================================================
    // A message; tool lines; permission cards
    // ================================================================================================================
    // An Editor's and a Viewer's message is refused: the composer of an Editor sends a suggestion instead (below).
    expect(await refusal(amy.conn.request('session.message.send', { sessionId, text: 'hello' }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(leo.conn.request('session.message.send', { sessionId, text: 'hello' }))).toMatchObject({ code: 'forbidden' });
    const first = await mei.conn.request('session.message.send', { sessionId, text: 'Please run the tests.' });

    // ---- the first command asks; the card is at every watcher, the inbox item at who may decide (nobody is
    // responsible: the host and every member with agent access)
    const once = await permissionAt(leo, (request) => request.command === 'pnpm test', 'the first permission card');
    expect(once).toMatchObject({ sessionId, status: 'open', tool: 'Bash', what: 'command', command: 'pnpm test', root: MAIN_ROOT, hostOnly: false, alwaysRule: { tool: 'Bash', pattern: 'pnpm test *' } });
    for (const member of everyone) await permissionAt(member, (request) => request.id === once.id, 'the first permission card');
    const onceKey = `permission:${once.id}`;
    expect(await inboxItem(mei, (item) => item.key === onceKey, 'the permission request')).toMatchObject({ kind: 'permission', sessionId, waiting: true, unread: true, excerpt: 'pnpm test', alsoFor: [{ userId: IAN }] });
    expect(await inboxItem(ian, (item) => item.key === onceKey, 'the permission request')).toMatchObject({ kind: 'permission', alsoFor: [{ userId: MEI }] });
    expect(await amy.inbox()).toEqual([]);
    expect(await leo.inbox()).toEqual([]);
    expect((await ian.conn.request('session.list', {})).sessions.find((entry) => entry.id === sessionId)).toMatchObject({ status: 'waiting-permission' });

    // ---- Amy (Editor) and Leo (Viewer) cannot decide; Mei allows once
    expect(await refusal(amy.conn.request('permission.decide', { requestId: once.id, decision: 'allow' }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(leo.conn.request('permission.decide', { requestId: once.id, decision: 'allow' }))).toMatchObject({ code: 'forbidden' });
    expect((await mei.conn.request('permission.decide', { requestId: once.id, decision: 'allow' })).request).toMatchObject({ id: once.id, status: 'allowed', decision: { by: { userId: MEI } } });
    // A late answer after the settle is refused, and says who settled it.
    expect(await refusal(ian.conn.request('permission.decide', { requestId: once.id, decision: 'deny' }))).toMatchObject({ code: 'conflict', reason: 'settled', detail: { status: 'allowed', by: { userId: MEI } } });
    await inboxWithout(ian, (item) => item.key === onceKey, 'the decided request');
    await inboxWithout(mei, (item) => item.key === onceKey, 'the decided request');

    // ---- the second command asks again; Mei: "always allow this kind" for this session
    const always = await permissionAt(amy, (request) => request.command === 'pnpm test --coverage', 'the second permission card');
    expect(always).toMatchObject({ status: 'open', alwaysRule: { tool: 'Bash', pattern: 'pnpm test *' } });
    expect((await mei.conn.request('permission.decide', { requestId: always.id, decision: 'allow-always', scope: 'session' })).request).toMatchObject({ status: 'allowed', decision: { by: { userId: MEI }, always: 'session' } });

    // ---- the third command of that kind does not ask; the fourth is a kind that can never be always allowed
    const never = await permissionAt(leo, (request) => request.command === 'npx cowsay done', 'the fourth permission card');
    expect(never).toMatchObject({ status: 'open', noAlways: 'fetches-code' });
    expect(never.alwaysRule).toBeUndefined();
    expect(await refusal(mei.conn.request('permission.decide', { requestId: never.id, decision: 'allow-always', scope: 'session' }))).toMatchObject({ code: 'conflict', reason: 'no-always', id: 'permission.noAlways' });
    // (the refusal left the card open) Ian, the host, denies it and says what to do instead.
    expect((await ian.conn.request('permission.decide', { requestId: never.id, decision: 'deny', message: 'Use the echo command.' })).request).toMatchObject({ status: 'denied', decision: { by: { userId: IAN }, message: 'Use the echo command.' } });
    await turnsFinished(leo, sessionId, 1);
    await statusIs(leo, sessionId, 'idle');

    // ---- what everyone saw of the turn, the Viewer included, and the same for all four
    expect(leo.events(sessionId)[0]).toMatchObject({ seq: 1, kind: 'line', text: { id: 'conversation.started.free', params: { name: 'Mei' } } });
    const turn1 = leo.events(sessionId).slice(1);
    expect(kinds(turn1)).toEqual([
      'message',
      'delivery',
      'turn.started',
      'text',
      'tool.started', // Read README.md
      'tool.finished',
      'tool.started', // pnpm test
      'card:permission',
      'tool.finished',
      'tool.started', // pnpm test --coverage
      'card:permission',
      'line', // "Mei always allows Bash(pnpm test *) in this session"
      'tool.finished',
      'tool.started', // pnpm test unit: no card
      'tool.finished',
      'tool.started', // npx cowsay done
      'card:permission',
      'tool.finished',
      'text',
      'turn.finished',
      'delivery',
    ]);
    for (const member of [ian, mei, amy]) expect(member.events(sessionId).slice(1)).toEqual(turn1);
    expect(turn1[0]).toMatchObject({ kind: 'message', messageId: first.messageId, from: { userId: MEI, displayName: 'Mei', role: 'agent' }, text: 'Please run the tests.' });
    expect(turn1.filter((event) => event.kind === 'tool.started').map((event) => (event.kind === 'tool.started' ? `${event.tool.name} ${event.tool.verb} ${event.tool.target ?? event.tool.file?.path ?? ''}` : ''))).toEqual([
      'Read read README.md',
      'Bash run pnpm test',
      'Bash run pnpm test --coverage',
      'Bash run pnpm test unit',
      'Bash run npx cowsay done',
    ]);
    expect(turn1.filter((event) => event.kind === 'tool.finished').map((event) => (event.kind === 'tool.finished' ? event.ok : null))).toEqual([true, true, true, true, false]);
    expect(turn1.find((event) => event.kind === 'line')).toMatchObject({ text: { id: 'conversation.rule.added', params: { by: 'Mei', rule: 'Bash(pnpm test *)' } } });
    // The rule is the session's, added by Mei; every member reads it.
    expect((await leo.conn.request('session.rules.get', { sessionId })).rules).toMatchObject([{ tool: 'Bash', pattern: 'pnpm test *', scope: 'session', addedBy: { userId: MEI } }]);
    // What the agent was sent: Mei's message under her header, and nothing else.
    expect(await told(flow, sessionId)).toEqual(['[Mei · Agent access]\nPlease run the tests.']);
    // The audit log has every decision with the whole command, and by whom.
    expect((await audited(flow, 'permission.decide')).map((entry) => `${entry.actor.kind === 'user' ? entry.actor.userId : entry.actor.kind} ${String(entry.detail?.['decision'])} ${String(entry.detail?.['command'])}${entry.detail?.['rule'] === undefined ? '' : ` ${String(entry.detail['rule'])}`}`)).toEqual([
      `${MEI} allow pnpm test`,
      `${MEI} allow-always pnpm test --coverage Bash(pnpm test *)`,
      `${IAN} deny npx cowsay done`,
    ]);

    // ================================================================================================================
    // A question with two parts: everyone votes, a comment mentions Leo, a tie, the decider submits
    // ================================================================================================================
    await mei.conn.request('session.message.send', { sessionId, text: 'Now ask the team how to build it.' });
    const asked = await questionAt(leo, (question) => question.status === 'open', 'the question card');
    const questionId = asked.id;
    // Mei opened the session and nobody is responsible: she decides.
    expect(asked).toMatchObject({ sessionId, status: 'open', decider: { userId: MEI }, eligible: 3, votes: [], comments: [] });
    expect(asked.parts).toMatchObject([
      { header: 'Cart', text: CART.question, multi: false, options: [{ label: 'On the server' }, { label: 'In the browser' }] },
      { header: 'Checks', text: CHECKS.question, multi: true, options: [{ label: 'Unit tests' }, { label: 'Type check' }, { label: 'Lint, format' }] },
    ]);
    // The decider holds the question; the other two who may vote are asked for their vote; the Viewer for nothing.
    expect(await inboxItem(mei, (item) => item.key === `question:${questionId}`, 'the question')).toMatchObject({ kind: 'question', waiting: true, excerpt: CART.question, voted: 0, eligible: 3, allVoted: false });
    expect(await inboxItem(ian, (item) => item.key === `vote:${questionId}`, 'the vote')).toMatchObject({ kind: 'vote', waiting: true, waitsFor: { userId: MEI } });
    expect(await inboxItem(amy, (item) => item.key === `vote:${questionId}`, 'the vote')).toMatchObject({ kind: 'vote', waitsFor: { userId: MEI } });
    expect(await leo.inbox()).toEqual([]);

    // ---- the votes: Ian and Mei disagree on the cart (a tie), Amy answers it in her own words; the Viewer cannot vote
    expect(await refusal(leo.conn.request('question.vote', { questionId, part: 0, options: [0] }))).toMatchObject({ code: 'forbidden' });
    await ian.conn.request('question.vote', { questionId, part: 0, options: [0] });
    await mei.conn.request('question.vote', { questionId, part: 0, options: [1] });
    await amy.conn.request('question.vote', { questionId, part: 0, other: AMY_OTHER });
    await ian.conn.request('question.vote', { questionId, part: 1, options: [0, 1] });
    await mei.conn.request('question.vote', { questionId, part: 1, options: [0] });
    await amy.conn.request('question.vote', { questionId, part: 1, options: [2, 0] });
    // A vote for two options of a single choice, or for an option that is not there, is refused.
    expect(await refusal(amy.conn.request('question.vote', { questionId, part: 0, options: [0, 1] }))).toMatchObject({ code: 'bad_request', reason: 'single-select' });
    expect(await refusal(amy.conn.request('question.vote', { questionId, part: 1, options: [3] }))).toMatchObject({ code: 'bad_request', reason: 'unknown-option' });
    await waitFor(() => leo.got('question.changed').filter((change) => change.questionId === questionId && change.vote !== undefined).length === 6, { what: 'the six votes at the Viewer' });
    expect(leo.got('question.changed').filter((change) => change.vote !== undefined).map((change) => `${change.vote?.displayName} ${change.vote?.part}: ${change.vote?.other ?? change.vote?.options?.join(',')}`)).toEqual([
      'Ian 0: 0',
      'Mei 0: 1',
      `Amy 0: ${AMY_OTHER}`,
      'Ian 1: 0,1',
      'Mei 1: 0',
      'Amy 1: 0,2',
    ]);
    // Everyone has voted: the vote items are gone, the decider's item is unread again and names no leader (a tie).
    await inboxWithout(ian, (item) => item.key === `vote:${questionId}`, 'the vote item');
    await inboxWithout(amy, (item) => item.key === `vote:${questionId}`, 'the vote item');
    const tied = await inboxItem(mei, (item) => item.key === `question:${questionId}` && item.allVoted === true, 'the question with every vote');
    expect(tied).toMatchObject({ voted: 3, eligible: 3, allVoted: true, unread: true });
    expect(tied.leading).toBeUndefined();

    // ---- Amy comments and mentions Leo: the comment is for the team, the mention is in Leo's inbox
    const { commentId } = await amy.conn.request('question.comment', { questionId, text: AMY_COMMENT, mentions: [LEO] });
    await waitFor(() => leo.got('question.changed').some((change) => change.comment?.id === commentId), { what: 'the comment at the Viewer' });
    expect(leo.got('question.changed').find((change) => change.comment !== undefined)?.comment).toMatchObject({ id: commentId, from: { userId: AMY, displayName: 'Amy' }, text: AMY_COMMENT, mentions: [LEO] });
    const mention = await inboxItem(leo, (item) => item.kind === 'mention', 'the mention');
    expect(mention).toMatchObject({ kind: 'mention', unread: true, waiting: false, sessionId, from: { kind: 'user', userId: AMY }, target: { kind: 'session', sessionId }, anchor: { cardId: questionId }, excerpt: AMY_COMMENT });
    // The Viewer cannot comment.
    expect(await refusal(leo.conn.request('question.comment', { questionId, text: 'me too' }))).toMatchObject({ code: 'forbidden' });

    // ---- who may submit: not the Editor (she is not the decider), not the Viewer; an Editor never in her own words
    expect(await refusal(amy.conn.request('question.submit', { questionId, answers: [{ options: [0] }, { options: [0] }] }))).toMatchObject({ code: 'forbidden', reason: 'not-decider' });
    expect(await refusal(leo.conn.request('question.submit', { questionId, answers: [{ options: [0] }, { options: [0] }] }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(mei.conn.request('question.submit', { questionId, answers: [{ options: [0] }] }))).toMatchObject({ code: 'bad_request', reason: 'incomplete' });
    // Nothing reached the agent while people voted and talked.
    expect(await answersGiven(flow, sessionId)).toEqual([]);

    // ---- the decider submits: the server for the cart (against her own vote), and her own words for the checks ("Other")
    const { question: answered } = await mei.conn.request('question.submit', { questionId, answers: [{ options: [0] }, { other: 'Unit tests and the type check, on every push.' }], note: 'Keep it fast.' });
    expect(answered).toMatchObject({
      status: 'answered',
      answer: { parts: [{ options: [0] }, { other: 'Unit tests and the type check, on every push.' }], note: 'Keep it fast.', by: { userId: MEI }, tally: [[1, 1, 1], [3, 1, 1, 0]] },
    });
    expect(answered.answer?.onBehalfOf).toBeUndefined();
    for (const member of everyone) expect(await questionAt(member, (question) => question.id === questionId && question.status === 'answered', 'the answered question')).toMatchObject({ answer: { by: { userId: MEI } } });
    // A late answer after the settle is refused: a vote, a comment and a second submit alike.
    expect(await refusal(ian.conn.request('question.submit', { questionId, answers: [{ options: [1] }, { options: [1] }] }))).toMatchObject({ code: 'conflict', reason: 'settled', detail: { status: 'answered', by: { userId: MEI } } });
    expect(await refusal(amy.conn.request('question.vote', { questionId, part: 0, options: [0] }))).toMatchObject({ code: 'conflict', reason: 'settled' });
    expect(await refusal(amy.conn.request('question.comment', { questionId, text: 'too late' }))).toMatchObject({ code: 'conflict', reason: 'settled' });
    await inboxWithout(mei, (item) => item.key === `question:${questionId}`, 'the answered question');
    await turnsFinished(leo, sessionId, 2);

    // ---- what the agent got: its own labels, the decider's words, and a note of counts composed by the daemon
    const given = await answersGiven(flow, sessionId);
    expect(given).toHaveLength(1);
    expect(given[0]?.answers).toEqual({ [CART.question]: 'On the server', [CHECKS.question]: 'Unit tests and the type check, on every push.' });
    expect(given[0]?.annotations?.[CART.question]?.notes).toBe('Votes: On the server 1, In the browser 1, other 1 (3 of 3 members voted). Decided by Mei.\n[Note from Mei: Keep it fast.]');
    expect(given[0]?.annotations?.[CHECKS.question]?.notes).toBe('Votes: Unit tests 3, Type check 1, Lint, format 1, other 0 (3 of 3 members voted). Decided by Mei.\n[Note from Mei: Keep it fast.]');
    // The mention stays until Leo opens it; opening it removes it.
    leo.conn.notify('inbox.seen', { keys: [mention.key] });
    await inboxWithout(leo, (item) => item.key === mention.key, 'the opened mention');

    // ================================================================================================================
    // An Editor's message is a suggestion: accepted by Mei it is Amy's message to the agent; rejected, a result for Amy
    // ================================================================================================================
    const before = leo.events(sessionId).length;
    const { suggestion } = await amy.conn.request('suggest.create', { sessionId, text: AMY_SUGGESTION });
    expect(suggestion).toMatchObject({ sessionId, status: 'pending', origin: 'composer', author: { userId: AMY, displayName: 'Amy' }, text: AMY_SUGGESTION });
    // A card in the conversation for everyone; an inbox item for who may accept (nobody responsible: Ian and Mei).
    await eventOf(leo, sessionId, (event) => event.kind === 'card' && event.card === 'suggestion' && event.id === suggestion.id, 'the suggestion card');
    for (const member of everyone) await waitFor(() => member.got('suggest.updated').some((update) => update.suggestion.id === suggestion.id), { what: `the suggestion at ${member.name}` });
    expect(await inboxItem(mei, (item) => item.kind === 'suggestion', 'the suggestion')).toMatchObject({ kind: 'suggestion', sessionId, from: { kind: 'user', userId: AMY }, excerpt: AMY_SUGGESTION, count: 1, anchor: { cardId: suggestion.id }, alsoFor: [{ userId: IAN }] });
    expect(await inboxItem(ian, (item) => item.kind === 'suggestion', 'the suggestion')).toMatchObject({ count: 1 });
    // A second one of the same author is the same inbox item, counted.
    const { suggestion: second } = await amy.conn.request('suggest.create', { sessionId, text: AMY_REJECTED });
    expect(await inboxItem(mei, (item) => item.kind === 'suggestion' && item.count === 2, 'both suggestions as one item')).toMatchObject({ anchor: { cardId: suggestion.id }, excerpt: AMY_SUGGESTION });
    // Nobody without agent access accepts; nothing of it is at the agent.
    expect(await refusal(amy.conn.request('suggest.accept', { suggestionId: suggestion.id }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(leo.conn.request('suggest.accept', { suggestionId: suggestion.id }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(leo.conn.request('suggest.create', { sessionId, text: 'me too' }))).toMatchObject({ code: 'forbidden' });
    expect(await told(flow, sessionId)).toEqual(['[Mei · Agent access]\nPlease run the tests.', '[Mei · Agent access]\nNow ask the team how to build it.']);
    expect(await everythingAgentsReceived(flow)).not.toContain('amy-');

    // ---- Mei accepts the first: only now it is a message of Amy's to the agent
    expect((await mei.conn.request('suggest.accept', { suggestionId: suggestion.id })).suggestion).toMatchObject({ status: 'accepted', decidedBy: { userId: MEI } });
    const accepted = await eventOf<Extract<ConversationEvent, { kind: 'message' }>>(leo, sessionId, (event) => event.kind === 'message' && event.suggestion?.id === suggestion.id, "Amy's message");
    expect(accepted).toMatchObject({ from: { userId: AMY, displayName: 'Amy', role: 'editor' }, text: AMY_SUGGESTION, suggestion: { id: suggestion.id, acceptedBy: { userId: MEI }, modified: false } });
    await turnsFinished(leo, sessionId, 3);
    expect((await told(flow, sessionId)).slice(2)).toEqual([`[Amy · Editor, suggestion accepted by Mei]\n${AMY_SUGGESTION}`]);
    expect(await refusal(ian.conn.request('suggest.reject', { suggestionId: suggestion.id }))).toMatchObject({ code: 'conflict' });

    // ---- Mei rejects the second: a result in Amy's inbox, nothing at the agent
    expect((await mei.conn.request('suggest.reject', { suggestionId: second.id, reason: 'We keep them.' })).suggestion).toMatchObject({ status: 'rejected', decidedBy: { userId: MEI }, rejectReason: 'We keep them.' });
    const result = await inboxItem(amy, (item) => item.kind === 'result', 'the result of the rejected suggestion');
    expect(result).toMatchObject({ kind: 'result', result: 'rejected', sessionId, from: { kind: 'user', userId: MEI }, anchor: { cardId: second.id }, unread: true, waiting: false });
    await inboxWithout(mei, (item) => item.kind === 'suggestion', 'the settled suggestions');
    await inboxWithout(ian, (item) => item.kind === 'suggestion', 'the settled suggestions');
    expect(await refusal(mei.conn.request('inbox.dismiss', { key: result.key }))).toMatchObject({ code: 'not_found' });
    await amy.conn.request('inbox.dismiss', { key: result.key });
    expect(await amy.inbox()).toEqual([]);
    expect(kinds(leo.events(sessionId).slice(before))).toEqual(['card:suggestion', 'card:suggestion', 'message', 'delivery', 'turn.started', 'text', 'turn.finished', 'delivery']);
    expect((await audited(flow, 'suggest.accept', 'suggest.reject')).map((entry) => `${entry.action} ${entry.actor.kind === 'user' ? entry.actor.userId : ''}`)).toEqual([`suggest.accept ${MEI}`, `suggest.reject ${MEI}`]);

    // ================================================================================================================
    // Escalation: Mei does not answer; after the waiting time the host submits for her
    // ================================================================================================================
    await mei.conn.request('session.message.send', { sessionId, text: 'Please ask about the release.' });
    const waiting = await questionAt(ian, (question) => question.status === 'open' && question.parts[0]?.text === RELEASE.question, 'the second question');
    expect(waiting).toMatchObject({ decider: { userId: MEI } });
    expect(waiting.escalatedAt).toBeUndefined();
    await inboxItem(mei, (item) => item.key === `question:${waiting.id}`, 'the question');
    // Before the waiting time: Ian is asked for a vote, not for the answer.
    expect(await inboxItem(ian, (item) => item.key === `vote:${waiting.id}`, 'the vote')).toMatchObject({ kind: 'vote' });
    expect((await ian.inbox()).some((item) => item.key === `question:${waiting.id}`)).toBe(false);
    // Amy proposes an answer in her own words: a vote, for the team.
    await amy.conn.request('question.vote', { questionId: waiting.id, part: 0, other: AMY_OTHER_PROPOSED });
    // A member with agent access who is not the decider cannot submit yet... (there is none besides Mei here; the Editor cannot at any time)
    expect(await refusal(amy.conn.request('question.submit', { questionId: waiting.id, answers: [{ options: [0] }] }))).toMatchObject({ code: 'forbidden', reason: 'not-decider' });

    // ---- five minutes pass (the host's setting `escalateAfterMs`)
    flow.advance(5 * 60_000 + 1_000);
    const escalated = await questionAt(leo, (question) => question.id === waiting.id && question.escalatedAt !== undefined, 'the escalated question');
    expect(escalated).toMatchObject({ status: 'open', decider: { userId: MEI } });
    // Now it is ALSO in the host's inbox, marked, and says whom it waits for; it stays in Mei's.
    expect(await inboxItem(ian, (item) => item.key === `question:${waiting.id}`, 'the escalated question')).toMatchObject({ kind: 'question', escalated: true, waiting: true, waitsFor: { userId: MEI }, waitsForOffline: false, alsoFor: [{ userId: MEI }] });
    expect((await ian.inbox()).some((item) => item.key === `vote:${waiting.id}`)).toBe(false);
    expect(await inboxItem(mei, (item) => item.key === `question:${waiting.id}` && item.escalated === true, 'the escalated question')).toMatchObject({ kind: 'question', escalated: true });
    // Still not an Editor's to answer.
    expect(await refusal(amy.conn.request('question.submit', { questionId: waiting.id, answers: [{ options: [0] }] }))).toMatchObject({ code: 'forbidden', reason: 'not-decider' });
    expect(await everythingAgentsReceived(flow)).not.toContain('amy-proposed');

    // ---- Ian submits for Mei, with the words Amy proposed: now they reach the agent, under her name
    const { question: forMei } = await ian.conn.request('question.submit', { questionId: waiting.id, answers: [{ other: AMY_OTHER_PROPOSED, otherBy: AMY }] });
    expect(forMei).toMatchObject({ status: 'answered', answer: { parts: [{ other: AMY_OTHER_PROPOSED, otherBy: { userId: AMY } }], by: { userId: IAN }, onBehalfOf: { userId: MEI } } });
    await eventOf(leo, sessionId, (event) => event.kind === 'line' && event.text.id === 'conversation.submittedFor', 'the line "submitted by Ian, Mei was away"');
    expect(leo.events(sessionId).find((event) => event.kind === 'line' && event.text.id === 'conversation.submittedFor')).toMatchObject({ text: { params: { by: 'Ian', name: 'Mei' } } });
    await inboxWithout(ian, (item) => item.sessionId === sessionId, 'the answered question');
    await inboxWithout(mei, (item) => item.sessionId === sessionId, 'the answered question');
    await turnsFinished(leo, sessionId, 4);
    const release = (await answersGiven(flow, sessionId))[1];
    expect(release?.answers).toEqual({ [RELEASE.question]: AMY_OTHER_PROPOSED });
    expect(release?.annotations?.[RELEASE.question]?.notes).toBe('Votes: Every week 0, When it is ready 0, other 1 (1 of 3 members voted). Decided by Ian.\n[The answer text was proposed by Amy (Editor).]');
    expect((await audited(flow, 'question.submit')).map((entry) => entry.detail)).toMatchObject([
      { questionId, escalated: false, answers: ['0', 'other'], note: 'Keep it fast.' },
      { questionId: waiting.id, escalated: true, onBehalfOf: MEI, otherBy: [AMY], other: AMY_OTHER_PROPOSED },
    ]);

    // ================================================================================================================
    // A responsible person: her requests are hers alone, until she does not answer
    // ================================================================================================================
    expect(await refusal(amy.conn.request('session.responsible.set', { sessionId, userId: AMY }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(mei.conn.request('session.responsible.set', { sessionId, userId: LEO }))).toMatchObject({ code: 'bad_request', reason: 'not-eligible' });

    // ---- an Editor can be responsible: the session's questions are hers to decide, among the agent's own options
    expect((await mei.conn.request('session.responsible.set', { sessionId, userId: AMY })).session).toMatchObject({ responsible: { userId: AMY, displayName: 'Amy' } });
    await mei.conn.request('session.message.send', { sessionId, text: 'Please ask about the colour.' });
    const colour = await questionAt(leo, (question) => question.status === 'open' && question.parts[0]?.text === COLOUR.question, 'the third question');
    expect(colour.decider).toMatchObject({ userId: AMY });
    // It is in her inbox and in nobody else's (somebody is responsible: nobody is asked for a vote by the inbox).
    expect(await inboxItem(amy, (item) => item.key === `question:${colour.id}`, 'the question she decides')).toMatchObject({ kind: 'question', waiting: true });
    expect((await mei.inbox()).some((item) => item.sessionId === sessionId)).toBe(false);
    expect((await ian.inbox()).some((item) => item.sessionId === sessionId)).toBe(false);
    // Mei has agent access but is not the decider: not hers to submit yet. Amy cannot answer in her own words.
    expect(await refusal(mei.conn.request('question.submit', { questionId: colour.id, answers: [{ options: [1] }] }))).toMatchObject({ code: 'forbidden', reason: 'not-decider' });
    expect(await refusal(amy.conn.request('question.submit', { questionId: colour.id, answers: [{ other: 'Purple' }] }))).toMatchObject({ code: 'forbidden', reason: 'other-needs-agent-access' });
    expect(await refusal(amy.conn.request('question.submit', { questionId: colour.id, answers: [{ options: [1] }], note: 'Because.' }))).toMatchObject({ code: 'forbidden', reason: 'other-needs-agent-access' });
    // Amy does not answer. After the waiting time it is ALSO the host's and the other member's with agent access.
    flow.advance(5 * 60_000 + 1_000);
    await questionAt(leo, (question) => question.id === colour.id && question.escalatedAt !== undefined, 'the escalated third question');
    for (const member of [ian, mei]) expect(await inboxItem(member, (item) => item.key === `question:${colour.id}`, 'the escalated question')).toMatchObject({ kind: 'question', escalated: true, waitsFor: { userId: AMY }, waitsForOffline: false });
    expect(await inboxItem(amy, (item) => item.key === `question:${colour.id}` && item.escalated === true, 'her escalated question')).toMatchObject({ alsoFor: [{ userId: IAN }, { userId: MEI }] });
    // "Submit for Amy": Mei does, without becoming responsible.
    const { question: forAmy } = await mei.conn.request('question.submit', { questionId: colour.id, answers: [{ options: [1] }] });
    expect(forAmy).toMatchObject({ status: 'answered', answer: { parts: [{ options: [1] }], by: { userId: MEI }, onBehalfOf: { userId: AMY } } });
    for (const member of [ian, mei, amy]) await inboxWithout(member, (item) => item.key === `question:${colour.id}`, 'the answered third question');
    await turnsFinished(leo, sessionId, 5);
    expect(leo.events(sessionId).filter((event) => event.kind === 'line' && event.text.id === 'conversation.submittedFor').at(-1)).toMatchObject({ text: { params: { by: 'Mei', name: 'Amy' } } });
    expect((await ian.conn.request('session.list', {})).sessions.find((entry) => entry.id === sessionId)).toMatchObject({ responsible: { userId: AMY } });

    // ---- a responsible member with agent access: her session's permission requests are hers alone, at first
    expect((await mei.conn.request('session.responsible.set', { sessionId, userId: MEI })).session).toMatchObject({ responsible: { userId: MEI, displayName: 'Mei' } });
    await waitFor(() => leo.got('session.state').some((update) => update.session.id === sessionId && update.session.kind === 'agent' && update.session.responsible?.userId === MEI), { what: 'the responsible person at the Viewer' });
    await mei.conn.request('session.message.send', { sessionId, text: 'Please deploy it.' });
    const deploy = await permissionAt(leo, (request) => request.command === './deploy.sh staging', 'the deploy request');
    expect(deploy).toMatchObject({ status: 'open', noAlways: 'no-suggestion' });
    const deployKey = `permission:${deploy.id}`;
    // Mei is responsible and may allow: the request is in her inbox only (the host sees the card, as every watcher).
    const mine = await inboxItem(mei, (item) => item.key === deployKey, 'the deploy request');
    expect(mine).toMatchObject({ kind: 'permission', excerpt: './deploy.sh staging' });
    expect(mine.alsoFor).toBeUndefined();
    await permissionAt(ian, (request) => request.id === deploy.id, 'the deploy card');
    expect((await ian.inbox()).some((item) => item.key === deployKey)).toBe(false);
    // The waiting time passes: now it is also the host's, and says whom it waited for.
    flow.advance(5 * 60_000 + 1_000);
    expect(await permissionAt(leo, (request) => request.id === deploy.id && request.escalatedAt !== undefined, 'the escalated request')).toMatchObject({ status: 'open' });
    expect(await inboxItem(ian, (item) => item.key === deployKey, 'the escalated request')).toMatchObject({ kind: 'permission', escalated: true, waitsFor: { userId: MEI }, alsoFor: [{ userId: MEI }] });
    expect((await ian.conn.request('permission.decide', { requestId: deploy.id, decision: 'allow' })).request).toMatchObject({ status: 'allowed', decision: { by: { userId: IAN } } });
    await inboxWithout(mei, (item) => item.key === deployKey, 'the allowed request');
    await turnsFinished(leo, sessionId, 6);
    await statusIs(leo, sessionId, 'idle');

    // ================================================================================================================
    // A turn is stopped while a card is open: the card is withdrawn for everyone
    // ================================================================================================================
    await mei.conn.request('session.message.send', { sessionId, text: 'Please clean up.' });
    const stopped = await permissionAt(amy, (request) => request.command === 'rm -rf build', 'the request of the turn that is stopped');
    await inboxItem(mei, (item) => item.key === `permission:${stopped.id}`, 'the request');
    expect(await refusal(amy.conn.request('session.interrupt', { sessionId }))).toMatchObject({ code: 'forbidden' });
    await mei.conn.request('session.interrupt', { sessionId });
    for (const member of everyone) expect(await permissionAt(member, (request) => request.id === stopped.id && request.status === 'withdrawn', 'the withdrawn card')).toMatchObject({ withdrawn: { reason: 'stopped' } });
    await inboxWithout(mei, (item) => item.key === `permission:${stopped.id}`, 'the withdrawn request');
    expect(await refusal(mei.conn.request('permission.decide', { requestId: stopped.id, decision: 'allow' }))).toMatchObject({ code: 'conflict', reason: 'settled', detail: { status: 'withdrawn' } });
    await turnsFinished(leo, sessionId, 7);
    await statusIs(leo, sessionId, 'idle');
    const lastTurn = leo.events(sessionId).slice(leo.events(sessionId).findLastIndex((event) => event.kind === 'message'));
    // (the stand-in gives no result for a call whose request was withdrawn: the tool card has no end, the turn has)
    expect(kinds(lastTurn)).toEqual(['message', 'delivery', 'turn.started', 'tool.started', 'card:permission', 'line', 'turn.finished', 'delivery']);
    expect(lastTurn.find((event) => event.kind === 'line')).toMatchObject({ text: { id: 'conversation.stopped', params: { name: 'Mei' } } });
    expect(lastTurn.find((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'interrupted' });
    // The command never ran, and the text after it was never said.
    expect(JSON.stringify(lastTurn)).not.toContain('never said');

    // ================================================================================================================
    // The agent's process starts again: the session's remembered rule is in what the new process is started with
    // ================================================================================================================
    const cardsBefore = leo.got('permission.updated').length;
    // (Asked for here; the same happens by itself when a session has been idle for a while.)
    await mei.conn.request('session.restart', { sessionId });
    await mei.conn.request('session.message.send', { sessionId, text: 'Please run them once more.' });
    await turnsFinished(leo, sessionId, 8);
    await statusIs(leo, sessionId, 'idle');
    const starts = (await flow.claude.echoed()).filter((entry) => entry.session === sessionId && (entry.kind === 'argv' || entry.kind === 'settings'));
    const lastArgv = starts.filter((entry) => entry.kind === 'argv').at(-1)?.value as string[];
    const lastSettings = starts.filter((entry) => entry.kind === 'settings').at(-1)?.value as { permissions?: { allow?: string[] } };
    expect(starts.filter((entry) => entry.kind === 'argv').length).toBeGreaterThanOrEqual(2);
    // The same Claude conversation, resumed; the rule Mei added is one of the new process's own allow rules.
    expect(lastArgv).toContain('--resume');
    expect(lastSettings.permissions?.allow).toContain('Bash(pnpm test *)');
    // So the command of that kind ran without a card.
    expect(leo.got('permission.updated')).toHaveLength(cardsBefore);
    expect(leo.events(sessionId).filter((event) => event.kind === 'tool.started').at(-1)).toMatchObject({ tool: { name: 'Bash', target: 'pnpm test --watch=false' } });
    expect((await told(flow, sessionId)).at(-1)).toBe('[Mei · Agent access]\nPlease run them once more.');

    // ================================================================================================================
    // In the end: what an agent received of Amy's words, and what the Viewer saw and could not do
    // ================================================================================================================
    // Of everything Amy wrote, the agent got exactly what Mei accepted and what Ian submitted: never the comment, the
    // "Other" vote nobody submitted, or the rejected suggestion.
    const received = await everythingAgentsReceived(flow);
    expect(received).toContain('amy-suggestion-7f31');
    expect(received).toContain('amy-proposed-19c3');
    for (const never of ['amy-rejected-52c9', 'amy-comment-a0d4', 'amy-other-e8b6']) expect(received).not.toContain(never);
    // The Viewer received the whole conversation, event for event what the host received; the page reads the same.
    expect(leo.events(sessionId)).toEqual(ian.events(sessionId));
    const page = await leo.conn.request('session.watch', { sessionId });
    expect(page.events).toEqual(leo.events(sessionId));
    expect(open(page.questions)).toEqual([]);
    expect(open(page.permissions)).toEqual([]);
    // An earlier page comes with the cards it points to, settled as they are; one card can be read by itself.
    const history = await leo.conn.request('session.history', { sessionId, afterSeq: 0, limit: 30 });
    expect(history.events).toEqual(page.events.slice(0, 30));
    expect(history.permissions.map((request) => `${request.command} ${request.status}`)).toEqual(['pnpm test allowed', 'pnpm test --coverage allowed', 'npx cowsay done denied']);
    expect((await leo.conn.request('session.cards.get', { sessionId, cards: [{ kind: 'question', id: questionId }, { kind: 'suggestion', id: second.id }] }))).toMatchObject({
      questions: [{ id: questionId, status: 'answered', votes: [{ userId: IAN }, { userId: MEI }, { userId: AMY }, { userId: IAN }, { userId: MEI }, { userId: AMY }], comments: [{ id: commentId, text: AMY_COMMENT }] }],
      suggestions: [{ id: second.id, status: 'rejected' }],
      permissions: [],
    });
    // ... and every request of his that would change something was refused.
    for (const attempt of [
      leo.conn.request('session.interrupt', { sessionId }),
      leo.conn.request('session.rename', { sessionId, title: 'Mine' }),
      leo.conn.request('session.end', { sessionId }),
      leo.conn.request('session.mode.set', { sessionId, mode: 'ask-commands' }),
      leo.conn.request('session.responsible.set', { sessionId, userId: LEO }),
      leo.conn.request('session.rule.remove', { sessionId, ruleId: 'rule_x' }),
      leo.conn.request('session.restart', { sessionId }),
      leo.conn.request('question.remind', { questionId }),
    ]) {
      expect(await refusal(attempt)).toMatchObject({ code: 'forbidden' });
    }
    expect((await ian.conn.request('session.list', {})).sessions.find((entry) => entry.id === sessionId)).toMatchObject({ title: 'Tests', status: 'idle', responsible: { userId: MEI }, permissionMode: 'ask-all' });
  });
});
