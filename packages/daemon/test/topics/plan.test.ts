// The plan of a topic (design §3.7, §4.3, §4.4, §4.5): generating it, the agent's own check of its file, who is
// responsible, the Start dialog. The REAL topics module in a test daemon; every other service is a fake.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, SmurgError, planInfoSchema, startPreflightSchema, topicPlanPath, topicSpecPath } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildQuestion, recordActivity } from '../../src/core/fakes/index.ts';
import { countOpenQuestions } from '../../src/topics/plan-service.ts';
import { checkPlan, createTopic, itemOf, lineIds, mcpContext, planText, settle, setupTopics, smurgSent, SPEC_TEXT, startPlan, topicWithPlan, waitFor, type TopicsTest } from './support.ts';

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

const THREE = [{ id: 'cart-api', title: 'Cart API', size: 'm' as const }, { id: 'payment-form', title: 'Payment form', size: 's' as const }, { id: 'checkout-page', title: 'Checkout page', size: 'l' as const, dependsOn: ['cart-api', 'payment-form'] }];

describe('generating the plan', () => {
  it('"Generate plan" needs a spec, tells the agent who can be responsible right now, and shows "writing" until that turn ends', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    expect(await refusal(test.mei.conn.request('plan.generate', { topicId: topic.id }))).toMatchObject({ code: 'conflict', text: { id: 'topic.noSpec' } });
    await test.write(topicSpecPath(topic.slug), SPEC_TEXT);
    expect(await refusal(test.amy.conn.request('plan.generate', { topicId: topic.id }))).toMatchObject({ code: 'forbidden' });

    await test.mei.conn.request('plan.generate', { topicId: topic.id });
    expect(lineIds(test, session.id)).toEqual(['conversation.started.discussion', 'conversation.planRequested']);
    const asked = smurgSent(test, session.id).at(-1);
    expect(asked).toMatchObject({ purpose: 'generate-plan', by: { userId: 'dev:mei' } });
    // The people: members with agent access who are online (the host and Mei), never the Editor.
    expect(asked?.text).toContain('People who can be responsible right now: Host, Mei.');
    expect(test.topic(topic.id).plan.generating).toBe(true);
    expect((await test.audit('plan.generate'))[0]).toMatchObject({ detail: { topicId: topic.id, update: false, people: ['dev:host', 'dev:mei'] } });

    // The agent writes the file, checks it and proposes a split in the same turn.
    test.fakes.agents.startTurn(session.id);
    await writeFile(join(test.t.root, topicPlanPath(topic.slug)), planText(THREE));
    test.fakes.agents.edit(session.id, { root: MAIN_ROOT, path: topicPlanPath(topic.slug) });
    expect(await checkPlan(test, session.id)).toEqual({ ok: true, items: 3, warnings: [] });
    expect(test.topic(topic.id).plan.generating).toBe(true);
    test.fakes.agents.finishTurn(session.id);
    await waitFor(() => !test.topic(topic.id).plan.generating, { what: 'generating to end with the turn' });

    const after = test.topic(topic.id);
    expect(after).toMatchObject({ phase: 'plan', plan: { exists: true, valid: true, items: 3, started: 0, stale: false } });
    expect(after.plan.changedBy).toMatchObject({ kind: 'agent', sessionId: session.id });
    expect(test.fakes.agents.eventsOf(session.id).at(-1)).toMatchObject({ kind: 'pointer', target: 'plan', topicId: topic.id });
    // No fix was needed.
    expect(smurgSent(test, session.id).map((message) => message.purpose)).toEqual(['generate-plan']);
    const plan = test.plan(topic.id);
    expect(planInfoSchema.safeParse(plan).success).toBe(true);
    expect(plan.items.map((item) => [item.number, item.id, item.state, item.inPlan])).toEqual([
      [1, 'cart-api', 'not-started', true],
      [2, 'payment-form', 'not-started', true],
      [3, 'checkout-page', 'not-started', true],
    ]);

    // A second "Generate plan" updates it; nothing is started, so no ids must be kept.
    await test.mei.conn.request('plan.generate', { topicId: topic.id });
    expect(lineIds(test, session.id).at(-1)).toBe('conversation.planUpdateRequested');
    expect(smurgSent(test, session.id).at(-1)).toMatchObject({ purpose: 'update-plan' });
    expect(smurgSent(test, session.id).at(-1)?.text).toMatch(/Keep the id of every item that stays\.$/);
  });

  it('a turn that ends with a plan that does not pass gets fix-plan: once per file content, at most twice in a row, with lines and fixed sentences only', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    await test.write(topicSpecPath(topic.slug), SPEC_TEXT);
    const planPath = topicPlanPath(topic.slug);
    const agentWrites = async (text: string): Promise<void> => {
      test.fakes.agents.startTurn(session.id);
      await writeFile(join(test.t.root, planPath), text);
      test.fakes.agents.edit(session.id, { root: MAIN_ROOT, path: planPath });
      test.fakes.agents.finishTurn(session.id);
    };
    const fixes = (): string[] => smurgSent(test, session.id).filter((message) => message.purpose === 'fix-plan').map((message) => message.text);

    await test.mei.conn.request('plan.generate', { topicId: topic.id });
    await agentWrites(planText([{ id: 'cart-api', size: 's' }]).replace('- size: s', '- size: HUGE-SECRET'));
    await waitFor(() => fixes().length === 1, { what: 'the first fix-plan' });
    expect(fixes()[0]).toBe('smurg cannot use "specs/checkout/PLAN.md". Line 9: size is s, m or l. Fix exactly that and call check_plan again.');
    expect(lineIds(test, session.id).at(-1)).toBe('conversation.fix.plan');
    // The plan column keeps saying the agent is writing, and shows the error to people with its line.
    expect(test.topic(topic.id).plan).toMatchObject({ generating: true, valid: false, error: { line: 9, text: { id: 'plan.error.size', params: { line: 9 } } } });

    // The agent's next attempt is still wrong (another content): the second and last fix.
    await agentWrites(planText([{ id: 'cart-api' }]).replace('- id: cart-api', '- id: Cart API'));
    await waitFor(() => fixes().length === 2, { what: 'the second fix-plan' });
    expect(fixes()[1]).toContain('Line 8: An id is 1 to 40 characters of lower-case letters, digits and hyphens');
    // A third wrong content: nothing more is sent; people see the error and can ask the agent themselves.
    await agentWrites(planText([{ id: 'cart-api' }]).replace('### 1. cart-api', '## cart-api'));
    await waitFor(() => test.topic(topic.id).plan.error?.text.id === 'plan.error.heading', { what: 'the third content to be read' });
    await waitFor(() => !test.topic(topic.id).plan.generating, { what: 'generating to end' });
    expect(fixes()).toHaveLength(2);
    expect(fixes().join('\n')).not.toMatch(/HUGE-SECRET|Cart API/);

    // Once the file passes, the count starts again.
    await agentWrites(planText([{ id: 'cart-api' }]));
    await waitFor(() => test.topic(topic.id).plan.valid, { what: 'a valid plan' });
    await agentWrites(planText([{ id: 'cart-api' }]).replace('- id: cart-api', '- id: cart-api\n- size: XL'));
    await waitFor(() => fixes().length === 3, { what: 'a fix after a valid plan' });
  });

  it('when PEOPLE break the file nothing is sent to the agent; the items of the last plan that parsed stay', async () => {
    test = await setupTopics();
    const { topic, session } = await topicWithPlan(test, THREE);
    const revision = test.plan(topic.id).revision;
    await test.write(topicPlanPath(topic.slug), planText(THREE).replace('- id: payment-form', '- ident: payment-form'));
    await waitFor(() => !test.topic(topic.id).plan.valid, { what: 'the broken plan to be read' });
    expect(test.topic(topic.id).plan.error).toMatchObject({ line: 14, text: { id: 'plan.error.field' } });
    expect(test.plan(topic.id).items.map((item) => item.id)).toEqual(['cart-api', 'payment-form', 'checkout-page']);
    expect(test.plan(topic.id).revision).toBe(revision);
    expect(smurgSent(test, session.id)).toEqual([]);
    // A discussion turn about something else does not send a fix either.
    test.fakes.agents.say(session.id, 'Noted.');
    test.fakes.agents.finishTurn(session.id);
    await settle(test);
    expect(smurgSent(test, session.id)).toEqual([]);
  });
});

