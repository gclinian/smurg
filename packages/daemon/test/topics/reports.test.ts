// Result reports (design §4.5, §3.9; security S21): what the end of an execution turn does, the report with its
// changes, follow-ups, review marks, the reviewed draft that is ready to merge, and the escalation of a report nobody
// reviews. The REAL topics module; agents, worktrees, conversation and the rest are fakes the test drives.
import { afterEach, describe, expect, it } from 'vitest';
import { SmurgError, reportInfoSchema, type ReportSummary } from '@smurg/protocol';
import { buildMergeRequest } from '../../src/core/fakes/index.ts';
import type { DaemonEvents } from '../../src/core/interfaces.ts';
import { checkReport, handInReport, itemOf, lineIds, reportText, setupTopics, smurgSent, startPlan, topicWithPlan, waitFor, writeReport, type TopicsTest } from './support.ts';

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

/** A topic "Checkout" whose items were started by Mei; returns the session and worktree of each item. */
async function started(items: Parameters<typeof topicWithPlan>[1], prepare?: (topicId: string) => Promise<void>): Promise<{ topicId: string; slug: string; session: (itemId: string) => string; worktree: (itemId: string) => string }> {
  const { topic } = await topicWithPlan(test, items);
  await prepare?.(topic.id);
  await startPlan(test, topic.id);
  return {
    topicId: topic.id,
    slug: topic.slug,
    session: (itemId) => itemOf(test.plan(topic.id), itemId).sessionId as string,
    worktree: (itemId) => itemOf(test.plan(topic.id), itemId).worktreeId as string,
  };
}

function state(topicId: string, itemId: string): string {
  return itemOf(test.plan(topicId), itemId).state;
}

