// The console's requests about Claude Code on the host (ARCHITECTURE §5.8): the trust gate for project settings
// (`admin.claudeConfig.*`), the host's own allow rules (`admin.hostRules.*`: information, no decision; they apply),
// and redaction of one conversation entry (`admin.transcript.redact`). The handlers are the core's; they delegate to
// ProjectTrust, HostRules and AgentSessions, here the in-memory fakes.
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, SmurgError, lineEvent, type ConversationEvent } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { FAKE_HASH, buildAgentSession, fakesModule, fakesOf } from '../src/core/fakes/index.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof SmurgError)) throw new Error('expected a refusal');
  return { code: error.code, reason: error.detail?.['reason'] };
}

describe('admin.claudeConfig.*', () => {
  it('the host reads what the project settings do and decides; nobody else may', async () => {
    t = await createTestDaemon({ modules: [fakesModule()] });
    const trust = fakesOf(t.ctx).projectTrust;
    trust.description = { roots: [{ root: MAIN_ROOT, state: 'ignored', files: [] }], hasMore: false };
    const host = await t.connectHost();
    const rita = await t.connect({ userId: 'dev:rita', role: 'agent' });

    expect(await host.conn.request('admin.claudeConfig.get', {})).toEqual({ roots: [{ root: MAIN_ROOT, state: 'ignored', files: [] }], hasMore: false });
    expect(await host.conn.request('admin.claudeConfig.get', { after: 'main' })).toMatchObject({ hasMore: false });
    expect(trust.log.of('describe')).toEqual([[{}], [{ after: 'main' }]]);

    const decision = { root: MAIN_ROOT, files: [{ path: '.claude/settings.json', hash: FAKE_HASH }], decision: 'trust' as const, acknowledged: ['credentials' as const] };
    const changes: string[] = [];
    t.ctx.bus.on('trust.changed', (event) => changes.push(event.state));
    expect(await host.conn.request('admin.claudeConfig.decide', decision)).toEqual({});
    expect(trust.state(MAIN_ROOT)).toBe('used');
    expect(changes).toEqual(['used']);
    const [input, by] = trust.log.of('decide')[0] as [unknown, { userId: string; role: string }];
    expect(input).toEqual(decision);
    expect(by).toMatchObject({ userId: t.hostUserId, role: 'host' });

    for (const request of [rita.conn.request('admin.claudeConfig.get', {}), rita.conn.request('admin.claudeConfig.decide', { ...decision, decision: 'ignore' })]) {
      expect((await refusal(request)).code).toBe('forbidden');
    }
    expect(trust.log.of('decide')).toHaveLength(1);
    expect(trust.state(MAIN_ROOT)).toBe('used');
  });

  it('a refusal of the gate reaches the host as it is (a file changed since it was shown)', async () => {
    t = await createTestDaemon({ modules: [fakesModule()] });
    const trust = fakesOf(t.ctx).projectTrust;
    trust.decide = async () => {
      throw new SmurgError('conflict', msg('claudeConfig.changed'), { reason: 'changed' });
    };
    const host = await t.connectHost();
    const error = await host.conn
      .request('admin.claudeConfig.decide', { root: MAIN_ROOT, files: [{ path: '.claude/settings.json', hash: FAKE_HASH }], decision: 'trust', acknowledged: [] })
      .then(() => null, (e: unknown) => e as SmurgError);
    expect(error).toMatchObject({ code: 'conflict', detail: { reason: 'changed' } });
    expect(error?.text?.id).toBe('claudeConfig.changed');
  });
});

describe('admin.hostRules.*', () => {
  it('the host is shown its own Claude Code allow rules once; "seen" takes no decision and the rules keep applying', async () => {
    t = await createTestDaemon({ modules: [fakesModule()] });
    const rules = fakesOf(t.ctx).hostRules;
    const host = await t.connectHost();
    const eddie = await t.connect({ userId: 'dev:eddie', role: 'editor' });
    const sources: string[] = [];
    t.ctx.bus.on('attention.changed', (event) => sources.push(event.source));

    rules.found(['Bash(git status)', 'Bash(pnpm test *)']);
    expect(rules.attention()).toMatchObject([{ subject: 'host-rules', recipients: [t.hostUserId], count: 2 }]);
    expect(await host.conn.request('admin.hostRules.get', {})).toEqual({
      rules: [
        { rule: 'Bash(git status)', source: 'user' },
        { rule: 'Bash(pnpm test *)', source: 'user' },
      ],
      seen: false,
    });
    expect(await host.conn.request('admin.hostRules.seen', {})).toEqual({});
    expect((await host.conn.request('admin.hostRules.get', {})).seen).toBe(true);
    expect(rules.attention()).toEqual([]);
    // Nothing was switched off: the rules still apply to agent sessions (they run as the host).
    expect(rules.applied()).toEqual(['Bash(git status)', 'Bash(pnpm test *)']);
    expect(sources).toEqual(['host-rules', 'host-rules']);
    expect((rules.log.of('markSeen')[0]?.[0] as { userId: string }).userId).toBe(t.hostUserId);

    expect((await refusal(eddie.conn.request('admin.hostRules.get', {}))).code).toBe('forbidden');
    expect((await refusal(eddie.conn.request('admin.hostRules.seen', {}))).code).toBe('forbidden');
  });
});

