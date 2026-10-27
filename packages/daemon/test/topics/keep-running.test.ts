// Keeping it running (DESIGN 0.7.0 D15, D16, and D18's daemon half): the REAL topics module with the in-memory fakes.
//
//   - the one rule at every start: a plan stays paused when a person paused it or an item that runs directly in the
//     shared folder was interrupted; a continue that cannot be sent leaves the item stalled by the restart;
//   - "Pause": nothing starts, merges or continues by itself until "Continue all";
//   - smurg's own continues: a usage limit when the account is back, a broken turn twice (1 minute, then 5), a crash
//     once (the process started again as smurg), a failed snapshot once; never a person's stop, a logged-out account
//     or a refused model; each counted, audited and said in the conversation; a person's Continue counts again;
//   - the slots: sessions that wait for a person do not keep unrelated items from starting (up to twice the limit);
//   - what goes on at the next start (`smurg host` and `smurg stop` say it at a stop).
// The restart with goOn deferred, the person's pause across a restart and 0.6.0's pause lifted are in scheduler.test.ts.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SmurgError, topicPlanPath, topicSpecPath, type PlanInfo } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import { createTempDir, createTempRunDir, removeTempDir, removeTempRunDir } from '../../src/testing/index.ts';
import { handInReport, itemOf, lineIds, reportText, settle, setupTopics, smurgSent, startPlan, storedItem, topicWithPlan, waitFor, writeReport, type TopicsTest } from './support.ts';

