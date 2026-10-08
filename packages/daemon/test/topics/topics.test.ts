// Topics (design §3.7, §3.9, §4.1, §4.2): creating, the discussion session and its loss, renaming, the kinds of
// commands always allowed in a topic, hand edits of the two files, archive and delete, and what goes with a member.
// The REAL topics module in a test daemon; every other service is a fake the test drives.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, SmurgError, topicSchema, topicPlanPath, topicSpecPath, unmergedWorktreesOfError, type Topic } from '@smurg/protocol';
import { buildMergeRequest, buildQuestion, recordActivity } from '../../src/core/fakes/index.ts';
import { PathDeniedError, type PathDeniedReason } from '../../src/core/errors.ts';
import type { DaemonEvents, PathGuard } from '../../src/core/interfaces.ts';
import { SPEC_TEXT, createTopic, lineIds, planText, settle, setupTopics, smurgSent, startPlan, topicWithPlan, waitFor, type TopicsTest } from './support.ts';

let test: TopicsTest;
afterEach(async () => {
  await test?.cleanup();
});

async function refusal(promise: Promise<unknown>): Promise<SmurgError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SmurgError) return err;
    throw err;
  }
  throw new Error('expected the request to be refused');
}

/** Makes the path guard refuse the next `times` reads of one file of the main workspace, as it does on the host's disk. */
function refuseReads(of: TopicsTest, path: string, reason: PathDeniedReason, times: number): { count: number; read: number; restore(): void } {
  const paths = of.t.ctx.paths as { readFile: PathGuard['readFile'] };
  const real = paths.readFile;
  const seen = {
    count: 0,
    read: 0,
    restore: () => {
      paths.readFile = real;
    },
  };
  paths.readFile = async (ref, options) => {
    if (ref.path !== path) return real.call(paths, ref, options);
    if (seen.count < times) {
      seen.count += 1;
      throw new PathDeniedError(reason, path);
    }
    seen.read += 1;
    return real.call(paths, ref, options);
  };
  return seen;
}

