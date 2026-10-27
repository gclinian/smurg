// The host's undo, the topics' half (DESIGN 0.7.0 D14): the REAL topics module with the in-memory fakes. The fake
// worktree module takes back what it is asked (its merges, `undoSameLines` for a later merge of another topic on the
// same lines, `undoBlockers` for what is in the way) through the same `main` queue its automatic merges wait in; the
// git of it (the trial, the one commit, what blocks it, a crash before or after the commit) is
// test/worktree/undo.test.ts's, with the real git.
import { afterEach, describe, expect, it } from 'vitest';
import { SmurgError, type WorkItem } from '@smurg/protocol';
import { handInReport, itemOf, lineIds, reportText, settle, setupTopics, startPlan, storedItem, topicWithPlan, waitFor, type TopicsTest } from './support.ts';

let test: TopicsTest;
afterEach(async () => {
  await test?.cleanup();
});

const MEI = { userId: 'dev:mei', displayName: 'Mei' };
const HOST = { userId: 'dev:host', displayName: 'Host' };

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
async function started(items: Parameters<typeof topicWithPlan>[1], name = 'Checkout'): Promise<{ topicId: string; slug: string; session: (itemId: string) => string; worktree: (itemId: string) => string }> {
  const { topic } = await topicWithPlan(test, items, name);
  for (const entry of items) await test.mei.conn.request('plan.assign', { topicId: topic.id, itemId: entry.id, userId: MEI.userId });
  await startPlan(test, topic.id);
  return {
    topicId: topic.id,
    slug: topic.slug,
    session: (itemId) => itemOf(test.plan(topic.id), itemId).sessionId as string,
    worktree: (itemId) => itemOf(test.plan(topic.id), itemId).worktreeId as string,
  };
}

const item = (topicId: string, itemId: string): WorkItem => itemOf(test.plan(topicId), itemId);
async function merged(run: { topicId: string; slug: string }, itemId: string, text?: string): Promise<void> {
  await waitFor(() => item(run.topicId, itemId).state === 'running', { what: `${itemId} to run` });
  await handInReport(test, run.slug, itemId, text === undefined ? {} : { text });
  if (text !== undefined) return;
  await waitFor(() => item(run.topicId, itemId).merged?.by === 'smurg', { what: `smurg to merge ${itemId}` });
}
const tried = (): string[] => test.fakes.worktrees.log.of('autoMerge').map((call) => (call[0] as { requestId: string }).requestId);

