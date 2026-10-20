// @vitest-environment node
// The requests of protocol 5 that the stores send (DESIGN 0.6.0 D18): a session's model, a topic's agent settings,
// the host's "Got it" of the update's notice, what the host's side says (the host's agent, how work items run), and
// the requests that may make the daemon snapshot the whole shared folder first, or wait behind such a snapshot on the
// worktree module's queue, which wait 5 minutes.
import { buildAgentSession, buildPlan, buildTopic } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { makeHostState, makeMergeRequest } from '../../testing/fixtures.ts';
import { answerLoads, setupStores } from '../../testing/stores.ts';
import { selectAgentHost, selectWork } from './host.ts';
import { LONG_REQUEST_TIMEOUT_MS, createsWorktree } from './sessions.ts';

async function ready() {
  const ctx = setupStores({ role: 'host' });
  ctx.admit();
  answerLoads(ctx.conn, { 'session.host.get': makeHostState({ work: { history: 'smurg' } }) });
  await ctx.flush();
  return ctx;
}

describe('the stores: protocol 5 requests', () => {
  it("the host's agent and how work items run, live", async () => {
    const { conn, stores } = await ready();
    expect(selectAgentHost(stores.host.getState())?.models.map((model) => model.value)).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
    expect(selectWork(stores.host.getState())).toEqual({ history: 'smurg' });
    conn.emit('session.host', makeHostState({ work: { history: 'folder' } }));
    expect(selectWork(stores.host.getState())).toEqual({ history: 'folder' });
  });

  it("a session's model, or the host's default again", async () => {
    const { conn, stores, flush } = await ready();
    const changed = stores.sessions.setModel('sess_a', 'sonnet');
    expect(conn.lastRequest('session.model.set')?.payload).toEqual({ sessionId: 'sess_a', model: 'sonnet' });
    conn.respond('session.model.set', { session: buildAgentSession({ id: 'sess_a', model: 'sonnet' }) });
    expect((await changed).model).toBe('sonnet');
    void stores.sessions.setModel('sess_a', null);
    await flush();
    expect(conn.lastRequest('session.model.set')?.payload).toEqual({ sessionId: 'sess_a', model: null });
  });

  it("a topic's model and the mode its work items follow: only the keys given", async () => {
    const { conn, stores } = await ready();
    const set = stores.topics.setAgent('tp_1', { permissionMode: 'ask-commands' });
    expect(conn.lastRequest('topic.agent.set')?.payload).toEqual({ topicId: 'tp_1', permissionMode: 'ask-commands' });
    conn.respond('topic.agent.set', { topic: buildTopic({ id: 'tp_1', agent: { model: null, permissionMode: 'ask-commands' } }) });
    expect((await set).agent.permissionMode).toBe('ask-commands');
    expect(stores.topics.getState().topics.get('tp_1')?.agent.permissionMode).toBe('ask-commands');
    void stores.topics.setAgent('tp_1', { model: null, permissionMode: null });
    expect(conn.lastRequest('topic.agent.set')?.payload).toEqual({ topicId: 'tp_1', model: null, permissionMode: null });
  });

  it('"Got it" of the update\'s notice', async () => {
    const { conn, stores } = await ready();
    const seen = stores.admin.seeNotice('agents-auto');
    expect(conn.lastRequest('admin.notice.seen')?.payload).toEqual({ notice: 'agents-auto' });
    conn.respond('admin.notice.seen', {});
    await seen;
  });

  it('a Start, a session in a new worktree, a merge, the Start dialog, Resolve, a merge request and a rejection wait longer than the daemon may take; nothing else does', async () => {
    const { conn, stores } = await ready();
    void stores.topics.start({ topicId: 'tp_1', planRevision: 1, specHash: 'a'.repeat(64), planHash: 'b'.repeat(64) });
    expect(conn.lastRequest('plan.start')?.options).toEqual({ timeoutMs: LONG_REQUEST_TIMEOUT_MS });
    expect(LONG_REQUEST_TIMEOUT_MS).toBe(300_000);
    void stores.sessions.create({ kind: 'agent', workspace: { mode: 'worktree' } });
    expect(conn.lastRequest('session.create')?.options).toEqual({ timeoutMs: 300_000 });
    void stores.sessions.create({ kind: 'agent', workspace: { mode: 'worktree', worktreeId: 'wt_1' } });
    expect(conn.lastRequest('session.create')?.options).toBeUndefined();
    void stores.sessions.create({ kind: 'agent', workspace: { mode: 'main' } });
    expect(conn.lastRequest('session.create')?.options).toBeUndefined();
    expect(createsWorktree({ kind: 'terminal', workspace: { mode: 'worktree' }, cols: 80, rows: 24 })).toBe(true);
    void stores.worktrees.approve(makeMergeRequest().id);
    expect(conn.lastRequest('worktree.merge.approve')?.options).toEqual({ timeoutMs: 300_000 });
    // These wait on the daemon's queue behind another person's snapshot of a big folder (0.6.0's review measured a
    // preflight refused by the page after 30 s while the Start went on): they wait as long (until then 30 s).
    void stores.topics.preflight('tp_1');
    expect(conn.lastRequest('plan.preflight')?.options).toEqual({ timeoutMs: 300_000 });
    void stores.topics.resolveItem('tp_1', 'cart-api');
    expect(conn.lastRequest('plan.item.resolve')?.options).toEqual({ timeoutMs: 300_000 });
    void stores.worktrees.reject(makeMergeRequest().id);
    expect(conn.lastRequest('worktree.merge.reject')?.options).toEqual({ timeoutMs: 300_000 });
    // A merge request commits the worktree, then waits on the same queue to bring that commit in (until then 30 s).
    void stores.worktrees.requestMerge('wt_1');
    expect(conn.lastRequest('worktree.merge.request')?.options).toEqual({ timeoutMs: 300_000 });
    void stores.topics.resume('tp_1');
    expect(conn.lastRequest('plan.resume')?.options).toBeUndefined();
    conn.respond('plan.start', { plan: buildPlan() });
  });
});