describe('T1.1 a topic and its discussion session', () => {
  it('a member with agent access creates a topic: its folder, its discussion session with the opening line and the first message; everyone sees it', async () => {
    test = await setupTopics();
    const seenByAmy: Topic[] = [];
    test.amy.conn.on('topic.updated', (payload) => seenByAmy.push(payload.topic));
    const order: string[] = [];
    test.t.ctx.bus.on('topic.changed', (event: DaemonEvents['topic.changed']) => order.push(`topic:${event.previous === null ? 'new' : 'changed'}:${event.topic.discussionSessionId === undefined ? 'no-session' : 'session'}`));
    test.t.ctx.bus.on('session.created', () => order.push('session.created'));

    const { topic, session } = await createTopic(test, 'Checkout', 'We need a checkout page.');

    expect(topicSchema.safeParse(topic).success).toBe(true);
    expect(topic).toMatchObject({ name: 'Checkout', slug: 'checkout', phase: 'discussing', archived: false, discussion: 'live', discussionSessionId: session.id, createdBy: { userId: 'dev:mei', displayName: 'Mei' } });
    expect(topic.spec).toEqual({ exists: false });
    expect(topic.plan).toMatchObject({ exists: false, valid: false, generating: false, mode: 'assigned', paused: false, items: 0 });
    expect(session).toMatchObject({ kind: 'agent', purpose: 'discussion', topicId: topic.id, topicName: 'Checkout', openedBy: { userId: 'dev:mei' }, responsible: null, root: MAIN_ROOT, modeFixed: true });
    // A topic's session has no title of its own: clients name it from its purpose.
    expect(session.title).toBeUndefined();
    expect(existsSync(join(test.t.root, 'specs/checkout'))).toBe(true);

    // The topic is announced BEFORE its session exists, then again with it.
    expect(order).toEqual(['topic:new:no-session', 'session.created', 'topic:changed:session']);

    const start = test.fakes.agents.log.of('start')[0]?.[0] as { purpose: string; mode: string; title?: string; topic: unknown; workspace: unknown };
    expect(start).toMatchObject({ purpose: 'discussion', mode: 'ask-all', topic: { id: topic.id, slug: 'checkout', name: 'Checkout' }, workspace: { mode: 'main' } });
    expect(start.title).toBeUndefined();
    const prompt = test.fakes.agents.rolePromptOf(session.id);
    expect(prompt.rolePrompt).toContain('You are the discussion agent of one topic in a shared smurg workspace. The topic\'s files are in specs/checkout/.');
    expect(prompt.rolePrompt).toContain(`"[smurg ${prompt.smurgTag}]"`);

    const events = test.fakes.agents.eventsOf(session.id);
    expect(events[0]).toMatchObject({ kind: 'line', text: { id: 'conversation.started.discussion', params: { name: 'Mei' } } });
    expect(events[1]).toMatchObject({ kind: 'message', from: { userId: 'dev:mei', role: 'agent' }, text: 'We need a checkout page.', origin: 'composer' });

    // Everyone sees it: the Editor got the event and finds it in the list.
    await waitFor(() => seenByAmy.some((seen) => seen.discussionSessionId === session.id), { what: 'topic.updated to reach the editor' });
    const listed = await test.amy.conn.request('topic.list', {});
    expect(listed).toEqual({ topics: [test.topic(topic.id)], hasMore: false });
    expect((await test.amy.conn.request('session.list', { topicId: topic.id })).sessions.map((entry) => entry.id)).toEqual([session.id]);
    expect(await test.audit('topic.create')).toMatchObject([{ actor: { kind: 'user', userId: 'dev:mei' }, outcome: 'ok', detail: { topicId: topic.id, slug: 'checkout', name: 'Checkout' } }]);
    expect(test.t.ctx.services.topics.bySession(session.id)?.id).toBe(topic.id);
  });

  it('an Editor cannot create one', async () => {
    test = await setupTopics();
    expect(await refusal(test.amy.conn.request('topic.create', { name: 'Checkout' }))).toMatchObject({ code: 'forbidden' });
    expect(test.t.ctx.services.topics.list({}).topics).toEqual([]);
  });

  it('the slug comes from the name; a name without three slug characters gets topic-<n>; a taken slug or an existing folder is refused', async () => {
    test = await setupTopics();
    expect((await createTopic(test, 'Payment Flow v2')).topic.slug).toBe('payment-flow-v2');
    // A name in Chinese gives no slug characters.
    expect((await createTopic(test, '結帳')).topic.slug).toBe('topic-1');
    expect((await test.mei.conn.request('topic.create', { name: 'Anything', slug: 'my-folder' })).topic.slug).toBe('my-folder');
    expect(await refusal(test.mei.conn.request('topic.create', { name: 'Other', slug: 'my-folder' }))).toMatchObject({ code: 'conflict', text: { id: 'topic.slugTaken' } });
    await mkdir(join(test.t.root, 'specs/legacy'), { recursive: true });
    expect(await refusal(test.mei.conn.request('topic.create', { name: 'Legacy' }))).toMatchObject({ code: 'conflict', text: { id: 'topic.folderExists', params: { path: 'specs/legacy' } } });
    expect(test.t.ctx.services.topics.list({}).topics.map((topic) => topic.slug)).toEqual(['payment-flow-v2', 'topic-1', 'my-folder']);
  });

  it('when the discussion cannot start there is no topic: the name and the folder are free again', async () => {
    test = await setupTopics();
    const removed: string[] = [];
    test.host.conn.on('topic.removed', (payload) => removed.push(payload.topicId));
    test.fakes.agents.failNextStart = new SmurgError('conflict', undefined, { reason: 'not-logged-in' });
    expect(await refusal(createTopic(test, 'Checkout'))).toMatchObject({ code: 'conflict', detail: { reason: 'not-logged-in' } });
    expect(test.t.ctx.services.topics.list({}).topics).toEqual([]);
    expect(existsSync(join(test.t.root, 'specs/checkout'))).toBe(false);
    await waitFor(() => removed.length === 1, { what: 'topic.removed' });
    expect((await createTopic(test, 'Checkout')).topic.slug).toBe('checkout');
  });

  it('renaming keeps the folder and relabels every session of the topic', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const renamed = (await test.mei.conn.request('topic.rename', { topicId: topic.id, name: 'Checkout v2' })).topic;
    expect(renamed).toMatchObject({ name: 'Checkout v2', slug: 'checkout' });
    expect(test.fakes.agents.get(session.id)?.topicName).toBe('Checkout v2');
    expect(await refusal(test.amy.conn.request('topic.rename', { topicId: topic.id, name: 'Mine' }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(test.mei.conn.request('topic.rename', { topicId: 'tp_unknown', name: 'X' }))).toMatchObject({ code: 'not_found', text: { id: 'topic.notFound' } });
  });
});

describe('the spec of a topic', () => {
  it('"Write the spec now" tells the agent, with a line that names who asked; the first draft makes the phase `spec` with a pointer and who asked', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test, 'Checkout', 'A checkout, please.');
    await test.mei.conn.request('topic.spec.request', { topicId: topic.id });
    expect(lineIds(test, session.id)).toEqual(['conversation.started.discussion', 'conversation.specRequested']);
    expect(smurgSent(test, session.id)).toMatchObject([{ purpose: 'write-spec', by: { userId: 'dev:mei' }, text: 'Write the first draft of the spec now, from what was discussed so far. List what is still undecided under Open questions.' }]);
    expect((await test.audit('topic.spec.request'))[0]).toMatchObject({ detail: { topicId: topic.id } });

    // The agent writes the file with its edit tool and ends its turn.
    const specPath = topicSpecPath(topic.slug);
    const turn = test.fakes.agents.startTurn(session.id);
    expect(turn).toBeTruthy();
    await writeFile(join(test.t.root, specPath), SPEC_TEXT);
    const seq = test.fakes.agents.edit(session.id, { root: MAIN_ROOT, path: specPath });
    test.fakes.agents.finishTurn(session.id, { finalText: 'The draft is ready.' });
    await waitFor(() => test.topic(topic.id).phase === 'spec', { what: 'the phase to become spec' });

    const after = test.topic(topic.id);
    expect(after.spec.exists).toBe(true);
    expect(after.spec.changedBy).toMatchObject({ kind: 'agent', sessionId: session.id });
    // "Changed by Claude, asked by Mei · Show in the discussion": the edit's tool card and who asked.
    expect(after.spec.lastAgentChange).toMatchObject({ sessionId: session.id, seq, askedBy: { userId: 'dev:mei', displayName: 'Mei' } });
    // The agent's own edit is not a hand edit.
    expect(after.handEdits).toEqual({ spec: [], plan: [] });
    await waitFor(() => test.fakes.agents.eventsOf(session.id).some((event) => event.kind === 'pointer'), { what: 'the pointer event' });
    expect(test.fakes.agents.eventsOf(session.id).at(-1)).toMatchObject({ kind: 'pointer', target: 'spec', topicId: topic.id });
  });

  it('the spec is gone again: the phase is `discussing` again', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    await test.write(topicSpecPath(topic.slug), SPEC_TEXT);
    await waitFor(() => test.topic(topic.id).phase === 'spec', { what: 'spec' });
    await test.write(topicSpecPath(topic.slug), '   \n');
    await waitFor(() => test.topic(topic.id).phase === 'discussing', { what: 'an empty spec is no spec' });
    await test.write(topicSpecPath(topic.slug), SPEC_TEXT);
    await waitFor(() => test.topic(topic.id).phase === 'spec', { what: 'spec again' });
    await test.remove(topicSpecPath(topic.slug));
    await waitFor(() => test.topic(topic.id).phase === 'discussing', { what: 'discussing' });
  });

  it('a read that meets the spec while a save replaces it is made again: the spec is not taken for a missing one', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    const specPath = topicSpecPath(topic.slug);
    await test.write(specPath, SPEC_TEXT);
    await waitFor(() => test.topic(topic.id).phase === 'spec', { what: 'spec' });

    // What the path guard says when the file was replaced between its look and its open (an editor's save).
    const refused = refuseReads(test, specPath, 'changed', 2);
    await test.write(specPath, `${SPEC_TEXT}\nOne more line.\n`);
    await waitFor(() => refused.count === 2 && refused.read > 0, { what: 'the read to be made again' });
    await settle(test);
    expect(test.topic(topic.id)).toMatchObject({ phase: 'spec', spec: { exists: true } });
    expect(test.fakes.agents.log.of('start')).toHaveLength(1);
  });

  it('a spec that is replaced at every look is no spec for this read, and a refusal of another kind is not asked twice', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    const specPath = topicSpecPath(topic.slug);
    await test.write(specPath, SPEC_TEXT);
    await waitFor(() => test.topic(topic.id).phase === 'spec', { what: 'spec' });

    const always = refuseReads(test, specPath, 'changed', Number.POSITIVE_INFINITY);
    await test.write(specPath, `${SPEC_TEXT}\nOne more line.\n`);
    await waitFor(() => test.topic(topic.id).phase === 'discussing', { what: 'no spec that could be read' });
    // The first look and four more, then it gives up (no endless loop on a file that never holds still).
    expect(always.count).toBe(5);
    always.restore();

    await test.write(specPath, SPEC_TEXT);
    await waitFor(() => test.topic(topic.id).phase === 'spec', { what: 'spec again' });
    const link = refuseReads(test, specPath, 'symlink', Number.POSITIVE_INFINITY);
    await test.write(specPath, `${SPEC_TEXT}\nAnd another.\n`);
    await waitFor(() => test.topic(topic.id).phase === 'discussing', { what: 'a refused spec is no spec' });
    expect(link.count).toBe(1);
  });

  it('"Ask the agent to revise" is a message of a member with agent access and a suggestion of an Editor, both composed by the conversation module', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const sent = await test.mei.conn.request('topic.revise', { topicId: topic.id, target: 'spec', text: 'Say who pays', quote: { heading: 'Cart rules', text: 'The cart is free.' } });
    expect(sent).toHaveProperty('messageId');
    const asked = test.fakes.conversation.log.of('sendAs').at(-1) as unknown[];
    expect(asked[1]).toEqual({ sessionId: session.id, text: 'Say who pays', origin: 'revise', target: 'spec', topicId: topic.id, quote: { heading: 'Cart rules', text: 'The cart is free.' } });
    expect(test.fakes.agents.sentTo(session.id).at(-1)).toMatchObject({ kind: 'person', origin: 'revise', text: 'About SPEC.md, section "Cart rules":\n```text\nThe cart is free.\n```\nSay who pays' });

    const suggested = await test.amy.conn.request('topic.revise', { topicId: topic.id, target: 'plan', text: 'Split item 2' });
    expect(suggested).toMatchObject({ suggestion: { author: { userId: 'dev:amy' }, origin: 'revise', topicId: topic.id, sessionId: session.id, status: 'pending' } });
    // Not one byte of it reached the agent.
    expect(test.fakes.agents.sentTo(session.id).some((message) => message.kind === 'person' && message.text.includes('Split item 2'))).toBe(false);
  });

  it('while people type in the spec the agent waits: one notice says who holds it, until the agent got its turn', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const file = { root: MAIN_ROOT, path: topicSpecPath(topic.slug) };
    const holder = { kind: 'human' as const, file, holders: [{ userId: 'dev:amy', displayName: 'Amy', lastActivityAt: 1 }], acquiredAt: 1 };
    const denied = { sessionId: session.id, ownerUserId: 'dev:mei', tool: 'Edit', file, outcome: 'denied' as const, holder };
    test.t.ctx.bus.emit('agent.tool.pre', denied as DaemonEvents['agent.tool.pre']);
    test.t.ctx.bus.emit('agent.tool.pre', denied as DaemonEvents['agent.tool.pre']);
    const notices = (): unknown[] => test.fakes.agents.eventsOf(session.id).filter((event) => event.kind === 'notice');
    expect(notices()).toMatchObject([{ level: 'info', text: { id: 'conversation.locked.spec', params: { path: 'specs/checkout/SPEC.md', holders: ['Amy'] } } }]);
    test.t.ctx.bus.emit('agent.tool.pre', { sessionId: session.id, ownerUserId: 'dev:mei', tool: 'Edit', file, outcome: 'granted' });
    test.t.ctx.bus.emit('agent.tool.pre', denied as DaemonEvents['agent.tool.pre']);
    expect(notices()).toHaveLength(2);
  });
});

