// The merge queue (DESIGN 0.7.0 D8, D3, D12): the REAL topics module with the in-memory fakes. The fake worktree
// module merges what it is asked to (or answers what a test scripted: a wait, a hold, a conflict), through a `main`
// queue a test can hold, and asks "still in order" at entry and just before the merge as the real one does
// (test/worktree/auto-merge.test.ts covers the real one with git).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, planInfoSchema, topicPlanPath, topicSpecPath, type AgentSession, type MergeRequest, type WorktreeInfo } from '@smurg/protocol';
import type { FakeAutoMergeStep } from '../../src/core/fakes/worktrees.ts';
import { AUTO_MERGE_BUSY_HOLD_MS, AUTO_MERGE_RECHECK_MS } from '../../src/topics/auto-merge.ts';
import { createTempDir, createTempRunDir, removeTempDir, removeTempRunDir } from '../../src/testing/index.ts';
import { checkReport, handInReport, itemOf, lineIds, reportText, settle, setupTopics, smurgSent, startPlan, storedItem, storedReport, topicWithPlan, waitFor, writeReport, type TopicsTest } from './support.ts';

let test: TopicsTest;
const after: (() => Promise<void>)[] = [];
afterEach(async () => {
  await test?.cleanup();
  for (const job of after.splice(0)) await job();
});

const AMY = { userId: 'dev:amy', displayName: 'Amy' };

/** A topic of these items, started by Mei, in a workspace that merges by itself. */
async function started(items: Parameters<typeof topicWithPlan>[1], name = 'Checkout'): Promise<{ topicId: string; slug: string; session: (itemId: string) => string; worktree: (itemId: string) => string }> {
  const { topic } = await topicWithPlan(test, items, name);
  await startPlan(test, topic.id);
  return {
    topicId: topic.id,
    slug: topic.slug,
    session: (itemId) => itemOf(test.plan(topic.id), itemId).sessionId as string,
    worktree: (itemId) => itemOf(test.plan(topic.id), itemId).worktreeId as string,
  };
}

const item = (topicId: string, itemId: string) => itemOf(test.plan(topicId), itemId);
const tried = (): string[] => test.fakes.worktrees.log.of('autoMerge').map((call) => (call[0] as { requestId: string }).requestId);
const steps = (itemId: string, ...list: FakeAutoMergeStep[]): void => {
  test.fakes.worktrees.autoMergeItemSteps.set(itemId, list);
};
async function mergedBySmurg(topicId: string, itemId: string): Promise<void> {
  await waitFor(() => item(topicId, itemId).merged?.by === 'smurg', { what: `smurg to merge ${itemId}` });
}

