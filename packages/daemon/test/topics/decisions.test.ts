// What needs a person, and the end of a topic (DESIGN 0.7.0 D9, D11, D13): the REAL topics module with the in-memory
// fakes (the fake worktree module merges what it is asked to, through a `main` queue a test can hold, and can hold a
// merge past its last "still in order" as a `git merge` that runs). The inbox rows of the same facts are derive.test's
// (pure) and release-flow.unattended.test's (the release composition with the stand-in `claude`); items that ran
// directly in the folder (D10) are no-git.test's.
import { afterEach, describe, expect, it } from 'vitest';
import { SmurgError, type WorkItem } from '@smurg/protocol';
import { handInReport, itemOf, lineIds, reportText, settle, setupTopics, smurgSent, startPlan, storedItem, storedReport, topicWithPlan, waitFor, checkReport, writeReport, type TopicsTest } from './support.ts';

let test: TopicsTest;
afterEach(async () => {
  await test?.cleanup();
});

const MEI = { userId: 'dev:mei', displayName: 'Mei' };
const HOST = { userId: 'dev:host', displayName: 'Host' };
const AMY = { userId: 'dev:amy', displayName: 'Amy' };

async function refusal(promise: Promise<unknown>): Promise<SmurgError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SmurgError) return err;
    throw err;
  }
  throw new Error('the request was not refused');
}

/** A topic of these items, Mei responsible for each, started by Mei, in a workspace that merges by itself. */
async function started(items: Parameters<typeof topicWithPlan>[1], options: { readonly name?: string; readonly responsible?: Readonly<Record<string, string>> } = {}): Promise<{ topicId: string; slug: string; session: (itemId: string) => string; worktree: (itemId: string) => string }> {
  const { topic } = await topicWithPlan(test, items, options.name ?? 'Checkout');
  for (const item of items) await test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: item.id, userId: options.responsible?.[item.id] ?? MEI.userId });
  await startPlan(test, topic.id);
  return {
    topicId: topic.id,
    slug: topic.slug,
    session: (itemId) => itemOf(test.plan(topic.id), itemId).sessionId as string,
    worktree: (itemId) => itemOf(test.plan(topic.id), itemId).worktreeId as string,
  };
}

const item = (topicId: string, itemId: string): WorkItem => itemOf(test.plan(topicId), itemId);
const tried = (): string[] => test.fakes.worktrees.log.of('autoMerge').map((call) => (call[0] as { requestId: string }).requestId);
async function mergedBySmurg(topicId: string, itemId: string): Promise<void> {
  await waitFor(() => item(topicId, itemId).merged?.by === 'smurg', { what: `smurg to merge ${itemId}` });
}
const decisionsOf = (topicId: string): Record<string, number> => Object.fromEntries(test.plan(topicId).waitingFor.filter((entry) => entry.decisions > 0).map((entry) => [entry.user.userId, entry.decisions]));