describe('S3 handEdits per write path', () => {
  it('every write of the two files that was not the discussion agent\'s is listed with who made it; a change no member made through smurg is `outside`', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const spec = { root: MAIN_ROOT, path: topicSpecPath(topic.slug) };
    const plan = { root: MAIN_ROOT, path: topicPlanPath(topic.slug) };
    const amy = { kind: 'user' as const, userId: 'dev:amy', displayName: 'Amy' };
    const mei = { kind: 'user' as const, userId: 'dev:mei', displayName: 'Mei' };
    const discussion = test.fakes.agents.agentActor(session.id);

    // typing in the editor, file.write / create, an upload, a delete
    recordActivity(test.t.ctx, { actor: amy, kind: 'human.edit', file: spec, at: 100 });
    recordActivity(test.t.ctx, { actor: mei, kind: 'file.create', file: spec, at: 110 });
    recordActivity(test.t.ctx, { actor: amy, kind: 'file.upload', file: plan, at: 120 });
    recordActivity(test.t.ctx, { actor: mei, kind: 'file.delete', file: plan, at: 130 });
    // a rename INTO place, and one AWAY from it
    recordActivity(test.t.ctx, { actor: amy, kind: 'file.rename', file: spec, renamedFrom: 'specs/checkout/draft.md', at: 140 });
    recordActivity(test.t.ctx, { actor: { kind: 'user', userId: 'dev:host', displayName: 'Host' }, kind: 'file.rename', file: { root: MAIN_ROOT, path: 'specs/checkout/old-plan.md' }, renamedFrom: plan.path, at: 150 });
    // an outside program, and another agent session
    recordActivity(test.t.ctx, { actor: { kind: 'system' }, kind: 'external.change', file: spec, at: 160 });
    recordActivity(test.t.ctx, { actor: { kind: 'agent', sessionId: 'sess_other', ownerUserId: 'dev:mei', displayName: 'Claude (Other)' }, kind: 'agent.edit', file: plan, via: 'bash', at: 170 });
    // NOT hand edits: the discussion agent's own edit, a denied lock, another file of the folder, another root
    recordActivity(test.t.ctx, { actor: discussion, kind: 'agent.edit', file: spec, at: 180 });
    recordActivity(test.t.ctx, { actor: amy, kind: 'lock.denied', file: spec, at: 190 });
    recordActivity(test.t.ctx, { actor: amy, kind: 'human.edit', file: { root: MAIN_ROOT, path: 'specs/checkout/notes.md' }, at: 200 });
    recordActivity(test.t.ctx, { actor: amy, kind: 'human.edit', file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: spec.path }, at: 210 });

    const { handEdits } = test.topic(topic.id);
    // One entry per person, with the time of their newest edit.
    expect(handEdits.spec).toEqual([
      { by: { userId: 'dev:mei', displayName: 'Mei' }, at: 110 },
      { by: { userId: 'dev:amy', displayName: 'Amy' }, at: 140 },
      { by: 'outside', at: 160 },
    ]);
    expect(handEdits.plan).toEqual([
      { by: { userId: 'dev:amy', displayName: 'Amy' }, at: 120 },
      { by: { userId: 'dev:mei', displayName: 'Mei' }, at: 130 },
      { by: { userId: 'dev:host', displayName: 'Host' }, at: 150 },
      { by: 'outside', at: 170 },
    ]);
  });

  it('at most 20 per file: the oldest entry goes', async () => {
    test = await setupTopics({ members: false });
    const { topic } = await test.host.conn.request('topic.create', { name: 'Checkout' });
    for (let i = 0; i < 25; i += 1) recordActivity(test.t.ctx, { actor: { kind: 'user', userId: `dev:user${i}`, displayName: `User ${i}` }, kind: 'human.edit', file: { root: MAIN_ROOT, path: topicSpecPath(topic.slug) }, at: 1_000 + i });
    const edits = test.topic(topic.id).handEdits.spec;
    expect(edits).toHaveLength(20);
    expect(edits[0]).toEqual({ by: { userId: 'dev:user5', displayName: 'User 5' }, at: 1_005 });
  });
});