describe('DESIGN 0.7.0 D8: smurg merges what is in order', () => {
  it('a version whose report says complete, a check passed and none failed, checked in its turn, merges by itself: as the host\'s standing consent, with what waited started, the session and worktree kept until it is reviewed', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'cart-api' }, { id: 'checkout-page', dependsOn: ['cart-api'] }]);
    const sessionId = run.session('cart-api');
    // The agent was told that smurg may merge its work (D17).
    expect(test.fakes.agents.rolePromptOf(sessionId).rolePrompt.replace(/\n\s*/g, ' ')).toContain('smurg may merge your work into the shared folder without a person reading it first');
    await handInReport(test, run.slug, 'cart-api');
    await mergedBySmurg(run.topicId, 'cart-api');

    const merged = item(run.topicId, 'cart-api');
    expect(merged).toMatchObject({ state: 'done', merging: 'auto', merge: { status: 'merged' }, merged: { by: 'smurg' } });
    expect(merged.autoMerge).toBeUndefined();
    expect(planInfoSchema.safeParse(test.plan(run.topicId)).success).toBe(true);
    const requestId = merged.merge?.requestId as string;
    // On the host's standing consent, into the branch the Start committed on, from the Start's checkpoint.
    const pin = (await storedItem(test, run.topicId, 'cart-api')).pin;
    expect(test.fakes.worktrees.log.of('autoMerge').map((call) => call[0])).toEqual([{ requestId, host: { userId: 'dev:host', displayName: 'Host' }, pin: { branch: 'main', commit: pin?.commit }, consent: 'host-setting' }]);
    // Who merged it and the merge commit are the item's own record.
    expect((await storedItem(test, run.topicId, 'cart-api')).mergedAs).toMatchObject({ requestId, commit: expect.stringMatching(/^[0-9a-f]{40}$/), by: 'smurg' });
    expect((await storedReport(test, run.topicId, 'cart-api'))?.checkedInTurn).toBe(true);
    expect(lineIds(test, sessionId)).toContain('conversation.merged.auto');
    // Nobody waits for a review; what depended on it starts from the merged state.
    expect(test.plan(run.topicId).waitingFor).toEqual([]);
    await waitFor(() => item(run.topicId, 'checkout-page').state === 'running', { what: 'the dependent item to start' });
    // The item is not finished: its session and its worktree stay for a follow-up.
    await settle(test);
    expect(test.fakes.agents.get(sessionId)?.status).not.toBe('ended');
    expect(test.fakes.worktrees.log.of('releaseItem')).toEqual([]);
    // "I've reviewed this" is a mark: it finishes the item now.
    await test.host.conn.request('report.review', { topicId: run.topicId, itemId: 'cart-api', version: 1 });
    await waitFor(() => test.fakes.agents.get(sessionId)?.status === 'ended', { what: 'the reviewed item\'s session to end' });
    expect(test.fakes.agents.get(sessionId)?.endReason).toBe('merged');
  });

  it('a follow-up after the merge reaches the agent that did the work, and its new version merges like the first one', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'cart-api' }]);
    await handInReport(test, run.slug, 'cart-api');
    await mergedBySmurg(run.topicId, 'cart-api');
    const first = item(run.topicId, 'cart-api').merge?.requestId;
    await test.mei.conn.request('report.followUp', { topicId: run.topicId, itemId: 'cart-api', text: 'Also round the total.' });
    // While its answer is to come nothing of a newer version could merge; it is the agent's turn.
    expect(item(run.topicId, 'cart-api').changesAsked).toMatchObject({ by: { userId: 'dev:mei' } });
    await handInReport(test, run.slug, 'cart-api', { text: reportText('cart-api', { done: 'Everything, rounded.' }) });
    await waitFor(() => item(run.topicId, 'cart-api').merge?.requestId !== first && item(run.topicId, 'cart-api').merge?.status === 'merged', { what: 'the second version to merge' });
    expect(item(run.topicId, 'cart-api')).toMatchObject({ merged: { by: 'smurg' }, report: { version: 2 } });
    expect(item(run.topicId, 'cart-api').changesAsked).toBeUndefined();
  });

  it('one merge at a time, the oldest report first (not the oldest topic); a wait does not keep the next one from merging, and is tried again only when what it waits for moved', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const first = await started([{ id: 'a' }], 'First');
    const second = await started([{ id: 'b' }], 'Second');
    const third = await started([{ id: 'c' }], 'Third');
    // The main queue is busy (a slow snapshot, a Start's checkpoint): c's merge waits in it.
    const release = test.fakes.worktrees.holdMain();
    await handInReport(test, third.slug, 'c');
    await waitFor(() => tried().length === 1, { what: 'c\'s merge to wait in the queue' });
    // Meanwhile the second topic's report comes first, then the first topic's.
    await handInReport(test, second.slug, 'b');
    await waitFor(() => item(second.topicId, 'b').merge?.status === 'draft', { what: 'b\'s version' });
    test.t.advanceClock(1_000);
    await handInReport(test, first.slug, 'a');
    await waitFor(() => item(first.topicId, 'a').merge?.status === 'draft', { what: 'a\'s version' });
    // b: someone is typing in one of its files.
    const lock = { kind: 'human' as const, file: { root: MAIN_ROOT, path: 'src/b.ts' }, holders: [{ userId: 'dev:amy', displayName: 'Amy', since: 1, lastActivity: 1, channels: 1 }], acquiredAt: 1 };
    steps('b', { kind: 'wait', reason: 'typing', paths: ['src/b.ts'], lock } as unknown as FakeAutoMergeStep);
    release();
    await mergedBySmurg(first.topicId, 'a');
    const requestOf = (topicId: string, itemId: string): string => item(topicId, itemId).merge?.requestId as string;
    expect(tried()).toEqual([requestOf(third.topicId, 'c'), requestOf(second.topicId, 'b'), requestOf(first.topicId, 'a')]);
    expect(item(second.topicId, 'b').autoMerge).toMatchObject({ state: 'waiting', reason: 'typing', paths: ['src/b.ts'], hostOnly: false });
    // The sweep runs every 20 ms: b is not tried again while the lock holds and the minute has not passed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle(test);
    expect(tried().filter((id) => id === requestOf(second.topicId, 'b'))).toHaveLength(1);
    // Amy lets go of the file: b is tried at once, and merges.
    test.t.ctx.bus.emit('lock.changed', { file: { root: MAIN_ROOT, path: 'src/b.ts' }, lock: null, previous: null, reason: 'released' });
    await mergedBySmurg(second.topicId, 'b');
    expect(item(second.topicId, 'b').autoMerge).toBeUndefined();
  });

  it('a wait or a hold of the main workspace is looked at again at the latest a minute after its last try, or when a file it names changes, never on every sweep', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    steps('a', { kind: 'wait', reason: 'typing', paths: ['src/a.ts'] });
    steps('b', { kind: 'hold', reason: 'local-changes', paths: ['README.md'] });
    await handInReport(test, run.slug, 'a');
    await handInReport(test, run.slug, 'b');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.reason === 'typing' && item(run.topicId, 'b').autoMerge?.reason === 'local-changes', { what: 'a to wait and b to be held' });
    expect(item(run.topicId, 'b').autoMerge).toMatchObject({ state: 'held', reason: 'local-changes', hostOnly: true, paths: ['README.md'] });
    expect((await test.audit('worktree.merge.held')).map((entry) => entry.detail?.['reason'])).toEqual(['local-changes']);
    const count = tried().length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle(test);
    expect(tried()).toHaveLength(count);
    // A file the hold does not name changes: nothing; README.md changes: b is tried again (and merges).
    test.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'other.txt', change: 'change' }] });
    await settle(test);
    expect(tried()).toHaveLength(count);
    test.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'README.md', change: 'change' }] });
    await mergedBySmurg(run.topicId, 'b');
    // A minute of the daemon's clock: a is tried again although nobody said the lock went.
    test.t.advanceClock(AUTO_MERGE_RECHECK_MS + 1);
    await mergedBySmurg(run.topicId, 'a');
  });

  it('a second `retry` in a row is a hold for the host (merge-failed); git busy for ten minutes of the daemon\'s clock too, which clears by itself once git is done', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    steps('a', { kind: 'wait', reason: 'retry' }, { kind: 'wait', reason: 'retry' });
    steps('b', ...Array.from({ length: 30 }, (): FakeAutoMergeStep => ({ kind: 'wait', reason: 'git-busy' })));
    await handInReport(test, run.slug, 'a');
    await handInReport(test, run.slug, 'b');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.reason === 'merge-failed', { what: 'the second retry to hold a' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'merge-failed', hostOnly: true });
    await waitFor(() => item(run.topicId, 'b').autoMerge?.reason === 'git-busy', { what: 'b to wait for git' });
    expect(item(run.topicId, 'b').autoMerge).toMatchObject({ state: 'waiting', hostOnly: false });
    test.t.advanceClock(AUTO_MERGE_BUSY_HOLD_MS + 1);
    await waitFor(() => item(run.topicId, 'b').autoMerge?.state === 'held', { what: 'git busy for ten minutes to hold b' });
    expect(item(run.topicId, 'b').autoMerge).toMatchObject({ state: 'held', reason: 'git-busy', hostOnly: true });
    // git is done in the host's terminal: the next look merges it.
    steps('b');
    test.t.advanceClock(AUTO_MERGE_RECHECK_MS + 1);
    await mergedBySmurg(run.topicId, 'b');
    // merge-failed does not clear by itself.
    test.t.advanceClock(AUTO_MERGE_RECHECK_MS + 1);
    await settle(test);
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'merge-failed' });
  });
});