describe('DESIGN 0.7.0 D9: a decision stops only its item, and the right person decides', () => {
  it('a report that is not complete is the responsible person\'s decision; after the escalation time also the host\'s and agent access\'s; a host-only hold is the host\'s and never escalates', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c' }]);
    test.fakes.worktrees.refuseSnapshot.set(run.worktree('c'), { ok: false, reason: 'host-only-paths', files: ['CLAUDE.md'] });
    await handInReport(test, run.slug, 'a', { text: reportText('a', { outcome: 'partial' }) });
    await handInReport(test, run.slug, 'c');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'held' && item(run.topicId, 'c').autoMerge?.state === 'held', { what: 'a and c to be held' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'partial', hostOnly: false, escalated: false });
    expect(item(run.topicId, 'c').autoMerge).toMatchObject({ state: 'held', reason: 'policy', hostOnly: true, escalated: false, paths: ['CLAUDE.md'] });
    // What depends on a waits; the plan says who decides what.
    expect(item(run.topicId, 'b')).toMatchObject({ state: 'waiting', waitsFor: ['a'] });
    expect(decisionsOf(run.topicId)).toEqual({ [MEI.userId]: 1, [HOST.userId]: 1 });

    // Five minutes (the host's setting) later the decision on a reaches the host and every member with agent access too.
    await settle(test);
    expect(item(run.topicId, 'a').autoMerge?.escalated).toBe(false);
    test.t.advanceClock(test.t.ctx.settings.get().escalateAfterMs + 1);
    await settle(test);
    await waitFor(() => item(run.topicId, 'a').autoMerge?.escalated === true, { what: 'the decision on a to escalate' });
    expect((await storedItem(test, run.topicId, 'a')).autoMerge?.escalatedAt).toEqual(expect.any(Number));
    expect(item(run.topicId, 'c').autoMerge).toMatchObject({ hostOnly: true, escalated: false });
    expect((await storedItem(test, run.topicId, 'c')).autoMerge?.escalatedAt).toBeUndefined();
    expect(decisionsOf(run.topicId)).toEqual({ [MEI.userId]: 1, [HOST.userId]: 2 });
    expect(tried()).toEqual([]);
  });

  it('an item whose session waits for an answer or a permission says so, and smurg merges nothing of it meanwhile', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    test.fakes.agents.raise(run.session('a'), { id: 'rq_q', kind: 'question', toolUseId: 'tu_1', parts: [{ header: 'Cart', text: 'Where?', multi: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] });
    await waitFor(() => item(run.topicId, 'a').waiting === 'question', { what: 'a to say it waits for an answer' });
    expect(item(run.topicId, 'a').state).toBe('running');
    expect(item(run.topicId, 'b').waiting).toBeUndefined();
    test.fakes.agents.raise(run.session('b'), { id: 'rq_p', kind: 'permission', toolUseId: 'tu_2', tool: 'Bash', view: { name: 'Bash', verb: 'run', target: 'curl example.invalid' }, input: { command: 'curl example.invalid' } });
    await waitFor(() => item(run.topicId, 'b').waiting === 'permission', { what: 'b to say it waits for a permission' });
    test.fakes.agents.finishTurn(run.session('a'));
    await waitFor(() => item(run.topicId, 'a').waiting === undefined, { what: 'a no longer to wait' });
  });
});