describe('T3.1 a plan that does not parse cannot start', () => {
  it('the broken plan is reported with its line, Start is refused, and fixing the file makes it startable again', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, THREE);
    const good = await test.mei.conn.request('plan.preflight', { topicId: topic.id });
    expect(good.preflight.blockers).toEqual([]);

    await test.write(topicPlanPath(topic.slug), planText(THREE).replace('- depends on: cart-api, payment-form', '- depends on: cart-api, ghost'));
    await waitFor(() => !test.topic(topic.id).plan.valid, { what: 'the broken plan' });
    expect(test.topic(topic.id).plan.error).toMatchObject({ line: 21, text: { id: 'plan.error.unknownDependency', params: { line: 21 } }, fallback: 'Line 21: "depends on" names something that is not a work item of this plan.' });
    // The old pins no longer fit the file: the dialog reloads.
    expect(await refusal(test.mei.conn.request('plan.start', { topicId: topic.id, planRevision: good.preflight.planRevision, specHash: good.preflight.specHash, planHash: good.preflight.planHash }))).toMatchObject({
      code: 'conflict',
      detail: { reason: 'plan-changed' },
      text: { id: 'plan.start.changed' },
    });
    // The reloaded dialog says why it cannot start, and a start with ITS pins is refused for that reason.
    const broken = (await test.mei.conn.request('plan.preflight', { topicId: topic.id })).preflight;
    expect(broken.blockers.map((blocker) => blocker.text.id)).toEqual(['plan.start.invalid']);
    expect(await refusal(test.mei.conn.request('plan.start', { topicId: topic.id, planRevision: broken.planRevision, specHash: broken.specHash, planHash: broken.planHash }))).toMatchObject({ code: 'conflict', text: { id: 'plan.start.invalid' } });
    expect(test.fakes.agents.log.of('start').filter((call) => (call[0] as { purpose: string }).purpose === 'item')).toEqual([]);
    expect(test.fakes.worktrees.log.of('commitMainPaths')).toEqual([]);

    await test.write(topicPlanPath(topic.slug), planText(THREE));
    await waitFor(() => test.topic(topic.id).plan.valid, { what: 'the fixed plan' });
    const plan = await startPlan(test, topic.id);
    expect(plan.items.map((item) => item.state)).toEqual(['running', 'running', 'waiting']);
  });
});