describe('DESIGN 0.7.0 D8: a merge that is not clean', () => {
  it('against other work items only: the checkout is brought up to date and the item\'s own agent resolves, naming what merged before it; one resolution at a time per file; three tries, then a decision', { timeout: 30_000 }, async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    test.fakes.worktrees.conflictedFiles = ['src/app.ts'];
    const conflict = (): FakeAutoMergeStep => ({ kind: 'conflict', paths: ['src/app.ts'] });
    // c merges first; a then conflicts with it (twice, then it is clean); b conflicts on the same file meanwhile.
    steps('a', conflict(), conflict());
    steps('b', ...Array.from({ length: 12 }, conflict));
    await handInReport(test, run.slug, 'c');
    await mergedBySmurg(run.topicId, 'c');
    await handInReport(test, run.slug, 'a');
    await waitFor(() => smurgSent(test, run.session('a')).some((message) => message.purpose === 'resolve-conflict'), { what: 'a to be asked to resolve' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'resolving', reason: 'conflict', tries: 1, paths: ['src/app.ts'] });
    expect(test.fakes.worktrees.log.of('updateFromMain').map((call) => call[0])).toEqual([run.worktree('a')]);
    expect(lineIds(test, run.session('a')).at(-1)).toBe('conversation.update.auto');
    const resolve = smurgSent(test, run.session('a')).at(-1);
    expect(resolve).toMatchObject({ purpose: 'resolve-conflict' });
    expect(resolve?.by).toBeUndefined();
    expect(resolve?.text).toBe('smurg merged the main workspace into your checkout. These files have conflict markers: ["src/app.ts"]. Other work items were merged before yours: 3 (id c). Keep their changes. Resolve them, verify again, update the report and call check_report. Do not run git.');
    // b conflicts on the file a is resolving: it waits behind it.
    await handInReport(test, run.slug, 'b');
    await waitFor(() => item(run.topicId, 'b').autoMerge?.reason === 'behind', { what: 'b to wait behind a' });
    expect(test.fakes.worktrees.log.of('updateFromMain')).toHaveLength(1);
    // a's agent resolves: the next version is snapshotted with its merge parent, and goes into the queue again.
    await handInReport(test, run.slug, 'a', { text: reportText('a', { done: 'Resolved.' }) });
    const resolves = (itemId: string): number => smurgSent(test, run.session(itemId)).filter((message) => message.purpose === 'resolve-conflict').length;
    await waitFor(() => resolves('a') === 2, { what: 'a\'s second try' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'resolving', tries: 2 });
    await handInReport(test, run.slug, 'a', { text: reportText('a', { done: 'Resolved again.' }) });
    await mergedBySmurg(run.topicId, 'a');
    expect((await storedItem(test, run.topicId, 'a')).mergeTries).toBe(2);
    // a is in: b is tried again, and now resolves itself (not counted as a try for a person's resolve, D8).
    await waitFor(() => resolves('b') === 1, { what: 'b to resolve after a merged' });
    expect(smurgSent(test, run.session('b')).at(-1)?.text).toContain('Other work items were merged before yours: 3 (id c), 1 (id a).');
    for (const [done, count] of [['b1', 2], ['b2', 3]] as const) {
      await handInReport(test, run.slug, 'b', { text: reportText('b', { done }) });
      await waitFor(() => resolves('b') === count, { what: `b's try after ${done}` });
    }
    await handInReport(test, run.slug, 'b', { text: reportText('b', { done: 'b3' }) });
    // Three tries spent: a person decides.
    await waitFor(() => item(run.topicId, 'b').autoMerge?.state === 'held', { what: 'b to be held after three tries' });
    expect(item(run.topicId, 'b').autoMerge).toMatchObject({ state: 'held', reason: 'conflict', tries: 3, hostOnly: false, paths: ['src/app.ts'] });
    expect((await test.audit('worktree.merge.held')).at(-1)?.detail).toMatchObject({ itemId: 'b', reason: 'conflict', tries: 3 });
    expect(lineIds(test, run.session('b')).at(-1)).toBe('conversation.held');
  });

  it('against a person\'s change: a decision for the item\'s carers at once, naming the person; no try, and a person\'s "Ask the agent to resolve" says which files hold that change', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }]);
    steps('a', { kind: 'conflict', paths: ['config.txt'], people: [{ path: 'config.txt', by: [AMY], outside: false }] });
    await handInReport(test, run.slug, 'a');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'held', { what: 'a to be held' });
    expect(item(run.topicId, 'a').autoMerge).toEqual({ state: 'held', reason: 'conflict', since: expect.any(Number), tries: 0, hostOnly: false, escalated: false, paths: ['config.txt'], people: [{ path: 'config.txt', by: [AMY], outside: false }] });
    expect(test.fakes.worktrees.log.of('updateFromMain')).toEqual([]);
    expect((await test.audit('worktree.merge.held'))[0]?.detail).toMatchObject({ itemId: 'a', reason: 'conflict', paths: ['config.txt'], people: [{ path: 'config.txt', by: ['dev:amy'], outside: false }], tries: 0 });
    await test.mei.conn.request('plan.item.resolve', { topicId: run.topicId, itemId: 'a' });
    expect(smurgSent(test, run.session('a')).at(-1)?.text).toContain('In these files the other side is a change a person made in the main workspace, not another work item\'s: ["config.txt"]. Keep that change and fit yours to it, unless the person who asked you to resolve says otherwise.');
    expect((await storedItem(test, run.topicId, 'a')).mergeTries).toBeUndefined();
  });
});