describe('DESIGN 0.7.0 D9: "Merge it as it is" (plan.item.release)', () => {
  it('a later turn a person stopped holds the version for its carers; an Editor cannot let it stand, nor anybody for an older version or another hold; Mei can, and smurg merges it', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    await handInReport(test, run.slug, 'b', { text: reportText('b', { outcome: 'blocked' }) });
    const release = test.fakes.worktrees.holdMain();
    await handInReport(test, run.slug, 'a');
    await waitFor(() => tried().length === 1, { what: 'a\'s merge to wait in the queue' });
    test.fakes.agents.startTurn(run.session('a'));
    test.fakes.agents.finishTurn(run.session('a'), { outcome: 'interrupted', stoppedBy: MEI });
    release();
    await waitFor(() => item(run.topicId, 'a').autoMerge?.reason === 'stopped', { what: 'a to be held' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'stopped', hostOnly: false });

    expect(await refusal(test.amy.conn.request('plan.item.release', { topicId: run.topicId, itemId: 'a', version: 1 }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(test.mei.conn.request('plan.item.release', { topicId: run.topicId, itemId: 'a', version: 2 }))).toMatchObject({ code: 'conflict', text: { id: 'report.changed' } });
    // b is held for a report that is not complete: "Merge it as it is" is not for that.
    expect(await refusal(test.mei.conn.request('plan.item.release', { topicId: run.topicId, itemId: 'b', version: 1 }))).toMatchObject({ code: 'conflict', text: { id: 'plan.item.release.notHeld' }, detail: { reason: 'not-held' } });
    expect(tried()).toHaveLength(1);

    await test.mei.conn.request('plan.item.release', { topicId: run.topicId, itemId: 'a', version: 1 });
    await mergedBySmurg(run.topicId, 'a');
    expect((await storedItem(test, run.topicId, 'a')).lastTurn).toBeUndefined();
    expect((await storedReport(test, run.topicId, 'a'))?.checkedInTurn).toBe(true);
    expect(lineIds(test, run.session('a'))).toContain('conversation.released');
    expect((await test.audit('plan.item.release')).map((entry) => [entry.actor.kind === 'user' ? entry.actor.userId : entry.actor.kind, entry.detail])).toEqual([[MEI.userId, { topicId: run.topicId, itemId: 'a', version: 1, reason: 'stopped' }]]);
    // A merged item is held for nothing any more.
    expect(await refusal(test.mei.conn.request('plan.item.release', { topicId: run.topicId, itemId: 'a', version: 1 }))).toMatchObject({ text: { id: 'plan.item.release.notHeld' } });
  });

  it('somebody wrote to the agent after its report and its answer made no new version: held, naming who wrote; "Merge it as it is" lets it merge', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }]);
    const release = test.fakes.worktrees.holdMain();
    await handInReport(test, run.slug, 'a');
    await waitFor(() => tried().length === 1, { what: 'a\'s merge to wait in the queue' });
    await test.mei.conn.request('report.followUp', { topicId: run.topicId, itemId: 'a', text: 'Is the total rounded?' });
    test.fakes.agents.finishTurn(run.session('a'), { finalText: 'Yes, it is.' });
    release();
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'held', { what: 'a to be held' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'asked', asked: MEI, hostOnly: false });
    expect(item(run.topicId, 'a').merged).toBeUndefined();
    await test.host.conn.request('plan.item.release', { topicId: run.topicId, itemId: 'a', version: 1 });
    await mergedBySmurg(run.topicId, 'a');
    expect(item(run.topicId, 'a').changesAsked).toBeUndefined();
  });

  it('its report was not checked again after its last change and its agent did not check it when asked: "Merge it as it is" lets that version stand', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    // The report is checked, the turn is stopped before its end registers it, and "Continue" changes nothing.
    await writeReport(test, run.slug, 'a', run.worktree('a'), reportText('a'));
    expect((await checkReport(test, sessionId)).ok).toBe(true);
    test.fakes.agents.finishTurn(sessionId, { outcome: 'interrupted' });
    await waitFor(() => item(run.topicId, 'a').state === 'stalled', { what: 'the stopped turn' });
    await test.mei.conn.request('plan.item.continue', { topicId: run.topicId, itemId: 'a' });
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => smurgSent(test, sessionId).some((message) => message.purpose === 'verify-again'), { what: 'verify-again' });
    test.fakes.agents.finishTurn(sessionId, { finalText: 'It is fine.' });
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'held', { what: 'the hold' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ reason: 'stale-report' });
    await test.mei.conn.request('plan.item.release', { topicId: run.topicId, itemId: 'a', version: 1 });
    await mergedBySmurg(run.topicId, 'a');
  });
});

describe('DESIGN 0.7.0 D9: "Ask the agent to take them out" (plan.item.removePaths)', () => {
  it('files only the host may merge: the host asks the agent to undo exactly those; its next version merges by itself', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    test.fakes.worktrees.refuseSnapshot.set(run.worktree('a'), { ok: false, reason: 'host-only-paths', files: ['CLAUDE.md', '.claude/settings.json'] });
    await handInReport(test, run.slug, 'a');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.reason === 'policy', { what: 'a to be held for the host' });
    expect(await refusal(test.mei.conn.request('plan.item.removePaths', { topicId: run.topicId, itemId: 'a' }))).toMatchObject({ code: 'forbidden' });
    // b is not held for such files.
    expect(await refusal(test.host.conn.request('plan.item.removePaths', { topicId: run.topicId, itemId: 'b' }))).toMatchObject({ code: 'conflict', text: { id: 'plan.item.removePaths.notHeld' } });

    await test.host.conn.request('plan.item.removePaths', { topicId: run.topicId, itemId: 'a' });
    const asked = smurgSent(test, run.session('a')).at(-1);
    expect(asked).toMatchObject({ purpose: 'remove-paths', by: HOST });
    expect(asked?.text).toBe('smurg does not merge changes to these files, which only the host may change: ["CLAUDE.md",".claude/settings.json"]. Undo your changes to them, keep the rest of your work, verify again, update the report and call check_report. Do not run git.');
    expect(lineIds(test, run.session('a')).at(-1)).toBe('conversation.removePathsRequested');
    expect((await test.audit('plan.item.removePaths'))[0]?.detail).toMatchObject({ topicId: run.topicId, itemId: 'a', paths: ['CLAUDE.md', '.claude/settings.json'] });
    // While the agent is at work on it nobody is asked; the hold is kept until its next version, which merges.
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'waiting', reason: 'busy' });
    expect((await storedItem(test, run.topicId, 'a')).autoMerge).toMatchObject({ state: 'held', reason: 'policy' });
    await handInReport(test, run.slug, 'a', { text: reportText('a', { done: 'Without CLAUDE.md.' }) });
    await mergedBySmurg(run.topicId, 'a');
  });
});