describe('T4.4 a turn without a report is nudged once, then stalled', () => {
  it('missing report: one nudge; still nothing: the item is stalled and its responsible person is told; "Continue" starts over', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'cart-api', title: 'Cart API' }], async (topicId) => {
      await test.mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: 'dev:amy' });
    });
    const sessionId = run.session('cart-api');

    // The agent stops in prose.
    test.fakes.agents.say(sessionId, 'I think I am done.');
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => smurgSent(test, sessionId).some((message) => message.purpose === 'nudge-report'), { what: 'the nudge' });
    expect(lineIds(test, sessionId).at(-1)).toBe('conversation.nudge.report');
    expect(smurgSent(test, sessionId).at(-1)).toMatchObject({ purpose: 'nudge-report', text: 'You stopped without the result report. If you need a decision, ask it with AskUserQuestion. If you are finished, write the report and call check_report.' });
    expect(smurgSent(test, sessionId).at(-1)).not.toHaveProperty('by');
    expect(state(run.topicId, 'cart-api')).toBe('running');

    // It stops again without one: once is all smurg nudges.
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => state(run.topicId, 'cart-api') === 'stalled', { what: 'the item to stall' });
    expect(itemOf(test.plan(run.topicId), 'cart-api')).toMatchObject({ state: 'stalled', stalledBy: 'agent' });
    expect(smurgSent(test, sessionId).filter((message) => message.purpose === 'nudge-report')).toHaveLength(1);
    expect(test.fakes.agents.log.of('setItemState').at(-1)).toEqual([sessionId, { reportRegistered: false, stalled: 'agent' }]);
    expect(test.fakes.agents.get(sessionId)?.status).toBe('stalled');
    // Work that stopped without a card reaches someone: the item's responsible person.
    expect(test.t.ctx.services.topics.attention()).toMatchObject([
      { subject: 'item-stalled', id: `${run.topicId}.cart-api`, recipients: ['dev:amy'], sessionId, itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, target: { kind: 'session', sessionId } },
    ]);

    // "Continue": the agent goes on, and may be nudged afresh.
    await test.mei.conn.request('plan.item.continue', { topicId: run.topicId, itemId: 'cart-api' });
    expect(state(run.topicId, 'cart-api')).toBe('running');
    expect(test.t.ctx.services.topics.attention()).toEqual([]);
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => smurgSent(test, sessionId).filter((message) => message.purpose === 'nudge-report').length === 2, { what: 'a fresh nudge after Continue' });
  });

  it('who is told when nobody is responsible: the member who started it; when they are gone: the host', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }], async (topicId) => {
      await test.mei.conn.request('plan.mode.set', { topicId, mode: 'everyone' });
    });
    const sessionId = run.session('a');
    await test.fakes.agents.interrupt(sessionId, test.principals.host.actor);
    test.fakes.agents.startTurn(sessionId);
    await test.fakes.agents.interrupt(sessionId, test.principals.host.actor);
    await waitFor(() => state(run.topicId, 'a') === 'stalled', { what: 'the item to stall' });
    expect(test.t.ctx.services.topics.attention()[0]?.recipients).toEqual(['dev:mei']);
    test.t.ctx.members.kick('dev:mei', test.principals.host);
    await waitFor(() => test.t.ctx.services.topics.attention()[0]?.recipients[0] === 'dev:host', { what: 'the host to be told' });
  });

  it('a turn a person stopped, or that ended with an error, stalls at once, without a nudge', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    test.fakes.agents.startTurn(run.session('a'));
    await test.fakes.agents.interrupt(run.session('a'), test.principals.mei.actor);
    await waitFor(() => state(run.topicId, 'a') === 'stalled', { what: 'a to stall' });
    expect(itemOf(test.plan(run.topicId), 'a').stalledBy).toBe('stopped');
    test.fakes.agents.startTurn(run.session('b'));
    test.fakes.agents.finishTurn(run.session('b'), { outcome: 'error' });
    await waitFor(() => state(run.topicId, 'b') === 'stalled', { what: 'b to stall' });
    expect(itemOf(test.plan(run.topicId), 'b').stalledBy).toBe('error');
    expect([...smurgSent(test, run.session('a')), ...smurgSent(test, run.session('b'))].map((message) => message.purpose)).toEqual(['start-item', 'start-item']);
    // The next turn of a stalled session makes it run again.
    test.fakes.agents.startTurn(run.session('b'));
    expect(state(run.topicId, 'b')).toBe('running');
  });

  it('a report that exists but was not checked ok gets fix-report: once per content, at most twice in a row, then the item is stalled', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    const fixes = (): string[] => smurgSent(test, sessionId).filter((message) => message.purpose === 'fix-report').map((message) => message.text);

    // A report with a format problem, never checked.
    await writeReport(test, run.slug, 'a', run.worktree('a'), reportText('a').replace('- outcome: complete', '- outcome: SECRET-OUTCOME'));
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => fixes().length === 1, { what: 'the first fix-report' });
    expect(fixes()[0]).toBe(
      'smurg cannot use "specs/checkout/reports/a.md". Line 4: Directly after the marker line the report needs the line "- outcome: complete", "- outcome: partial" or "- outcome: blocked". Fix exactly that and call check_report again.',
    );
    expect(lineIds(test, sessionId).at(-1)).toBe('conversation.fix.report');
    // The same content again: nothing more for it; the item stalls.
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => state(run.topicId, 'a') === 'stalled', { what: 'the item to stall' });
    expect(fixes()).toHaveLength(1);

    // A person lets it continue; the format is right now but the agent still did not call check_report.
    await test.mei.conn.request('plan.item.continue', { topicId: run.topicId, itemId: 'a' });
    await writeReport(test, run.slug, 'a', run.worktree('a'), reportText('a'));
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => fixes().length === 2, { what: 'the fix that asks for the check' });
    expect(fixes()[1]).toBe('smurg cannot use "specs/checkout/reports/a.md" yet: this content was not checked. Call check_report and fix what it reports until it answers ok.');
    expect(fixes().join('\n')).not.toContain('SECRET-OUTCOME');
    expect(test.t.ctx.services.reports.get(run.topicId, 'a')).toBeNull();
  });
});