describe('DESIGN 0.7.0 D6 row 13: a version checked in the turn that made it', () => {
  async function checkedEarlier(): Promise<{ topicId: string; slug: string; sessionId: string }> {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    // The agent checks its report, and that turn is stopped before its end registers it; "Continue": a turn that
    // changes nothing ends, and the version it registers was checked in an earlier turn.
    await writeReport(test, run.slug, 'a', run.worktree('a'), reportText('a'));
    expect((await checkReport(test, sessionId)).ok).toBe(true);
    test.fakes.agents.finishTurn(sessionId, { outcome: 'interrupted' });
    await waitFor(() => item(run.topicId, 'a').state === 'stalled', { what: 'the stopped turn' });
    await test.mei.conn.request('plan.item.continue', { topicId: run.topicId, itemId: 'a' });
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => smurgSent(test, sessionId).some((message) => message.purpose === 'verify-again'), { what: 'verify-again' });
    return { topicId: run.topicId, slug: run.slug, sessionId };
  }

  it('smurg asks the agent once to verify again; a turn that checks it and changes nothing lets it merge', async () => {
    const run = await checkedEarlier();
    expect((await storedReport(test, run.topicId, 'a'))?.checkedInTurn).toBeUndefined();
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'resolving', reason: 'stale-report' });
    expect(lineIds(test, run.sessionId).at(-1)).toBe('conversation.verifyAgain');
    expect(smurgSent(test, run.sessionId).at(-1)?.text).toBe('You changed files after your report was last checked. Verify again, update the report so that it says what you verified now, and call check_report. Do not run git.');
    expect(tried()).toEqual([]);
    expect((await checkReport(test, run.sessionId)).ok).toBe(true);
    test.fakes.agents.finishTurn(run.sessionId);
    await mergedBySmurg(run.topicId, 'a');
    expect(item(run.topicId, 'a').report?.version).toBe(1);
    expect((await storedReport(test, run.topicId, 'a'))?.checkedInTurn).toBe(true);
    expect(smurgSent(test, run.sessionId).filter((message) => message.purpose === 'verify-again')).toHaveLength(1);
  });

  it('a turn that neither checks it nor makes a new version is a decision for the carers', async () => {
    const run = await checkedEarlier();
    test.fakes.agents.say(run.sessionId, 'It is fine.');
    test.fakes.agents.finishTurn(run.sessionId);
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'held', { what: 'the hold' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'stale-report', hostOnly: false });
    await settle(test);
    expect(tried()).toEqual([]);
    expect(smurgSent(test, run.sessionId).filter((message) => message.purpose === 'verify-again')).toHaveLength(1);
  });
});