describe('the agent checks its own plan (MCP check_plan, propose_split)', () => {
  it('check_plan reads the file as it is now and answers ok with the item count and warnings, or errors with their lines', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const planPath = topicPlanPath(topic.slug);
    expect(await checkPlan(test, session.id)).toEqual({ ok: false, errors: [{ message: '"specs/checkout/PLAN.md" does not exist. Write it first, then call check_plan.' }] });
    await writeFile(join(test.t.root, planPath), planText([{ id: 'a', touches: ['src/**'], summary: '' }, { id: 'b', touches: ['src/x.ts'] }]).replace('Do a.', ''));
    const withWarnings = await checkPlan(test, session.id);
    expect(withWarnings).toMatchObject({ ok: true, items: 2 });
    expect(withWarnings.ok && withWarnings.warnings).toHaveLength(2);
    // The same read is the daemon's own: the plan column agrees with the answer at once.
    expect(test.plan(topic.id).items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(test.plan(topic.id).warnings.map((warning) => warning.text.id)).toEqual(['plan.warning.noSummary', 'plan.warning.overlap']);

    await writeFile(join(test.t.root, planPath), planText([{ id: 'a' }, { id: 'a' }]));
    expect(await checkPlan(test, session.id)).toEqual({ ok: false, errors: [{ line: 13, message: 'This id is already used by an earlier work item. Every work item needs its own id.' }] });
    // Without the read that comes first, the synchronous contract method has nothing to answer from.
    expect(test.t.ctx.services.plans.checkPlan(mcpContext(test, session.id))).toEqual({ ok: false, errors: [{ message: '"specs/checkout/PLAN.md" could not be read right now. Call check_plan again.' }] });
  });

  it('a session that is not the topic\'s discussion gets one sentence saying so', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, [{ id: 'cart-api' }]);
    await startPlan(test, topic.id);
    const itemSession = itemOf(test.plan(topic.id), 'cart-api').sessionId as string;
    const free = await test.fakes.agents.start({ purpose: 'free', openedBy: test.principals.mei, responsible: null, workspace: { mode: 'main' }, modeChoice: 'ask-all', model: null, rolePrompt: () => '' });
    for (const sessionId of [itemSession, free.id]) {
      expect(await checkPlan(test, sessionId)).toEqual({ ok: false, errors: [{ message: 'This tool is for the discussion session of a topic. This session is not one.' }] });
      expect(() => test.t.ctx.services.plans.recordSplit(mcpContext(test, sessionId), { items: [], reason: '' })).toThrow(SmurgError);
    }
  });

  it('propose_split: a pair is kept when the person is one of the people the agent was told about; smurg fills the rest evenly', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    await test.write(topicSpecPath(topic.slug), SPEC_TEXT);
    await test.mei.conn.request('plan.generate', { topicId: topic.id });
    test.fakes.agents.startTurn(session.id);
    await writeFile(join(test.t.root, topicPlanPath(topic.slug)), planText([{ id: 'a', size: 'l' }, { id: 'b', size: 'l' }, { id: 'c', size: 's' }, { id: 'd', size: 's' }]));
    expect((await checkPlan(test, session.id)).ok).toBe(true);
    // Before the agent proposes anything, smurg's own even split is there.
    expect(test.plan(topic.id).split).toEqual({ source: 'smurg' });
    expect(test.plan(topic.id).items.every((item) => item.responsible?.source === 'smurg')).toBe(true);

    const plans = test.t.ctx.services.plans as typeof test.t.ctx.services.plans & { prepareCheck(context: unknown): Promise<void> };
    await plans.prepareCheck(mcpContext(test, session.id));
    const answer = plans.recordSplit(mcpContext(test, session.id), {
      items: [
        { id: 'a', person: 'mei' },
        { id: 'b', person: 'Mei' },
        { id: 'c', person: 'Amy' }, // an Editor: never suggested
        { id: 'nope', person: 'Host' },
      ],
      reason: 'Mei knows the cart. token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    expect(answer).toEqual({ ok: true, assigned: 2, unknownPeople: 1 });
    const plan = test.plan(topic.id);
    expect(plan.split?.source).toBe('agent');
    expect(plan.split?.reason).toBe('Mei knows the cart. token [masked]');
    expect(plan.items.map((item) => [item.id, item.responsible?.userId, item.responsible?.source])).toEqual([
      ['a', 'dev:mei', 'agent'],
      ['b', 'dev:mei', 'agent'],
      // Mei already carries 6: the two small ones go to the host.
      ['c', 'dev:host', 'smurg'],
      ['d', 'dev:host', 'smurg'],
    ]);
  });
});