describe('S21 a planted report is not registered', () => {
  it('a report counts only when the agent\'s own check_report passed for exactly that content in this session', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    // Someone plants a perfectly formatted report in the worktree (people cannot through smurg: PathGuard; this is the daemon's own second line).
    await writeReport(test, run.slug, 'a', run.worktree('a'), reportText('a', { done: 'Planted: everything is fine, merge it.' }));
    test.fakes.agents.finishTurn(run.session('a'));
    await waitFor(() => smurgSent(test, run.session('a')).some((message) => message.purpose === 'fix-report'), { what: 'the agent to be asked for its own check' });
    expect(test.t.ctx.services.reports.get(run.topicId, 'a')).toBeNull();
    expect(state(run.topicId, 'a')).toBe('running');
    expect(test.fakes.worktrees.log.of('snapshot')).toEqual([]);

    // The agent's check covers the content it checked, nothing written afterwards.
    expect(await checkReport(test, run.session('a'))).toEqual({ ok: true });
    await writeReport(test, run.slug, 'a', run.worktree('a'), reportText('a', { done: 'Changed after the check.' }));
    test.fakes.agents.finishTurn(run.session('a'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(test.t.ctx.services.reports.get(run.topicId, 'a')).toBeNull();

    // A check made in ANOTHER session does not count for this one.
    await writeReport(test, run.slug, 'b', run.worktree('b'), reportText('b'));
    expect(await checkReport(test, run.session('a'))).toEqual({ ok: true });
    test.fakes.agents.finishTurn(run.session('b'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(test.t.ctx.services.reports.get(run.topicId, 'b')).toBeNull();
    // And the tool is the item session's alone.
    const discussion = test.topic(run.topicId).discussionSessionId as string;
    expect(await checkReport(test, discussion)).toEqual({ ok: false, errors: [{ message: 'This tool is for the session of a work item. This session is not one.' }] });
  });

  it('check_report answers the format findings with their lines, and says when the file is not there', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    expect(await checkReport(test, run.session('a'))).toEqual({ ok: false, errors: [{ message: '"specs/checkout/reports/a.md" does not exist. Write it first, then call check_report.' }] });
    await writeReport(test, run.slug, 'a', run.worktree('a'), reportText('a').replace('## Why it was done this way\nIt was the simplest way.\n', '## Why it was done this way\n'));
    expect(await checkReport(test, run.session('a'))).toEqual({ ok: false, errors: [{ line: 9, message: 'This section is empty. Every section needs at least one sentence.' }] });
    // A report of another item (a copied file) is not this item's report.
    await writeReport(test, run.slug, 'a', run.worktree('a'), reportText('other-item'));
    expect((await checkReport(test, run.session('a'))).ok).toBe(false);
  });
});

describe('T5.1 a report with its changes and a follow-up', () => {
  it('a checked report at the end of a turn becomes a version: the draft merge request, the sections, a pointer, the item is done; a follow-up is answered in the report', async () => {
    test = await setupTopics();
    const updates: { itemId: string; report: ReportSummary }[] = [];
    const run = await started([{ id: 'cart-api', title: 'Cart API' }], async (topicId) => {
      await test.mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: 'dev:mei' });
    });
    test.amy.conn.on('report.updated', (payload) => updates.push({ itemId: payload.itemId, report: payload.report }));
    const sessionId = run.session('cart-api');
    const worktreeId = run.worktree('cart-api');
    test.fakes.worktrees.snapshotStats = { files: 4, additions: 120, deletions: 7, byHand: [{ path: 'src/cart.ts', by: [{ userId: 'dev:amy', displayName: 'Amy' }] }] };

    await handInReport(test, run.slug, 'cart-api', { text: reportText('cart-api', { outcome: 'partial' }), finalText: 'Done, see the report.' });
    await waitFor(() => state(run.topicId, 'cart-api') === 'done', { what: 'the item to be done' });

    const { report } = await test.amy.conn.request('report.get', { topicId: run.topicId, itemId: 'cart-api' });
    expect(reportInfoSchema.safeParse(report).success).toBe(true);
    const draft = test.fakes.worktrees.listMerges(test.principals.host)[0];
    expect(report).toMatchObject({
      version: 1,
      outcome: 'partial',
      state: 'to-review',
      reviewers: [{ userId: 'dev:mei', displayName: 'Mei' }],
      checks: { passed: 1, notVerified: 1 },
      topicId: run.topicId,
      itemId: 'cart-api',
      file: { root: { kind: 'worktree', worktreeId }, path: 'specs/checkout/reports/cart-api.md' },
      sections: {
        done: 'Everything of cart-api.',
        why: 'It was the simplest way.',
        verified: [{ text: '`pnpm test`: all tests passed', passed: true }, { text: 'Manual check', passed: false, note: 'no browser in this session' }],
        watchOut: 'Nothing special.',
      },
      changes: { requestId: draft?.id, files: 4, additions: 120, deletions: 7, byHand: [{ path: 'src/cart.ts', by: [{ userId: 'dev:amy', displayName: 'Amy' }] }] },
      questions: [],
    });
    // The snapshot is the report's diff: a DRAFT merge request of the item's worktree.
    expect(test.fakes.worktrees.log.of('snapshot')).toEqual([[{ worktreeId, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' }]]);
    expect(draft).toMatchObject({ status: 'draft', reviewed: false, topicId: run.topicId, itemId: 'cart-api' });
    const item = itemOf(test.plan(run.topicId), 'cart-api');
    expect(item).toMatchObject({ state: 'done', report: { version: 1, outcome: 'partial', state: 'to-review' }, merge: { requestId: draft?.id, status: 'draft', ready: false } });
    // In the conversation: a pointer to the report; the session is `done`.
    expect(test.fakes.agents.eventsOf(sessionId).filter((event) => event.kind === 'pointer')).toMatchObject([{ target: 'report', topicId: run.topicId, itemId: 'cart-api', version: 1 }]);
    expect(test.fakes.agents.get(sessionId)?.status).toBe('done');
    expect(test.t.ctx.services.reports.toReview()).toMatchObject([{ topicId: run.topicId, itemId: 'cart-api', report: { version: 1, state: 'to-review' } }]);
    expect(test.plan(run.topicId).waitingFor).toMatchObject([{ user: { userId: 'dev:mei' }, questions: 0, permissions: 0, reports: 1 }]);
    await waitFor(() => updates.some((update) => update.report.version === 1), { what: 'report.updated on the wire' });
    expect((await test.audit('report.register'))[0]).toMatchObject({ actor: { kind: 'system' }, detail: { topicId: run.topicId, itemId: 'cart-api', version: 1, outcome: 'partial', sessionId, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    // Nothing was nudged or fixed on the way.
    expect(smurgSent(test, sessionId).map((message) => message.purpose)).toEqual(['start-item']);

    // ---- a turn that changes nothing makes no new version ----
    test.fakes.agents.say(sessionId, 'Anything else?');
    test.fakes.agents.finishTurn(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(test.t.ctx.services.reports.get(run.topicId, 'cart-api')?.version).toBe(1);

    // ---- a follow-up from the report ----
    const asked = await test.mei.conn.request('report.followUp', { topicId: run.topicId, itemId: 'cart-api', text: 'Why is the browser check missing?' });
    expect(asked).toHaveProperty('messageId');
    expect(test.fakes.conversation.log.of('sendAs').at(-1)?.[1]).toEqual({ sessionId, text: 'Why is the browser check missing?', origin: 'follow-up', topicId: run.topicId, itemId: 'cart-api' });
    expect(itemOf(test.plan(run.topicId), 'cart-api').changesAsked).toMatchObject({ by: { userId: 'dev:mei', displayName: 'Mei' } });
    let current = (await test.mei.conn.request('report.get', { topicId: run.topicId, itemId: 'cart-api' })).report;
    expect(current.questions).toMatchObject([{ from: { userId: 'dev:mei' }, text: 'Why is the browser check missing?' }]);
    expect(current.questions[0]?.answer).toBeUndefined();
    // The turn that took the message ends: its final text is the answer. Nothing changed, so no new version.
    test.fakes.agents.finishTurn(sessionId, { finalText: 'There is no browser in this session.' });
    await waitFor(async () => (await test.mei.conn.request('report.get', { topicId: run.topicId, itemId: 'cart-api' })).report.questions[0]?.answer !== undefined, { what: 'the answer' });
    current = (await test.mei.conn.request('report.get', { topicId: run.topicId, itemId: 'cart-api' })).report;
    expect(current).toMatchObject({ version: 1, questions: [{ text: 'Why is the browser check missing?', answer: { text: 'There is no browser in this session.' } }] });

    // ---- "tell Claude what to change": the agent changes files and the report; a new version clears "changes asked" ----
    await test.mei.conn.request('report.followUp', { topicId: run.topicId, itemId: 'cart-api', text: 'Add the stock check.' });
    await handInReport(test, run.slug, 'cart-api', { text: reportText('cart-api', { done: 'Everything, and the stock check.' }), finalText: 'Added.' });
    await waitFor(() => test.t.ctx.services.reports.get(run.topicId, 'cart-api')?.version === 2, { what: 'version 2' });
    current = (await test.mei.conn.request('report.get', { topicId: run.topicId, itemId: 'cart-api' })).report;
    expect(current).toMatchObject({ version: 2, outcome: 'complete', state: 'to-review', sections: { done: 'Everything, and the stock check.' } });
    expect(current.questions.map((question) => question.answer?.text)).toEqual(['There is no browser in this session.', 'Added.']);
    expect(itemOf(test.plan(run.topicId), 'cart-api').changesAsked).toBeUndefined();
    // The newer draft replaced the older one.
    expect(test.fakes.worktrees.listMerges(test.principals.host)).toHaveLength(1);
    expect(current.changes?.requestId).toBe(test.fakes.worktrees.listMerges(test.principals.host)[0]?.id);
  });

  it('an Editor\'s follow-up is a suggestion; once a member with agent access accepted it, it is a question of the report with its answer', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    await handInReport(test, run.slug, 'a');
    await waitFor(() => state(run.topicId, 'a') === 'done', { what: 'done' });

    const suggested = await test.amy.conn.request('report.followUp', { topicId: run.topicId, itemId: 'a', text: 'Does it handle an empty cart?' });
    expect(suggested).toMatchObject({ suggestion: { author: { userId: 'dev:amy' }, origin: 'follow-up', topicId: run.topicId, itemId: 'a', sessionId, status: 'pending' } });
    // Not a question of the report yet, and not one byte of it reached the agent.
    expect(test.t.ctx.services.reports.get(run.topicId, 'a')?.questions).toEqual([]);
    expect(itemOf(test.plan(run.topicId), 'a').changesAsked).toBeUndefined();
    expect(test.fakes.agents.sentTo(sessionId).filter((message) => message.kind === 'person')).toEqual([]);

    const suggestionId = (suggested as { suggestion: { id: string } }).suggestion.id;
    await test.mei.conn.request('suggest.accept', { suggestionId });
    expect(itemOf(test.plan(run.topicId), 'a').changesAsked).toMatchObject({ by: { userId: 'dev:amy' } });
    test.fakes.agents.finishTurn(sessionId, { finalText: 'Yes: an empty cart shows the empty state.' });
    await waitFor(() => (test.t.ctx.services.reports.get(run.topicId, 'a')?.questions.length ?? 0) === 1, { what: 'the accepted follow-up' });
    expect(test.t.ctx.services.reports.get(run.topicId, 'a')?.questions).toMatchObject([{ from: { userId: 'dev:amy', displayName: 'Amy' }, text: 'Does it handle an empty cart?', answer: { text: 'Yes: an empty cart shows the empty state.' } }]);

    // A rejected one is simply forgotten.
    const second = (await test.amy.conn.request('report.followUp', { topicId: run.topicId, itemId: 'a', text: 'Second thought' })) as { suggestion: { id: string } };
    await test.mei.conn.request('suggest.reject', { suggestionId: second.suggestion.id });
    test.fakes.agents.finishTurn(sessionId, { finalText: 'Nothing new.' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(test.t.ctx.services.reports.get(run.topicId, 'a')?.questions).toHaveLength(1);
  });

  it('a snapshot the merge policy refuses still registers the report, without changes, and says why in the session', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    test.fakes.worktrees.refuseSnapshot.set(run.worktree('a'), { ok: false, reason: 'conflict-markers', files: ['src/cart.ts'] });
    await handInReport(test, run.slug, 'a');
    await waitFor(() => state(run.topicId, 'a') === 'done', { what: 'done' });
    const report = test.t.ctx.services.reports.get(run.topicId, 'a');
    expect(report).toMatchObject({ version: 1, noChanges: 'conflict-markers' });
    expect(report?.changes).toBeUndefined();
    expect(itemOf(test.plan(run.topicId), 'a').merge).toBeUndefined();
    expect(test.fakes.agents.eventsOf(run.session('a')).find((event) => event.kind === 'notice')).toMatchObject({ level: 'warning', text: { id: 'report.changes.markers', params: { files: ['src/cart.ts'] } } });
  });

  it('there is no report before one is registered; a follow-up needs one', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    expect(await refusal(test.mei.conn.request('report.get', { topicId: run.topicId, itemId: 'a' }))).toMatchObject({ code: 'not_found', text: { id: 'report.none' } });
    expect(await refusal(test.mei.conn.request('report.followUp', { topicId: run.topicId, itemId: 'a', text: 'x' }))).toMatchObject({ code: 'not_found', text: { id: 'report.none' } });
    expect(await refusal(test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1 }))).toMatchObject({ code: 'not_found', text: { id: 'report.none' } });
    expect(test.t.ctx.services.reports.toReview()).toEqual([]);
  });
});

describe('T5.2 review, change after review, topic complete', () => {
  it('the reviewer marks it reviewed; unfinished work needs a second look; a change afterwards asks again; all reviewed: the topic is complete', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }, { id: 'b' }], async (topicId) => {
      await test.mei.conn.request('plan.assign', { topicId, itemId: 'a', userId: 'dev:amy' });
      await test.mei.conn.request('plan.assign', { topicId, itemId: 'b', userId: 'dev:mei' });
    });
    await handInReport(test, run.slug, 'a', { text: reportText('a', { outcome: 'blocked' }) });
    await handInReport(test, run.slug, 'b');
    await waitFor(() => state(run.topicId, 'a') === 'done' && state(run.topicId, 'b') === 'done', { what: 'both done' });
    expect(test.topic(run.topicId)).toMatchObject({ phase: 'executing', plan: { reviewed: 0 } });

    // ---- who may: the responsible person (an Editor may review); not someone else, not for an older version ----
    expect(await refusal(test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1, acknowledgeUnfinished: true }))).toMatchObject({ code: 'forbidden', text: { id: 'report.notReviewer', params: { name: 'Amy' } } });
    expect(await refusal(test.amy.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 7, acknowledgeUnfinished: true }))).toMatchObject({ code: 'conflict', detail: { reason: 'report-changed' }, text: { id: 'report.changed' } });
    // A report that is not `complete` is marked reviewed only on purpose.
    expect(await refusal(test.amy.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1 }))).toMatchObject({ code: 'conflict', detail: { reason: 'unfinished' }, text: { id: 'report.unfinished' } });
    const reviewed = (await test.amy.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1, acknowledgeUnfinished: true })).report;
    expect(reviewed).toMatchObject({ state: 'reviewed', review: { by: { userId: 'dev:amy', displayName: 'Amy' }, version: 1 } });
    expect(reviewed.review?.insteadOf).toBeUndefined();
    expect(state(run.topicId, 'a')).toBe('reviewed');
    expect(test.topic(run.topicId)).toMatchObject({ phase: 'executing', plan: { reviewed: 1 } });
    expect(test.t.ctx.services.reports.toReview().map((entry) => entry.itemId)).toEqual(['b']);
    expect((await test.audit('report.review'))[0]).toMatchObject({ actor: { kind: 'user', userId: 'dev:amy' }, detail: { topicId: run.topicId, itemId: 'a', version: 1, acknowledgedUnfinished: true } });

    // ---- the report changes after the review: the item stays reviewed, the report asks again ----
    await handInReport(test, run.slug, 'a', { text: reportText('a', { done: 'Now complete.' }) });
    await waitFor(() => test.t.ctx.services.reports.get(run.topicId, 'a')?.version === 2, { what: 'version 2' });
    expect(test.t.ctx.services.reports.get(run.topicId, 'a')).toMatchObject({ version: 2, state: 'changed-after-review', outcome: 'complete', review: { version: 1 } });
    expect(state(run.topicId, 'a')).toBe('reviewed');
    expect(test.t.ctx.services.reports.toReview().map((entry) => entry.itemId).sort()).toEqual(['a', 'b']);
    expect(test.topic(run.topicId).plan.reviewed).toBe(0);

    await test.amy.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 2 });
    expect(test.topic(run.topicId).phase).toBe('executing');
    await test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'b', version: 1 });
    // Every item of the plan is reviewed.
    expect(test.topic(run.topicId)).toMatchObject({ phase: 'complete', plan: { items: 2, reviewed: 2, merged: 0 } });
    expect(test.t.ctx.services.reports.toReview()).toEqual([]);
  });

  it('with nobody assigned anyone who may discuss reviews, once, for all; a Viewer never', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }], async (topicId) => {
      await test.mei.conn.request('plan.mode.set', { topicId, mode: 'everyone' });
    });
    const leo = await test.t.connect({ userId: 'dev:leo', displayName: 'Leo', role: 'viewer' });
    await handInReport(test, run.slug, 'a');
    await waitFor(() => state(run.topicId, 'a') === 'done', { what: 'done' });
    expect(test.t.ctx.services.reports.get(run.topicId, 'a')?.reviewers.map((reviewer) => reviewer.userId)).toEqual(['dev:host', 'dev:mei', 'dev:amy']);
    expect(await refusal(leo.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1 }))).toMatchObject({ code: 'forbidden' });
    expect((await test.amy.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1 })).report.state).toBe('reviewed');
  });

  it('who reviews follows who is responsible, and who is still a member', async () => {
    test = await setupTopics();
    const changes: DaemonEvents['report.changed'][] = [];
    const run = await started([{ id: 'a' }], async (topicId) => {
      await test.mei.conn.request('plan.assign', { topicId, itemId: 'a', userId: 'dev:amy' });
    });
    await handInReport(test, run.slug, 'a');
    await waitFor(() => state(run.topicId, 'a') === 'done', { what: 'done' });
    test.t.ctx.bus.on('report.changed', (event: DaemonEvents['report.changed']) => changes.push(event));
    const reviewers = (): string[] => test.t.ctx.services.reports.get(run.topicId, 'a')?.reviewers.map((reviewer) => reviewer.userId) ?? [];
    expect(reviewers()).toEqual(['dev:amy']);
    await test.mei.conn.request('plan.assign', { topicId: run.topicId, itemId: 'a', userId: 'dev:mei' });
    expect(reviewers()).toEqual(['dev:mei']);
    expect(changes.at(-1)).toMatchObject({ itemId: 'a', report: { reviewers: [{ userId: 'dev:mei' }] }, previous: { reviewers: [{ userId: 'dev:amy' }] } });
    // The responsible person is kicked: the session's record is cleared by the teardown, everyone who may discuss reviews.
    test.fakes.agents.setResponsible(run.session('a'), null, { kind: 'system' });
    expect(reviewers()).toEqual(['dev:host', 'dev:mei', 'dev:amy']);
    test.t.ctx.members.kick('dev:amy', test.principals.host);
    await waitFor(() => reviewers().length === 2, { what: 'the kicked member to leave the reviewers' });
    expect(reviewers()).toEqual(['dev:host', 'dev:mei']);
  });
});