let test: TopicsTest;
const after: (() => Promise<void>)[] = [];
afterEach(async () => {
  await test?.cleanup();
  for (const job of after.splice(0)) await job();
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

/** A topic of these items, started by Mei. */
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

const item = (topicId: string, itemId: string): PlanInfo['items'][number] => itemOf(test.plan(topicId), itemId);
const continues = (sessionId: string) => smurgSent(test, sessionId).filter((message) => message.purpose === 'continue-item');
const autoContinues = async (): Promise<unknown[][]> => (await test.audit('plan.item.autoContinue')).map((entry) => [entry.actor.kind, entry.outcome, entry.detail?.['itemId'], entry.detail?.['cause'], entry.detail?.['count']]);

async function folders(prefix: string): Promise<{ root: string; stateDir: string }> {
  const root = await createTempDir(prefix);
  const stateDir = await createTempRunDir();
  after.push(async () => {
    await removeTempDir(root);
    await removeTempRunDir(stateDir);
  });
  await writeFile(join(root, 'README.md'), '# project\n');
  return { root, stateDir };
}

const NO_GIT = { isRepo: false, hasCommit: false, gitOk: false, branch: null, busy: false, free: 64, unavailable: msg('worktree.unavailable.gitCannotRun') };

describe('DESIGN 0.7.0 D15: the one rule at every start', () => {
  it('a topic with an interrupted item that runs directly in the shared folder stays paused for the host (its change is half done in a folder without history); it says nothing goes on, and "Continue all" goes on', async () => {
    const { root, stateDir } = await folders('s6-direct');
    const workspaceId = 'ws_test_s6_direct_00001';
    test = await setupTopics({ root, stateDir, workspaceId });
    test.fakes.worktrees.main = NO_GIT;
    const { topic } = await topicWithPlan(test, [{ id: 'a' }]);
    const { preflight } = await test.host.conn.request('plan.preflight', { topicId: topic.id });
    expect(preflight.history).toBe('direct');
    await test.host.conn.request('plan.start', { topicId: topic.id, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash, direct: true });
    const sessionId = item(topic.id, 'a').sessionId as string;
    test.fakes.agents.startTurn(sessionId);
    // At a stop now, this topic would not go on by itself: the stop interrupts its item in the folder.
    expect(test.t.daemon.goOnAtNextStart()).toBe(0);
    const sessions = test.fakes.agents.list({ topicId: topic.id });
    await test.cleanup();

    test = await setupTopics({
      root,
      stateDir,
      workspaceId,
      seed: (fakes) => {
        fakes.worktrees.main = NO_GIT;
        for (const session of sessions) fakes.agents.adopt({ ...session, status: 'idle' }, { hasProcess: false });
      },
    });
    await settle(test);
    expect(test.plan(topic.id).paused).toBe(true);
    expect(test.topic(topic.id).plan.pausedBy).toBeUndefined();
    expect(item(topic.id, 'a')).toMatchObject({ state: 'stalled', stalledBy: 'restart' });
    expect(continues(sessionId)).toEqual([]);
    // Not a person's pause: smurg host names neither what goes on nor this topic as paused by someone.
    expect(test.t.daemon.continued()).toEqual({ topics: [], paused: [] });
    expect(test.t.ctx.services.topics.attention().filter((fact) => fact.subject === 'plan-paused')).toMatchObject([{ id: topic.id, count: 1 }]);
    const resumed = (await test.host.conn.request('plan.resume', { topicId: topic.id })).plan;
    expect(resumed.paused).toBe(false);
    expect(itemOf(resumed, 'a').state).toBe('running');
    expect(continues(sessionId)).toMatchObject([{ by: { userId: 'dev:host' } }]);
  });

  it('a continue that cannot be sent (no agent process can start here) leaves the item stalled by the restart with its attention item; nothing is said to go on and nothing is counted', async () => {
    const { root, stateDir } = await folders('s6-cannot');
    const workspaceId = 'ws_test_s6_cannot_00001';
    test = await setupTopics({ root, stateDir, workspaceId });
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]);
    const sessions = test.fakes.agents.list({ topicId: run.topicId });
    await test.cleanup();

    test = await setupTopics({
      root,
      stateDir,
      workspaceId,
      seed: async (fakes) => {
        fakes.agents.launchable = false;
        for (const session of sessions) fakes.agents.adopt({ ...session, status: 'idle' }, { hasProcess: false });
        await fakes.worktrees.commitMainPaths({ paths: [topicSpecPath(run.slug), topicPlanPath(run.slug)], message: 'the checkpoint of before', trailers: [], as: test.principals.mei });
      },
    });
    await settle(test);
    expect(test.plan(run.topicId).paused).toBe(false);
    expect(item(run.topicId, 'a')).toMatchObject({ state: 'stalled', stalledBy: 'restart' });
    expect(item(run.topicId, 'b')).toMatchObject({ state: 'waiting', armed: true });
    expect(continues(run.session('a'))).toEqual([]);
    expect(test.t.daemon.continued()).toEqual({ topics: [], paused: [] });
    expect(test.t.ctx.services.topics.attention().map((fact) => fact.subject)).toEqual(['item-stalled']);
    expect(await test.audit('plan.item.autoContinue')).toEqual([]);
    // Once agents can run again, "Continue" is a person's, as before.
    test.fakes.agents.launchable = true;
    await test.mei.conn.request('plan.item.continue', { topicId: run.topicId, itemId: 'a' });
    expect(item(run.topicId, 'a').state).toBe('running');
  });
});