describe('DESIGN 0.7.0 D11: "Leave it out"', () => {
  it('leaves out the item and what depends on it (also through another item), ends a running one\'s session and keeps its worktree; the rest goes on; a merged item cannot be left out; Try again and Start take one back', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }, { id: 'd' }]);
    const sessionA = run.session('a');
    expect(item(run.topicId, 'c').state).toBe('waiting');
    expect(await refusal(test.amy.conn.request('plan.item.leaveOut', { topicId: run.topicId, itemId: 'a' }))).toMatchObject({ code: 'forbidden' });

    const { plan } = await test.mei.conn.request('plan.item.leaveOut', { topicId: run.topicId, itemId: 'a' });
    expect(plan.items.map((entry) => [entry.id, entry.state, entry.leftOut?.by.userId ?? null, entry.armed])).toEqual([
      ['a', 'stopped', MEI.userId, false],
      ['b', 'not-started', MEI.userId, false],
      ['c', 'not-started', MEI.userId, false],
      ['d', 'running', null, false],
    ]);
    expect(test.fakes.agents.get(sessionA)).toMatchObject({ status: 'ended', endReason: 'ended' });
    expect(lineIds(test, sessionA)).toContain('conversation.ended.leftOut');
    expect(test.fakes.worktrees.log.of('releaseItem')).toEqual([]);
    expect(test.topic(run.topicId).plan).toMatchObject({ items: 4, leftOut: 3, merged: 0 });
    expect((await test.audit('plan.item.leaveOut'))[0]).toMatchObject({ actor: { kind: 'user', userId: MEI.userId }, detail: { topicId: run.topicId, itemId: 'a', others: ['b', 'c'], sessions: 1 } });
    // Nobody is told a left-out item stopped.
    expect(test.t.ctx.services.topics.attention().filter((fact) => fact.itemId === 'a' || fact.itemId === 'b')).toEqual([]);

    // d goes on and merges: everything is settled, the topic is ready to check.
    await handInReport(test, run.slug, 'd');
    await mergedBySmurg(run.topicId, 'd');
    await waitFor(() => test.topic(run.topicId).phase === 'ready', { what: 'the topic to be ready to check' });
    expect(await refusal(test.mei.conn.request('plan.item.leaveOut', { topicId: run.topicId, itemId: 'd' }))).toMatchObject({ code: 'conflict', text: { id: 'plan.item.leaveOut.merged' }, detail: { reason: 'merged' } });

    // Try again takes a back in (it waits for nothing); Start takes b back in (it waits for a).
    await test.mei.conn.request('plan.item.retry', { topicId: run.topicId, itemId: 'a' });
    expect(item(run.topicId, 'a').leftOut).toBeUndefined();
    expect(test.topic(run.topicId).phase).toBe('executing');
    await startPlan(test, run.topicId, ['b']);
    expect(item(run.topicId, 'b')).toMatchObject({ armed: true, state: 'waiting' });
    expect(item(run.topicId, 'b').leftOut).toBeUndefined();
    expect(item(run.topicId, 'c').leftOut).toMatchObject({ by: MEI });
  });

  it('a merge that waits in the queue when the item is left out never happens; one already past its last check is waited for, and then the item is merged, not left out', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'x' }]);
    // a's merge waits for the main queue (a slow snapshot): "Leave it out" wins.
    const release = test.fakes.worktrees.holdMain();
    await handInReport(test, run.slug, 'a');
    await waitFor(() => tried().length === 1, { what: 'a\'s merge to wait in the queue' });
    const leaving = test.mei.conn.request('plan.item.leaveOut', { topicId: run.topicId, itemId: 'a' });
    release();
    const { plan } = await leaving;
    expect(plan.items.filter((entry) => entry.leftOut !== undefined).map((entry) => entry.id)).toEqual(['a', 'b']);
    await settle(test);
    expect(item(run.topicId, 'a').merge?.status).toBe('draft');
    expect(item(run.topicId, 'a').merged).toBeUndefined();

    // x's merge is past its last check (git merge runs): "Leave it out" waits for it and says it is merged.
    const merging = test.fakes.worktrees.holdMerging();
    await handInReport(test, run.slug, 'x');
    await merging.reached;
    const late = test.mei.conn.request('plan.item.leaveOut', { topicId: run.topicId, itemId: 'x' }).then(
      () => null,
      (err: unknown) => err,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    merging.release();
    expect(await late).toMatchObject({ code: 'conflict', text: { id: 'plan.item.leaveOut.merged' } });
    await mergedBySmurg(run.topicId, 'x');
    expect(item(run.topicId, 'x').leftOut).toBeUndefined();
    expect(await test.audit('plan.item.leaveOut')).toHaveLength(1);
  });
});