describe('DESIGN 0.7.0 D6, D8: what holds an item, and what clears a hold', () => {
  it('a report that is not complete and verified is held; a new version that is clears it and merges; a later stopped turn holds the version it followed', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    await handInReport(test, run.slug, 'a', { text: reportText('a', { outcome: 'partial' }) });
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'held', { what: 'a held' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'partial', hostOnly: false });
    expect(lineIds(test, run.session('a'))).toContain('conversation.held');
    await handInReport(test, run.slug, 'a', { text: reportText('a') });
    await mergedBySmurg(run.topicId, 'a');
    expect(item(run.topicId, 'a').autoMerge).toBeUndefined();

    // b's report is in, then a later turn (a person wrote to its agent) is stopped before smurg merged it.
    const release = test.fakes.worktrees.holdMain();
    await handInReport(test, run.slug, 'b');
    await waitFor(() => tried().length === 2, { what: 'b\'s merge to wait in the queue' });
    test.fakes.agents.startTurn(run.session('b'));
    test.fakes.agents.finishTurn(run.session('b'), { outcome: 'interrupted', stoppedBy: { userId: 'dev:mei', displayName: 'Mei' } });
    release();
    await waitFor(() => item(run.topicId, 'b').autoMerge?.state === 'held', { what: 'b held' });
    expect(item(run.topicId, 'b').autoMerge).toMatchObject({ state: 'held', reason: 'stopped' });
    expect(item(run.topicId, 'b').merge?.status).toBe('draft');
  });

  it('the host rejects a draft smurg would have merged: a decision for the carers', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }]);
    const release = test.fakes.worktrees.holdMain();
    await handInReport(test, run.slug, 'a');
    await waitFor(() => tried().length === 1, { what: 'the merge to wait in the queue' });
    // (what the host's "Reject" ends in: the worktree module records it and announces it)
    await test.fakes.worktrees.reject({ requestId: item(run.topicId, 'a').merge?.requestId as string }, test.principals.host);
    release();
    await waitFor(() => item(run.topicId, 'a').autoMerge?.reason === 'rejected', { what: 'the rejection to hold it' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'rejected', hostOnly: false });
  });

  it('files only the host may merge: the host\'s decision at once, with the files; a hand edit by someone without agent access holds it for the host', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    test.fakes.worktrees.refuseSnapshot.set(run.worktree('a'), { ok: false, reason: 'host-only-paths', files: ['CLAUDE.md'] });
    await handInReport(test, run.slug, 'a');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'held', { what: 'a held' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'policy', hostOnly: true, paths: ['CLAUDE.md'] });
    // Amy (an Editor) edited one of b's files by hand; Mei (agent access) another: Amy's holds it for the host.
    test.fakes.worktrees.snapshotStats = { files: 2, additions: 2, deletions: 0, byHand: [{ path: 'src/b.ts', by: [AMY] }, { path: 'src/c.ts', by: [{ userId: 'dev:mei', displayName: 'Mei' }] }] };
    await handInReport(test, run.slug, 'b');
    await waitFor(() => item(run.topicId, 'b').autoMerge?.state === 'held', { what: 'b held' });
    expect(item(run.topicId, 'b').autoMerge).toMatchObject({ state: 'held', reason: 'by-hand', hostOnly: true, paths: ['src/b.ts'] });
    expect(tried()).toEqual([]);
  });
});