describe('DESIGN 0.7.0 D15: "Pause", the brake that survives a restart', () => {
  it('while a plan is paused nothing starts, nothing merges and nothing continues by itself; turns that run go on; "Continue all" lets all of it go on', async () => {
    test = await setupTopics({ settings: { merging: 'auto', maxLiveAgents: 2 } });
    // Every item session starts working at once, as a real agent does with its first message (it holds a process).
    test.t.ctx.bus.on('session.created', (event) => {
      if (event.session.kind === 'agent' && event.session.purpose === 'item') queueMicrotask(() => test.fakes.agents.startTurn(event.session.id));
    });
    const run = await started([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await waitFor(() => test.plan(run.topicId).slots.inUse === 2, { what: 'two agents to run' });
    expect(test.plan(run.topicId).items.map((entry) => entry.state)).toEqual(['running', 'running', 'queued']);
    expect(await refusal(test.amy.conn.request('plan.pause', { topicId: run.topicId }))).toMatchObject({ code: 'forbidden' });
    const paused = (await test.mei.conn.request('plan.pause', { topicId: run.topicId })).plan;
    expect(paused.paused).toBe(true);
    expect(test.topic(run.topicId).plan.pausedBy).toEqual({ userId: 'dev:mei', displayName: 'Mei' });
    // b's turn breaks: smurg owes it a continue a minute later.
    test.fakes.agents.finishTurn(run.session('b'), { outcome: 'error' });
    await waitFor(() => item(run.topicId, 'b').state === 'stalled', { what: 'b to stall' });
    // a's report comes in (its turn was running): it is not merged, and the plan says why.
    await handInReport(test, run.slug, 'a');
    await waitFor(() => item(run.topicId, 'a').state === 'done', { what: 'a done' });
    await settle(test);
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'waiting', reason: 'paused' });
    expect(test.fakes.worktrees.log.of('autoMerge')).toEqual([]);
    // a's and b's processes are given up: slots are free, and still c does not start; b's minute passes, and nothing
    // is continued.
    test.fakes.agents.park(run.session('a'));
    test.fakes.agents.park(run.session('b'));
    test.t.advanceClock(5 * 60_000);
    await settle(test);
    expect(item(run.topicId, 'c').state).toBe('queued');
    expect(continues(run.session('b'))).toEqual([]);

    // "Continue all": everything goes on.
    await test.mei.conn.request('plan.resume', { topicId: run.topicId });
    expect(test.topic(run.topicId).plan.pausedBy).toBeUndefined();
    await waitFor(() => item(run.topicId, 'a').merged?.by === 'smurg', { what: 'a to merge' });
    await waitFor(() => item(run.topicId, 'c').state === 'running', { what: 'c to start' });
    await waitFor(() => continues(run.session('b')).length === 1, { what: 'b to be continued by smurg' });
    expect((await test.audit('plan.pause')).map((entry) => entry.detail)).toEqual([{ topicId: run.topicId }]);
  });
});