describe('T3.2 assigning and everyone watches', () => {
  it('people change who is responsible; a chosen item is never recomputed; "no one assigned" clears everyone', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, THREE);
    // New items were filled with smurg's even split over the members with agent access who are present.
    const initial = test.plan(topic.id);
    expect(initial.mode).toBe('assigned');
    expect(initial.items.every((item) => item.responsible !== null && item.responsible.source === 'smurg' && ['dev:host', 'dev:mei'].includes(item.responsible.userId))).toBe(true);
    expect(test.topic(topic.id).plan.mode).toBe('assigned');

    // An Editor may be chosen by hand (they review and vote); a Viewer or a stranger may not.
    const assigned = (await test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'cart-api', userId: 'dev:amy' })).plan;
    expect(itemOf(assigned, 'cart-api').responsible).toEqual({ userId: 'dev:amy', displayName: 'Amy', source: 'chosen' });
    const leo = await test.t.connect({ userId: 'dev:leo', displayName: 'Leo', role: 'viewer' });
    expect(leo.userId).toBe('dev:leo');
    expect(await refusal(test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'cart-api', userId: 'dev:leo' }))).toMatchObject({ code: 'bad_request', text: { id: 'responsible.notEligible', params: { name: 'Leo' } } });
    expect(await refusal(test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'cart-api', userId: 'dev:nobody' }))).toMatchObject({ code: 'not_found', text: { id: 'responsible.unknownMember' } });
    expect(await refusal(test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'ghost', userId: 'dev:mei' }))).toMatchObject({ code: 'not_found', text: { id: 'plan.item.unknown' } });
    expect(await refusal(test.amy.conn.request('plan.assign', { topicId: topic.id, itemId: 'cart-api', userId: 'dev:amy' }))).toMatchObject({ code: 'forbidden' });
    // "Nobody" for one item is a choice too.
    expect(itemOf((await test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'payment-form', userId: null })).plan, 'payment-form').responsible).toBeNull();

    // "Suggest again" leaves what people chose and redoes the rest.
    const suggested = (await test.mei.conn.request('plan.suggest', { topicId: topic.id })).plan;
    expect(itemOf(suggested, 'cart-api').responsible).toMatchObject({ userId: 'dev:amy', source: 'chosen' });
    expect(itemOf(suggested, 'payment-form').responsible).toBeNull();
    expect(itemOf(suggested, 'checkout-page').responsible).toMatchObject({ source: 'smurg' });
    expect(suggested.split).toEqual({ source: 'smurg' });

    // The ids are the identity: editing titles, order and text keeps who is responsible.
    await test.write(topicPlanPath(topic.slug), planText([{ ...THREE[2], dependsOn: [] }, { ...THREE[0], title: 'Cart endpoints' }, THREE[1]] as typeof THREE));
    await waitFor(() => test.plan(topic.id).items[0]?.id === 'checkout-page', { what: 'the reordered plan' });
    const reordered = test.plan(topic.id);
    expect(reordered.revision).toBe(initial.revision + 1);
    expect(reordered.items.map((item) => [item.number, item.id, item.title])).toEqual([
      [1, 'checkout-page', 'Checkout page'],
      [2, 'cart-api', 'Cart endpoints'],
      [3, 'payment-form', 'Payment form'],
    ]);
    expect(itemOf(reordered, 'cart-api').responsible).toMatchObject({ userId: 'dev:amy', source: 'chosen' });
    // An item that never started and leaves the file is gone; a new one is filled.
    await test.write(topicPlanPath(topic.slug), planText([THREE[0], { id: 'emails', title: 'Emails' }] as typeof THREE));
    await waitFor(() => test.plan(topic.id).items.length === 2, { what: 'the shorter plan' });
    expect(test.plan(topic.id).items.map((item) => [item.id, item.responsible?.source])).toEqual([
      ['cart-api', 'chosen'],
      ['emails', 'smurg'],
    ]);

    // "No one assigned: everyone watches".
    const everyone = (await test.mei.conn.request('plan.mode.set', { topicId: topic.id, mode: 'everyone' })).plan;
    expect(everyone.mode).toBe('everyone');
    expect(everyone.items.every((item) => item.responsible === null)).toBe(true);
    expect(everyone.split).toBeUndefined();
    const back = (await test.mei.conn.request('plan.mode.set', { topicId: topic.id, mode: 'assigned' })).plan;
    expect(back.items.every((item) => item.responsible?.source === 'smurg')).toBe(true);
    expect((await test.audit('plan.mode')).map((entry) => entry.detail?.['mode'])).toEqual(['everyone', 'assigned']);
    expect((await test.audit('plan.assign')).length).toBeGreaterThanOrEqual(3);
  });

  it('once an item has a session, the session holds who is responsible: plan.assign changes it there, and the plan follows the session', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, [{ id: 'cart-api' }]);
    await test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'cart-api', userId: 'dev:mei' });
    await startPlan(test, topic.id);
    const sessionId = itemOf(test.plan(topic.id), 'cart-api').sessionId as string;
    // At start the item's responsible person became its session's.
    expect(test.fakes.agents.get(sessionId)?.responsible).toEqual({ userId: 'dev:mei', displayName: 'Mei' });

    await test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'cart-api', userId: 'dev:host' });
    expect(test.fakes.agents.log.of('setResponsible').at(-1)).toMatchObject([sessionId, { userId: 'dev:host' }, { kind: 'user', userId: 'dev:mei' }]);
    expect(test.fakes.agents.get(sessionId)?.responsible?.userId).toBe('dev:host');
    // "Make me responsible" in the session's own menu reaches the plan too.
    test.fakes.agents.setResponsible(sessionId, { userId: 'dev:amy', displayName: 'Amy' }, test.principals.mei.actor);
    expect(itemOf(test.plan(topic.id), 'cart-api').responsible).toEqual({ userId: 'dev:amy', displayName: 'Amy', source: 'chosen' });
  });

  it('a member who becomes a Viewer or is kicked is no longer responsible for items that have not started', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, THREE);
    await test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'cart-api', userId: 'dev:amy' });
    expect(test.t.ctx.services.topics.memberRemoved('dev:amy', 'role-changed', 'viewer')).toEqual({ rules: [], disarmed: [] });
    expect(itemOf(test.plan(topic.id), 'cart-api').responsible).toBeNull();
  });
});