describe('T1.5 a topic survives the loss of its discussion session', () => {
  it('a crashed session is not lost: it continues with the next message', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    test.fakes.agents.fail(session.id);
    expect(test.topic(topic.id).discussion).toBe('live');
    expect(test.t.ctx.services.topics.attention()).toEqual([]);
    await test.mei.conn.request('topic.revise', { topicId: topic.id, target: 'spec', text: 'Go on' });
    test.fakes.agents.resume(session.id);
    expect(test.fakes.agents.get(session.id)?.status).toBe('idle');
    expect(test.topic(topic.id).discussion).toBe('live');
  });

  it('a session the host terminated, or one that failed to start three times, is lost; a restart gives the topic a new discussion and leaves the files alone', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    await test.write(topicSpecPath(topic.slug), SPEC_TEXT);
    await waitFor(() => test.topic(topic.id).phase === 'spec', { what: 'spec' });
    // The team decided something in the first discussion.
    test.fakes.conversation.putQuestion(
      buildQuestion({ id: 'q_cart', sessionId: session.id, status: 'answered', answer: { parts: [{ options: [0] }], by: { userId: 'dev:mei', displayName: 'Mei' }, at: 5, tally: [[2, 0, 0]] } }),
    );

    // Three failed starts in a row: only the host may retry, the discussion is lost.
    test.fakes.agents.fail(session.id);
    test.t.ctx.bus.emit('session.updated', { session: { ...(test.fakes.agents.get(session.id) as NonNullable<ReturnType<typeof test.fakes.agents.get>>), status: 'failed', retryHostOnly: true } });
    expect(test.topic(topic.id).discussion).toBe('lost');
    expect(test.t.ctx.services.topics.attention()).toMatchObject([{ subject: 'discussion-lost', id: topic.id, recipients: ['dev:host', 'dev:mei'], target: { kind: 'session', sessionId: session.id }, excerpt: 'Checkout' }]);
    // What needs the agent is refused with the sentence that offers the restart.
    expect(await refusal(test.mei.conn.request('topic.revise', { topicId: topic.id, target: 'spec', text: 'x' }))).toMatchObject({ code: 'conflict', text: { id: 'topic.noDiscussion' } });
    expect(await refusal(test.mei.conn.request('plan.generate', { topicId: topic.id }))).toMatchObject({ code: 'conflict', text: { id: 'topic.noDiscussion' } });
    expect(await refusal(test.mei.conn.request('topic.spec.request', { topicId: topic.id }))).toMatchObject({ code: 'conflict', text: { id: 'topic.noDiscussion' } });

    const restarted = await test.mei.conn.request('topic.discussion.restart', { topicId: topic.id });
    expect(restarted.session.id).not.toBe(session.id);
    expect(restarted.topic).toMatchObject({ discussion: 'live', discussionSessionId: restarted.session.id, phase: 'spec' });
    expect(test.t.ctx.services.topics.attention()).toEqual([]);
    // The old one is closed with a line and stays readable.
    expect(test.fakes.agents.get(session.id)).toMatchObject({ status: 'ended', endReason: 'replaced' });
    expect(lineIds(test, session.id)).toContain('conversation.discussion.replaced');
    // The new one opens with who restarted it and smurg's own first message, the earlier decisions quoted.
    const events = test.fakes.agents.eventsOf(restarted.session.id);
    expect(events[0]).toMatchObject({ kind: 'line', text: { id: 'conversation.discussion.restarted', params: { name: 'Mei' } } });
    const first = smurgSent(test, restarted.session.id)[0];
    expect(first).toMatchObject({ purpose: 'restart-discussion', by: { userId: 'dev:mei' } });
    expect(first?.text).toContain('This is a new conversation for a topic that already exists. Read specs/checkout/SPEC.md and specs/checkout/PLAN.md if they exist.');
    expect(first?.text).toMatch(/```quotation\nQuestion 1: Where is the cart kept\?\nAnswer: On the server\n```$/);
    // The folder, the files and the topic are untouched.
    expect(test.topic(topic.id).spec.exists).toBe(true);
    expect(existsSync(join(test.t.root, topicSpecPath(topic.slug)))).toBe(true);
    expect(test.t.ctx.services.topics.bySession(session.id)?.id).toBe(topic.id);
    expect((await test.audit('topic.discussion.restart'))[0]).toMatchObject({ detail: { topicId: topic.id, sessionId: restarted.session.id, replaced: session.id } });

    // Terminated by the host in the console: lost as well.
    await test.fakes.agents.end(restarted.session.id, { by: test.principals.host.actor, reason: 'terminated', keepWorktree: true });
    expect(test.topic(topic.id).discussion).toBe('lost');
  });

  it('"Start a fresh conversation" while the discussion is alive: the old one is replaced, not lost', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const restarted = await test.mei.conn.request('topic.discussion.restart', { topicId: topic.id });
    expect(test.fakes.agents.get(session.id)).toMatchObject({ status: 'ended', endReason: 'replaced' });
    // Ended by the system: no "X ended this session" line, only the replacement line.
    expect(lineIds(test, session.id)).toEqual(['conversation.started.discussion', 'conversation.discussion.replaced']);
    expect(restarted.topic.discussion).toBe('live');
    expect(await refusal(test.amy.conn.request('topic.discussion.restart', { topicId: topic.id }))).toMatchObject({ code: 'forbidden' });
  });
});