describe('T5.3 a reviewed draft is ready to merge', () => {
  it('reviewing puts the draft in front of the host; merging finishes the item (its session ends, its worktree goes) and starts what waited', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'cart-api' }, { id: 'checkout-page', dependsOn: ['cart-api'] }], async (topicId) => {
      await test.mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: 'dev:mei' });
    });
    const sessionId = run.session('cart-api');
    const worktreeId = run.worktree('cart-api');
    await handInReport(test, run.slug, 'cart-api');
    await waitFor(() => state(run.topicId, 'cart-api') === 'done', { what: 'done' });
    const requestId = test.t.ctx.services.reports.get(run.topicId, 'cart-api')?.changes?.requestId as string;
    expect(itemOf(test.plan(run.topicId), 'cart-api').merge).toEqual({ requestId, status: 'draft', ready: false });

    // Reviewing is not merging, but it must not strand the work: the draft is marked reviewed (the host's inbox).
    await test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'cart-api', version: 1 });
    expect(test.fakes.worktrees.log.of('setReviewed')).toEqual([[requestId, true]]);
    expect(itemOf(test.plan(run.topicId), 'cart-api')).toMatchObject({ state: 'reviewed', merge: { requestId, status: 'draft', ready: true } });
    // Reviewed is not merged: the dependent item still waits, and the session is still there for questions.
    expect(itemOf(test.plan(run.topicId), 'checkout-page')).toMatchObject({ state: 'waiting', waitsFor: ['cart-api'] });
    expect(test.fakes.agents.get(sessionId)?.status).not.toBe('ended');

    // The host merges (a draft directly).
    await test.fakes.worktrees.approve({ requestId }, test.principals.host);
    await waitFor(() => itemOf(test.plan(run.topicId), 'checkout-page').state === 'running', { what: 'the dependent item to start' });
    await waitFor(() => test.fakes.agents.get(sessionId)?.status === 'ended', { what: 'the finished item\'s session to end' });
    expect(test.fakes.agents.get(sessionId)).toMatchObject({ status: 'ended', endReason: 'merged' });
    expect(test.fakes.agents.log.of('end').at(-1)).toEqual([sessionId, { by: { kind: 'system' }, reason: 'merged', keepWorktree: true }]);
    await waitFor(() => test.fakes.worktrees.get(worktreeId) === null, { what: 'the worktree to be released' });
    expect(test.fakes.worktrees.log.of('releaseItem')).toEqual([[worktreeId]]);
    const finished = itemOf(test.plan(run.topicId), 'cart-api');
    expect(finished).toMatchObject({ state: 'reviewed', merge: { status: 'merged' } });
    expect(finished.worktreeId).toBeUndefined();
    expect(test.topic(run.topicId).plan).toMatchObject({ merged: 1, reviewed: 1 });
    // Its conversation and report stay readable; a follow-up points to the discussion.
    expect(test.t.ctx.services.reports.get(run.topicId, 'cart-api')?.version).toBe(1);
    expect(await refusal(test.mei.conn.request('report.followUp', { topicId: run.topicId, itemId: 'cart-api', text: 'One more thing' }))).toMatchObject({ code: 'conflict', text: { id: 'report.closed' } });
  });

  it('merged before it was reviewed ("Request merge"): what waited starts, and the review finishes the item', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }], async (topicId) => {
      await test.mei.conn.request('plan.assign', { topicId, itemId: 'a', userId: 'dev:mei' });
    });
    const sessionId = run.session('a');
    await handInReport(test, run.slug, 'a');
    await waitFor(() => state(run.topicId, 'a') === 'done', { what: 'done' });
    const requestId = test.t.ctx.services.reports.get(run.topicId, 'a')?.changes?.requestId as string;
    test.fakes.worktrees.putRequest({ ...buildMergeRequest({ id: requestId, worktreeId: run.worktree('a'), topicId: run.topicId, itemId: 'a' }), status: 'merged' });
    await waitFor(() => state(run.topicId, 'b') === 'running', { what: 'b to start' });
    expect(test.fakes.agents.get(sessionId)?.status).not.toBe('ended');
    expect(state(run.topicId, 'a')).toBe('done');
    await test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1 });
    expect(test.fakes.agents.get(sessionId)).toMatchObject({ status: 'ended', endReason: 'merged' });
  });
});