describe('the Start dialog (plan.preflight)', () => {
  it('lists what a Start will do: what starts and what waits, who is responsible, the commit, hand edits, warnings, rules and blockers', async () => {
    test = await setupTopics({ settings: { sharedDirs: [] } });
    const { topic, session } = await topicWithPlan(test, THREE);
    const specPath = topicSpecPath(topic.slug);
    const planPath = topicPlanPath(topic.slug);
    await test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'cart-api', userId: 'dev:amy' });
    await test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'payment-form', userId: null });
    await test.mei.conn.request('topic.rule.add', { topicId: topic.id, tool: 'Bash', pattern: 'pnpm test *' });
    // Something else lies in the folder; the spec has invisible characters and two open questions; Amy edited it.
    await test.write('specs/checkout/mockup.png', 'png');
    await test.write('specs/checkout/notes/ideas.md', 'ideas');
    await test.write(specPath, `${SPEC_TEXT.replace('None.', '- Which provider?\n- Guest checkout?')}​`);
    recordActivity(test.t.ctx, { actor: { kind: 'user', userId: 'dev:amy', displayName: 'Amy' }, kind: 'human.edit', file: { root: MAIN_ROOT, path: specPath }, at: 77 });
    test.fakes.worktrees.mainDiffs.set(specPath, { diff: '+changed\n' });
    test.fakes.projectTrust.set(MAIN_ROOT, 'ignored');
    test.fakes.conversation.putQuestion(buildQuestion({ id: 'q_open', sessionId: session.id }));
    await waitFor(() => test.topic(topic.id).plan.stale, { what: 'the plan to be stale' });

    const { preflight } = await test.mei.conn.request('plan.preflight', { topicId: topic.id });
    expect(startPreflightSchema.safeParse(preflight).success).toBe(true);
    const plan = test.plan(topic.id);
    expect(preflight).toMatchObject({
      planRevision: plan.revision,
      specHash: plan.specHash,
      planHash: plan.planHash,
      startsNow: ['cart-api', 'payment-form'],
      waits: [{ itemId: 'checkout-page', for: ['cart-api', 'payment-form'] }],
      alreadyStarted: [],
      commit: { needed: true, branch: 'main', as: { userId: 'dev:mei', displayName: 'Mei' }, files: [specPath, planPath], alsoInFolder: ['specs/checkout/mockup.png', 'specs/checkout/notes/ideas.md'] },
      handEdits: { spec: [{ by: { userId: 'dev:amy', displayName: 'Amy' }, at: 77 }], plan: [] },
      invisibleCharacters: ['spec'],
      stale: true,
      openQuestion: true,
      specOpenQuestions: 2,
      editingNow: [],
      projectSettings: 'ignored',
      sharedDirs: [],
      blockers: [],
    });
    expect(preflight.rules.map((rule) => rule.pattern)).toEqual(['pnpm test *']);
    expect(preflight.responsible.slice(0, 2)).toEqual([
      { itemId: 'cart-api', user: { userId: 'dev:amy', displayName: 'Amy' }, online: true },
      { itemId: 'payment-form', user: null, online: false },
    ]);
    // Mei will decide the questions of the session nobody is assigned to (and of her own items).
    expect(preflight.youDecide).toBe(preflight.responsible.filter((entry) => entry.user === null || entry.user.userId === 'dev:mei').length);

    // For chosen items only.
    const one = (await test.mei.conn.request('plan.preflight', { topicId: topic.id, itemIds: ['checkout-page'] })).preflight;
    expect(one).toMatchObject({ startsNow: [], waits: [{ itemId: 'checkout-page', for: ['cart-api', 'payment-form'] }] });
    expect(await refusal(test.mei.conn.request('plan.preflight', { topicId: topic.id, itemIds: ['ghost'] }))).toMatchObject({ code: 'not_found', text: { id: 'plan.item.unknown' } });
    // Starting is for members who may open sessions.
    expect(await refusal(test.amy.conn.request('plan.preflight', { topicId: topic.id }))).toMatchObject({ code: 'forbidden' });
  });

  it('blockers: why git is in the way (one message per reason), git busy, no room for worktrees', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, THREE);
    const blockers = async (): Promise<string[]> => (await test.mei.conn.request('plan.preflight', { topicId: topic.id })).preflight.blockers.map((blocker) => blocker.text.id);
    // (0.6.0, DESIGN D14: a folder without `.git` has smurg's own history: no blocker, no commit line (no branch of the
    // folder's to name), and what the Start dialog found about the folder: nested repositories, a cloud-synced folder.)
    test.fakes.worktrees.main = { isRepo: false, hasCommit: false, gitOk: true, branch: null, busy: false, free: 64 };
    test.fakes.worktrees.startFacts = { nestedRepos: ['frontend'], cloudSynced: true, problem: null };
    const smurg = (await test.mei.conn.request('plan.preflight', { topicId: topic.id })).preflight;
    expect(smurg).toMatchObject({ blockers: [], history: 'smurg', direct: null, commit: null, nestedRepos: ['frontend'], cloudSynced: true });
    expect(test.topic(topic.id).versioned).toBe(false);
    // What smurg's own history cannot record now is the blocker (here: the folder is too large to copy into checkouts).
    const tooLarge = msg('worktree.hidden.tooLarge', { size: '3 GB', files: '90,000', maxSize: '1 GB', maxFiles: '50,000', largest: 'data (2 GB)' });
    test.fakes.worktrees.startFacts = { nestedRepos: [], cloudSynced: false, problem: tooLarge };
    expect(await blockers()).toEqual(['worktree.hidden.tooLarge']);
    test.fakes.worktrees.startFacts = { nestedRepos: [], cloudSynced: false, problem: null };
    // A repository without a commit: its own sentence, and no commit line (there is no branch to name yet).
    test.fakes.worktrees.main = { isRepo: true, hasCommit: false, gitOk: true, branch: 'main', busy: false, free: 64 };
    expect(await blockers()).toEqual(['worktree.unavailable.noCommit']);
    expect((await test.mei.conn.request('plan.preflight', { topicId: topic.id })).preflight.commit).toBeNull();
    expect(test.topic(topic.id).versioned).toBe(true);
    // Whatever the module says is the reason git cannot be used is what the dialog shows (here: git is too old). 0.6.0
    // (DESIGN D15): that is no blocker any more, the items would run directly in the folder; only the host may start
    // them (Mei is told so).
    test.fakes.worktrees.main = { isRepo: true, hasCommit: false, gitOk: false, branch: null, busy: false, free: 64, unavailable: msg('worktree.unavailable.gitTooOld', { version: '2.39.5', minVersion: '2.42.0' }) };
    const tooOld = (await test.mei.conn.request('plan.preflight', { topicId: topic.id })).preflight;
    expect(tooOld.blockers).toEqual([]);
    expect(tooOld).toMatchObject({
      history: 'direct',
      direct: {
        reason: { text: { id: 'worktree.unavailable.gitTooOld', params: { version: '2.39.5', minVersion: '2.42.0' } }, fallback: "The host's git is version 2.39.5, and worktrees need 2.42.0 or later. The host can update git, stop sharing, and share again from a new terminal." },
        hostOnly: true,
      },
    });
    expect((await test.host.conn.request('plan.preflight', { topicId: topic.id })).preflight.direct?.hostOnly).toBe(false);
    expect(tooOld.commit).toBeNull();
    test.fakes.worktrees.main = { isRepo: true, hasCommit: true, gitOk: true, branch: 'main', busy: true, free: 64 };
    expect(await blockers()).toEqual(['plan.start.commit.busy']);
    expect(test.topic(topic.id).versioned).toBe(true);
    test.fakes.worktrees.main = { isRepo: true, hasCommit: true, gitOk: true, branch: 'main', busy: false, free: 1 };
    expect(await blockers()).toEqual(['plan.start.worktreeLimit']);
    test.fakes.worktrees.main = { isRepo: true, hasCommit: true, gitOk: true, branch: 'main', busy: false, free: 64 };
    expect(await blockers()).toEqual([]);
  });

  it('counts the entries under "Open questions" of a spec', () => {
    expect(countOpenQuestions('# Spec\n\n## Open questions\n- One?\n- Two?\n\n## Scope\n- not a question\n')).toBe(2);
    expect(countOpenQuestions('## Open questions\nNone.\n')).toBe(0);
    expect(countOpenQuestions('## Open Questions\n1. First\n2) Second\n3. None\n')).toBe(2);
    expect(countOpenQuestions('## Open questions\nWe still have to decide the provider.\n')).toBe(1);
    expect(countOpenQuestions('# Spec\n\n## Goal\nx\n')).toBe(0);
  });
});