describe('DESIGN 0.7.0 D15: smurg continues by itself, bounded and audited', () => {
  it('a usage limit: the stalled item waits while the account is limited, and is continued when it works again; a usage limit has no bound', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    test.fakes.agents.setAccount({ state: 'usage-limit', sessions: 1, resetsAt: test.t.clock.now() + 3_600_000 });
    test.fakes.agents.startTurn(sessionId);
    test.fakes.agents.finishTurn(sessionId, { outcome: 'error' });
    await waitFor(() => item(run.topicId, 'a').state === 'stalled', { what: 'a to stall' });
    expect((await storedItem(test, run.topicId, 'a')).autoContinue).toMatchObject({ cause: 'usage-limit', count: 0 });
    test.t.advanceClock(10 * 60_000);
    await settle(test);
    expect(continues(sessionId)).toEqual([]);
    // The account works again (at its reset time, or with any turn that goes through).
    test.fakes.agents.setAccount({ state: 'ok', sessions: 0 });
    await waitFor(() => continues(sessionId).length === 1, { what: 'the continue after the limit' });
    expect(continues(sessionId)[0]?.by).toBeUndefined();
    expect(lineIds(test, sessionId).at(-1)).toBe('conversation.continued.usageLimit');
    expect(item(run.topicId, 'a').state).toBe('running');
    // It hits the limit again: again, as often as it happens.
    test.fakes.agents.setAccount({ state: 'usage-limit', sessions: 1 });
    test.fakes.agents.startTurn(sessionId);
    test.fakes.agents.finishTurn(sessionId, { outcome: 'error' });
    await waitFor(() => item(run.topicId, 'a').state === 'stalled', { what: 'a to stall again' });
    test.fakes.agents.setAccount({ state: 'ok', sessions: 0 });
    await waitFor(() => continues(sessionId).length === 2, { what: 'the second continue' });
    expect(await autoContinues()).toEqual([
      ['system', 'ok', 'a', 'usage-limit', 1],
      ['system', 'ok', 'a', 'usage-limit', 2],
    ]);
  });

  it('a broken turn: continued 1 minute after the stall, then 5 minutes after the next; after that it stays stalled for its carers; a person\'s Continue counts again from 0', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    const breakTurn = async (): Promise<void> => {
      test.fakes.agents.startTurn(sessionId);
      test.fakes.agents.finishTurn(sessionId, { outcome: 'error' });
      await waitFor(() => item(run.topicId, 'a').state === 'stalled', { what: 'a to stall' });
    };
    await breakTurn();
    expect(item(run.topicId, 'a').stalledBy).toBe('error');
    test.t.advanceClock(59_000);
    await settle(test);
    expect(continues(sessionId)).toEqual([]);
    test.t.advanceClock(2_000);
    await waitFor(() => continues(sessionId).length === 1, { what: 'the first continue' });
    expect(lineIds(test, sessionId).at(-1)).toBe('conversation.continued.error');
    expect(test.fakes.agents.eventsOf(sessionId).filter((event) => event.kind === 'line').at(-1)).toMatchObject({ text: { id: 'conversation.continued.error', params: { count: 1 } } });
    expect(item(run.topicId, 'a').state).toBe('running');
    // It breaks again: 5 minutes this time.
    await breakTurn();
    test.t.advanceClock(4 * 60_000);
    await settle(test);
    expect(continues(sessionId)).toHaveLength(1);
    test.t.advanceClock(61_000 + 1_000);
    await waitFor(() => continues(sessionId).length === 2, { what: 'the second continue' });
    expect(test.fakes.agents.eventsOf(sessionId).filter((event) => event.kind === 'line').at(-1)).toMatchObject({ text: { id: 'conversation.continued.error', params: { count: 2 } } });
    // And again: the two are spent; the item needs someone.
    await breakTurn();
    test.t.advanceClock(30 * 60_000);
    await settle(test);
    expect(continues(sessionId)).toHaveLength(2);
    expect(test.t.ctx.services.topics.attention().map((fact) => fact.subject)).toEqual(['item-stalled']);
    expect(await autoContinues()).toEqual([
      ['system', 'ok', 'a', 'error', 1],
      ['system', 'ok', 'a', 'error', 2],
    ]);
    // Mei presses Continue: smurg's count starts again.
    await test.mei.conn.request('plan.item.continue', { topicId: run.topicId, itemId: 'a' });
    expect((await storedItem(test, run.topicId, 'a')).autoContinue).toBeUndefined();
    await breakTurn();
    test.t.advanceClock(61_000);
    await waitFor(() => continues(sessionId).length === 4, { what: 'smurg\'s continue after the person\'s' });
    expect(continues(sessionId).map((message) => message.by?.userId ?? 'smurg')).toEqual(['smurg', 'smurg', 'dev:mei', 'smurg']);
  });

  it('a later turn of a done item that broke: its version waits while a continue is owed; once both are spent it is held (`stopped`) for its carers and nothing of it merges', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    test.fakes.worktrees.autoMergeItemSteps.set('a', [{ kind: 'wait', reason: 'typing', paths: ['src/a.ts'] }, { kind: 'wait', reason: 'typing', paths: ['src/a.ts'] }]);
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    await handInReport(test, run.slug, 'a');
    await waitFor(() => item(run.topicId, 'a').autoMerge?.reason === 'typing', { what: 'a to wait for the typing' });
    const breakTurn = async (turns: number): Promise<void> => {
      test.fakes.agents.startTurn(sessionId);
      test.fakes.agents.finishTurn(sessionId, { outcome: 'error' });
      await waitFor(async () => (await storedItem(test, run.topicId, 'a')).turns === turns && (await storedItem(test, run.topicId, 'a')).lastTurn !== undefined, { what: 'the broken turn to be recorded' });
    };
    await breakTurn(2);
    await settle(test);
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'waiting', reason: 'busy' });
    test.t.advanceClock(61_000);
    await waitFor(() => continues(sessionId).length === 1, { what: 'the first continue' });
    await breakTurn(3);
    test.t.advanceClock(5 * 60_000 + 1_000);
    await waitFor(() => continues(sessionId).length === 2, { what: 'the second continue' });
    await breakTurn(4);
    await waitFor(() => item(run.topicId, 'a').autoMerge?.state === 'held', { what: 'a to be held' });
    expect(item(run.topicId, 'a').autoMerge).toMatchObject({ state: 'held', reason: 'stopped', hostOnly: false });
    expect(item(run.topicId, 'a').merged).toBeUndefined();
    expect(test.fakes.worktrees.log.of('autoMerge').length).toBeLessThanOrEqual(1);
  });

  it('a crash: smurg starts the process again once, a minute later, as smurg (the system principal), and tells it to continue; a second crash stays failed', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    test.fakes.agents.startTurn(sessionId);
    test.fakes.agents.finishTurn(sessionId, { outcome: 'error' });
    test.fakes.agents.fail(sessionId);
    await waitFor(() => item(run.topicId, 'a').state === 'failed', { what: 'a to fail' });
    expect((await storedItem(test, run.topicId, 'a')).autoContinue).toMatchObject({ cause: 'crash', count: 0 });
    test.t.advanceClock(30_000);
    await settle(test);
    expect(test.fakes.agents.log.of('retry')).toEqual([]);
    test.t.advanceClock(31_000);
    await waitFor(() => continues(sessionId).length === 1, { what: 'the continue after the crash' });
    expect(test.fakes.agents.log.of('retry')).toEqual([[sessionId, SYSTEM_PRINCIPAL]]);
    expect(lineIds(test, sessionId).at(-1)).toBe('conversation.continued.crash');
    expect(item(run.topicId, 'a').state).toBe('running');
    // It fails again: it stays failed (the host, or agent access, decides with "Try again").
    test.fakes.agents.fail(sessionId);
    await waitFor(() => item(run.topicId, 'a').state === 'failed', { what: 'a to fail again' });
    test.t.advanceClock(10 * 60_000);
    await settle(test);
    expect(test.fakes.agents.log.of('retry')).toHaveLength(1);
    expect(test.t.ctx.services.topics.attention().map((fact) => fact.subject)).toEqual(['item-failed']);
    expect(await autoContinues()).toEqual([['system', 'ok', 'a', 'crash', 1]]);
  });

  it('a snapshot that failed: smurg continues the item once, a minute later, and the next completed turn takes the snapshot', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }]);
    const sessionId = run.session('a');
    test.fakes.worktrees.failSnapshot.set(run.worktree('a'), [new Error('git ran out of time')]);
    await handInReport(test, run.slug, 'a');
    await waitFor(() => item(run.topicId, 'a').state === 'stalled', { what: 'a to stall without a version' });
    expect((await storedItem(test, run.topicId, 'a')).autoContinue).toMatchObject({ cause: 'snapshot', count: 0 });
    test.t.advanceClock(61_000);
    await waitFor(() => continues(sessionId).length === 1, { what: 'the continue after the snapshot' });
    expect(lineIds(test, sessionId)).toContain('conversation.continued.snapshot');
    // The next turn ends with its report: this time the snapshot is taken, and the count goes with the version.
    await writeReport(test, run.slug, 'a', run.worktree('a'), reportText('a'));
    await handInReport(test, run.slug, 'a');
    await waitFor(() => item(run.topicId, 'a').state === 'done', { what: 'a done' });
    expect((await storedItem(test, run.topicId, 'a')).autoContinue).toBeUndefined();
    expect(await autoContinues()).toEqual([['system', 'ok', 'a', 'snapshot', 1]]);
  });

  it('never by itself: a turn a person stopped, a turn while the account is logged out, a turn the API refused the model of', async () => {
    test = await setupTopics();
    const run = await started([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    test.fakes.agents.startTurn(run.session('a'));
    await test.fakes.agents.interrupt(run.session('a'), test.principals.mei.actor);
    test.fakes.agents.startTurn(run.session('c'));
    test.fakes.agents.finishTurn(run.session('c'), { outcome: 'error', modelRefused: true });
    await waitFor(() => item(run.topicId, 'a').state === 'stalled' && item(run.topicId, 'c').state === 'stalled', { what: 'a and c to stall' });
    test.fakes.agents.setAccount({ state: 'logged-out', sessions: 1 });
    test.fakes.agents.startTurn(run.session('b'));
    test.fakes.agents.finishTurn(run.session('b'), { outcome: 'error' });
    await waitFor(() => item(run.topicId, 'b').state === 'stalled', { what: 'b to stall' });
    test.fakes.agents.setAccount({ state: 'ok', sessions: 0 });
    test.t.advanceClock(60 * 60_000);
    await settle(test);
    for (const id of ['a', 'b', 'c']) {
      expect(continues(run.session(id)), id).toEqual([]);
      expect((await storedItem(test, run.topicId, id)).autoContinue, id).toBeUndefined();
    }
    expect(await test.audit('plan.item.autoContinue')).toEqual([]);
  });
});