describe('kinds of commands always allowed in a topic', () => {
  it('only the two checked forms are remembered; removing one restarts the topic\'s sessions without it', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const added = (await test.mei.conn.request('topic.rule.add', { topicId: topic.id, tool: 'Bash', pattern: 'pnpm test *' })).topic;
    expect(added.rules).toMatchObject([{ tool: 'Bash', pattern: 'pnpm test *', scope: 'topic', addedBy: { userId: 'dev:mei' } }]);
    // The same rule again is the same rule.
    expect((await test.host.conn.request('topic.rule.add', { topicId: topic.id, tool: 'Bash', pattern: 'pnpm test *' })).topic.rules).toHaveLength(1);
    expect((await test.host.conn.request('topic.rule.add', { topicId: topic.id, tool: 'WebFetch', pattern: 'domain:example.com' })).topic.rules).toHaveLength(2);
    // An interpreter, something that fetches and runs code, a one-word pattern: never.
    for (const pattern of ['node *', 'pnpm add *', 'ls *']) {
      expect(await refusal(test.mei.conn.request('topic.rule.add', { topicId: topic.id, tool: 'Bash', pattern }))).toMatchObject({ code: 'bad_request', text: { id: 'rule.notAllowed' } });
    }
    expect(await refusal(test.amy.conn.request('topic.rule.add', { topicId: topic.id, tool: 'Bash', pattern: 'pnpm lint *' }))).toMatchObject({ code: 'forbidden' });
    expect(test.t.ctx.services.topics.rules(topic.id).map((rule) => rule.pattern)).toEqual(['pnpm test *', 'domain:example.com']);
    // The conversation module's "always allow in this topic" takes the same road.
    const remembered = await test.t.ctx.services.topics.rememberRule(topic.id, { tool: 'Bash', pattern: 'pnpm lint *' }, test.principals.mei);
    expect(remembered).toMatchObject({ scope: 'topic', pattern: 'pnpm lint *' });
    await expect(test.t.ctx.services.topics.rememberRule(topic.id, { tool: 'Bash', pattern: 'bash *' }, test.principals.mei)).rejects.toMatchObject({ code: 'bad_request' });

    const ruleId = added.rules[0]?.id as string;
    test.fakes.agents.log.clear();
    const after = (await test.mei.conn.request('topic.rule.remove', { topicId: topic.id, ruleId })).topic;
    expect(after.rules.map((rule) => rule.pattern)).toEqual(['domain:example.com', 'pnpm lint *']);
    expect(test.fakes.agents.log.of('restartProcess')).toEqual([[session.id, 'rules']]);
    expect(await refusal(test.mei.conn.request('topic.rule.remove', { topicId: topic.id, ruleId }))).toMatchObject({ code: 'not_found', text: { id: 'rule.notFound' } });
    expect((await test.audit('topic.rule.add')).map((entry) => entry.detail?.['rule'])).toEqual(['Bash(pnpm test *)', 'WebFetch(domain:example.com)', 'Bash(pnpm lint *)']);
    expect((await test.audit('topic.rule.remove'))[0]).toMatchObject({ actor: { kind: 'user', userId: 'dev:mei' }, detail: { rule: 'Bash(pnpm test *)' } });
  });

  it('a member who is kicked or loses agent access: the rules they added go with them, audited by the system', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    await test.mei.conn.request('topic.rule.add', { topicId: topic.id, tool: 'Bash', pattern: 'pnpm test *' });
    await test.host.conn.request('topic.rule.add', { topicId: topic.id, tool: 'Bash', pattern: 'pnpm lint *' });
    // Still Agent access: nothing goes.
    expect(test.t.ctx.services.topics.memberRemoved('dev:mei', 'role-changed', 'agent')).toEqual({ rules: [], disarmed: [] });
    expect(test.t.ctx.services.topics.memberRemoved('dev:mei', 'role-changed', 'editor')).toEqual({ rules: ['Bash(pnpm test *)'], disarmed: [] });
    expect(test.topic(topic.id).rules.map((rule) => rule.pattern)).toEqual(['pnpm lint *']);
    expect((await test.audit('topic.rule.remove'))[0]).toMatchObject({ actor: { kind: 'system' }, detail: { rule: 'Bash(pnpm test *)', addedBy: 'dev:mei' } });
  });
});