describe('"Show the changes" (plan.changes)', () => {
  it('the two files against HEAD before the first Start, against what the last Start pinned afterwards', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, [{ id: 'cart-api' }]);
    const specPath = topicSpecPath(topic.slug);
    const planPath = topicPlanPath(topic.slug);
    test.fakes.worktrees.mainDiffs.set(planPath, { diff: '@@ plan\n+changed\n' });
    // A Viewer may look too.
    const leo = await test.t.connect({ userId: 'dev:leo', displayName: 'Leo', role: 'viewer' });
    expect(await leo.conn.request('plan.changes', { topicId: topic.id })).toEqual({ files: [{ target: 'plan', diff: '@@ plan\n+changed\n', truncated: false }] });
    expect(test.fakes.worktrees.log.of('diffMainPaths').at(-1)).toMatchObject([{ paths: [specPath, planPath], against: 'head', maxBytes: 512 * 1024 }]);

    test.fakes.worktrees.mainDiffs.clear();
    await startPlan(test, topic.id);
    test.fakes.worktrees.mainDiffs.set(specPath, { diff: '@@ spec\n+typo fixed\n' });
    expect(await test.amy.conn.request('plan.changes', { topicId: topic.id })).toEqual({ files: [{ target: 'spec', diff: '@@ spec\n+typo fixed\n', truncated: false }] });
    const against = (test.fakes.worktrees.log.of('diffMainPaths').at(-1)?.[0] as { against: Record<string, string> }).against;
    expect(against).toEqual({ [specPath]: test.fakes.worktrees.head.get(specPath), [planPath]: test.fakes.worktrees.head.get(planPath) });
  });
});