describe('after a merge conflict', () => {
  it('the turn that took resolve-conflict is snapshotted again whatever the report did; a worktree a person removed takes its draft with it', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    await handInReport(test, run.slug, 'a');
    await waitFor(() => state(run.topicId, 'a') === 'done', { what: 'done' });
    const first = test.t.ctx.services.reports.get(run.topicId, 'a')?.changes?.requestId as string;
    test.fakes.worktrees.conflict(first, ['src/cart.ts']);
    expect(itemOf(test.plan(run.topicId), 'a').merge).toEqual({ requestId: first, status: 'conflict', ready: false });
    test.fakes.worktrees.conflictedFiles = [];
    await test.mei.conn.request('plan.item.resolve', { topicId: run.topicId, itemId: 'a' });
    // The agent verifies and changes nothing: the merge smurg made is still a change of the worktree.
    test.fakes.agents.finishTurn(sessionId, { finalText: 'Verified again.' });
    await waitFor(() => test.t.ctx.services.reports.get(run.topicId, 'a')?.version === 2, { what: 'version 2' });
    expect(test.fakes.worktrees.log.of('snapshot')).toHaveLength(2);
    const second = test.t.ctx.services.reports.get(run.topicId, 'a')?.changes?.requestId as string;
    expect(second).not.toBe(first);
    expect(itemOf(test.plan(run.topicId), 'a').merge).toEqual({ requestId: second, status: 'draft', ready: false });

    // The host removes the worktree by hand.
    const worktreeId = run.worktree('a');
    await test.fakes.worktrees.remove(worktreeId, test.principals.host);
    const item = itemOf(test.plan(run.topicId), 'a');
    expect(item.worktreeId).toBeUndefined();
    expect(item.merge).toBeUndefined();
  });
});