describe('admin.transcript.redact', () => {
  it('replaces one entry of an agent conversation under the same seq, tells the watchers, and is audited', async () => {
    t = await createTestDaemon({ modules: [fakesModule()] });
    const fakes = fakesOf(t.ctx);
    const host = await t.connectHost();
    const rita = await t.connect({ userId: 'dev:rita', role: 'agent' });
    fakes.agents.adopt(buildAgentSession({ id: 'ses_a' }));
    const first = fakes.agents.append('ses_a', lineEvent(msg('conversation.stopped', { name: 'Ian' })));
    const second = fakes.agents.say('ses_a', 'the token is hunter2');
    const updates: ConversationEvent[] = [];
    rita.conn.on('session.events', (payload) => updates.push(...payload.events));
    const started = await fakes.agents.watch({ sessionId: 'ses_a' }, t.ctx.hub.connections({ userId: 'dev:rita' })[0] as never);
    const seqs = fakes.agents.eventsOf('ses_a').map((event) => event.seq);
    expect(seqs).toContain(first);
    expect(seqs).toContain(second);
    expect(started.events.map((event) => event.seq)).toEqual(seqs);
    started.afterReply();

    expect(await host.conn.request('admin.transcript.redact', { sessionId: 'ses_a', seq: second })).toEqual({});
    await waitFor(() => updates.length === 1, { what: 'the replaced entry' });
    expect(updates[0]).toMatchObject({ seq: second, kind: 'notice', text: { id: 'conversation.redacted' }, fallback: 'The host removed this entry.' });
    expect(JSON.stringify(fakes.agents.eventsOf('ses_a'))).not.toContain('hunter2');
    expect(fakes.agents.eventsOf('ses_a').map((event) => event.seq)).toEqual(seqs);

    await t.ctx.audit.flush();
    const entries = (await t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'transcript.redact');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'ok', target: 'ses_a', actor: { kind: 'user', userId: t.hostUserId }, detail: { sessionId: 'ses_a', seq: second } });
    expect(JSON.stringify(entries[0])).not.toContain('hunter2');
  });

  it('only the host; only agent sessions; only entries that exist', async () => {
    t = await createTestDaemon({ modules: [fakesModule()] });
    const fakes = fakesOf(t.ctx);
    const host = await t.connectHost();
    const rita = await t.connect({ userId: 'dev:rita', role: 'agent' });
    fakes.agents.adopt(buildAgentSession({ id: 'ses_a' }));
    fakes.agents.say('ses_a', 'hello');
    const terminal = await fakes.sessions.create({ kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 }, {} as never, t.ctx.members.principalOf(t.hostUserId) as never);

    expect((await refusal(rita.conn.request('admin.transcript.redact', { sessionId: 'ses_a', seq: 1 }))).code).toBe('forbidden');
    expect(await refusal(host.conn.request('admin.transcript.redact', { sessionId: 'ses_nope', seq: 1 }))).toEqual({ code: 'not_found', reason: undefined });
    expect(await refusal(host.conn.request('admin.transcript.redact', { sessionId: terminal.id, seq: 1 }))).toEqual({ code: 'bad_request', reason: 'not-an-agent' });
    expect((await refusal(host.conn.request('admin.transcript.redact', { sessionId: 'ses_a', seq: 99 }))).code).toBe('not_found');
    expect((await refusal(host.conn.request('admin.transcript.redact', { sessionId: 'ses_a', seq: 0 } as never))).code).toBe('bad_request');
    expect(fakes.agents.log.of('redact').map((args) => args.slice(0, 2))).toEqual([['ses_a', 99]]);
    await t.ctx.audit.flush();
    expect((await t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'transcript.redact')).toEqual([]);
  });
});

describe('admin.status', () => {
  it('counts agent sessions, topics, the main folder\'s trust state and the host\'s rules when their modules are composed', async () => {
    t = await createTestDaemon({ modules: [fakesModule()] });
    const fakes = fakesOf(t.ctx);
    fakes.agents.adopt(buildAgentSession({ id: 'ses_run', status: 'running' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_wait', status: 'waiting-permission' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_wait2', status: 'waiting-answer' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_stall', status: 'stalled' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_fail', status: 'failed' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_idle', status: 'idle' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_done', status: 'done' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_ended', status: 'ended' }));
    fakes.projectTrust.set(MAIN_ROOT, 'ignored');
    fakes.hostRules.found(['Bash(git status)']);
    const status = t.daemon.status();
    expect(status.agents).toEqual({ running: 1, waiting: 2, stalled: 2, idle: 2 });
    expect(status.topics).toEqual({ total: 0, paused: 0 });
    expect(status.projectSettings).toBe('ignored');
    expect(status.hostRules).toEqual({ count: 1 });
  });

  it('says nothing about agents while their modules are not composed', async () => {
    t = await createTestDaemon({ modules: [] });
    const status = t.daemon.status();
    for (const key of ['agents', 'topics', 'projectSettings', 'hostRules'] as const) expect(status[key]).toBeUndefined();
  });
});