describe('what the wire carries of a plan', () => {
  it('a plan of 40 items with the longest titles, summaries and globs, every item assigned, still passes its schemas', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `item-${String(index + 1).padStart(2, '0')}-${'x'.repeat(31)}`,
      title: `T${index} ${'t'.repeat(110)}`,
      size: 'l' as const,
      dependsOn: index === 0 ? [] : [`item-${String(index).padStart(2, '0')}-${'x'.repeat(31)}`],
      touches: Array.from({ length: 16 }, (_unused, glob) => `src/${index}/${glob}/${'g'.repeat(180)}`),
      summary: 's'.repeat(2_500),
    }));
    await test.write(topicSpecPath(topic.slug), SPEC_TEXT);
    await test.write(topicPlanPath(topic.slug), planText(items));
    await waitFor(() => test.t.ctx.services.plans.get(topic.id)?.items.length === 40, { what: 'the large plan' });
    const plan = test.plan(topic.id);
    expect(planInfoSchema.safeParse(plan).success).toBe(true);
    expect(plan.items[0]?.summary).toHaveLength(2_000);
    expect(plan.items.every((item) => item.responsible !== null)).toBe(true);
    const { preflight } = await test.mei.conn.request('plan.preflight', { topicId: topic.id });
    expect(startPreflightSchema.safeParse(preflight).success).toBe(true);
    expect(preflight.startsNow).toHaveLength(1);
    expect(preflight.waits).toHaveLength(39);
    // A circle through all of them is refused with a reference that still fits the wire.
    await test.write(topicPlanPath(topic.slug), planText(items.map((item, index) => (index === 0 ? { ...item, dependsOn: [items[39]?.id as string] } : item))));
    await waitFor(() => test.topic(topic.id).plan.error?.text.id === 'plan.error.cycle', { what: 'the cycle' });
    expect(JSON.stringify(test.topic(topic.id).plan.error?.text).length).toBeLessThan(2_000);
  });
});

// ── protocol 5 (smurg 0.6.0): a topic's agent settings and the Start dialog's new facts (DESIGN 0.6.0 D3, D4, D5) ────

/** The host agent's list as Claude Code answered it (U1 E3), for the tests that need a model to be offered. */
const OFFERED = {
  models: [
    { value: 'opus', name: 'Opus', description: 'Most capable', auto: true },
    { value: 'sonnet', name: 'Sonnet', description: 'Everyday tasks', auto: true },
  ],
  modelsKnown: true,
  hostDefault: 'opus',
  autoMode: 'ok',
  asksNothing: 'ok',
} as const;