describe('DESIGN 0.7.0 D13: ready to check, and "I\'ve checked the result"', () => {
  it('every item merged: ready to check; nobody before that, and no Viewer, can check it; Amy checks it: complete, and the items\' sessions end', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const leo = await test.t.connect({ userId: 'dev:leo', displayName: 'Leo', role: 'viewer' });
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    await handInReport(test, run.slug, 'a');
    await mergedBySmurg(run.topicId, 'a');
    expect(test.topic(run.topicId).phase).toBe('executing');
    expect(await refusal(test.amy.conn.request('topic.check', { topicId: run.topicId }))).toMatchObject({ code: 'conflict', text: { id: 'topic.check.notReady' }, detail: { reason: 'not-ready' } });
    await handInReport(test, run.slug, 'b');
    await mergedBySmurg(run.topicId, 'b');
    await waitFor(() => test.topic(run.topicId).phase === 'ready', { what: 'ready to check' });
    // Nothing of them is finished before the check: their sessions and worktrees stay for a follow-up.
    await settle(test);
    expect(test.fakes.agents.get(run.session('a'))?.status).not.toBe('ended');
    expect(await refusal(leo.conn.request('topic.check', { topicId: run.topicId }))).toMatchObject({ code: 'forbidden' });

    const { topic } = await test.amy.conn.request('topic.check', { topicId: run.topicId });
    expect(topic).toMatchObject({ phase: 'complete', checked: { by: AMY } });
    for (const itemId of ['a', 'b']) await waitFor(() => test.fakes.agents.get(run.session(itemId))?.status === 'ended', { what: `${itemId}'s session to end` });
    expect(test.fakes.agents.get(run.session('a'))?.endReason).toBe('merged');
    expect(test.fakes.worktrees.log.of('releaseItem')).toHaveLength(2);
    expect((await test.audit('topic.check'))[0]).toMatchObject({ actor: { kind: 'user', userId: AMY.userId }, detail: { topicId: run.topicId, items: 2, merged: 2, leftOut: 0, undone: 0 } });
    expect(await refusal(test.amy.conn.request('topic.check', { topicId: run.topicId }))).toMatchObject({ text: { id: 'topic.check.notReady' } });
  });

  it('not settled yet: a merged item whose follow-up is to be answered, an item held for a decision (also when every report is reviewed); settled: a left-out item, a merged item whose follow-up was answered', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await handInReport(test, run.slug, 'a');
    await handInReport(test, run.slug, 'b', { text: reportText('b', { outcome: 'partial' }) });
    await mergedBySmurg(run.topicId, 'a');
    await waitFor(() => item(run.topicId, 'b').autoMerge?.state === 'held', { what: 'b held' });
    // Every report reviewed (a mark, also on an unfinished one) does not make the topic complete while b is held.
    await test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1 });
    await test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'b', version: 1, acknowledgeUnfinished: true });
    expect(test.topic(run.topicId).phase).toBe('executing');
    await test.mei.conn.request('plan.item.leaveOut', { topicId: run.topicId, itemId: 'b' });
    expect(test.topic(run.topicId).phase).toBe('executing');
    // c merges, but a follow-up to it is still to be answered: c is not settled.
    await handInReport(test, run.slug, 'c');
    await mergedBySmurg(run.topicId, 'c');
    await test.mei.conn.request('report.followUp', { topicId: run.topicId, itemId: 'c', text: 'Does it log?' });
    await settle(test);
    expect(test.topic(run.topicId).phase).toBe('executing');
    // Answered with no new version: c is merged and nothing of it is in progress any more.
    test.fakes.agents.finishTurn(run.session('c'), { finalText: 'It does.' });
    await waitFor(() => test.topic(run.topicId).phase === 'ready', { what: 'ready to check' });
    expect(test.topic(run.topicId).plan).toMatchObject({ items: 3, merged: 2, leftOut: 1 });
    expect(item(run.topicId, 'c').autoMerge).toBeUndefined();
  });

  it('a version registered after the check, and a Start of more items, take the mark back: the topic has new work', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const { topic } = await topicWithPlan(test, [{ id: 'a' }, { id: 'b' }]);
    await startPlan(test, topic.id, ['a']);
    const sessionA = itemOf(test.plan(topic.id), 'a').sessionId as string;
    await handInReport(test, topic.slug, 'a');
    await mergedBySmurg(topic.id, 'a');
    // (b was never started: not every item of the plan is settled)
    expect(test.topic(topic.id).phase).toBe('executing');
    await test.mei.conn.request('plan.item.leaveOut', { topicId: topic.id, itemId: 'b' });
    await waitFor(() => test.topic(topic.id).phase === 'ready', { what: 'ready' });
    await test.mei.conn.request('topic.check', { topicId: topic.id });
    expect(test.topic(topic.id)).toMatchObject({ phase: 'complete', checked: { by: MEI } });
    await waitFor(() => test.fakes.agents.get(sessionA)?.status === 'ended', { what: 'a\'s session to end' });
    // Start b: the plan has new work.
    await startPlan(test, topic.id, ['b']);
    expect(test.topic(topic.id).checked).toBeUndefined();
    expect(test.topic(topic.id).phase).toBe('executing');
    await handInReport(test, topic.slug, 'b');
    await mergedBySmurg(topic.id, 'b');
    await waitFor(() => test.topic(topic.id).phase === 'ready', { what: 'ready again' });
    // A version registered after the check (an item whose finishing could not run: its session did not end): the topic
    // is executing again, and ready again once that version is merged.
    const sessionB = itemOf(test.plan(topic.id), 'b').sessionId as string;
    const end = test.fakes.agents.end.bind(test.fakes.agents);
    test.fakes.agents.end = async () => {
      throw new Error('not now');
    };
    await test.mei.conn.request('topic.check', { topicId: topic.id });
    expect(test.fakes.agents.get(sessionB)?.status).not.toBe('ended');
    expect(test.topic(topic.id).phase).toBe('complete');
    await handInReport(test, topic.slug, 'b', { text: reportText('b', { done: 'Again.' }) });
    await waitFor(() => test.topic(topic.id).checked === undefined, { what: 'the mark to go' });
    // (the session could end again only now: the sweep's finishing found the topic checked until this version)
    test.fakes.agents.end = end;
    await waitFor(() => test.topic(topic.id).phase === 'ready', { what: 'ready once more' });
    expect(test.fakes.agents.get(sessionB)?.status).not.toBe('ended');
  });

  it('the host merges each item: merged and not reviewed is ready to check; merged and reviewed is complete; reviewed and not merged waits for the host', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    await handInReport(test, run.slug, 'a');
    await handInReport(test, run.slug, 'b');
    await waitFor(() => item(run.topicId, 'a').state === 'done' && item(run.topicId, 'b').state === 'done', { what: 'both done' });
    await test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'a', version: 1 });
    await test.mei.conn.request('report.review', { topicId: run.topicId, itemId: 'b', version: 1 });
    expect(test.topic(run.topicId).phase).toBe('executing');
    await test.fakes.worktrees.approve({ requestId: item(run.topicId, 'a').merge?.requestId as string }, test.principals.host);
    await settle(test);
    expect(test.topic(run.topicId).phase).toBe('executing');
    await test.fakes.worktrees.approve({ requestId: item(run.topicId, 'b').merge?.requestId as string }, test.principals.host);
    await waitFor(() => test.topic(run.topicId).phase === 'complete', { what: 'complete' });
  });
});