describe('a report nobody reviews', () => {
  it('after six times the waiting time it is also for members with agent access, who may review instead', async () => {
    test = await setupTopics({ settings: { escalateAfterMs: 60_000 } });
    const run = await started([{ id: 'a' }], async (topicId) => {
      await test.mei.conn.request('plan.assign', { topicId, itemId: 'a', userId: 'dev:amy' });
    });
    await handInReport(test, run.slug, 'a');
    await waitFor(() => state(run.topicId, 'a') === 'done', { what: 'done' });
    // Mei is not the reviewer.
    expect(await refusal(test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1 }))).toMatchObject({ code: 'forbidden', text: { id: 'report.notReviewer' } });
    test.t.advanceClock(5 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(test.t.ctx.services.reports.get(run.topicId, 'a')?.escalatedAt).toBeUndefined();
    test.t.advanceClock(61_000);
    await waitFor(() => test.t.ctx.services.reports.get(run.topicId, 'a')?.escalatedAt !== undefined, { what: 'the report to escalate' });
    expect(test.t.ctx.services.reports.toReview()[0]?.report.escalatedAt).toBeDefined();
    // "Review instead of Amy": recorded.
    const reviewed = (await test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1 })).report;
    expect(reviewed).toMatchObject({ state: 'reviewed', review: { by: { userId: 'dev:mei' }, insteadOf: { userId: 'dev:amy', displayName: 'Amy' } } });
    expect(reviewed.escalatedAt).toBeUndefined();
    expect((await test.audit('report.review'))[0]).toMatchObject({ detail: { insteadOf: 'dev:amy' } });
  });
});