describe('a topic\'s agent settings (topic.agent.set, plan.start `agent`)', () => {
  it('a new topic has none (the host\'s default model, the workspace\'s mode); topic.agent.set stores either, audited, and the topic\'s sessions are told', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    expect(topic.agent).toEqual({ model: null, permissionMode: null });
    const set = await test.mei.conn.request('topic.agent.set', { topicId: topic.id, permissionMode: 'ask-commands' });
    expect(set.topic.agent).toEqual({ model: null, permissionMode: 'ask-commands' });
    expect(test.topic(topic.id).agent).toEqual({ model: null, permissionMode: 'ask-commands' });
    expect(test.fakes.agents.log.of('topicAgentChanged')).toEqual([[topic.id, null, test.principals.mei.actor]]);
    expect((await test.audit('topic.agent')).map((entry) => entry.detail)).toEqual([{ topicId: topic.id, permissionMode: 'ask-commands' }]);
    // Back to the workspace's mode.
    await test.mei.conn.request('topic.agent.set', { topicId: topic.id, permissionMode: null });
    expect(test.topic(topic.id).agent).toEqual({ model: null, permissionMode: null });
    // An Editor cannot; a request that sets nothing is no request.
    expect(await refusal(test.amy.conn.request('topic.agent.set', { topicId: topic.id, permissionMode: 'ask-all' }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(test.mei.conn.request('topic.agent.set', { topicId: topic.id } as never))).toMatchObject({ code: 'bad_request' });
    // `ask-nothing` is the workspace's alone.
    expect(await refusal(test.mei.conn.request('topic.agent.set', { topicId: topic.id, permissionMode: 'ask-nothing' } as never))).toMatchObject({ code: 'bad_request' });
  });

  it('a model must be one of the host agent\'s list: while it is not known every model is refused, then only what it offers', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    expect(await refusal(test.mei.conn.request('topic.agent.set', { topicId: topic.id, model: 'sonnet' }))).toMatchObject({ code: 'conflict', detail: { reason: 'models-not-known' }, text: { id: 'session.model.notKnown' } });
    expect(await refusal(test.mei.conn.request('topic.create', { name: 'Billing', model: 'sonnet' }))).toMatchObject({ code: 'conflict', detail: { reason: 'models-not-known' } });
    expect(test.topic(topic.id).agent).toEqual({ model: null, permissionMode: null });
    expect(await test.audit('topic.agent')).toEqual([]);

    test.fakes.agents.hostAgent = structuredClone(OFFERED) as never;
    expect(await refusal(test.mei.conn.request('topic.agent.set', { topicId: topic.id, model: 'haiku' }))).toMatchObject({ code: 'bad_request', detail: { reason: 'model-not-offered' }, text: { id: 'session.model.notOffered', params: { model: 'haiku' } } });
    await test.mei.conn.request('topic.agent.set', { topicId: topic.id, model: 'sonnet' });
    expect(test.topic(topic.id).agent).toEqual({ model: 'sonnet', permissionMode: null });
    // Only the model was set: no session follows a mode that did not change.
    expect(test.fakes.agents.log.of('topicAgentChanged')).toEqual([]);
    const billing = await test.mei.conn.request('topic.create', { name: 'Billing', model: 'opus' });
    expect(billing.topic.agent).toEqual({ model: 'opus', permissionMode: null });
    // null is the host's default, and always passes.
    await test.mei.conn.request('topic.agent.set', { topicId: topic.id, model: null });
    expect(test.topic(topic.id).agent).toEqual({ model: null, permissionMode: null });
  });

  it('DESIGN 0.6.0 D12: when a member who chose a topic\'s settings goes, a mode LOOSER than the workspace\'s goes back (a stricter one stays), and a model that may bill usage credits goes back to the host\'s default (any other stays)', async () => {
    test = await setupTopics();
    test.fakes.agents.hostAgent = { ...structuredClone(OFFERED), models: [...OFFERED.models, { value: 'fable', name: 'Fable', description: '', auto: true, billing: 'usage-credits' }] } as never;
    await test.t.ctx.settings.update({ permissionMode: 'ask-commands' }, test.principals.host);
    const loose = (await createTopic(test)).topic;
    const strict = (await test.mei.conn.request('topic.create', { name: 'Billing' })).topic;
    await test.mei.conn.request('topic.agent.set', { topicId: loose.id, permissionMode: 'auto', model: 'fable' });
    await test.mei.conn.request('topic.agent.set', { topicId: strict.id, permissionMode: 'ask-all', model: 'sonnet' });
    test.fakes.agents.log.clear();
    test.t.ctx.services.topics.memberRemoved('dev:mei', 'kicked');
    expect(test.topic(loose.id).agent).toEqual({ model: null, permissionMode: null });
    expect(test.topic(strict.id).agent).toEqual({ model: 'sonnet', permissionMode: 'ask-all' });
    // The item sessions that follow the topic take the workspace's mode, each with the line that names who had chosen it.
    await waitFor(() => test.fakes.agents.log.of('topicAgentChanged').length === 1, { what: 'the topic\'s sessions to follow' });
    expect(test.fakes.agents.log.of('topicAgentChanged')).toEqual([[loose.id, 'auto', { kind: 'system' }, { userId: 'dev:mei', displayName: 'Mei' }]]);
    expect((await test.audit('topic.agent')).at(-1)).toMatchObject({ actor: { kind: 'system' }, detail: { topicId: loose.id, permissionMode: null, model: null, reset: 'dev:mei' } });
    // A role that keeps agent access takes nothing.
    await test.mei.conn.request('topic.agent.set', { topicId: loose.id, permissionMode: 'auto' });
    test.t.ctx.services.topics.memberRemoved('dev:mei', 'role-changed', 'agent');
    expect(test.topic(loose.id).agent).toEqual({ model: null, permissionMode: 'auto' });
  });

  it('the Start dialog says how its items will run (the folder\'s history, the topic\'s settings, the mode in effect)', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, THREE);
    const { preflight } = await test.mei.conn.request('plan.preflight', { topicId: topic.id });
    expect(startPreflightSchema.safeParse(preflight).success).toBe(true);
    expect(preflight).toMatchObject({ history: 'folder', direct: null, agent: { model: null, permissionMode: null, effective: 'auto' }, nestedRepos: [], cloudSynced: false });
    await test.mei.conn.request('topic.agent.set', { topicId: topic.id, permissionMode: 'ask-all' });
    expect((await test.mei.conn.request('plan.preflight', { topicId: topic.id })).preflight.agent).toEqual({ model: null, permissionMode: 'ask-all', effective: 'ask-all' });
  });

  it('plan.start `agent` changes the topic in the update that arms the items; a Start refused at the checkpoint leaves the topic\'s agent settings unchanged', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, THREE);
    const specPath = topicSpecPath(topic.slug);
    // Refused AFTER the checkpoint commit: HEAD does not hold what the dialog showed.
    const pins = (await test.mei.conn.request('plan.preflight', { topicId: topic.id })).preflight;
    test.fakes.worktrees.mainDiffs.set(specPath, { diff: '+someone else\n' });
    const refused = await refusal(test.mei.conn.request('plan.start', { topicId: topic.id, planRevision: pins.planRevision, specHash: pins.specHash, planHash: pins.planHash, agent: { permissionMode: 'ask-commands' } }));
    expect(refused).toMatchObject({ code: 'conflict', detail: { reason: 'plan-changed' } });
    expect(test.fakes.worktrees.log.of('commitMainPaths')).toHaveLength(1);
    expect(test.topic(topic.id).agent).toEqual({ model: null, permissionMode: null });
    expect(test.fakes.agents.log.of('topicAgentChanged')).toEqual([]);
    // Refused for a model nobody offers: before anything is done.
    expect(await refusal(test.mei.conn.request('plan.start', { topicId: topic.id, planRevision: pins.planRevision, specHash: pins.specHash, planHash: pins.planHash, agent: { model: 'sonnet' } }))).toMatchObject({ code: 'conflict', detail: { reason: 'models-not-known' } });
    expect(test.fakes.worktrees.log.of('commitMainPaths')).toHaveLength(1);

    test.fakes.worktrees.mainDiffs.clear();
    const { preflight } = await test.mei.conn.request('plan.preflight', { topicId: topic.id });
    const { plan } = await test.mei.conn.request('plan.start', { topicId: topic.id, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash, agent: { permissionMode: 'ask-commands' } });
    expect(plan.items.map((item) => item.state)).toEqual(['running', 'running', 'waiting']);
    expect(test.topic(topic.id).agent).toEqual({ model: null, permissionMode: 'ask-commands' });
    expect(test.fakes.agents.log.of('topicAgentChanged')).toEqual([[topic.id, null, test.principals.mei.actor]]);
    expect((await test.audit('plan.start')).at(-1)?.detail).toMatchObject({ topicId: topic.id, agent: { permissionMode: 'ask-commands' } });
    // The items it started run in the topic's mode.
    const cart = test.fakes.agents.get(itemOf(test.plan(topic.id), 'cart-api').sessionId as string);
    expect(cart).toMatchObject({ purpose: 'item', permissionMode: 'ask-commands', modeChoice: null, model: null });
  });
});