describe('0.7.0 review: what reaches more people, and when', () => {
  it('a decision whose one recipient has been offline a minute reaches the host and agent access too, as a question does (not only after five minutes)', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }]);
    await handInReport(test, run.slug, 'a', { text: reportText('a', { outcome: 'partial' }) });
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'held', { what: 'a held for Mei' });
    test.mei.close();
    await waitFor(() => !test.t.ctx.hub.isOnline(MEI.userId), { what: 'Mei offline' });
    await settle(test);
    expect(item(run.topicId, 'a').autoMerge?.escalated).toBe(false);
    test.t.advanceClock(test.t.ctx.config.agents.escalateOfflineMs + 1_000);
    await waitFor(() => item(run.topicId, 'a').autoMerge?.escalated === true, { what: 'the decision to escalate' });
    expect(test.t.ctx.config.agents.escalateOfflineMs + 1_000).toBeLessThan(test.t.ctx.settings.get().escalateAfterMs);
    expect(decisionsOf(run.topicId)).toEqual({ [MEI.userId]: 1, [HOST.userId]: 1 });
  });

  it('an item whose agent could not finish is a decision too: it reaches the host and agent access once it has waited, or at once when its one carer is offline, and the plan counts it', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]);
    const sessionId = run.session('a');
    // The agent stops in prose, and again after the nudge: stalled (`agent`), for Mei.
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => smurgSent(test, sessionId).some((message) => message.purpose === 'nudge-report'), { what: 'the nudge' });
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => item(run.topicId, 'a').state === 'stalled', { what: 'a to stall' });
    expect(test.t.ctx.services.topics.attention().map((fact) => [fact.subject, fact.recipients])).toEqual([['item-stalled', [MEI.userId]]]);
    expect(decisionsOf(run.topicId)).toEqual({ [MEI.userId]: 1 });
    test.t.advanceClock(test.t.ctx.settings.get().escalateAfterMs + 1);
    await waitFor(() => decisionsOf(run.topicId)[HOST.userId] === 1, { what: 'the plan to count it for the host' });
    expect(test.t.ctx.services.topics.attention().map((fact) => [fact.subject, [...fact.recipients].sort()])).toEqual([['item-stalled', [HOST.userId, MEI.userId].sort()]]);
  });

  it('the same at once when its one carer has been offline a minute', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => smurgSent(test, sessionId).some((message) => message.purpose === 'nudge-report'), { what: 'the nudge' });
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => item(run.topicId, 'a').state === 'stalled', { what: 'a to stall' });
    test.mei.close();
    await waitFor(() => !test.t.ctx.hub.isOnline(MEI.userId), { what: 'Mei offline' });
    await settle(test);
    test.t.advanceClock(test.t.ctx.config.agents.escalateOfflineMs + 1_000);
    await waitFor(() => test.t.ctx.services.topics.attention().some((fact) => fact.recipients.includes(HOST.userId)), { what: 'the host to have it' });
    // 0.7.0 verify (W/verify/diff): once escalated it stays so, as a question's or a hold's `escalatedAt` does: the host
    // and agent access do not lose the row when Mei comes back (it came and went with her connection).
    await test.t.connect({ userId: MEI.userId, displayName: MEI.displayName, role: 'agent' });
    await waitFor(() => test.t.ctx.hub.isOnline(MEI.userId), { what: 'Mei online again' });
    await settle(test);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle(test);
    expect(test.t.ctx.services.topics.attention().map((fact) => [fact.subject, [...fact.recipients].sort()])).toEqual([['item-stalled', [HOST.userId, MEI.userId].sort()]]);
    expect(decisionsOf(run.topicId)).toEqual({ [MEI.userId]: 1, [HOST.userId]: 1 });
  });
});