describe('DESIGN 0.7.0 D14: the host takes merged work items back (the topics\' half)', () => {
  it('what is built on it goes with it, what waits for it is left out (a done one too), sessions end, worktrees go; the host alone; Start again makes a fresh worktree', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const vera = await test.t.connect({ userId: 'dev:vera', displayName: 'Vera', role: 'viewer' });
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }, { id: 'd' }]);
    await merged(run, 'a');
    await merged(run, 'b');
    await merged(run, 'd');
    // c started from the merged state and is done, held for a report that is not complete: it stands on a and b.
    await merged(run, 'c', reportText('c', { outcome: 'partial' }));
    await waitFor(() => item(run.topicId, 'c').autoMerge?.state === 'held', { what: 'c to be held' });
    const [worktreeA, worktreeB, worktreeC] = [run.worktree('a'), run.worktree('b'), run.worktree('c')];
    const [sessionA, sessionB, sessionC, sessionD] = [run.session('a'), run.session('b'), run.session('c'), run.session('d')];

    // Only the host: an Editor, Agent access and a Viewer are refused by the capability.
    for (const client of [test.amy, test.mei, vera]) expect(await refusal(client.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: ['a'] }))).toMatchObject({ code: 'forbidden' });
    // An item that is not merged has nothing to take back.
    expect(await refusal(test.host.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: ['c'] }))).toMatchObject({ code: 'conflict', text: { id: 'undo.notMerged' } });

    const { preview } = await test.host.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: ['a'] });
    expect(preview).toMatchObject({
      history: 'folder',
      ok: true,
      undone: [
        { topicId: run.topicId, topicName: 'Checkout', itemId: 'a', number: 1, why: 'asked' },
        { itemId: 'b', number: 2, why: 'built-on' },
      ],
      leftOut: [{ itemId: 'c', number: 3 }],
      blockers: { running: [], changedSince: [], staged: false, busy: false, branch: null, unavailable: null },
    });
    // Nothing changed by looking.
    expect(item(run.topicId, 'a').merged?.by).toBe('smurg');
    expect(test.fakes.worktrees.log.of('undo')).toEqual([]);

    const { plan } = await test.host.conn.request('topic.undo', { topicId: run.topicId, itemIds: ['a'], token: preview.token });
    expect(plan.items.map((entry) => [entry.id, entry.state, entry.merged === undefined ? null : 'merged', entry.undone?.by.userId ?? null, entry.leftOut?.by.userId ?? null])).toEqual([
      ['a', 'not-started', null, HOST.userId, null],
      ['b', 'not-started', null, HOST.userId, null],
      ['c', 'stopped', null, null, HOST.userId],
      ['d', 'done', 'merged', null, null],
    ]);
    expect(test.fakes.worktrees.log.of('undo')[0]?.[0]).toMatchObject({ subject: 'smurg: undo work item 1 (a) of checkout' });
    for (const sessionId of [sessionA, sessionB]) {
      await waitFor(() => test.fakes.agents.get(sessionId)?.status === 'ended', { what: 'an undone item\'s session to end' });
      expect(lineIds(test, sessionId)).toContain('conversation.ended.undone');
    }
    expect(test.fakes.agents.get(sessionC)).toMatchObject({ status: 'ended', endReason: 'ended' });
    expect(lineIds(test, sessionC)).toContain('conversation.ended.leftOut');
    expect(test.fakes.agents.get(sessionD)?.status).not.toBe('ended');
    // The undone items' worktrees go (re-merging reverted commits would do nothing); the left-out one keeps its work.
    expect(test.fakes.worktrees.log.of('releaseItem').map((call) => call[0])).toEqual([worktreeA, worktreeB]);
    expect(test.fakes.worktrees.get(worktreeC)).not.toBeNull();
    const stored = await storedItem(test, run.topicId, 'a');
    expect(stored).toMatchObject({ merged: false, armed: false, undone: { by: HOST } });
    expect(stored.mergedAs).toBeUndefined();
    expect(stored.merge).toBeUndefined();
    expect(stored.worktreeId).toBeUndefined();
    // Their requests say so (the worktree module's record), and the audit names what went with it.
    expect(test.fakes.worktrees.listMerges(test.principals.host).filter((request) => request.undone !== undefined).map((request) => request.itemId).sort()).toEqual(['a', 'b']);
    expect((await test.audit('worktree.merge.undo'))[0]).toMatchObject({
      actor: { kind: 'user', userId: HOST.userId },
      outcome: 'ok',
      detail: { topicId: run.topicId, itemIds: ['a'], goesWith: [{ topicId: run.topicId, itemId: 'b', why: 'built-on' }], leftOut: [{ topicId: run.topicId, itemId: 'c' }], history: 'folder' },
    });
    // a, b undone, c left out, d merged: every item is settled, the topic is ready to check.
    expect(test.topic(run.topicId).plan).toMatchObject({ items: 4, merged: 1, leftOut: 1, undone: 2 });
    await waitFor(() => test.topic(run.topicId).phase === 'ready', { what: 'the topic to be ready to check' });
    // Taken back once: there is nothing of it to undo any more.
    expect(await refusal(test.host.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: ['a'] }))).toMatchObject({ text: { id: 'undo.notMerged' } });

    // Start again: a fresh worktree from the main workspace as it is now; b waits for a again.
    await startPlan(test, run.topicId, ['a', 'b'], test.host);
    await waitFor(() => item(run.topicId, 'a').state === 'running', { what: 'a to start again' });
    expect(item(run.topicId, 'a').undone).toBeUndefined();
    expect(run.worktree('a')).not.toBe(worktreeA);
    expect(item(run.topicId, 'b')).toMatchObject({ state: 'waiting', waitsFor: ['a'] });
    expect(test.topic(run.topicId).phase).toBe('executing');
  });

  it('the whole topic, and an item of another topic that changed the same lines later goes with it, named with its topic, its session ended too', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b' }]);
    await merged(run, 'a');
    await merged(run, 'b');
    const other = await started([{ id: 'banner' }], 'Front page');
    await merged(other, 'banner');
    test.fakes.worktrees.undoSameLines = [{ topicId: other.topicId, itemId: 'banner' }];
    const { preview } = await test.host.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: null });
    expect(preview.undone.map((entry) => [entry.topicName, entry.itemId, entry.why])).toEqual([
      ['Checkout', 'a', 'asked'],
      ['Checkout', 'b', 'asked'],
      ['Front page', 'banner', 'same-lines'],
    ]);
    expect(preview.ok).toBe(true);
    await test.host.conn.request('topic.undo', { topicId: run.topicId, itemIds: null, token: preview.token });
    expect(test.fakes.worktrees.log.of('undo')[0]?.[0]).toMatchObject({ subject: 'smurg: undo topic checkout' });
    expect(item(other.topicId, 'banner')).toMatchObject({ state: 'not-started', undone: { by: HOST } });
    await waitFor(() => test.fakes.agents.get(other.session('banner'))?.status === 'ended', { what: 'banner\'s session to end' });
    expect(test.topic(other.topicId).plan).toMatchObject({ undone: 1, merged: 0 });
  });

  it('the token: an apply after what the undo does changed is refused (undo.changed); one while something is in the way (undo.notOk); a dependent in a turn is in the way; nothing changes', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]);
    await merged(run, 'a');
    await waitFor(() => item(run.topicId, 'b').state === 'running', { what: 'b to run' });
    // b is in a turn: it stands on a and would be left out, so it is in the way.
    const running = (await test.host.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: ['a'] })).preview;
    expect(running).toMatchObject({ ok: false, leftOut: [], blockers: { running: [{ itemId: 'b' }] } });
    expect(await refusal(test.host.conn.request('topic.undo', { topicId: run.topicId, itemIds: ['a'], token: running.token }))).toMatchObject({ code: 'conflict', text: { id: 'undo.notOk' } });

    await handInReport(test, run.slug, 'b', { text: reportText('b', { outcome: 'partial' }) });
    await waitFor(() => item(run.topicId, 'b').autoMerge?.state === 'held', { what: 'b to be held' });
    const looked = (await test.host.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: ['a'] })).preview;
    expect(looked).toMatchObject({ ok: true, leftOut: [{ itemId: 'b' }] });
    // b's new version merges after the look: what the undo does now (b goes with it) is not what was shown.
    await test.fakes.agents.startTurn(run.session('b'));
    await handInReport(test, run.slug, 'b');
    await waitFor(() => item(run.topicId, 'b').merged?.by === 'smurg', { what: 'b to merge' });
    expect(await refusal(test.host.conn.request('topic.undo', { topicId: run.topicId, itemIds: ['a'], token: looked.token }))).toMatchObject({ code: 'conflict', text: { id: 'undo.changed' }, detail: { reason: 'changed' } });
    const now = (await test.host.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: ['a'] })).preview;
    expect(now.undone.map((entry) => entry.why)).toEqual(['asked', 'built-on']);
    expect(now.token).not.toBe(looked.token);

    // Something in the way of the folder (staged changes): the preview says it, the apply is refused.
    test.fakes.worktrees.undoBlockers = { staged: true };
    const staged = (await test.host.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: ['a'] })).preview;
    expect(staged).toMatchObject({ ok: false, blockers: { staged: true } });
    expect(await refusal(test.host.conn.request('topic.undo', { topicId: run.topicId, itemIds: ['a'], token: staged.token }))).toMatchObject({ code: 'conflict', text: { id: 'undo.notOk' } });
    expect(item(run.topicId, 'a').merged?.by).toBe('smurg');
    expect(item(run.topicId, 'b').merged?.by).toBe('smurg');
    expect((await test.audit('worktree.merge.undo')).map((entry) => [entry.outcome, entry.detail?.['reason']])).toEqual([
      ['denied', 'not-ok'],
      ['denied', 'changed'],
      ['denied', 'not-ok'],
    ]);
  });

  it('an automatic merge of a dependent queued behind the undo\'s apply does not merge: the undo claims it', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]);
    await merged(run, 'a');
    await merged(run, 'b', reportText('b', { outcome: 'partial' }));
    await waitFor(() => item(run.topicId, 'b').autoMerge?.state === 'held', { what: 'b to be held' });
    const { preview } = await test.host.conn.request('topic.undo.preview', { topicId: run.topicId, itemIds: ['a'] });
    expect(preview).toMatchObject({ ok: true, leftOut: [{ itemId: 'b' }] });
    // The main queue is busy (a slow snapshot): the undo waits in it, and then b's new version's merge behind it.
    const release = test.fakes.worktrees.holdMain();
    const undoing = test.host.conn.request('topic.undo', { topicId: run.topicId, itemIds: ['a'], token: preview.token });
    await waitFor(() => test.fakes.worktrees.log.of('undo').length === 1, { what: 'the undo to wait in the queue' });
    const before = tried().length;
    await test.fakes.agents.startTurn(run.session('b'));
    await handInReport(test, run.slug, 'b');
    await waitFor(() => tried().length > before, { what: 'b\'s merge to wait in the queue' });
    release();
    await undoing;
    await settle(test);
    expect(item(run.topicId, 'b').merged).toBeUndefined();
    expect(item(run.topicId, 'b').leftOut?.by).toEqual(HOST);
    expect(test.fakes.worktrees.listMerges(test.principals.host).filter((request) => request.itemId === 'b' && request.status === 'merged')).toEqual([]);
  });

  it('an undo the worktree module recorded after a crash (its request undone, the item still merged here): the item and what waits for it follow', async () => {
    test = await setupTopics({ settings: { merging: 'auto' } });
    const run = await started([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]);
    await merged(run, 'a');
    await waitFor(() => item(run.topicId, 'b').state === 'running', { what: 'b to run' });
    const request = test.fakes.worktrees.listMerges(test.principals.host).find((entry) => entry.itemId === 'a' && entry.status === 'merged');
    if (request === undefined) throw new Error('no merged request of a');
    test.fakes.worktrees.putRequest({ ...request, undone: { commit: 'e'.repeat(40), at: test.t.clock.now(), by: HOST } });
    await waitFor(() => item(run.topicId, 'a').undone !== undefined, { what: 'a to be taken back' });
    expect(item(run.topicId, 'a')).toMatchObject({ state: 'not-started', undone: { by: HOST } });
    expect(item(run.topicId, 'b').leftOut?.by).toEqual(HOST);
    expect((await storedItem(test, run.topicId, 'a')).undone?.commit).toBe('e'.repeat(40));
    await waitFor(() => test.fakes.agents.get(run.session('a'))?.status === 'ended', { what: 'a\'s session to end' });
    expect(lineIds(test, run.session('a'))).toContain('conversation.ended.undone');
  });
});