describe('archive and delete', () => {
  it('archiving ends the topic\'s sessions and makes it read-only; restoring needs a new discussion; deleting is for archived topics only', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const removedOnWire: string[] = [];
    test.amy.conn.on('topic.removed', (payload) => removedOnWire.push(payload.topicId));
    expect(await refusal(test.host.conn.request('topic.delete', { topicId: topic.id }))).toMatchObject({ code: 'conflict', text: { id: 'topic.delete.notArchived' } });

    const archived = (await test.mei.conn.request('topic.archive', { topicId: topic.id, archived: true })).topic;
    expect(archived.archived).toBe(true);
    expect(test.fakes.agents.get(session.id)).toMatchObject({ status: 'ended', endReason: 'archived', endedBy: { userId: 'dev:mei' } });
    expect((await test.amy.conn.request('topic.list', {})).topics).toEqual([]);
    expect((await test.amy.conn.request('topic.list', { archived: true })).topics.map((entry) => entry.id)).toEqual([topic.id]);
    // Read-only: no message, no rename, no rule, no plan.
    for (const attempt of [
      test.mei.conn.request('topic.rename', { topicId: topic.id, name: 'X' }),
      test.mei.conn.request('topic.revise', { topicId: topic.id, target: 'spec', text: 'x' }),
      test.mei.conn.request('topic.rule.add', { topicId: topic.id, tool: 'Bash', pattern: 'pnpm test *' }),
      test.mei.conn.request('plan.generate', { topicId: topic.id }),
      test.mei.conn.request('topic.discussion.restart', { topicId: topic.id }),
    ]) {
      expect(await refusal(attempt)).toMatchObject({ code: 'conflict', detail: { reason: 'archived' }, text: { id: 'topic.archived' } });
    }
    // An archived topic's lost discussion asks nobody for attention.
    expect(test.t.ctx.services.topics.attention()).toEqual([]);

    const restored = (await test.mei.conn.request('topic.archive', { topicId: topic.id, archived: false })).topic;
    expect(restored).toMatchObject({ archived: false, discussion: 'lost' });
    expect(test.t.ctx.services.topics.attention()).toMatchObject([{ subject: 'discussion-lost' }]);
    expect((await test.mei.conn.request('topic.discussion.restart', { topicId: topic.id })).topic.discussion).toBe('live');

    // Delete: the host only, archived only; the bus event FIRST (with the sessions), then the transcripts.
    await test.mei.conn.request('topic.archive', { topicId: topic.id, archived: true });
    expect(await refusal(test.mei.conn.request('topic.delete', { topicId: topic.id }))).toMatchObject({ code: 'forbidden' });
    const steps: string[] = [];
    test.t.ctx.bus.on('topic.removed', (event: DaemonEvents['topic.removed']) => steps.push(`bus:${event.sessionIds.length}:${test.fakes.agents.get(session.id) === null ? 'forgotten' : 'still-there'}`));
    await test.host.conn.request('topic.delete', { topicId: topic.id });
    expect(steps).toEqual(['bus:2:still-there']);
    expect(test.fakes.agents.get(session.id)).toBeNull();
    expect(test.t.ctx.services.topics.get(topic.id)).toBeNull();
    await waitFor(() => removedOnWire.includes(topic.id), { what: 'topic.removed on the wire' });
    // Never files of the project.
    expect(existsSync(join(test.t.root, 'specs/checkout'))).toBe(true);
    expect((await test.audit('topic.archive')).map((entry) => entry.detail?.['archived'])).toEqual([true, false, true]);
    expect(await test.audit('topic.delete')).toHaveLength(1);
  });

  it('worktrees with changes that were never merged need a decision: refused without one, kept with false, removed with true', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, [{ id: 'cart-api' }, { id: 'payment-form' }]);
    await startPlan(test, topic.id);
    const plan = test.plan(topic.id);
    const [cart, payment] = [plan.items[0], plan.items[1]] as [(typeof plan.items)[number], (typeof plan.items)[number]];
    expect(cart.worktreeId).toBeDefined();
    // The cart item has edits nobody merged; the payment item has nothing.
    test.fakes.worktrees.unsavedEdits.add(cart.worktreeId as string);

    const error = await refusal(test.mei.conn.request('topic.archive', { topicId: topic.id, archived: true }));
    expect(error).toMatchObject({ code: 'conflict', detail: { reason: 'unmerged' }, text: { id: 'topic.archive.unmerged', params: { count: 1 } } });
    expect(unmergedWorktreesOfError(error)).toEqual([{ itemId: 'cart-api', worktreeId: cart.worktreeId, branch: 'smurg/checkout/cart-api' }]);
    // Nothing changed.
    expect(test.topic(topic.id).archived).toBe(false);
    expect(test.fakes.agents.get(cart.sessionId as string)?.status).not.toBe('ended');

    await test.mei.conn.request('topic.archive', { topicId: topic.id, archived: true, deleteUnmerged: false });
    expect(test.fakes.worktrees.get(cart.worktreeId as string)).not.toBeNull();
    expect(test.fakes.worktrees.get(payment.worktreeId as string)).toBeNull();
    expect(test.fakes.agents.get(cart.sessionId as string)).toMatchObject({ status: 'ended', endReason: 'archived' });
    // Every end keeps the item's worktree: only releaseItem removes one.
    expect(test.fakes.agents.log.of('end').every((call) => (call[1] as { keepWorktree: boolean }).keepWorktree)).toBe(true);

    await test.mei.conn.request('topic.archive', { topicId: topic.id, archived: false });
    await test.mei.conn.request('topic.archive', { topicId: topic.id, archived: true, deleteUnmerged: true });
    expect(test.fakes.worktrees.get(cart.worktreeId as string)).toBeNull();
  });

  it('a topic with a pending merge request is not deleted', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    await test.mei.conn.request('topic.archive', { topicId: topic.id, archived: true });
    test.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_open', status: 'pending', topicId: topic.id, itemId: 'cart-api' }));
    expect(await refusal(test.host.conn.request('topic.delete', { topicId: topic.id }))).toMatchObject({ code: 'conflict', text: { id: 'topic.delete.openMerge' } });
    test.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_open', status: 'rejected', topicId: topic.id, itemId: 'cart-api' }));
    await test.host.conn.request('topic.delete', { topicId: topic.id });
    expect(test.t.ctx.services.topics.get(topic.id)).toBeNull();
  });
});