describe('DESIGN 0.7.0 D8: nothing merges out of order (the races)', () => {
  const INTERVENTIONS: readonly (readonly [string, (run: { topicId: string; slug: string; session: (itemId: string) => string }) => Promise<void>])[] = [
    ['the setting turned to the host', async () => {
      await test.host.conn.request('admin.settings.set', { merging: 'host' });
    }],
    ['the topic archived', async (run) => {
      await test.mei.conn.request('topic.archive', { topicId: run.topicId, archived: true, deleteUnmerged: true });
    }],
    ['a follow-up from the report', async (run) => {
      await test.mei.conn.request('report.followUp', { topicId: run.topicId, itemId: 'a', text: 'One more thing.' });
    }],
    ['a new turn of the item\'s agent', async (run) => {
      test.fakes.agents.startTurn(run.session('a'));
    }],
  ];

  it.each(INTERVENTIONS)('%s while the merge waits in the worktree module\'s queue: nothing is merged and the request is not marked', async (_name, intervene) => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }]);
    const release = test.fakes.worktrees.holdMain();
    await handInReport(test, run.slug, 'a');
    await waitFor(() => tried().length === 1, { what: 'the merge to wait in the queue' });
    const requestId = tried()[0] as string;
    await intervene(run);
    release();
    await settle(test);
    const request = test.fakes.worktrees.listMerges(test.principals.host).find((candidate) => candidate.id === requestId);
    expect(request?.status ?? 'gone').not.toBe('merged');
    if (request !== undefined) expect(request.status).toBe('draft');
    expect(item(run.topicId, 'a').merged).toBeUndefined();
  });
});

