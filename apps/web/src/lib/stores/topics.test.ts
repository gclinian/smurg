// @vitest-environment node
// The topics store: topics, plans and reports live from the wire, every request of the three families, and the
// notices a change of a topic gives everyone (DESIGN §5.3).
import { SmurgError } from '@smurg/protocol';
import { buildAgentSession, buildPlan, buildReport, buildReportSummary, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { answerLoads, setupStores } from '../../testing/stores.ts';
import { reportKey, selectArchivedTopics, selectPausedTopics, selectPlan, selectReport, selectTopic, selectTopicList, topicNoticeKind } from './topics.ts';

const plan = { exists: true, valid: true, generating: false, stale: false, mode: 'assigned', paused: false, items: 3, started: 0, reviewed: 0, merged: 0 } as const;

async function ready(topics = [buildTopic()]) {
  const ctx = setupStores({ role: 'host' });
  ctx.admit();
  answerLoads(ctx.conn, { 'topic.list': { topics, hasMore: false } });
  await ctx.flush();
  return ctx;
}

describe('topics store: the list', () => {
  it('reads every page of topic.list and keeps the topics that are not archived', async () => {
    const ctx = setupStores();
    ctx.admit();
    expect(ctx.conn.lastRequest('topic.list')?.payload).toEqual({});
    ctx.conn.respond('topic.list', { topics: [buildTopic({ id: 'tp_1' })], hasMore: true });
    await ctx.flush();
    expect(ctx.conn.lastRequest('topic.list')?.payload).toEqual({ after: 'tp_1' });
    ctx.conn.respond('topic.list', { topics: [buildTopic({ id: 'tp_2', name: 'Search' })], hasMore: false });
    await ctx.flush();
    expect(ctx.stores.topics.getState()).toMatchObject({ status: 'ready', archived: null });
    expect([...ctx.stores.topics.getState().topics.keys()]).toEqual(['tp_1', 'tp_2']);
  });

  it('orders topics for the session list: still worked on first (newest first), complete ones after', async () => {
    const { stores } = await ready([
      buildTopic({ id: 'old', createdAt: 1 }),
      buildTopic({ id: 'done', createdAt: 5, phase: 'complete' }),
      buildTopic({ id: 'new', createdAt: 9 }),
    ]);
    expect(selectTopicList(stores.topics.getState()).map((topic) => topic.id)).toEqual(['new', 'old', 'done']);
  });

  it('topic.updated puts a topic where it belongs; topic.removed takes it and everything of it away', async () => {
    const { conn, stores } = await ready();
    conn.emit('topic.updated', { topic: buildTopic({ name: 'Checkout redesign' }) });
    expect(selectTopic(stores.topics.getState(), 'tp_1')?.name).toBe('Checkout redesign');
    conn.emit('plan.updated', { plan: buildPlan() });
    void stores.topics.loadReport('tp_1', 'cart-api');
    conn.respond('report.get', { report: buildReport() });
    await Promise.resolve();
    conn.emit('topic.removed', { topicId: 'tp_1' });
    expect(stores.topics.getState()).toMatchObject({ topics: new Map(), plans: new Map(), reports: new Map(), planStatus: new Map() });
  });

  it('an archived topic leaves the list; the archived ones are fetched only when asked, then kept current', async () => {
    const { conn, stores } = await ready([buildTopic({ id: 'tp_1' }), buildTopic({ id: 'tp_2' })]);
    conn.emit('topic.updated', { topic: buildTopic({ id: 'tp_1', archived: true }) });
    expect([...stores.topics.getState().topics.keys()]).toEqual(['tp_2']);
    expect(stores.topics.getState().archived).toBeNull();
    expect(selectTopic(stores.topics.getState(), 'tp_1')).toBeUndefined();

    const loading = stores.topics.loadArchived();
    expect(conn.lastRequest('topic.list')?.payload).toEqual({ archived: true });
    conn.respond('topic.list', { topics: [buildTopic({ id: 'tp_1', archived: true })], hasMore: false });
    await loading;
    expect(selectArchivedTopics(stores.topics.getState()).map((topic) => topic.id)).toEqual(['tp_1']);
    expect(selectTopic(stores.topics.getState(), 'tp_1')?.archived).toBe(true);
    // Restored: back in the list, out of the archived ones.
    conn.emit('topic.updated', { topic: buildTopic({ id: 'tp_1', archived: false }) });
    expect([...stores.topics.getState().topics.keys()].sort()).toEqual(['tp_1', 'tp_2']);
    expect(selectArchivedTopics(stores.topics.getState())).toEqual([]);
    // And archived again by its own request.
    const archiving = stores.topics.archive('tp_2', true, false);
    expect(conn.lastRequest('topic.archive')?.payload).toEqual({ topicId: 'tp_2', archived: true, deleteUnmerged: false });
    conn.respond('topic.archive', { topic: buildTopic({ id: 'tp_2', archived: true }) });
    await archiving;
    expect(selectArchivedTopics(stores.topics.getState()).map((topic) => topic.id)).toEqual(['tp_2']);
  });

  it('a full resync loads the list again, with the archived ones if they were asked for, and the plans and reports that were wanted', async () => {
    const { conn, stores, admit, flush } = await ready();
    stores.topics.ensurePlan('tp_1');
    conn.respond('plan.get', { plan: buildPlan() });
    void stores.topics.loadReport('tp_1', 'cart-api');
    conn.respond('report.get', { report: buildReport() });
    const archived = stores.topics.loadArchived();
    conn.respond('topic.list', { topics: [], hasMore: false });
    await archived;
    await flush();

    admit({ resumed: false, channelId: 'ch_2' });
    expect(stores.topics.getState()).toMatchObject({ status: 'loading', plans: new Map(), reports: new Map() });
    conn.respond('topic.list', { topics: [buildTopic()], hasMore: false });
    await flush();
    conn.respond('topic.list', { topics: [buildTopic({ id: 'tp_old', archived: true })], hasMore: false });
    await flush();
    expect(conn.pendingOf('plan.get').map((request) => request.payload)).toEqual([{ topicId: 'tp_1' }]);
    expect(conn.pendingOf('report.get').map((request) => request.payload)).toEqual([{ topicId: 'tp_1', itemId: 'cart-api' }]);
    conn.respond('plan.get', { plan: buildPlan({ revision: 2 }) });
    conn.respond('report.get', { report: buildReport({ version: 2 }) });
    await flush();
    expect(selectPlan(stores.topics.getState(), 'tp_1')?.revision).toBe(2);
    expect(selectReport(stores.topics.getState(), 'tp_1', 'cart-api')?.version).toBe(2);
    expect(selectArchivedTopics(stores.topics.getState()).map((topic) => topic.id)).toEqual(['tp_old']);
  });

  it('the archived list survives a load that began before it was asked for', async () => {
    const { conn, stores, admit, flush } = setupStores();
    admit();
    // The first load is still in flight when someone presses "Show archived topics".
    const archived = stores.topics.loadArchived();
    const [first, second] = conn.pendingOf('topic.list');
    expect(first?.payload).toEqual({});
    expect(second?.payload).toEqual({ archived: true });
    second?.resolve({ topics: [buildTopic({ id: 'tp_old', archived: true })], hasMore: false });
    await archived;
    first?.resolve({ topics: [buildTopic()], hasMore: false });
    await flush();
    expect(selectArchivedTopics(stores.topics.getState()).map((topic) => topic.id)).toEqual(['tp_old']);
    expect([...stores.topics.getState().topics.keys()]).toEqual(['tp_1']);
  });

  it('a failed load is kept as the store\'s error and reported', async () => {
    const { conn, stores, admit, flush } = setupStores();
    admit();
    conn.fail('topic.list', new SmurgError('internal', 'boom'));
    await flush();
    expect(stores.topics.getState()).toMatchObject({ status: 'error', error: 'Something went wrong on the host.' });
    expect(stores.errors.getState().at(-1)).toMatchObject({ area: 'topics' });
  });

  it('paused plans are what the banner of the sessions view counts', async () => {
    const { stores } = await ready([buildTopic({ id: 'a', plan: { ...plan, paused: true } }), buildTopic({ id: 'b', plan })]);
    expect(selectPausedTopics(stores.topics.getState()).map((topic) => topic.id)).toEqual(['a']);
  });
});

describe('topics store: plans', () => {
  it('ensurePlan fetches a plan once, however often it is asked; plan.updated keeps every plan current', async () => {
    const { conn, stores, flush } = await ready();
    stores.topics.ensurePlan('tp_1');
    stores.topics.ensurePlan('tp_1');
    expect(conn.requestsOf('plan.get')).toHaveLength(1);
    expect(stores.topics.getState().planStatus.get('tp_1')).toBe('loading');
    conn.respond('plan.get', { plan: null });
    await flush();
    expect(selectPlan(stores.topics.getState(), 'tp_1')).toBeNull();
    expect(stores.topics.getState().planStatus.get('tp_1')).toBe('ready');
    stores.topics.ensurePlan('tp_1');
    expect(conn.requestsOf('plan.get')).toHaveLength(1);
    conn.emit('plan.updated', { plan: buildPlan({ revision: 3 }) });
    expect(selectPlan(stores.topics.getState(), 'tp_1')?.revision).toBe(3);
    // A plan nobody asked for is kept too (the event reaches everyone).
    conn.emit('plan.updated', { plan: buildPlan({ topicId: 'tp_9' }) });
    expect(selectPlan(stores.topics.getState(), 'tp_9')?.topicId).toBe('tp_9');
  });

  it('ensurePlan before the first admission asks nothing; the first load fetches what was wanted', async () => {
    const { conn, stores, admit, flush } = setupStores();
    stores.topics.ensurePlan('tp_1');
    expect(conn.requestsOf('plan.get')).toHaveLength(0);
    admit();
    answerLoads(conn, { 'topic.list': { topics: [buildTopic()], hasMore: false } });
    await flush();
    expect(conn.requestsOf('plan.get')).toHaveLength(1);
  });

  it('a failed plan.get is an error state of that plan and is reported', async () => {
    const { conn, stores, flush } = await ready();
    stores.topics.ensurePlan('tp_1');
    conn.fail('plan.get', new SmurgError('internal', 'boom'));
    await flush();
    expect(stores.topics.getState().planStatus.get('tp_1')).toBe('error');
    expect(stores.errors.getState().at(-1)).toMatchObject({ area: 'topics' });
    // Asking again by hand works.
    const reload = stores.topics.reloadPlan('tp_1');
    conn.respond('plan.get', { plan: buildPlan() });
    expect((await reload)?.topicId).toBe('tp_1');
  });

  it('every plan request puts the plan it gets back into the store', async () => {
    const { conn, stores } = await ready();
    const cases = [
      ['plan.mode.set', () => stores.topics.setPlanMode('tp_1', 'everyone'), { topicId: 'tp_1', mode: 'everyone' }],
      ['plan.assign', () => stores.topics.assign('tp_1', 'cart-api', null), { topicId: 'tp_1', itemId: 'cart-api', userId: null }],
      ['plan.suggest', () => stores.topics.suggestSplit('tp_1'), { topicId: 'tp_1' }],
      ['plan.resume', () => stores.topics.resume('tp_1'), { topicId: 'tp_1' }],
      ['plan.item.retry', () => stores.topics.retryItem('tp_1', 'cart-api'), { topicId: 'tp_1', itemId: 'cart-api' }],
      ['plan.start', () => stores.topics.start({ topicId: 'tp_1', planRevision: 1, specHash: 'a'.repeat(64), planHash: 'a'.repeat(64) }), { topicId: 'tp_1', planRevision: 1, specHash: 'a'.repeat(64), planHash: 'a'.repeat(64) }],
    ] as const;
    let revision = 10;
    for (const [type, run, payload] of cases) {
      revision += 1;
      const done = run();
      expect(conn.lastRequest(type)?.payload, type).toEqual(payload);
      conn.respond(type, { plan: buildPlan({ revision }) });
      expect((await done).revision, type).toBe(revision);
      expect(selectPlan(stores.topics.getState(), 'tp_1')?.revision, type).toBe(revision);
    }
  });

  it('the requests without a plan in their answer send what they were given', async () => {
    const { conn, stores } = await ready();
    conn.handle('plan.generate', () => ({}));
    conn.handle('plan.item.continue', () => ({}));
    conn.handle('plan.item.resolve', () => ({}));
    conn.handle('topic.spec.request', () => ({}));
    conn.handle('topic.delete', () => ({}));
    await stores.topics.generatePlan('tp_1');
    await stores.topics.continueItem('tp_1', 'cart-api');
    await stores.topics.resolveItem('tp_1', 'cart-api');
    await stores.topics.requestSpec('tp_1');
    await stores.topics.remove('tp_1');
    expect(conn.lastRequest('plan.generate')?.payload).toEqual({ topicId: 'tp_1' });
    expect(conn.lastRequest('plan.item.continue')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
    expect(conn.lastRequest('plan.item.resolve')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
    expect(conn.lastRequest('topic.spec.request')?.payload).toEqual({ topicId: 'tp_1' });
    expect(conn.lastRequest('topic.delete')?.payload).toEqual({ topicId: 'tp_1' });

    const preflight = stores.topics.preflight('tp_1', ['cart-api']);
    expect(conn.lastRequest('plan.preflight')?.payload).toEqual({ topicId: 'tp_1', itemIds: ['cart-api'] });
    conn.fail('plan.preflight', new SmurgError('conflict', 'changed'));
    await expect(preflight).rejects.toBeInstanceOf(SmurgError);
    const changes = stores.topics.changes('tp_1');
    conn.respond('plan.changes', { files: [{ target: 'spec', diff: '+x\n', truncated: false }] });
    expect((await changes).files).toHaveLength(1);
  });
});

describe('topics store: topics by request', () => {
  it('create, rename, the rules and a restart of the discussion put the topic they get back into the store', async () => {
    const { conn, stores } = await ready([]);
    const creating = stores.topics.create({ name: 'Checkout' });
    expect(conn.lastRequest('topic.create')?.payload).toEqual({ name: 'Checkout' });
    conn.respond('topic.create', { topic: buildTopic(), session: buildAgentSession({ purpose: 'discussion', topicId: 'tp_1' }) });
    expect((await creating).session.purpose).toBe('discussion');
    expect(selectTopic(stores.topics.getState(), 'tp_1')?.name).toBe('Checkout');
    // The member who asked needs no toast about it.
    expect(stores.topics.getState().notices).toEqual([]);

    const renaming = stores.topics.rename('tp_1', 'Checkout redesign');
    conn.respond('topic.rename', { topic: buildTopic({ name: 'Checkout redesign' }) });
    expect((await renaming).name).toBe('Checkout redesign');

    const rule = { id: 'r1', tool: 'Bash', pattern: 'pnpm test *', scope: 'topic', addedBy: { userId: 'dev:host', displayName: 'Host' }, addedAt: 1 } as const;
    const adding = stores.topics.addRule('tp_1', { tool: 'Bash', pattern: 'pnpm test *' });
    expect(conn.lastRequest('topic.rule.add')?.payload).toEqual({ topicId: 'tp_1', tool: 'Bash', pattern: 'pnpm test *' });
    conn.respond('topic.rule.add', { topic: buildTopic({ rules: [rule] }) });
    await adding;
    expect(selectTopic(stores.topics.getState(), 'tp_1')?.rules).toHaveLength(1);
    const removing = stores.topics.removeRule('tp_1', 'r1');
    expect(conn.lastRequest('topic.rule.remove')?.payload).toEqual({ topicId: 'tp_1', ruleId: 'r1' });
    conn.respond('topic.rule.remove', { topic: buildTopic() });
    await removing;
    expect(selectTopic(stores.topics.getState(), 'tp_1')?.rules).toEqual([]);

    const restarting = stores.topics.restartDiscussion('tp_1');
    conn.respond('topic.discussion.restart', { topic: buildTopic({ discussionSessionId: 's_new' }), session: buildAgentSession({ id: 's_new', purpose: 'discussion', topicId: 'tp_1' }) });
    await restarting;
    expect(selectTopic(stores.topics.getState(), 'tp_1')?.discussionSessionId).toBe('s_new');
  });

  it('revise and a follow-up answer with a message or a suggestion, as the daemon decided by role', async () => {
    const { conn, stores } = await ready();
    const revise = stores.topics.revise({ topicId: 'tp_1', target: 'spec', text: 'Shorter, please' });
    conn.respond('topic.revise', { messageId: 'm_1' });
    expect(await revise).toEqual({ messageId: 'm_1' });
    const followUp = stores.topics.followUp({ topicId: 'tp_1', itemId: 'cart-api', text: 'Why a queue?' });
    expect(conn.lastRequest('report.followUp')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', text: 'Why a queue?' });
    conn.respond('report.followUp', { messageId: 'm_2' });
    expect(await followUp).toEqual({ messageId: 'm_2' });
  });
});

describe('topics store: reports', () => {
  it('a summary updates the plan\'s item and the loaded report; a new version fetches the whole report again', async () => {
    const { conn, stores, flush } = await ready();
    conn.emit('plan.updated', { plan: buildPlan({ items: [buildWorkItem({ state: 'done', report: buildReportSummary() })] }) });
    const loading = stores.topics.loadReport('tp_1', 'cart-api');
    conn.respond('report.get', { report: buildReport() });
    expect((await loading).version).toBe(1);
    expect(stores.topics.getState().reports.has(reportKey('tp_1', 'cart-api'))).toBe(true);

    // Reviewed: the same version, another state. No fetch.
    conn.emit('report.updated', { topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary({ state: 'reviewed' }) });
    expect(selectReport(stores.topics.getState(), 'tp_1', 'cart-api')?.state).toBe('reviewed');
    expect(selectPlan(stores.topics.getState(), 'tp_1')?.items[0]?.report?.state).toBe('reviewed');
    expect(conn.requestsOf('report.get')).toHaveLength(1);

    // A new version: the sections changed, so the whole report is read again.
    conn.emit('report.updated', { topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary({ version: 2, state: 'changed-after-review' }) });
    expect(selectReport(stores.topics.getState(), 'tp_1', 'cart-api')).toMatchObject({ version: 2, state: 'changed-after-review' });
    expect(conn.pendingOf('report.get')).toHaveLength(1);
    conn.respond('report.get', { report: buildReport({ version: 2, sections: { done: 'More.', why: 'x', verified: [], watchOut: 'y' } }) });
    await flush();
    expect(selectReport(stores.topics.getState(), 'tp_1', 'cart-api')?.sections.done).toBe('More.');
  });

  it('a follow-up asked from the report, and its answer, arrive as the unchanged summary: the loaded report is read again', async () => {
    const { conn, stores, flush } = await ready();
    const loading = stores.topics.loadReport('tp_1', 'cart-api');
    conn.respond('report.get', { report: buildReport() });
    expect((await loading).questions).toEqual([]);

    // Someone asked about the result: the daemon announces the report again, and its summary says nothing new.
    const asked = { id: 'fq_1', from: { userId: 'dev:mei', displayName: 'Mei' }, text: 'Why is it partial?', at: 1_700_000_000_000 };
    conn.emit('report.updated', { topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary() });
    expect(conn.pendingOf('report.get')).toHaveLength(1);
    conn.respond('report.get', { report: buildReport({ questions: [asked] }) });
    await flush();
    expect(selectReport(stores.topics.getState(), 'tp_1', 'cart-api')?.questions).toEqual([asked]);

    // The agent answered: the same again.
    const answered = { ...asked, answer: { text: 'One check needs a display.', at: 1_700_000_001_000 } };
    conn.emit('report.updated', { topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary() });
    expect(conn.pendingOf('report.get')).toHaveLength(1);
    conn.respond('report.get', { report: buildReport({ questions: [answered] }) });
    await flush();
    expect(selectReport(stores.topics.getState(), 'tp_1', 'cart-api')?.questions).toEqual([answered]);
  });

  it('two askers of one report share one request; a report that moved on meanwhile is asked for afresh', async () => {
    const { conn, stores, flush } = await ready();
    const first = stores.topics.loadReport('tp_1', 'cart-api');
    const second = stores.topics.loadReport('tp_1', 'cart-api');
    expect(conn.requestsOf('report.get')).toHaveLength(1);
    conn.respond('report.get', { report: buildReport() });
    expect((await first).version).toBe(1);
    expect((await second).version).toBe(1);
    // Afterwards a new ask is a new request.
    void stores.topics.loadReport('tp_1', 'cart-api');
    expect(conn.requestsOf('report.get')).toHaveLength(2);
    // The report gets a new version while that request is on its way: its answer would be the old one.
    conn.emit('report.updated', { topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary({ version: 2 }) });
    expect(conn.pendingOf('report.get')).toHaveLength(2);
    conn.respond('report.get', { report: buildReport() });
    conn.respond('report.get', { report: buildReport({ version: 2 }) });
    await flush();
    expect(selectReport(stores.topics.getState(), 'tp_1', 'cart-api')?.version).toBe(2);
  });

  it('a summary of a report that is not loaded changes only the plan', async () => {
    const { conn, stores } = await ready();
    conn.emit('report.updated', { topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary() });
    expect(stores.topics.getState().reports.size).toBe(0);
    expect(conn.requestsOf('report.get')).toHaveLength(0);
  });

  it('"I\'ve reviewed this" sends the version on screen and applies the summary it gets back', async () => {
    const { conn, stores } = await ready();
    conn.emit('plan.updated', { plan: buildPlan({ items: [buildWorkItem({ state: 'done', report: buildReportSummary() })] }) });
    const reviewing = stores.topics.review({ topicId: 'tp_1', itemId: 'cart-api', version: 1 });
    expect(conn.lastRequest('report.review')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', version: 1 });
    conn.respond('report.review', { report: buildReportSummary({ state: 'reviewed' }) });
    expect((await reviewing).state).toBe('reviewed');
    expect(selectPlan(stores.topics.getState(), 'tp_1')?.items[0]?.report?.state).toBe('reviewed');
  });
});

describe('topics store: what a change of a topic tells everyone', () => {
  it('topicNoticeKind: a new topic, a spec draft, a plan, an updated plan, a complete topic; nothing else', () => {
    const discussing = buildTopic();
    const withSpec = buildTopic({ phase: 'spec', spec: { exists: true } });
    const withPlan = buildTopic({ phase: 'plan', plan });
    expect(topicNoticeKind(undefined, discussing)).toBe('started');
    // A topic that is new to this client but further along (it was restored) is not "started".
    expect(topicNoticeKind(undefined, withPlan)).toBeNull();
    expect(topicNoticeKind(discussing, withSpec)).toBe('spec-ready');
    expect(topicNoticeKind(withSpec, withPlan)).toBe('plan-ready');
    expect(topicNoticeKind(discussing, withPlan)).toBe('plan-ready');
    expect(topicNoticeKind(withPlan, buildTopic({ phase: 'executing', plan }))).toBeNull();
    expect(topicNoticeKind(buildTopic({ phase: 'executing', plan }), buildTopic({ phase: 'complete', plan }))).toBe('complete');
    // The same phase: the agent finished writing the plan again.
    expect(topicNoticeKind(buildTopic({ phase: 'plan', plan: { ...plan, generating: true } }), withPlan)).toBe('plan-updated');
    expect(topicNoticeKind(buildTopic({ phase: 'plan', plan: { ...plan, generating: true } }), buildTopic({ phase: 'plan', plan: { ...plan, valid: false } }))).toBeNull();
    expect(topicNoticeKind(withPlan, buildTopic({ phase: 'plan', plan: { ...plan, reviewed: 1 } }))).toBeNull();
    // Archived topics say nothing, in either direction.
    expect(topicNoticeKind(discussing, buildTopic({ archived: true }))).toBeNull();
    expect(topicNoticeKind(buildTopic({ archived: true }), withSpec)).toBeNull();
    // A phase that goes back (the plan was deleted) says nothing.
    expect(topicNoticeKind(withPlan, withSpec)).toBeNull();
  });

  it('notices come from events after the first snapshot, never from the snapshot itself, and can be dismissed', async () => {
    const { conn, stores, flush, admit } = setupStores();
    admit();
    // Before the list is in: every topic would look new.
    conn.emit('topic.updated', { topic: buildTopic({ id: 'early' }) });
    answerLoads(conn, { 'topic.list': { topics: [buildTopic()], hasMore: false } });
    await flush();
    expect(stores.topics.getState().notices).toEqual([]);

    conn.emit('topic.updated', { topic: buildTopic({ id: 'tp_2', name: 'Search filters' }) });
    conn.emit('topic.updated', { topic: buildTopic({ phase: 'spec', spec: { exists: true } }) });
    conn.emit('topic.updated', { topic: buildTopic({ phase: 'spec', spec: { exists: true }, name: 'Checkout!' }) });
    const notices = stores.topics.getState().notices;
    expect(notices.map((notice) => [notice.kind, notice.topicId, notice.name])).toEqual([
      ['started', 'tp_2', 'Search filters'],
      ['spec-ready', 'tp_1', 'Checkout'],
    ]);
    stores.topics.dismissNotice(notices[0]!.id);
    expect(stores.topics.getState().notices.map((notice) => notice.kind)).toEqual(['spec-ready']);
  });

  it('a new plan is told once: the end of the turn that wrote it is not "the plan was updated"; writing it again is', async () => {
    const { conn, stores, flush, admit } = setupStores();
    admit();
    answerLoads(conn, { 'topic.list': { topics: [buildTopic({ phase: 'spec', spec: { exists: true } })], hasMore: false } });
    await flush();
    const kinds = (): string[] => stores.topics.getState().notices.map((notice) => notice.kind);
    // "Generate plan": the agent writes PLAN.md, the daemon reads it (the phase is `plan`) while the turn still runs…
    conn.emit('topic.updated', { topic: buildTopic({ phase: 'spec', spec: { exists: true }, plan: { ...plan, exists: false, valid: false, generating: true } }) });
    conn.emit('topic.updated', { topic: buildTopic({ phase: 'plan', plan: { ...plan, generating: true } }) });
    expect(kinds()).toEqual(['plan-ready']);
    // …and the turn ends: the same plan, nothing new to tell.
    conn.emit('topic.updated', { topic: buildTopic({ phase: 'plan', plan }) });
    expect(kinds()).toEqual(['plan-ready']);
    // "Update plan" later: the agent writes it again, and that is told when it has finished.
    conn.emit('topic.updated', { topic: buildTopic({ phase: 'plan', plan: { ...plan, generating: true } }) });
    expect(kinds()).toEqual(['plan-ready']);
    conn.emit('topic.updated', { topic: buildTopic({ phase: 'plan', plan }) });
    expect(kinds()).toEqual(['plan-ready', 'plan-updated']);
  });
});