describe('the wire of topics', () => {
  it('topic.list is a list-rule page; plan.get of a topic without a plan is null, of no topic not_found', async () => {
    test = await setupTopics({ members: false });
    const ids: string[] = [];
    for (const name of ['One', 'Two', 'Three']) ids.push((await test.host.conn.request('topic.create', { name: `Topic ${name}` })).topic.id);
    const first = await test.host.conn.request('topic.list', {});
    expect(first.topics.map((topic) => topic.id)).toEqual(ids);
    expect((await test.host.conn.request('topic.list', { after: ids[0] })).topics.map((topic) => topic.id)).toEqual(ids.slice(1));
    expect(await test.host.conn.request('plan.get', { topicId: ids[0] as string })).toEqual({ plan: null });
    expect(await refusal(test.host.conn.request('plan.get', { topicId: 'tp_none' }))).toMatchObject({ code: 'not_found', text: { id: 'topic.notFound' } });
    expect(await refusal(test.host.conn.request('report.get', { topicId: ids[0] as string, itemId: 'cart-api' }))).toMatchObject({ code: 'not_found', text: { id: 'report.none' } });
  });

  it('a plan file written by hand also makes a plan: the phase follows the files, never a request', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    await test.write(topicPlanPath(topic.slug), planText([{ id: 'cart-api' }]));
    await waitFor(() => test.topic(topic.id).plan.valid, { what: 'the plan to parse' });
    expect(test.topic(topic.id)).toMatchObject({ phase: 'plan', plan: { exists: true, valid: true, items: 1, started: 0 } });
  });
});