describe('DESIGN 0.7.0 D8: after a restart', () => {
  async function folders(prefix: string): Promise<{ root: string; stateDir: string }> {
    const root = await createTempDir(prefix);
    const stateDir = await createTempRunDir();
    after.push(async () => {
      await removeTempDir(root);
      await removeTempRunDir(stateDir);
    });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# project\n');
    return { root, stateDir };
  }

  /** Stops the daemon with item a bringing its work up to date, and gives back what the other modules keep. */
  async function resolvingAtStop(prefix: string, workspaceId: string): Promise<{ root: string; stateDir: string; topicId: string; sessions: AgentSession[]; worktree: WorktreeInfo; requests: MergeRequest[]; parent: string | null }> {
    const { root, stateDir } = await folders(prefix);
    test = await setupTopics({ root, stateDir, workspaceId, settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }]);
    test.fakes.worktrees.conflictedFiles = ['src/app.ts'];
    steps('a', { kind: 'conflict', paths: ['src/app.ts'] });
    await handInReport(test, run.slug, 'a');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'resolving' && smurgSent(test, run.session('a')).some((message) => message.purpose === 'resolve-conflict'), { what: 'a to resolve' });
    const sessions = test.fakes.agents.list({ topicId: run.topicId });
    const worktree = test.fakes.worktrees.get(run.worktree('a')) as WorktreeInfo;
    const requests = test.fakes.worktrees.listMerges(test.principals.host);
    const parent = test.fakes.worktrees.pendingMergeParent(worktree.id);
    await test.cleanup();
    return { root, stateDir, topicId: run.topicId, sessions, worktree, requests, parent };
  }

  it('an item whose agent was resolving with the merge parent recorded: the resolve message again, after the restart\'s line, and no new try', async () => {
    const workspaceId = 'ws_test_s3_restart_0001';
    const before = await resolvingAtStop('s3-restart-a', workspaceId);
    expect(before.parent).not.toBeNull();
    test = await setupTopics({
      root: before.root,
      stateDir: before.stateDir,
      workspaceId,
      seed: (fakes) => {
        for (const session of before.sessions) fakes.agents.adopt({ ...session, status: 'idle' }, { hasProcess: false });
        fakes.worktrees.adopt(before.worktree);
        for (const request of before.requests) fakes.worktrees.putRequest(request);
        fakes.worktrees.mergeParents.set(before.worktree.id, before.parent as string);
      },
    });
    const sessionId = itemOf(test.plan(before.topicId), 'a').sessionId as string;
    await waitFor(() => smurgSent(test, sessionId).some((message) => message.purpose === 'resolve-conflict'), { what: 'the resolve message again' });
    expect(lineIds(test, sessionId)).toEqual(['conversation.continued.restart']);
    expect(test.fakes.worktrees.log.of('updateFromMain')).toEqual([]);
    expect(itemOf(test.plan(before.topicId), 'a').autoMerge).toMatchObject({ state: 'resolving', reason: 'conflict', tries: 1 });
  });

  it('the stop came before the checkout was brought up to date: both again, still no new try', async () => {
    const workspaceId = 'ws_test_s3_restart_0002';
    const before = await resolvingAtStop('s3-restart-b', workspaceId);
    test = await setupTopics({
      root: before.root,
      stateDir: before.stateDir,
      workspaceId,
      seed: (fakes) => {
        for (const session of before.sessions) fakes.agents.adopt({ ...session, status: 'idle' }, { hasProcess: false });
        fakes.worktrees.adopt(before.worktree);
        for (const request of before.requests) fakes.worktrees.putRequest(request);
        // (no merge parent: the kill came between the record and updateFromMain's)
      },
    });
    const sessionId = itemOf(test.plan(before.topicId), 'a').sessionId as string;
    await waitFor(() => smurgSent(test, sessionId).some((message) => message.purpose === 'resolve-conflict'), { what: 'the resolve message again' });
    expect(test.fakes.worktrees.log.of('updateFromMain').map((call) => call[0])).toEqual([before.worktree.id]);
    expect(lineIds(test, sessionId)).toEqual(['conversation.update.auto']);
    expect((await storedItem(test, before.topicId, 'a')).mergeTries).toBe(1);
  });

  it('a merge smurg made whose record the topics module never got: at the start it is recorded as smurg\'s; a plan paused by the restart merges nothing until "Continue all"', async () => {
    const { root, stateDir } = await folders('s3-restart-c');
    const workspaceId = 'ws_test_s3_restart_0003';
    test = await setupTopics({ root, stateDir, workspaceId, settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    // a: merged by smurg, recorded in worktrees.json only; b: done and waiting for a lock; c: mid-turn at the stop.
    steps('a', { kind: 'wait', reason: 'typing', paths: ['src/a.ts'] });
    steps('b', { kind: 'wait', reason: 'typing', paths: ['src/b.ts'] });
    await handInReport(test, run.slug, 'a');
    await handInReport(test, run.slug, 'b');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.reason === 'typing' && item(run.topicId, 'b').autoMerge?.reason === 'typing', { what: 'both to wait' });
    const sessions = test.fakes.agents.list({ topicId: run.topicId });
    const worktrees = ['a', 'b', 'c'].map((id) => test.fakes.worktrees.get(run.worktree(id)) as WorktreeInfo);
    const requests = test.fakes.worktrees.listMerges(test.principals.host);
    const aRequest = item(run.topicId, 'a').merge?.requestId as string;
    await test.cleanup();

    test = await setupTopics({
      root,
      stateDir,
      workspaceId,
      seed: (fakes) => {
        for (const session of sessions) fakes.agents.adopt({ ...session, status: 'idle' }, { hasProcess: false });
        for (const worktree of worktrees) fakes.worktrees.adopt(worktree);
        for (const request of requests) fakes.worktrees.putRequest(request.id === aRequest ? { ...request, status: 'merged', auto: true, decidedAt: 5 } : request);
      },
    });
    expect(test.plan(run.topicId).paused).toBe(true);
    expect((await storedItem(test, run.topicId, 'a')).mergedAs).toMatchObject({ requestId: aRequest, by: 'smurg', at: 5 });
    expect(itemOf(test.plan(run.topicId), 'a').merged).toEqual({ at: 5, by: 'smurg' });
    expect(itemOf(test.plan(run.topicId), 'b').autoMerge).toMatchObject({ state: 'waiting', reason: 'paused' });
    await test.fakes.worktrees.commitMainPaths({ paths: [topicSpecPath(run.slug), topicPlanPath(run.slug)], message: 'the checkpoint of before', trailers: [], as: test.principals.mei });
    await settle(test);
    expect(tried()).toEqual([]);
    await test.mei.conn.request('plan.resume', { topicId: run.topicId });
    await waitFor(() => itemOf(test.plan(run.topicId), 'b').merged?.by === 'smurg', { what: 'b to merge after Continue all' });
  });
});

describe('DESIGN 0.7.0 D12: under automatic merging a review is a mark', () => {
  it('no report waits for a review, and no report escalates; the host\'s items keep 0.6.0\'s', async () => {
    test = await setupTopics({ settings: { merging: 'auto' }, agents: { reportEscalationFactor: 1 } });
    const run = await started([{ id: 'a' }]);
    steps('a', { kind: 'wait', reason: 'typing', paths: ['src/a.ts'] });
    await handInReport(test, run.slug, 'a');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.reason === 'typing', { what: 'a to wait' });
    test.t.advanceClock(60 * 60_000);
    await settle(test);
    expect(item(run.topicId, 'a').report).toMatchObject({ state: 'to-review' });
    expect(item(run.topicId, 'a').report?.escalatedAt).toBeUndefined();
    expect(test.plan(run.topicId).waitingFor).toEqual([]);
  });
});
