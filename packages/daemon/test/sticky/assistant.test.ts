// Claude for the sticky notes, started over the wire (DESIGN 0.8.0 D3.5): `sticky.assistant.start` with the REAL agent
// runtime (the sessions module, the stand-in `claude`) and the real sticky module. One per workspace: the running one
// is answered, an ended one is followed by a new one, two presses start one.
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type AgentSession, type AuditEntry, type SmurgError } from '@smurg/protocol';
import { createStickyModule } from '../../src/sticky/module.ts';
import { notesRolePrompt } from '../../src/sticky/prompts.ts';
import { TEST_HOST_USER, waitFor, type TestClient } from '../../src/testing/index.ts';
import { startSessionStack, type SessionStack, type SessionStackOptions } from '../sessions/setup.ts';

let current: SessionStack | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

interface Rig {
  readonly s: SessionStack;
  readonly host: TestClient;
  readonly mei: TestClient;
  readonly amy: TestClient;
  readonly audit: AuditEntry[];
  notesSessions(): AgentSession[];
}

async function rig(options: SessionStackOptions = {}): Promise<Rig> {
  const s = await startSessionStack({ ...options, extraModules: [createStickyModule()] });
  current = s;
  const audit: AuditEntry[] = [];
  s.t.ctx.audit.subscribe((entry) => audit.push(entry));
  const host = await s.t.connectHost();
  const mei = await s.t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
  const amy = await s.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
  return { s, host, mei, amy, audit, notesSessions: () => s.t.ctx.services.agents.list().filter((session) => session.purpose === 'notes') };
}

const refused = (promise: Promise<unknown>): Promise<SmurgError> => promise.then(
  () => {
    throw new Error('the request was not refused');
  },
  (err: unknown) => err as SmurgError,
);

describe('sticky.assistant.start (D3.5)', { timeout: 60_000 }, () => {
  it('starts Claude for the sticky notes for the caller: purpose notes, nobody responsible, the main workspace, the host\'s default model, its role prompt and its first line; audited with its purpose', async () => {
    const r = await rig();
    const { session } = await r.mei.conn.request('sticky.assistant.start', {});
    expect(session).toMatchObject({ kind: 'agent', purpose: 'notes', openedBy: { userId: 'dev:mei', displayName: 'Mei' }, responsible: null, root: MAIN_ROOT, model: null, modeFixed: true, modeChoice: null, permissionMode: 'ask-all' });
    for (const key of ['topicId', 'itemId', 'title'] as const) expect(session[key], key).toBeUndefined();
    await waitFor(() => r.s.t.ctx.services.agents.get(session.id)?.status === 'idle', { timeoutMs: 15_000, what: 'the start' });
    // Started with notesRolePrompt for its own tag, word for word.
    const profile = r.s.fakes.hooks.profiles.find((entry) => entry.sessionId === session.id)?.profile;
    const tag = /\[smurg ([a-z0-9]{4})\]/.exec(profile?.rolePrompt ?? '')?.[1] as string;
    expect(profile?.rolePrompt).toBe(notesRolePrompt({ smurgTag: tag }));
    // The first line of its conversation says who started it.
    const { events } = await r.s.t.ctx.services.agents.history({ sessionId: session.id, afterSeq: 0, limit: 50 });
    expect(events.find((event) => event.kind === 'line')).toMatchObject({ kind: 'line', text: { id: 'conversation.started.notes', params: { name: 'Mei' } } });
    expect(r.audit.filter((entry) => entry.action === 'session.create')).toMatchObject([
      { actor: { kind: 'user', userId: 'dev:mei' }, outcome: 'ok', target: session.id, detail: { sessionId: session.id, kind: 'agent', purpose: 'notes', root: 'main', mode: 'ask-all', model: null } },
    ]);
  });

  it('the running one is answered to whoever asks; after it ended, a new one starts', async () => {
    const r = await rig();
    const first = (await r.mei.conn.request('sticky.assistant.start', {})).session;
    const again = (await r.host.conn.request('sticky.assistant.start', {})).session;
    expect(again.id).toBe(first.id);
    expect(again.openedBy.userId).toBe('dev:mei');
    expect(r.notesSessions()).toHaveLength(1);
    expect(r.audit.filter((entry) => entry.action === 'session.create')).toHaveLength(1);
    // The host ends it; the next press starts a new one, opened by whoever pressed.
    await r.host.conn.request('session.end', { sessionId: first.id });
    await waitFor(() => r.s.t.ctx.services.agents.get(first.id)?.status === 'ended', { timeoutMs: 15_000, what: 'the end' });
    const next = (await r.host.conn.request('sticky.assistant.start', {})).session;
    expect(next.id).not.toBe(first.id);
    expect(next.openedBy.userId).toBe(TEST_HOST_USER);
    expect(r.notesSessions().filter((session) => session.status !== 'ended')).toHaveLength(1);
  });

  it('two presses at once start one session', async () => {
    const r = await rig();
    const [a, b] = await Promise.all([r.mei.conn.request('sticky.assistant.start', {}), r.host.conn.request('sticky.assistant.start', {})]);
    expect(a.session.id).toBe(b.session.id);
    expect(r.notesSessions()).toHaveLength(1);
    expect(r.audit.filter((entry) => entry.action === 'session.create')).toHaveLength(1);
  });

  it('at the session limit it is refused with the runtime\'s own sentence', async () => {
    const r = await rig({ daemon: { agents: { maxAgentSessions: 1 } } });
    await r.host.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' } });
    expect(await refused(r.mei.conn.request('sticky.assistant.start', {}))).toMatchObject({ code: 'conflict', text: { id: 'session.limit.agents', params: { max: 1 } } });
    expect(r.notesSessions()).toEqual([]);
  });

  it('an Editor may not start it (an Editor\'s messages are suggestions; starting a session is agent access)', async () => {
    const r = await rig();
    expect(await refused(r.amy.conn.request('sticky.assistant.start', {}))).toMatchObject({ code: 'forbidden' });
    expect(r.notesSessions()).toEqual([]);
    expect(r.audit.filter((entry) => entry.action === 'authz.denied')).toMatchObject([{ actor: { userId: 'dev:amy' }, detail: { type: 'sticky.assistant.start', reason: 'capability', role: 'editor' } }]);
  });
});