describe('DESIGN 0.7.0 D16: sessions that wait for a person do not keep unrelated items from starting', () => {
  const question = (id: string) => ({ id, kind: 'question' as const, toolUseId: `tu_${id}`, parts: [{ header: 'Q', text: 'Which one?', multi: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] });

  it('two of two wait for a person: two more start; two working and two waiting: no fifth (at most twice the limit)', async () => {
    test = await setupTopics({ settings: { maxLiveAgents: 2 } });
    test.t.ctx.bus.on('session.created', (event) => {
      if (event.session.kind === 'agent' && event.session.purpose === 'item') queueMicrotask(() => test.fakes.agents.startTurn(event.session.id));
    });
    const run = await started([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]);
    await waitFor(() => test.plan(run.topicId).slots.inUse === 2, { what: 'two agents' });
    test.fakes.agents.raise(run.session('a'), question('rq_a'));
    test.fakes.agents.raise(run.session('b'), question('rq_b'));
    await waitFor(() => item(run.topicId, 'c').state === 'running' && item(run.topicId, 'd').state === 'running', { what: 'two more to start' });
    await settle(test);
    expect(test.plan(run.topicId).slots).toEqual({ inUse: 4, max: 2, waitingForPeople: 2 });
    expect(item(run.topicId, 'e').state).toBe('queued');
    expect(test.fakes.agents.log.of('restartProcess')).toEqual([]);
  });

  it('never more than `maxAgentProcesses` either', async () => {
    test = await setupTopics({ settings: { maxLiveAgents: 2 }, agents: { maxAgentProcesses: 3 } });
    test.t.ctx.bus.on('session.created', (event) => {
      if (event.session.kind === 'agent' && event.session.purpose === 'item') queueMicrotask(() => test.fakes.agents.startTurn(event.session.id));
    });
    const run = await started([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    await waitFor(() => test.plan(run.topicId).slots.inUse === 2, { what: 'two agents' });
    test.fakes.agents.raise(run.session('a'), question('rq_a'));
    await waitFor(() => item(run.topicId, 'c').state === 'running', { what: 'a third to start' });
    test.fakes.agents.raise(run.session('b'), question('rq_b'));
    await waitFor(() => test.plan(run.topicId).slots.waitingForPeople === 2, { what: 'two to wait' });
    await settle(test);
    expect(test.plan(run.topicId).slots).toEqual({ inUse: 3, max: 2, waitingForPeople: 2 });
    expect(item(run.topicId, 'd').state).toBe('queued');
  });
});

describe('DESIGN 0.7.0 D18: what goes on by itself at the next start', () => {
  it('open topics that are not paused, with work that goes on by itself; a paused or archived topic, or one whose work waits for a person only, is not counted', async () => {
    test = await setupTopics();
    expect(test.t.daemon.goOnAtNextStart()).toBe(0);
    const one = await started([{ id: 'a' }], 'Checkout');
    const two = await started([{ id: 'b' }], 'Search');
    const three = await started([{ id: 'c' }], 'Gift cards');
    expect(test.t.daemon.goOnAtNextStart()).toBe(3);
    await test.mei.conn.request('plan.pause', { topicId: two.topicId });
    expect(test.t.ctx.services.plans.goOnAtNextStart()).toBe(2);
    // c is stopped by a person: nothing of that topic goes on by itself.
    test.fakes.agents.startTurn(three.session('c'));
    await test.fakes.agents.interrupt(three.session('c'), test.principals.mei.actor);
    await waitFor(() => item(three.topicId, 'c').state === 'stalled', { what: 'c to stall' });
    expect(test.t.daemon.goOnAtNextStart()).toBe(1);
    void one;
  });
});
